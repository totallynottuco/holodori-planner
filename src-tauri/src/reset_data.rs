//! Durable, user-confirmed deletion of app-owned user data only.
use crate::store::{atomic, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

const JOURNAL: &str = "pending-reset.json";
const TRASH: &str = "reset-old-data";
const DIRECTORIES: &[&str] = &["profiles", "backups", "artwork", "restore-next-artwork", "restore-previous-artwork", "leaderboards"];
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent { schema: u32, operation: String }
fn error(e: impl std::fmt::Display) -> String { e.to_string() }
fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) { Ok(m) => Ok(Some(m)), Err(e) if e.kind()==std::io::ErrorKind::NotFound => Ok(None), Err(e)=>Err(error(e)) }
}
fn linked(m: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if m.file_attributes() & 0x400 != 0 { return true; } }
    m.file_type().is_symlink()
}
fn check_tree(root: &Path, path: &Path, budget: &mut usize) -> Result<()> {
    let Some(m)=metadata(path)? else {return Ok(())};
    if linked(&m) { return Err("A saved-data path is a link. Remove the link before deleting data.".into()); }
    let target=path.canonicalize().map_err(error)?;
    if target==root || !target.starts_with(root) { return Err("Saved-data deletion target is outside the data folder.".into()); }
    *budget+=1;
    if *budget>100_000 {return Err("The data folder contains too many entries to reset safely.".into());}
    if m.is_dir() { for entry in fs::read_dir(path).map_err(error)? {check_tree(root,&entry.map_err(error)?.path(),budget)?;} }
    else if !m.is_file() {return Err("Saved-data storage contains an unsupported file type.".into());}
    Ok(())
}
fn owned_file(name: &str) -> bool {
    ["workspace", "pending-transaction", "pending-restore"].iter().any(|stem| {
        name.strip_prefix(&format!("{stem}.")).is_some_and(|extension| matches!(extension,"json"|"bak"|"tmp") || extension.strip_prefix("corrupt-").is_some_and(|n|!n.is_empty()&&n.bytes().all(|b|b.is_ascii_digit())))
    })
}
fn targets(root: &Path) -> Result<Vec<PathBuf>> {
    let mut result=DIRECTORIES.iter().map(|name|root.join(name)).collect::<Vec<_>>();
    for entry in fs::read_dir(root).map_err(error)? {let entry=entry.map_err(error)?;if owned_file(&entry.file_name().to_string_lossy()) {result.push(entry.path());}}
    Ok(result)
}
fn check(root: &Path, paths: &[PathBuf]) -> Result<()> {
    let canonical=root.canonicalize().map_err(error)?;
    let mut count=0;
    for path in paths {check_tree(&canonical,path,&mut count)?;}
    for path in paths {if path.file_name().is_some_and(|name|owned_file(&name.to_string_lossy()))&&metadata(path)?.is_some_and(|m|!m.is_file()) {return Err("A saved-state file is not a regular file.".into());}}
    for name in DIRECTORIES {if metadata(&root.join(name))?.is_some_and(|m|!m.is_dir()) {return Err("A saved-data folder is not a regular directory.".into());}}
    Ok(())
}
pub fn pending(root: &Path) -> bool {root.join(JOURNAL).exists()}
pub fn begin(root: &Path) -> Result<()> {
    if pending(root) {return Ok(());}
    if metadata(&root.join(TRASH))?.is_some() {return Err("An unexpected reset folder already exists. Your data has been preserved.".into());}
    let paths=targets(root)?;check(root,&paths)?;
    atomic(&root.join(JOURNAL),br#"{"schema":1,"operation":"delete-all-user-data"}"#)
}
/// Called before reading old manifests or replaying autosave/restore journals.
/// The marker survives until a fresh empty store has committed successfully.
pub fn recover(root: &Path) -> Result<bool> {
    if !pending(root) {return Ok(false);}
    let journal=root.join(JOURNAL);
    let m=metadata(&journal)?.ok_or("Reset intent is missing.")?;
    if linked(&m)||!m.is_file()||m.len()>256 {return Err("Invalid reset intent. Existing files have been preserved.".into());}
    let intent:Intent=serde_json::from_slice(&fs::read(&journal).map_err(error)?).map_err(error)?;
    if intent.schema!=1||intent.operation!="delete-all-user-data" {return Err("Unsupported reset intent. Existing files have been preserved.".into());}
    let paths=targets(root)?;
    let trash=root.join(TRASH);
    let mut all=paths.clone();all.push(trash.clone());check(root,&all)?;
    fs::create_dir_all(&trash).map_err(error)?;
    for path in paths {
        if metadata(&path)?.is_none() {continue;}
        let destination=trash.join(path.file_name().ok_or("Invalid reset target.")?);
        if metadata(&destination)?.is_some() {return Err("Reset staging conflicts with live data. Restart after checking the data folder.".into());}
        fs::rename(&path,&destination).map_err(error)?;
    }
    // Recheck the complete resolved tree immediately before recursive deletion.
    check(root,std::slice::from_ref(&trash))?;
    fs::remove_dir_all(&trash).map_err(error)?;
    Ok(true)
}
pub fn finish(root: &Path) -> Result<()> {
    for name in ["pending-reset.bak","pending-reset.tmp"] {if metadata(&root.join(name))?.is_some() {fs::remove_file(root.join(name)).map_err(error)?;}}
    fs::remove_file(root.join(JOURNAL)).map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    fn fixture()->PathBuf {static SEQUENCE:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);let root=std::env::temp_dir().join(format!("holodori-reset-{}-{}-{}",std::process::id(),crate::store::now(),SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::SeqCst)));fs::create_dir_all(&root).unwrap();root}
    #[test]
    fn resets_every_profile_artwork_backup_and_settings_without_touching_assets_or_foreign_files() {
        let root=fixture();let mut store=Store::open(root.clone()).unwrap();
        store.apply(std::collections::BTreeMap::from([("accounts".into(),Some("[\"account-2\"]".into())),("main-notes".into(),Some("private".into())),("account-2-inventory".into(),Some("secret stock".into())),("settings".into(),Some("{\"custom\":true}".into()))])).unwrap();
        fs::write(root.join("artwork/card.json"),"private picture").unwrap();store.backup().unwrap();
        fs::create_dir(root.join("catalog-update")).unwrap();fs::write(root.join("catalog-update/public.json"),"public catalog").unwrap();fs::write(root.join("notes.txt"),"keep").unwrap();
        store.delete_all_data().unwrap();assert_eq!(store.snapshot.values.len(),3);assert_eq!(store.snapshot.values["accounts"],"[]");assert_eq!(store.snapshot.values["account"],"main");
        assert_eq!(fs::read_dir(root.join("profiles")).unwrap().count(),1);assert_eq!(fs::read_dir(root.join("artwork")).unwrap().count(),0);assert_eq!(fs::read_dir(root.join("backups")).unwrap().count(),0);
        assert_eq!(fs::read_to_string(root.join("notes.txt")).unwrap(),"keep");assert_eq!(fs::read_to_string(root.join("catalog-update/public.json")).unwrap(),"public catalog");
        assert!(!pending(&root));assert!(!root.join(TRASH).exists());assert!(!root.join("workspace.bak").exists());
        let restarted=Store::open(root).unwrap();assert_eq!(restarted.snapshot.values.len(),3);
    }
    #[test]
    fn interrupted_reset_resumes_before_old_transaction_can_restore_private_data() {
        let root=fixture();let mut store=Store::open(root.clone()).unwrap();store.apply(std::collections::BTreeMap::from([("main-notes".into(),Some("private".into()))])).unwrap();
        fs::write(root.join("pending-transaction.json"),serde_json::to_vec(&store.snapshot).unwrap()).unwrap();begin(&root).unwrap();
        fs::create_dir(root.join(TRASH)).unwrap();fs::rename(root.join("profiles"),root.join(TRASH).join("profiles")).unwrap();
        assert!(store.apply(std::collections::BTreeMap::new()).is_err());assert!(store.backup().is_err());
        let restarted=Store::open(root.clone()).unwrap();assert_eq!(restarted.snapshot.values.len(),3);assert!(!root.join("pending-transaction.json").exists());assert!(!pending(&root));
    }
    #[test]
    fn unexpected_staging_or_unsafe_paths_fail_before_any_deletion() {
        let root=fixture();let mut store=Store::open(root.clone()).unwrap();let before=fs::read(root.join("workspace.json")).unwrap();
        fs::create_dir(root.join(TRASH)).unwrap();fs::write(root.join(TRASH).join("personal.txt"),"keep").unwrap();assert!(store.delete_all_data().is_err());assert!(!pending(&root));assert_eq!(before,fs::read(root.join("workspace.json")).unwrap());
        #[cfg(windows)] {let other=fixture();if std::os::windows::fs::symlink_dir(&other,root.join("profiles/link")).is_ok(){fs::remove_file(root.join(TRASH).join("personal.txt")).unwrap();fs::remove_dir(root.join(TRASH)).unwrap();assert!(store.delete_all_data().is_err());assert!(!pending(&root));assert!(other.exists());}}
    }
}
