use crate::catalog_update::{public_transfer, read_json, write_json, PublicTransfer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, Url};

type Result<T> = std::result::Result<T, String>;
const MANIFEST: &str = "media-packs.json";
const CACHED: &str = "media-packs.latest.json";
const SOURCE: &str = "media-source.txt";
const MARKER: &str = ".media-pack-sha256";
const MANIFEST_LIMIT: usize = 98_304;
const PACK_LIMIT: u64 = 2_000_000_000;
static MEDIA_OPERATION: Mutex<()> = Mutex::new(());
const PACKS: [(&str, &str, &[&str]); 4] = [
    ("outfits", "outfits", &["webp", "gz"]),
    ("animations", "animations", &["webm"]),
    ("charts", "chart-artwork", &["png"]),
    ("music", "soundtracks", &["ogg"]),
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32,
    revision: u64,
    base_url: Option<String>,
    packs: Vec<Pack>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pack {
    id: String,
    size: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    parts: Vec<HostedPart>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HostedPart {
    size: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    packs: Vec<PackStatus>,
    online: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackStatus {
    id: String,
    size: Option<u64>,
    installed_size: Option<u64>,
    state: &'static str,
    can_install: bool,
    can_remove: bool,
    local: bool,
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    phase: &'a str,
    bytes: u64,
    total: u64,
}

fn err(error: impl std::fmt::Display) -> String { error.to_string() }

fn https_address(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some() && url.port().is_none() &&
        url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
}

fn valid(manifest: &Manifest) -> bool {
    let mut ids = HashSet::new();
    manifest.schema == 1 && manifest.revision > 0 && manifest.packs.len() == PACKS.len() &&
        manifest.packs.iter().all(|pack| PACKS.iter().any(|(id, _, _)| pack.id == *id) && ids.insert(&pack.id) &&
            (1..=PACK_LIMIT).contains(&pack.size) && valid_hash(&pack.sha256) &&
            valid_parts(pack))
}

fn valid_parts(pack: &Pack) -> bool {
    if pack.parts.is_empty() { return true; }
    let mut names = HashSet::new();
    pack.parts.len() <= 512 && pack.parts.iter().enumerate().all(|(index, part)| {
        let fallback = format!("{index:03}");
        let suffix = part.suffix.as_deref().unwrap_or(&fallback);
        let (first, second) = suffix.split_once('-').map_or((suffix, None), |(first, second)| (first, Some(second)));
        first.len() == 3 && first.bytes().all(|byte| byte.is_ascii_digit()) &&
            second.is_none_or(|suffix| suffix.len() == 2 && suffix.bytes().all(|byte| byte.is_ascii_digit())) &&
            names.insert(suffix.to_owned()) && (1..=32 * 1024 * 1024).contains(&part.size) && valid_hash(&part.sha256)
    }) && pack.parts.iter().map(|part| part.size).sum::<u64>() == pack.size
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_manifest(path: &Path) -> Option<Manifest> {
    read_json(path, MANIFEST_LIMIT).ok().filter(valid)
}

fn local_source(root: &Path) -> Option<PathBuf> {
    let path = root.join(SOURCE);
    if fs::metadata(&path).ok()?.len() > 32_768 { return None; }
    let value = fs::read_to_string(path).ok()?;
    let path = PathBuf::from(value.trim_start_matches('\u{feff}').trim_end_matches(['\r', '\n']));
    if path.is_absolute() { Some(path) } else { None }
}

fn origin(root: &Path) -> Option<Url> {
    let baseline = read_manifest(&root.join(MANIFEST))?;
    let url = Url::parse(&(baseline.base_url?.trim_end_matches('/').to_string() + "/")).ok()?;
    (https_address(&url) && url.query().is_none()).then_some(url)
}

fn matching_file(folder: Option<&Path>, pack: &Pack) -> Option<PathBuf> {
    let folder = folder?;
    [format!("{}.zip", pack.id), archive_name(pack)].into_iter().map(|name| folder.join(name))
        .find(|path| fs::metadata(path).ok().is_some_and(|metadata| metadata.is_file() && metadata.len() == pack.size))
}

fn archive_name(pack: &Pack) -> String { format!("{}-{}.zip", pack.id, pack.sha256) }

fn current_manifest(root: &Path, local: Option<&Path>) -> Option<Manifest> {
    [read_manifest(&root.join(MANIFEST)), read_manifest(&root.join(CACHED)),
        local.and_then(|directory| read_manifest(&directory.join(MANIFEST)))]
        .into_iter().flatten().max_by_key(|manifest| manifest.revision)
}

fn fetch(base: &Url, name: &str, limit: usize, mut write: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    let mut url = base.join(name).map_err(err)?;
    let host = base.host_str().ok_or("Media download host is missing.")?;
    for _ in 0..5 {
        let actual = url.host_str().ok_or("Media download host is missing.")?;
        if !https_address(&url) || !(actual == host || host == "github.com" &&
            matches!(actual, "release-assets.githubusercontent.com" | "objects.githubusercontent.com")) {
            return Err("Invalid media download redirect.".into());
        }
        let mut path = url.path().to_owned();
        if let Some(query) = url.query() { path.push('?'); path.push_str(query); }
        match public_transfer(actual, &path, limit, "", true, Some(host), &mut write)? {
            PublicTransfer::Complete => return Ok(()),
            PublicTransfer::Redirect(location) => url = url.join(&location).map_err(err)?,
        }
    }
    Err("Too many redirects while downloading media.".into())
}

fn refresh(root: &Path, base: &Url) -> Result<()> {
    let mut bytes = Vec::new();
    fetch(base, MANIFEST, MANIFEST_LIMIT, |chunk| { bytes.extend_from_slice(chunk); Ok(()) })?;
    let data: Manifest = serde_json::from_slice(&bytes).map_err(err)?;
    if !valid(&data) { return Err("The media update catalog is invalid.".into()); }
    let local = local_source(root);
    if current_manifest(root, local.as_deref()).is_none_or(|current| current.revision <= data.revision) {
        write_json(&root.join(CACHED), &data)?;
    }
    Ok(())
}

fn fetch_archive(base: &Url, pack: &Pack, mut write: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    if pack.parts.is_empty() { return fetch(base, &archive_name(pack), pack.size as usize, write); }
    for (index, part) in pack.parts.iter().enumerate() {
        let fallback = format!("{index:03}");
        let suffix = part.suffix.as_deref().unwrap_or(&fallback);
        let name = format!("{}-{}-{suffix}.bin", pack.id, pack.sha256);
        let mut bytes = Vec::with_capacity(part.size as usize);
        let download = |bytes: &mut Vec<u8>| fetch(base, &name, part.size as usize, |chunk| {
            bytes.extend_from_slice(chunk);
            Ok(())
        });
        if download(&mut bytes).is_err() {
            bytes.clear();
            download(&mut bytes)?;
        }
        if bytes.len() as u64 != part.size || format!("{:x}", Sha256::digest(&bytes)) != part.sha256 {
            return Err(format!("Media download part {} failed verification.", index + 1));
        }
        write(&bytes)?;
    }
    Ok(())
}

fn installed(directory: &Path, id: &str) -> bool {
    if id != "animations" { return directory.join("index.json").is_file(); }
    fs::read_dir(directory).ok().is_some_and(|mut items| items.any(|item| {
        item.ok().is_some_and(|item| item.path().join("full-0.webm").is_file())
    }))
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.is_symlink()
}

fn pack_directory(directory: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => Ok(true),
        Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "Expected a local media folder.")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn directory_size(directory: &Path) -> io::Result<u64> {
    let mut size = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if is_link(&metadata) { continue; }
        if metadata.is_dir() { size += directory_size(&entry.path())?; }
        if metadata.is_file() { size += metadata.len(); }
    }
    Ok(size)
}

fn removing_directory(root: &Path, id: &str) -> PathBuf {
    root.join(format!(".media-{id}-removing"))
}

fn status(root: &Path) -> Status {
    let local = local_source(root);
    let manifest = current_manifest(root, local.as_deref());
    let online = origin(root).is_some();
    let packs = PACKS.iter().map(|(id, directory, _)| {
        let pack = manifest.as_ref().and_then(|manifest| manifest.packs.iter().find(|pack| pack.id == *id));
        let directory = root.join(directory);
        let removing = removing_directory(root, id);
        let active = pack_directory(&directory).unwrap_or(false);
        let pending = pack_directory(&removing).unwrap_or(false);
        let state = if pending { "removing" } else if !active || !installed(&directory, id) {
            if active { "incomplete" } else { "missing" }
        } else if pack.is_some_and(|pack|
            fs::read_to_string(directory.join(MARKER)).ok().is_none_or(|marker| marker.trim() != pack.sha256)) {
            "update"
        } else { "installed" };
        let can_remove = active || pending;
        let installed_size = can_remove.then(|| {
            let size = if active { directory_size(&directory)? } else { 0 };
            Ok::<_, io::Error>(size + if pending { directory_size(&removing)? } else { 0 })
        }).and_then(|size| size.ok());
        let local = pack.and_then(|pack| matching_file(local.as_deref(), pack)).is_some();
        PackStatus { id: (*id).into(), size: pack.map(|pack| pack.size), installed_size, state,
            can_install: !pending && pack.is_some() && (online || local), can_remove, local }
    }).collect();
    Status { packs, online }
}

fn verify_archive(file: &mut File, pack: &Pack, mut progress: impl FnMut(u64)) -> Result<()> {
    file.rewind().map_err(err)?;
    let mut hash = Sha256::new();
    let mut read = 0u64;
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(err)?;
        if size == 0 { break; }
        read += size as u64;
        if read > pack.size { return Err("Media archive exceeds its listed size.".into()); }
        hash.update(&buffer[..size]);
        progress(read);
    }
    if read != pack.size || format!("{:x}", hash.finalize()) != pack.sha256 {
        return Err("The media archive failed verification. Use the matching payload or try downloading it again.".into());
    }
    file.rewind().map_err(err)
}

fn extract(file: File, staging: &Path, id: &str, extensions: &[&str]) -> Result<()> {
    let mut archive = zip::ZipArchive::new(file).map_err(err)?;
    if archive.is_empty() || archive.len() > 32_000 { return Err("Unsupported media archive size.".into()); }
    let mut names = HashSet::new();
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(err)?;
        let name = entry.name().to_owned();
        let path = entry.enclosed_name().filter(|_| !name.contains("..") && !name.starts_with('/') &&
            name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_. /".contains(&byte)) &&
            !name.split('/').any(|part| part.is_empty() || part.ends_with([' ', '.'])))
            .ok_or("Invalid media file path.")?;
        let expected_depth = if id == "animations" { 2 } else { 1 };
        if !entry.is_file() || entry.is_symlink() || path.components().count() != expected_depth ||
            !(name == "index.json" || path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| extensions.contains(&ext))) ||
            !names.insert(name.to_ascii_lowercase()) {
            return Err("Unexpected file in the media archive.".into());
        }
        expanded = expanded.checked_add(entry.size()).filter(|size| *size <= PACK_LIMIT).ok_or("Media archive is too large.")?;
        let target = staging.join(path);
        fs::create_dir_all(target.parent().ok_or("Invalid media target.")?).map_err(err)?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(target).map_err(err)?;
        let expected = entry.size();
        if io::copy(&mut (&mut entry).take(expected + 1), &mut output).map_err(err)? != expected {
            return Err("A media file was truncated or exceeded its expected length.".into());
        }
    }
    if !installed(staging, id) { return Err("The media pack is incomplete.".into()); }
    Ok(())
}

fn remove_stage(path: &Path) -> Result<()> {
    if path.exists() { fs::remove_dir_all(path).map_err(err)?; }
    Ok(())
}

fn install(app: &AppHandle, root: &Path, id: &str) -> Result<Status> {
    let _guard = MEDIA_OPERATION.try_lock().map_err(|_| "Another media operation is running.")?;
    let (_, folder, extensions) = PACKS.iter().find(|(name, _, _)| *name == id).ok_or("Unknown media pack.")?;
    if pack_directory(&removing_directory(root, id)).map_err(err)? {
        return Err("Finish removing this pack before installing it again.".into());
    }
    let local = local_source(root);
    let manifest = current_manifest(root, local.as_deref()).ok_or("Choose the Setup payload folder to install media.")?;
    let pack = manifest.packs.iter().find(|pack| pack.id == id).ok_or("The media pack is missing from the catalog.")?;
    let active = root.join(folder);
    let stage = root.join(format!(".media-{id}-stage"));
    let previous = root.join(format!(".media-{id}-previous"));
    if previous.exists() && !active.exists() { fs::rename(&previous, &active).map_err(err)?; }
    remove_stage(&previous)?;
    remove_stage(&stage)?;
    fs::create_dir(&stage).map_err(err)?;
    let outcome = (|| {
        let mut last = 0;
        let emit = |phase, bytes| { let _ = app.emit("desktop-media-progress", Progress { id, phase, bytes, total: pack.size }); };
        let mut archive = if let Some(path) = matching_file(local.as_deref(), pack) {
            File::open(path).map_err(err)?
        } else {
            let base = origin(root).ok_or("This local build has no download source. Choose the Setup payload folder.")?;
            let path = stage.join("payload.zip");
            let mut file = OpenOptions::new().read(true).write(true).create_new(true).open(path).map_err(err)?;
            let mut written = 0;
            emit("downloading", 0);
            fetch_archive(&base, pack, |chunk| {
                file.write_all(chunk).map_err(err)?;
                written += chunk.len() as u64;
                if written - last >= 4 * 1024 * 1024 { emit("downloading", written); last = written; }
                Ok(())
            })?;
            file
        };
        emit("verifying", 0);
        verify_archive(&mut archive, pack, |_| {})?;
        emit("installing", 0);
        let media = stage.join("media");
        fs::create_dir(&media).map_err(err)?;
        extract(archive, &media, id, extensions)?;
        fs::write(media.join(MARKER), &pack.sha256).map_err(err)?;
        if active.exists() { fs::rename(&active, &previous).map_err(err)?; }
        if let Err(error) = fs::rename(&media, &active) {
            if previous.exists() { fs::rename(&previous, &active).map_err(err)?; }
            return Err(err(error));
        }
        let _ = remove_stage(&previous);
        Ok(status(root))
    })();
    let _ = remove_stage(&stage);
    outcome
}

fn remove(root: &Path, id: &str) -> Result<Status> {
    let _guard = MEDIA_OPERATION.try_lock().map_err(|_| "Another media operation is running.")?;
    let (_, folder, _) = PACKS.iter().find(|(name, _, _)| *name == id).ok_or("Unknown media pack.")?;
    let root = root.canonicalize().map_err(err)?;
    let active = root.join(folder);
    let removing = removing_directory(&root, id);
    let remove_error = |error| format!("Could not remove the pack. Close any open media previews and try again. {error}");
    let active_exists = pack_directory(&active).map_err(err)?;
    for path in [root.join(format!(".media-{id}-stage")), root.join(format!(".media-{id}-previous")), removing.clone()] {
        if pack_directory(&path).map_err(err)? {
            fs::remove_dir_all(&path).map_err(remove_error)?;
        }
    }
    if active_exists {
        fs::rename(&active, &removing).map_err(remove_error)?;
        fs::remove_dir_all(&removing).map_err(remove_error)?;
    }
    Ok(status(&root))
}

#[tauri::command]
pub async fn desktop_media_packs_status(app: AppHandle, check_online: bool) -> Result<Status> {
    let root = app.path().resource_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        if check_online { if let Some(base) = origin(&root) { refresh(&root, &base)?; } }
        Ok(status(&root))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn desktop_media_packs_choose_folder(app: AppHandle) -> Result<Status> {
    let root = app.path().resource_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(folder) = crate::file_dialog(&app, "Choose the Setup payload folder").pick_folder() {
            let folder = if folder.join(MANIFEST).is_file() { folder } else { folder.join("payload") };
            if read_manifest(&folder.join(MANIFEST)).is_none() { return Err("This folder does not contain a valid media-packs.json file.".into()); }
            fs::write(root.join(SOURCE), folder.to_str().ok_or("The folder path is unsupported.")?).map_err(err)?;
        }
        Ok(status(&root))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn desktop_media_pack_install(app: AppHandle, id: String) -> Result<Status> {
    let root = app.path().resource_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || install(&app, &root, &id)).await.map_err(err)?
}

#[tauri::command]
pub async fn desktop_media_pack_remove(app: AppHandle, id: String) -> Result<Status> {
    let root = app.path().resource_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || remove(&root, &id)).await.map_err(err)?
}
