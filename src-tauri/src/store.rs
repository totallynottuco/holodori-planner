//! File-backed profiles. The journal makes multi-file commits replayable after a crash.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
pub type Values = BTreeMap<String, String>;
pub type Result<T> = std::result::Result<T, String>;
#[cfg(test)]
thread_local! {
    static PROFILE_WORK: std::cell::Cell<(u64,u64)> = const { std::cell::Cell::new((0,0)) };
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub schema: u32,
    pub revision: u64,
    pub values: Values,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    schema: u32,
    revision: u64,
    profiles: Vec<String>,
    values: Values,
}
#[derive(Serialize, Deserialize)]
struct Profile {
    schema: u32,
    id: String,
    values: Values,
}
#[derive(Clone, PartialEq, Eq)]
struct ProfileStamp {
    len: u64,
    modified: SystemTime,
    changed: i128,
}
#[cfg(windows)]
fn profile_change_time(path:&Path, _metadata:&fs::Metadata) -> Option<i128> {
    use std::os::windows::{fs::OpenOptionsExt,io::AsRawHandle};
    #[repr(C)]
    struct BasicInfo { created:i64,accessed:i64,written:i64,changed:i64,attributes:u32 }
    #[link(name="kernel32")]
    extern "system" { fn GetFileInformationByHandleEx(handle:*mut std::ffi::c_void,class:i32,info:*mut std::ffi::c_void,size:u32)->i32; }
    let file=fs::OpenOptions::new().read(true).access_mode(0x80).open(path).ok()?;
    let mut info=BasicInfo {created:0,accessed:0,written:0,changed:0,attributes:0};
    let result=unsafe {GetFileInformationByHandleEx(file.as_raw_handle().cast(),0,(&mut info as *mut BasicInfo).cast(),std::mem::size_of::<BasicInfo>() as u32)};
    (result!=0).then_some(info.changed as i128)
}
#[cfg(unix)]
fn profile_change_time(_path:&Path, metadata:&fs::Metadata) -> Option<i128> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.ctime() as i128*1_000_000_000+metadata.ctime_nsec() as i128)
}
#[cfg(not(any(windows,unix)))]
fn profile_change_time(_path:&Path,_metadata:&fs::Metadata) -> Option<i128> {None}
fn profile_stamp(path: &Path) -> Option<ProfileStamp> {
    let metadata=fs::metadata(path).ok()?;
    if !metadata.is_file() { return None; }
    Some(ProfileStamp { len:metadata.len(), modified:metadata.modified().ok()?,changed:profile_change_time(path,&metadata)? })
}
#[derive(Serialize, Deserialize)]
pub struct Backup {
    pub format: String,
    pub workspace: Snapshot,
    pub artwork: BTreeMap<String, String>,
}
const RESTORE_JOURNAL: &str = "pending-restore.json";
const RESTORE_NEXT_ART: &str = "restore-next-artwork";
const RESTORE_PREVIOUS_ART: &str = "restore-previous-artwork";
pub(crate) const MAX_RESTORE_BYTES: usize = 256_000_000;

fn check_restore_size(backup: &Backup) -> Result<()> {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_RESTORE_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Desktop backup exceeds the supported size.",
                ));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // Count the exact journal representation without allocating a second copy.
    serde_json::to_writer_pretty(&mut Counter(0), backup).map_err(err)
}

/// Fully validate before a recovery backup, staging file, or live file changes.
fn restore_artwork(backup: &Backup) -> Result<Vec<(String, Vec<u8>)>> {
    use base64::Engine;
    if backup.format != "holodori-desktop-backup-v1" {
        return Err("Not a Holodori desktop backup.".into());
    }
    validate(&backup.workspace)?;
    let size = backup
        .workspace
        .values
        .iter()
        .fold(0usize, |size, (key, value)| {
            size.saturating_add(key.len()).saturating_add(value.len())
        });
    let size = backup.artwork.iter().fold(size, |size, (name, data)| {
        size.saturating_add(name.len()).saturating_add(data.len())
    });
    if size > MAX_RESTORE_BYTES || backup.artwork.len() > 20_000 {
        return Err("Desktop backup exceeds the supported size.".into());
    }
    check_restore_size(backup)?;
    let mut names = BTreeSet::new();
    let mut art = Vec::with_capacity(backup.artwork.len());
    for (name, data) in &backup.artwork {
        if !safe_art_name(name) || !name.ends_with(".json") {
            return Err("Unsafe artwork filename in backup.".into());
        }
        if !names.insert(name.to_ascii_lowercase()) {
            return Err("Duplicate artwork filename in backup.".into());
        }
        // Bound the decode allocation as well as the resulting document.
        if data.len() > 4_000_000 {
            return Err("Artwork file exceeds the supported size.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(err)?;
        if bytes.len() > 3_000_000 {
            return Err("Artwork file exceeds the supported size.".into());
        }
        art.push((name.clone(), bytes));
    }
    Ok(art)
}
fn remove_restore_directory(root: &Path, name: &str) -> Result<()> {
    // Only fixed sibling transaction directories are ever removed recursively.
    if name != RESTORE_NEXT_ART && name != RESTORE_PREVIOUS_ART {
        return Err("Invalid restore staging directory.".into());
    }
    let path = root.join(name);
    if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(err)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Restore staging directory is not a regular directory.".into());
        }
        fs::remove_dir_all(path).map_err(err)?;
    }
    Ok(())
}
fn stage_restore_artwork(root: &Path, artwork: &[(String, Vec<u8>)]) -> Result<()> {
    remove_restore_directory(root, RESTORE_NEXT_ART)?;
    let directory = root.join(RESTORE_NEXT_ART);
    fs::create_dir(&directory).map_err(err)?;
    for (name, bytes) in artwork {
        atomic(&directory.join(name), bytes)?;
    }
    Ok(())
}
pub struct Store {
    pub root: PathBuf,
    pub snapshot: Snapshot,
    pub recovery: Vec<String>,
    pub backup_warning: Option<String>,
    profile_stamps: BTreeMap<String,ProfileStamp>,
    last_backup: u64,
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn owner(key: &str) -> Option<&str> {
    if key.starts_with("main-") {
        return Some("main");
    }
    if let Some(rest) = key.strip_prefix("account-") {
        if let Some((number, _)) = rest.split_once('-') {
            if !number.is_empty() && number.bytes().all(|c| c.is_ascii_digit()) {
                return Some(&key[..8 + number.len()]);
            }
        }
    }
    None
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = File::create(&tmp).map_err(err)?;
    f.write_all(bytes).map_err(err)?;
    f.sync_all().map_err(err)?;
    drop(f);
    if path.exists() {
        fs::copy(path, path.with_extension("bak")).map_err(err)?;
    }
    fs::rename(&tmp, path).map_err(err)
}
fn json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    atomic(path, &serde_json::to_vec_pretty(value).map_err(err)?)
}
fn read<T: serde::de::DeserializeOwned>(path: &Path, recovery: &mut Vec<String>) -> Result<T> {
    let primary = fs::read(path)
        .map_err(err)
        .and_then(|b| serde_json::from_slice(&b).map_err(err));
    match primary {
        Ok(v) => Ok(v),
        Err(e) => {
            let backup = path.with_extension("bak");
            let v = fs::read(&backup)
                .map_err(err)
                .and_then(|b| serde_json::from_slice(&b).map_err(err))
                .map_err(|_| {
                    format!(
                        "Cannot read {}: {e}. Your files have been preserved.",
                        path.display()
                    )
                })?;
            if path.exists() {
                fs::copy(path, path.with_extension(format!("corrupt-{}", now()))).map_err(err)?;
            }
            fs::copy(backup, path).map_err(err)?;
            recovery.push(format!(
                "Recovered {} from its previous good copy.",
                path.file_name().unwrap().to_string_lossy()
            ));
            Ok(v)
        }
    }
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(err)?;
        let was_reset = crate::reset_data::recover(&root)?;
        fs::create_dir_all(root.join("profiles")).map_err(err)?;
        fs::create_dir_all(root.join("backups")).map_err(err)?;
        fs::create_dir_all(root.join("artwork")).map_err(err)?;
        let mut recovery = vec![];
        // Restore intent supersedes an autosave interrupted during its commit.
        // Its fixed target revision and self-contained artwork make replay safe
        // before loading any possibly half-replaced profile documents.
        if root.join(RESTORE_JOURNAL).exists() {
            if fs::metadata(root.join(RESTORE_JOURNAL)).map_err(err)?.len()
                > MAX_RESTORE_BYTES as u64
            {
                return Err("Desktop restore journal exceeds the supported size. Your files have been preserved.".into());
            }
            let target: Backup = read(&root.join(RESTORE_JOURNAL), &mut recovery)?;
            let artwork = restore_artwork(&target)?;
            let mut store = Self {
                root,
                snapshot: target.workspace.clone(),
                recovery,
                backup_warning: None,
                profile_stamps: BTreeMap::new(),
                last_backup: 0,
            };
            store.finish_restore(&target, &artwork, false)?;
            store
                .recovery
                .push("Completed an interrupted desktop restore.".into());
            return Ok(store);
        }
        let journal = root.join("pending-transaction.json");
        let snapshot = if journal.exists() {
            let v: Snapshot = read(&journal, &mut recovery)?;
            recovery.push("Completed an interrupted autosave.".into());
            v
        } else if root.join("workspace.json").exists() {
            let m: Manifest = read(&root.join("workspace.json"), &mut recovery)?;
            if m.schema != 1 {
                return Err("This workspace requires a newer version of Hololive Dreams Planner.".into());
            }
            let mut values = m.values;
            for id in m.profiles {
                if !valid_id(&id) {
                    return Err("Invalid profile filename in workspace.".into());
                }
                let p: Profile = read(
                    &root.join("profiles").join(format!("{id}.json")),
                    &mut recovery,
                )?;
                if p.id != id || p.schema != 1 {
                    return Err("Invalid profile document.".into());
                }
                values.extend(p.values);
            }
            Snapshot {
                schema: 1,
                revision: m.revision,
                values,
            }
        } else {
            Snapshot {
                schema: 1,
                revision: 0,
                values: BTreeMap::from([
                    ("game_id".into(), "hololive-dreams".into()),
                    ("account".into(), "main".into()),
                    ("accounts".into(), "[]".into()),
                ]),
            }
        };
        validate(&snapshot)?;
        let mut s = Self {
            root,
            snapshot,
            recovery,
            backup_warning: None,
            profile_stamps: BTreeMap::new(),
            last_backup: 0,
        };
        if journal.exists() || !s.root.join("workspace.json").exists() {
            s.commit(s.snapshot.clone())?;
        }
        if was_reset {crate::reset_data::finish(&s.root)?;}
        Ok(s)
    }
    fn commit(&mut self, next: Snapshot) -> Result<()> {
        validate(&next)?;
        json(&self.root.join("pending-transaction.json"), &next)?;
        // The journal still contains the full transaction. Borrow its strings
        // while grouping instead of cloning every profile for serialization.
        let mut globals = BTreeMap::new();
        let mut profiles: BTreeMap<String,BTreeMap<&str,&str>> = BTreeMap::new();
        let mut changed = BTreeSet::new();
        let mut next_stamps=self.profile_stamps.clone();
        for (k, v) in &next.values {
            if let Some(id) = owner(k) {
                if self.snapshot.values.get(k)!=Some(v) { changed.insert(id.to_owned()); }
                profiles
                    .entry(id.into())
                    .or_default()
                    .insert(k.as_str(), v.as_str());
            } else {
                globals.insert(k.as_str(), v.as_str());
            }
        }
        for key in self.snapshot.values.keys().filter(|key|!next.values.contains_key(*key)) {
            if let Some(id)=owner(key) { changed.insert(id.to_owned()); }
        }
        let accounts: Vec<String> =
            serde_json::from_str(next.values.get("accounts").unwrap()).map_err(err)?;
        for id in accounts.into_iter().chain(std::iter::once("main".into())) {
            profiles.entry(id).or_default();
        }
        for (id, values) in &profiles {
            let p = self.root.join("profiles").join(format!("{id}.json"));
            // A warm unchanged profile needs only a metadata check. If a file
            // was removed or edited externally, fall back to the original
            // byte comparison and atomic repair rather than trusting a cache.
            if !changed.contains(id) && self.profile_stamps.get(id).is_some_and(|saved|profile_stamp(&p).as_ref()==Some(saved)) { continue; }
            #[derive(Serialize)]
            struct ProfileView<'a> { schema:u32, id:&'a str, values:&'a BTreeMap<&'a str,&'a str> }
            #[cfg(test)]
            PROFILE_WORK.with(|work| { let (serialized,read)=work.get(); work.set((serialized+1,read)); });
            let bytes = serde_json::to_vec_pretty(&ProfileView {
                schema: 1,
                id,
                values,
            })
            .map_err(err)?;
            #[cfg(test)]
            PROFILE_WORK.with(|work| { let (serialized,read)=work.get(); work.set((serialized,read+1)); });
            if fs::read(&p).ok().as_deref() != Some(bytes.as_slice()) {
                atomic(&p, &bytes)?;
            }
            if let Some(stamp)=profile_stamp(&p) {next_stamps.insert(id.clone(),stamp);} else {next_stamps.remove(id);}
        }
        next_stamps.retain(|id,_|profiles.contains_key(id));
        #[derive(Serialize)]
        struct ManifestView<'a> { schema:u32, revision:u64, profiles:Vec<String>, values:BTreeMap<&'a str,&'a str> }
        json(
            &self.root.join("workspace.json"),
            &ManifestView {
                schema: 1,
                revision: next.revision,
                profiles: profiles.keys().cloned().collect(),
                values: globals,
            },
        )?;
        // Orphan profile files are retained for recovery; the manifest controls what is loaded.
        fs::remove_file(self.root.join("pending-transaction.json")).map_err(err)?;
        let _ = fs::remove_file(self.root.join("pending-transaction.bak"));
        self.profile_stamps=next_stamps;
        self.snapshot = next;
        Ok(())
    }
    pub fn apply(&mut self, patch: BTreeMap<String, Option<String>>) -> Result<u64> {
        self.require_finished_restore()?;
        let mut next = self.snapshot.clone();
        for (k, v) in patch {
            if let Some(v) = v {
                next.values.insert(k, v);
            } else {
                next.values.remove(&k);
            }
        }
        next.revision += 1;
        let revision=next.revision;
        self.commit(next)?;
        if now().saturating_sub(self.last_backup) > 3_600_000 {
            if let Err(error) = self.backup() {
                // The profile transaction already succeeded. Backup trouble
                // must not report that durable user changes failed to save.
                self.backup_warning = Some(format!(
                    "Your changes were saved, but the automatic backup could not be created: {error}"
                ));
                self.last_backup = now();
            }
        }
        Ok(revision)
    }
    pub fn export(&self) -> Result<Backup> {
        self.require_finished_restore()?;
        use base64::Engine;
        let mut artwork = BTreeMap::new();
        for f in fs::read_dir(self.root.join("artwork")).map_err(err)? {
            let f = f.map_err(err)?;
            if f.file_type().map_err(err)?.is_file()
                && f.path().extension().is_some_and(|e| e == "json")
            {
                artwork.insert(
                    f.file_name().to_string_lossy().into_owned(),
                    base64::engine::general_purpose::STANDARD
                        .encode(fs::read(f.path()).map_err(err)?),
                );
            }
        }
        Ok(Backup {
            format: "holodori-desktop-backup-v1".into(),
            workspace: self.snapshot.clone(),
            artwork,
        })
    }
    pub fn backup(&mut self) -> Result<String> {
        let name = format!("backup-{}-{}.json", now(), self.snapshot.revision);
        let target = self.root.join("backups").join(&name);
        json(&target, &self.export()?)?;
        let mut files = fs::read_dir(self.root.join("backups"))
            .map_err(err)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .collect::<Vec<_>>();
        files.sort_by_key(|e| e.file_name());
        let remove = files.len().saturating_sub(20);
        for f in files.into_iter().take(remove) {
            fs::remove_file(f.path()).map_err(err)?;
        }
        self.last_backup = now();
        self.backup_warning = None;
        Ok(name)
    }
    pub fn restore(&mut self, backup: &Backup) -> Result<()> {
        if self.restore_pending() {
            if fs::metadata(self.root.join(RESTORE_JOURNAL))
                .map_err(err)?
                .len()
                > MAX_RESTORE_BYTES as u64
            {
                return Err("Desktop restore is pending. Its journal exceeds the supported size; restart Hololive Dreams Planner for recovery. Your files have been preserved.".into());
            }
            let target: Backup = read(&self.root.join(RESTORE_JOURNAL), &mut self.recovery)?;
            let artwork = restore_artwork(&target)?;
            if target.format != backup.format
                || target.workspace.schema != backup.workspace.schema
                || target.workspace.values != backup.workspace.values
                || target.artwork != backup.artwork
            {
                return Err("Desktop restore is pending. Retry the same desktop backup or restart Hololive Dreams Planner to complete recovery.".into());
            }
            // Retry the original durable intent, including its fixed revision.
            // A second recovery backup or a different replacement is unsafe.
            return self.finish_restore(&target, &artwork, false).map_err(|error| {
                format!("Desktop restore is pending: {error}. Retry or restart Hololive Dreams Planner to complete recovery. Your recovery backup has been preserved.")
            });
        }
        let art = restore_artwork(backup)?;
        let revision = self
            .snapshot
            .revision
            .checked_add(1)
            .ok_or("Workspace revision exceeds the supported range.")?;
        let mut next = backup.workspace.clone();
        next.revision = revision;
        let transaction = Backup {
            format: backup.format.clone(),
            workspace: next,
            artwork: backup.artwork.clone(),
        };
        check_restore_size(&transaction)?;
        self.backup()?;
        // Live artwork is unchanged until every target file is durable.
        stage_restore_artwork(&self.root, &art)?;
        json(&self.root.join(RESTORE_JOURNAL), &transaction)?;
        self.finish_restore(&transaction, &art, true).map_err(|error| {
            format!("Desktop restore is pending: {error}. Retry or restart Hololive Dreams Planner to complete recovery. Your recovery backup has been preserved.")
        })
    }
    pub fn restore_pending(&self) -> bool {
        self.root.join(RESTORE_JOURNAL).exists()
    }
    fn require_finished_restore(&self) -> Result<()> {
        if self.reset_pending() { return Err("Data deletion is pending. Finish deleting or restart the app before making changes.".into()); }
        if self.restore_pending() {
            return Err("Desktop restore is pending. Retry the same desktop backup or restart Hololive Dreams Planner to complete recovery before making changes.".into());
        }
        Ok(())
    }
    pub fn reset_pending(&self) -> bool {crate::reset_data::pending(&self.root)}
    pub fn delete_all_data(&mut self) -> Result<()> {
        if !self.reset_pending() {self.require_finished_restore()?;}
        crate::reset_data::begin(&self.root)?;
        let fresh=Self::open(self.root.clone())?;
        *self=fresh;
        Ok(())
    }
    fn finish_restore(
        &mut self,
        target: &Backup,
        artwork: &[(String, Vec<u8>)],
        staged: bool,
    ) -> Result<()> {
        // Rebuild staging from the durable journal on every replay. Neither a
        // partially written stage nor an interrupted directory swap is trusted.
        if !staged {
            stage_restore_artwork(&self.root, artwork)?;
        }
        remove_restore_directory(&self.root, RESTORE_PREVIOUS_ART)?;
        let live = self.root.join("artwork");
        if live.exists() {
            let metadata = fs::symlink_metadata(&live).map_err(err)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Artwork storage is not a regular directory.".into());
            }
            fs::rename(&live, self.root.join(RESTORE_PREVIOUS_ART)).map_err(err)?;
        }
        fs::rename(self.root.join(RESTORE_NEXT_ART), &live).map_err(err)?;
        self.commit(target.workspace.clone())?;
        remove_restore_directory(&self.root, RESTORE_PREVIOUS_ART)?;
        let _ = fs::remove_file(self.root.join("pending-restore.bak"));
        fs::remove_file(self.root.join(RESTORE_JOURNAL)).map_err(err)?;
        Ok(())
    }
}
pub fn safe_art_name(name: &str) -> bool {
    name.len() < 240
        && !name.is_empty()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        && !name.starts_with('.')
        && !name.contains("..")
}
pub fn validate(s: &Snapshot) -> Result<()> {
    if s.values.get("game_id").map(String::as_str) != Some("hololive-dreams") {
        return Err("This data belongs to another app. Your files have been preserved.".into());
    }
    if s.schema != 1 || s.values.len() > 20_000 {
        return Err("Unsupported workspace format.".into());
    }
    if s.values
        .iter()
        .any(|(k, v)| k.len() > 256 || v.len() > 16_000_000)
    {
        return Err("Save data exceeds supported limits.".into());
    }
    let ids: Vec<String> =
        serde_json::from_str(s.values.get("accounts").ok_or("Missing profiles list")?)
            .map_err(err)?;
    if ids.len() > 1000
        || ids.iter().any(|id| !valid_id(id))
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
    {
        return Err("Invalid profiles list.".into());
    }
    if s.values.get("account").map(String::as_str) != Some("main")
        && !ids.iter().any(|id| Some(id) == s.values.get("account"))
    {
        return Err("The active profile is missing.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Manual isolated performance fixture; run through scripts/benchmark-native.mjs"]
    fn benchmark_native_commits() {
        use std::time::Instant;
        let fixture=std::env::var("HOLODORI_BENCHMARK_FIXTURE").expect("benchmark fixture path");
        let fixtures:BTreeMap<String,Values>=serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        let mut results=Vec::new();
        for (count,values) in fixtures {
            let root=temp();let mut store=Store::open(root.clone()).unwrap();
            store.apply(values.into_iter().map(|(key,value)|(key,Some(value))).collect()).unwrap();
            for global in [false,true] {
                for iteration in 0..4 { let key=if global{"locale"}else{"main-notes"};store.apply(patch(key,&format!("warm-{iteration}"))).unwrap(); }
                PROFILE_WORK.with(|work|work.set((0,0)));
                let mut times=Vec::new();
                for iteration in 0..16 {
                    let key=if global{"locale"}else{"main-notes"};
                    let value=if global{if iteration%2==0{"en".into()}else{"ja".into()}}else{format!("{{\"benchmark\":{iteration}}}")};
                    let start=Instant::now();store.apply(patch(key,&value)).unwrap();times.push(start.elapsed().as_secs_f64()*1000.0);
                }
                times.sort_by(f64::total_cmp);let (serialized,read)=PROFILE_WORK.with(|work|work.get());
                results.push(serde_json::json!({"profiles":count.parse::<u32>().unwrap(),"kind":if global{"global-setting"}else{"one-profile-edit"},"iterations":times.len(),"medianMs":times[times.len()/2],"p95Ms":times[times.len()*95/100],"profileSerializations":serialized,"profileContentReads":read}));
            }
            fs::remove_dir_all(root).unwrap();
        }
        println!("PERF_NATIVE_JSON={}",serde_json::to_string(&results).unwrap());
    }
    fn temp() -> PathBuf {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "holodori-store-test-{}-{}-{}",
            std::process::id(),
            now(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::thread::sleep(std::time::Duration::from_millis(2));
        p
    }
    fn patch(k: &str, v: &str) -> BTreeMap<String, Option<String>> {
        BTreeMap::from([(k.into(), Some(v.into()))])
    }
    #[test]
    fn profiles_and_preferences_survive_restart() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(BTreeMap::from([
            ("accounts".into(), Some("[\"account-2\"]".into())),
            ("account".into(), Some("account-2".into())),
            (
                "account-2-notes".into(),
                Some("{\"test\":\"second\"}".into()),
            ),
            ("main-notes".into(), Some("{\"test\":\"first\"}".into())),
            ("locale".into(), Some("ja".into())),
        ]))
        .unwrap();
        assert!(p.join("profiles/account-2.json").exists());
        let other = Store::open(p.clone()).unwrap();
        assert_eq!(other.snapshot.values, s.snapshot.values);
        let profile: String = fs::read_to_string(p.join("profiles/main.json")).unwrap();
        assert!(!profile.contains("second"));
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn replay_interrupted_commit() {
        let p = temp();
        let s = Store::open(p.clone()).unwrap();
        let mut next = s.snapshot.clone();
        next.values
            .insert("main-notes".into(), "{\"replayed\":true}".into());
        next.revision += 1;
        json(&p.join("pending-transaction.json"), &next).unwrap();
        let s = Store::open(p.clone()).unwrap();
        assert_eq!(s.snapshot.values, next.values);
        assert!(!p.join("pending-transaction.json").exists());
        assert!(!s.recovery.is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn corrupted_profile_recovers_previous_good_copy() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(patch("main-notes", "{\"save\":1}")).unwrap();
        s.apply(patch("main-notes", "{\"save\":2}")).unwrap();
        fs::write(p.join("profiles/main.json"), b"interrupted").unwrap();
        let s = Store::open(p.clone()).unwrap();
        assert_eq!(s.snapshot.values["main-notes"], "{\"save\":1}");
        assert!(!s.recovery.is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn invalid_commit_does_not_replace_good_files() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        assert!(s.apply(patch("accounts", "[\"../../escape\"]")).is_err());
        assert_eq!(
            Store::open(p.clone()).unwrap().snapshot.values["accounts"],
            "[]"
        );
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn backup_restore_contains_art_and_all_profiles() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(patch("main-notes", "{\"backup\":true}")).unwrap();
        fs::write(p.join("artwork/holodori-test.json"), b"custom image").unwrap();
        let b = s.export().unwrap();
        s.apply(patch("main-notes", "{}")).unwrap();
        fs::remove_file(p.join("artwork/holodori-test.json")).unwrap();
        s.restore(&b).unwrap();
        assert_eq!(s.snapshot.values["main-notes"], "{\"backup\":true}");
        assert_eq!(
            fs::read(p.join("artwork/holodori-test.json")).unwrap(),
            b"custom image"
        );
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn deleted_profiles_stay_out_of_manifest_and_can_be_recovered() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(BTreeMap::from([
            ("accounts".into(), Some("[\"account-2\"]".into())),
            ("account-2-goals".into(), Some("[]".into())),
        ]))
        .unwrap();
        s.apply(BTreeMap::from([
            ("accounts".into(), Some("[]".into())),
            ("account-2-goals".into(), None),
        ]))
        .unwrap();
        let s = Store::open(p.clone()).unwrap();
        assert!(!s.snapshot.values.contains_key("account-2-goals"));
        assert!(p.join("profiles/account-2.json").exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn invalid_restore_never_changes_workspace() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        let mut b = s.export().unwrap();
        b.artwork.insert("../../escape".into(), "YQ==".into());
        assert!(s.restore(&b).is_err());
        assert_eq!(s.snapshot.revision, 0);
        fs::remove_dir_all(p).unwrap();
    }
    fn art_file_names(p: &Path) -> BTreeSet<String> {
        fs::read_dir(p.join("artwork"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }
    fn encoded(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
    #[test]
    fn restore_replaces_the_complete_artwork_set_and_keeps_a_recovery_backup() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(patch("main-notes", "target")).unwrap();
        fs::write(p.join("artwork/main-kept.json"), b"target image").unwrap();
        let target = s.export().unwrap();
        s.apply(patch("main-notes", "original")).unwrap();
        fs::write(p.join("artwork/main-kept.json"), b"original image").unwrap();
        fs::write(p.join("artwork/main-obsolete.json"), b"obsolete").unwrap();
        fs::write(p.join("artwork/main-kept.bak"), b"stale backup").unwrap();
        fs::write(p.join("artwork/main-kept.tmp"), b"stale temporary").unwrap();
        let revision = s.snapshot.revision;
        s.restore(&target).unwrap();
        assert_eq!(s.snapshot.revision, revision + 1);
        assert_eq!(s.snapshot.values["main-notes"], "target");
        assert_eq!(
            art_file_names(&p),
            BTreeSet::from(["main-kept.json".into()])
        );
        assert_eq!(
            fs::read(p.join("artwork/main-kept.json")).unwrap(),
            b"target image"
        );
        let before = fs::read_dir(p.join("backups"))
            .unwrap()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                serde_json::from_slice::<Backup>(&fs::read(path).ok()?).ok()
            })
            .find(|backup| {
                backup
                    .workspace
                    .values
                    .get("main-notes")
                    .map(String::as_str)
                    == Some("original")
            })
            .expect("pre-restore workspace backup");
        assert_eq!(before.artwork["main-kept.json"], encoded(b"original image"));
        assert_eq!(before.artwork["main-obsolete.json"], encoded(b"obsolete"));
        assert!(!p.join(RESTORE_JOURNAL).exists());
        assert!(!p.join(RESTORE_PREVIOUS_ART).exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn empty_artwork_backup_clears_current_artwork() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        let target = s.export().unwrap();
        fs::write(p.join("artwork/main-later.json"), b"not in target").unwrap();
        s.restore(&target).unwrap();
        assert!(art_file_names(&p).is_empty());
        assert!(Store::open(p.clone())
            .unwrap()
            .export()
            .unwrap()
            .artwork
            .is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn complete_restore_validation_precedes_backups_staging_and_live_changes() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        fs::write(p.join("artwork/main-good.json"), b"keep").unwrap();
        let workspace = fs::read(p.join("workspace.json")).unwrap();
        for invalid in [
            "base64",
            "case",
            "workspace",
            "format",
            "oversize",
            "extension",
        ] {
            let mut target = s.export().unwrap();
            target
                .artwork
                .insert("main-a-valid.json".into(), encoded(b"must not be written"));
            match invalid {
                "base64" => {
                    target
                        .artwork
                        .insert("main-z-invalid.json".into(), "?".into());
                }
                "case" => {
                    target
                        .artwork
                        .insert("MAIN-GOOD.json".into(), encoded(b"collision"));
                }
                "workspace" => {
                    target
                        .workspace
                        .values
                        .insert("accounts".into(), "[\"../../escape\"]".into());
                }
                "format" => target.format = "other-app".into(),
                "oversize" => {
                    target
                        .artwork
                        .insert("main-large.json".into(), encoded(&vec![0; 3_000_001]));
                }
                "extension" => {
                    target
                        .artwork
                        .insert("main-image.tmp".into(), encoded(b"invalid"));
                }
                _ => unreachable!(),
            }
            let error = s.restore(&target).expect_err(invalid);
            if invalid == "format" {
                assert!(error.contains("Holodori"));
            }
            assert_eq!(s.snapshot.revision, 0);
            assert_eq!(fs::read(p.join("workspace.json")).unwrap(), workspace);
            assert_eq!(fs::read(p.join("artwork/main-good.json")).unwrap(), b"keep");
            assert_eq!(
                art_file_names(&p),
                BTreeSet::from(["main-good.json".into()])
            );
            assert_eq!(fs::read_dir(p.join("backups")).unwrap().count(), 0);
            assert!(!p.join(RESTORE_NEXT_ART).exists());
            assert!(!p.join(RESTORE_JOURNAL).exists());
        }
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn staging_failure_preserves_live_data_and_does_not_lock_the_workspace() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        fs::write(p.join("artwork/main-original.json"), b"original").unwrap();
        let mut target = s.export().unwrap();
        target.artwork.clear();
        target
            .artwork
            .insert("main-new.json".into(), encoded(b"new"));
        fs::write(p.join(RESTORE_NEXT_ART), b"blocked staging directory").unwrap();
        assert!(s.restore(&target).is_err());
        assert_eq!(s.snapshot.revision, 0);
        assert_eq!(
            art_file_names(&p),
            BTreeSet::from(["main-original.json".into()])
        );
        assert!(!p.join(RESTORE_JOURNAL).exists());
        assert!(s.export().is_ok());
        s.apply(patch("locale", "en")).unwrap();
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn interrupted_restore_blocks_writes_then_replays_artwork_and_workspace_once() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(patch("main-notes", "before")).unwrap();
        fs::write(p.join("artwork/main-old.json"), b"old").unwrap();
        let mut target = s.export().unwrap();
        target
            .workspace
            .values
            .insert("main-notes".into(), "after".into());
        target.artwork.clear();
        target
            .artwork
            .insert("main-new.json".into(), encoded(b"new"));
        let revision = s.snapshot.revision + 1;
        // Fail the workspace manifest write after the complete artwork swap.
        fs::create_dir(p.join("workspace.tmp")).unwrap();
        let error = s.restore(&target).unwrap_err();
        assert!(error.contains("restart Hololive Dreams Planner"));
        assert!(p.join(RESTORE_JOURNAL).exists());
        assert!(p.join("pending-transaction.json").exists());
        assert_eq!(s.snapshot.values["main-notes"], "before");
        assert!(s
            .apply(patch("locale", "ja"))
            .unwrap_err()
            .contains("restore is pending"));
        assert!(s.export().is_err());
        assert!(s.backup().is_err());
        assert!(s.restore(&target).is_err());
        fs::remove_dir(p.join("workspace.tmp")).unwrap();
        drop(s);
        let s = Store::open(p.clone()).unwrap();
        assert_eq!(s.snapshot.revision, revision);
        assert_eq!(s.snapshot.values["main-notes"], "after");
        assert_eq!(art_file_names(&p), BTreeSet::from(["main-new.json".into()]));
        assert_eq!(fs::read(p.join("artwork/main-new.json")).unwrap(), b"new");
        assert!(s
            .recovery
            .iter()
            .any(|message| message.contains("interrupted desktop restore")));
        assert!(!p.join(RESTORE_JOURNAL).exists());
        assert!(!p.join("pending-transaction.json").exists());
        assert!(!p.join(RESTORE_PREVIOUS_ART).exists());
        assert_eq!(Store::open(p.clone()).unwrap().snapshot.revision, revision);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn restore_recovery_precedes_stale_autosave_and_handles_directory_swap_gap() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        fs::write(p.join("artwork/main-old.json"), b"old").unwrap();
        s.backup().unwrap();
        let mut target = s.export().unwrap();
        target.workspace.revision = 42;
        target
            .workspace
            .values
            .insert("main-notes".into(), "restore target".into());
        target.artwork.clear();
        target
            .artwork
            .insert("main-target.json".into(), encoded(b"target"));
        json(&p.join(RESTORE_JOURNAL), &target).unwrap();
        let mut stale = s.snapshot.clone();
        stale.revision = 99;
        stale
            .values
            .insert("main-notes".into(), "stale autosave".into());
        json(&p.join("pending-transaction.json"), &stale).unwrap();
        fs::rename(p.join("artwork"), p.join(RESTORE_PREVIOUS_ART)).unwrap();
        let s = Store::open(p.clone()).unwrap();
        assert_eq!(s.snapshot.revision, 42);
        assert_eq!(s.snapshot.values["main-notes"], "restore target");
        assert_eq!(s.export().unwrap().artwork, target.artwork);
        assert!(!p.join(RESTORE_NEXT_ART).exists());
        assert!(!p.join(RESTORE_PREVIOUS_ART).exists());
        assert!(!p.join(RESTORE_JOURNAL).exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn pending_restore_retries_only_its_original_candidate_and_fixed_revision() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(patch("main-notes", "before")).unwrap();
        let mut target = s.export().unwrap();
        target
            .workspace
            .values
            .insert("main-notes".into(), "after".into());
        target
            .artwork
            .insert("main-restored.json".into(), encoded(b"restored"));
        let revision = s.snapshot.revision + 1;
        fs::create_dir(p.join("workspace.tmp")).unwrap();
        assert!(s
            .restore(&target)
            .unwrap_err()
            .starts_with("Desktop restore is pending"));
        assert!(s.restore_pending());
        let backups = fs::read_dir(p.join("backups")).unwrap().count();
        let mut different = Backup {
            format: target.format.clone(),
            workspace: target.workspace.clone(),
            artwork: target.artwork.clone(),
        };
        different
            .workspace
            .values
            .insert("main-notes".into(), "different".into());
        assert!(s
            .restore(&different)
            .unwrap_err()
            .contains("same desktop backup"));
        assert_eq!(s.snapshot.values["main-notes"], "before");
        fs::remove_dir(p.join("workspace.tmp")).unwrap();
        s.restore(&target).unwrap();
        assert!(!s.restore_pending());
        assert_eq!(s.snapshot.revision, revision);
        assert_eq!(s.snapshot.values["main-notes"], "after");
        assert_eq!(s.export().unwrap().artwork, target.artwork);
        assert_eq!(fs::read_dir(p.join("backups")).unwrap().count(), backups);
        assert_eq!(Store::open(p.clone()).unwrap().snapshot.revision, revision);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn automatic_backup_failure_does_not_fail_or_repeat_a_successful_autosave() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        assert!(s.backup_warning.is_none());
        fs::rename(p.join("backups"), p.join("backups-held-for-test")).unwrap();
        fs::write(p.join("backups"), b"block backup writes").unwrap();
        let revision = s
            .apply(patch("main-notes", "durable new profile data"))
            .unwrap();
        assert_eq!(revision, 1);
        assert_eq!(s.snapshot.revision, revision);
        assert!(s
            .backup_warning
            .as_deref()
            .unwrap()
            .contains("changes were saved"));
        let retry_anchor = s.last_backup;
        assert!(retry_anchor > 0);
        // Repair the output location. Ordinary saves remain throttled instead
        // of retrying a failed automatic backup on every keystroke.
        fs::remove_file(p.join("backups")).unwrap();
        fs::rename(p.join("backups-held-for-test"), p.join("backups")).unwrap();
        s.apply(patch("locale", "ja")).unwrap();
        assert_eq!(s.last_backup, retry_anchor);
        assert!(s.backup_warning.is_some());
        assert_eq!(fs::read_dir(p.join("backups")).unwrap().count(), 0);
        let reopened = Store::open(p.clone()).unwrap();
        assert_eq!(
            reopened.snapshot.values["main-notes"],
            "durable new profile data"
        );
        assert_eq!(reopened.snapshot.values["locale"], "ja");
        assert_eq!(reopened.snapshot.revision, 2);
        s.backup().unwrap();
        assert!(s.backup_warning.is_none());
        assert_eq!(fs::read_dir(p.join("backups")).unwrap().count(), 1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn untouched_profile_is_not_rewritten() {
        let p = temp();
        let mut s = Store::open(p.clone()).unwrap();
        s.apply(patch("main-notes", "{}")).unwrap();
        let path = p.join("profiles/main.json");
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        s.apply(patch("locale", "en")).unwrap();
        assert_eq!(before, fs::metadata(path).unwrap().modified().unwrap());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn warm_commits_skip_untouched_profile_work_and_preserve_file_format() {
        let root=temp();let mut store=Store::open(root.clone()).unwrap();
        store.apply(BTreeMap::from([
            ("accounts".into(),Some("[\"account-2\"]".into())),
            ("main-notes".into(),Some("{\"note\":\"日本語 ♥\"}".into())),
            ("account-2-inventory".into(),Some("[]".into())),
        ])).unwrap();
        PROFILE_WORK.with(|work|work.set((0,0)));
        store.apply(patch("locale","ja")).unwrap();
        assert_eq!(PROFILE_WORK.with(|work|work.get()),(0,0));
        store.apply(patch("main-notes","{\"note\":\"Changed\"}")).unwrap();
        assert_eq!(PROFILE_WORK.with(|work|work.get()),(1,1));
        for id in ["main","account-2"] {
            let values=store.snapshot.values.iter().filter(|(key,_)|owner(key)==Some(id)).map(|(key,value)|(key.clone(),value.clone())).collect();
            let expected=serde_json::to_vec_pretty(&Profile{schema:1,id:id.into(),values}).unwrap();
            assert_eq!(fs::read(root.join("profiles").join(format!("{id}.json"))).unwrap(),expected);
        }
        let persisted=Store::open(root.clone()).unwrap();assert_eq!(persisted.snapshot.values,store.snapshot.values);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unchanged_profile_cache_detects_external_changes_and_missing_files() {
        let root=temp();let mut store=Store::open(root.clone()).unwrap();
        store.apply(patch("main-notes","{\"retained\":true}")).unwrap();
        let profile=root.join("profiles/main.json");let expected=fs::read(&profile).unwrap();
        fs::write(&profile,b"external edit").unwrap();
        store.apply(patch("locale","ja")).unwrap();assert_eq!(fs::read(&profile).unwrap(),expected);
        fs::remove_file(&profile).unwrap();
        store.apply(patch("locale","en")).unwrap();assert_eq!(fs::read(&profile).unwrap(),expected);
        assert_eq!(Store::open(root.clone()).unwrap().snapshot.values,store.snapshot.values);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_commit_does_not_promote_profile_cache_state() {
        let root=temp();let mut store=Store::open(root.clone()).unwrap();
        store.apply(patch("main-notes","{\"saved\":true}")).unwrap();
        let path=root.join("profiles/main.json");let expected=fs::read(&path).unwrap();
        fs::create_dir(root.join("workspace.tmp")).unwrap();
        assert!(store.apply(patch("main-notes","{\"failed\":true}")).is_err());
        fs::remove_dir(root.join("workspace.tmp")).unwrap();
        // A later independent transaction must still repair any profile bytes
        // written by the failed transaction, as the original commit did.
        store.apply(patch("locale","ja")).unwrap();
        assert_eq!(fs::read(path).unwrap(),expected);
        assert_eq!(Store::open(root.clone()).unwrap().snapshot.values,store.snapshot.values);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn profile_cache_detects_edits_even_when_modified_time_is_restored() {
        let root=temp();let mut store=Store::open(root.clone()).unwrap();
        store.apply(patch("main-notes","{\"saved\":true}")).unwrap();
        let path=root.join("profiles/main.json");let expected=fs::read(&path).unwrap();
        let modified=fs::metadata(&path).unwrap().modified().unwrap();
        let mut changed=expected.clone();let index=changed.iter().position(|byte|*byte==b'm').unwrap();changed[index]=b'n';
        std::thread::sleep(std::time::Duration::from_millis(2));fs::write(&path,&changed).unwrap();
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(),modified);
        store.apply(patch("locale","ja")).unwrap();assert_eq!(fs::read(&path).unwrap(),expected);
        fs::remove_dir_all(root).unwrap();
    }
}
