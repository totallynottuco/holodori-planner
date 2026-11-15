use crate::{
    catalog_update::{fetch_with_headers, public_request, PublicResponse},
    locked,
    store::Result,
    Native,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::Ordering, Mutex},
};
use tauri::Manager;

const REPO: &str = "totallynottuco/holodori-planner";
const MAX_SETUP: usize = 32 * 1024 * 1024;
const MAX_NOTES_CHARS: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq)]
struct Update {
    version: String,
    name: String,
    digest: String,
    size: usize,
    notes: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ReleaseNotes {
    version: String,
    notes: String,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
    size: usize,
    digest: Option<String>,
}

#[derive(Default)]
pub(crate) struct AppUpdater {
    offer: Mutex<Option<Update>>,
    download: Mutex<Option<(Update, Vec<u8>)>>,
}

pub(crate) fn supported() -> bool {
    cfg!(all(windows, target_arch = "x86_64"))
        && std::env::current_exe().ok().is_some_and(|exe| {
            exe.file_name().is_some_and(|name| name == "holodori-desktop.exe")
                && exe.parent().is_some_and(|dir| {
                    !dir.join("portable.mode").exists() && dir.join("unins000.dat").is_file()
                })
        })
}

fn version_parts(value: &str) -> Option<(u32, u32, u32)> {
    fn number(value: &str) -> Option<u32> {
        if value.is_empty() || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        value.parse().ok()
    }
    let mut parts = value.split('.');
    let version = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
    parts.next().is_none().then_some(version)
}

fn select_update(bytes: &[u8], current: &str) -> Result<Option<Update>> {
    let release: Release = serde_json::from_slice(bytes).map_err(|_| "Invalid app release response.")?;
    let Some(version) = release.tag_name.strip_prefix('v') else { return Ok(None) };
    if release.draft || release.prerelease || version_parts(version).is_none()
        || version_parts(version) <= version_parts(current)
    {
        return Ok(None);
    }
    let name = format!("Hololive-Dreams-Planner-{version}-Windows-x64-Setup.exe");
    let asset = release.assets.into_iter()
        .find(|asset| asset.name == name && asset.state == "uploaded")
        .ok_or("The latest release has no Windows installer yet.")?;
    let digest = asset.digest.as_deref().and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("The latest installer does not have a verification checksum.")?;
    if !(2..=MAX_SETUP).contains(&asset.size) {
        return Err("The latest installer has an unsupported download size.".into());
    }
    let notes = release.body.as_deref().unwrap_or_default().trim().chars().take(MAX_NOTES_CHARS).collect();
    Ok(Some(Update {version: version.into(), name, digest: digest.to_ascii_lowercase(), size: asset.size, notes}))
}

fn update_cache(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("app-updates"))
}

fn pending_notes(path: &Path, installed_version: &str) -> Option<ReleaseNotes> {
    let bytes = fs::read(path).ok()?;
    let notes: ReleaseNotes = serde_json::from_slice(&bytes).ok()?;
    (notes.version == installed_version).then_some(notes)
}

fn acknowledge_notes(path: &Path, installed_version: &str) -> Result<()> {
    if pending_notes(path, installed_version).is_some() {
        match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
            _ => {}
        }
    }
    Ok(())
}

fn latest(current: &str) -> Result<Option<Update>> {
    let path = format!("/repos/{REPO}/releases/latest");
    let bytes = fetch_with_headers("api.github.com", &path, 512 * 1024, "Accept: application/vnd.github+json\r\n")?;
    select_update(&bytes, current)
}

fn download_target(url: &tauri::Url) -> Result<(&str, String)> {
    let host = url.host_str().filter(|host| matches!(*host,
        "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"));
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("The installer download URL is invalid.".into());
    }
    let host = host.ok_or("The installer download host is invalid.")?;
    let mut path = url.path().to_owned();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    Ok((host, path))
}

fn verified(update: &Update, bytes: &[u8]) -> bool {
    bytes.len() == update.size && bytes.starts_with(b"MZ")
        && format!("{:x}", Sha256::digest(bytes)) == update.digest
}

fn download(update: &Update) -> Result<Vec<u8>> {
    let mut url = tauri::Url::parse(&format!(
        "https://github.com/{REPO}/releases/download/v{}/{}", update.version, update.name
    )).map_err(|_| "Invalid app download address.")?;
    for _ in 0..5 {
        let (host, path) = download_target(&url)?;
        match public_request(host, &path, update.size, "", true)? {
            PublicResponse::Body(bytes) if verified(update, &bytes) => return Ok(bytes),
            PublicResponse::Body(_) => return Err("The installer failed verification. Try checking for updates again.".into()),
            PublicResponse::Redirect(address) => {
                url = url.join(&address).map_err(|_| "Invalid installer download redirect.")?;
            }
        }
    }
    Err("Too many redirects while downloading the installer.".into())
}

#[tauri::command]
pub(crate) async fn desktop_app_update_check(app: tauri::AppHandle) -> Result<Option<String>> {
    if !supported() || app.state::<Native>().smoke.is_some() {return Ok(None);}
    tauri::async_runtime::spawn_blocking(move || {
        let update = latest(env!("CARGO_PKG_VERSION"))?;
        let version = update.as_ref().map(|update| update.version.clone());
        *app.state::<AppUpdater>().offer.lock().map_err(|e| e.to_string())? = update;
        Ok(version)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_app_update_notes(app: tauri::AppHandle) -> Result<Option<ReleaseNotes>> {
    if !supported() || app.state::<Native>().smoke.is_some() {return Ok(None);}
    tauri::async_runtime::spawn_blocking(move || {
        Ok(pending_notes(&update_cache(&app)?.join("whats-new.json"), env!("CARGO_PKG_VERSION")))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_app_update_acknowledge(app: tauri::AppHandle, version: String) -> Result<()> {
    if version != env!("CARGO_PKG_VERSION") || !supported() || app.state::<Native>().smoke.is_some() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        acknowledge_notes(&update_cache(&app)?.join("whats-new.json"), &version)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_app_update_download(app: tauri::AppHandle, version: String) -> Result<()> {
    if !supported() {return Err("Use the Windows installation to install app updates.".into());}
    tauri::async_runtime::spawn_blocking(move || {
        let updater = app.state::<AppUpdater>();
        let update = updater.offer.lock().map_err(|e| e.to_string())?.clone()
            .filter(|update| update.version == version).ok_or("Check for app updates again.")?;
        let mut slot = updater.download.lock().map_err(|e| e.to_string())?;
        if slot.as_ref().is_some_and(|(ready, _)| *ready == update) {return Ok(());}
        *slot = Some((update.clone(), download(&update)?));
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn desktop_app_update_install(app: tauri::AppHandle, version: String) -> Result<()> {
    if !supported() {return Err("Use the Windows installation to install app updates.".into());}
    tauri::async_runtime::spawn_blocking(move || {
        let updater = app.state::<AppUpdater>();
        let downloaded = updater.download.lock().map_err(|e| e.to_string())?;
        let (update, bytes) = downloaded.as_ref().filter(|(update, _)| update.version == version)
            .ok_or("Download the update before installing.")?;
        if updater.offer.lock().map_err(|e| e.to_string())?.as_ref() != Some(update) {
            return Err("Check for app updates again.".into());
        }
        let native = app.state::<Native>();
        if native.closing.swap(true, Ordering::SeqCst) {return Err("The app is already closing.".into());}
        let launch = (|| {
            locked(&native, |store| {
                if store.restore_pending() || store.reset_pending() {return Err("Finish the current data operation first.".into());}
                store.backup().map(|_| ())
            })?;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let dir = exe.parent().ok_or("The installation folder is unavailable.")?;
            let cache = update_cache(&app)?;
            fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
            let notes_path = cache.join("whats-new.json");
            let notes = ReleaseNotes {version: update.version.clone(), notes: update.notes.clone()};
            let notes_json = serde_json::to_vec(&notes).map_err(|e| e.to_string())?;
            let path = cache.join(format!("{}-{}-{}.exe", update.version, std::process::id(), crate::store::now()));
            let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
            let written = file.write_all(bytes).and_then(|_| file.sync_all());
            drop(file);
            let start = (|| -> Result<()> {
                written.map_err(|e| e.to_string())?;
                crate::store::atomic(&notes_path, &notes_json)?;
                Command::new(&path)
                    .args(["/SP-", "/SILENT", "/NORESTART"])
                    .arg(format!("/UPDATEPID={}", std::process::id()))
                    .arg(format!("/DIR={}", dir.display()))
                    .current_dir(&cache)
                    .spawn().map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(error) = start {
                let _ = fs::remove_file(&path);
                let _ = acknowledge_notes(&notes_path, &update.version);
                return Err(format!("Could not start Setup. {error}"));
            }
            Ok(())
        })();
        if launch.is_err() {native.closing.store(false, Ordering::SeqCst);}
        launch?;
        app.exit(0);
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn offers_only_a_newer_stable_verified_installer() {
        let mut release = json!({"tag_name":"v1.10.0","draft":false,"prerelease":false,"body":"## Changes\n- Faster startup","assets":[
            {"name":"Hololive-Dreams-Planner-1.10.0-Windows-x64-Setup.exe","state":"uploaded","size":1024,
            "digest":"sha256:aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd"}]});
        let current = "1.9.0";
        let update = select_update(&release.to_string().into_bytes(), current).unwrap().unwrap();
        assert_eq!(update.version, "1.10.0");
        assert_eq!(update.notes, "## Changes\n- Faster startup");
        assert!(select_update(&release.to_string().into_bytes(), "1.10.0").unwrap().is_none());
        release["prerelease"] = true.into();
        assert!(select_update(&release.to_string().into_bytes(), current).unwrap().is_none());
        release["prerelease"] = false.into();
        release["assets"][0]["digest"] = serde_json::Value::Null;
        assert!(select_update(&release.to_string().into_bytes(), current).is_err());
        release["tag_name"] = "installer-data-v1.10.0".into();
        assert!(select_update(&release.to_string().into_bytes(), current).unwrap().is_none());
    }

    #[test]
    fn verifies_digest_and_rejects_offsite_or_insecure_downloads() {
        let bytes = b"MZtest";
        let update = Update {version:"1.1.0".into(),name:"test.exe".into(),size:bytes.len(),
            digest:format!("{:x}", Sha256::digest(bytes)), notes:String::new()};
        assert!(verified(&update, bytes));
        assert!(!verified(&update, b"MZevil"));
        for address in ["http://github.com/file", "https://example.org/file", "https://user@github.com/file"] {
            assert!(download_target(&tauri::Url::parse(address).unwrap()).is_err(), "{address}");
        }
    }

    #[test]
    fn shows_notes_only_for_the_installed_update_until_acknowledged() {
        let dir = std::env::temp_dir().join(format!("planner-release-notes-{}-{}", std::process::id(), crate::store::now()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("whats-new.json");
        assert!(pending_notes(&path, "1.1.0").is_none());
        let notes = ReleaseNotes {version: "1.1.0".into(), notes: "Updated the board planner.".into()};
        crate::store::atomic(&path, &serde_json::to_vec(&notes).unwrap()).unwrap();
        acknowledge_notes(&path, "1.0.0").unwrap();
        assert!(pending_notes(&path, "1.0.0").is_none());
        assert_eq!(pending_notes(&path, "1.1.0").unwrap().notes, notes.notes);
        acknowledge_notes(&path, "1.1.0").unwrap();
        acknowledge_notes(&path, "1.1.0").unwrap();
        assert!(pending_notes(&path, "1.1.0").is_none());
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    #[ignore = "uses the public GitHub release and Windows HTTPS"]
    fn checks_and_verifies_the_live_setup_download() {
        let update = latest("0.0.0").unwrap().unwrap();
        let bytes = download(&update).unwrap();
        assert!(verified(&update, &bytes));
        assert!(latest(&update.version).unwrap().is_none());
    }
}
