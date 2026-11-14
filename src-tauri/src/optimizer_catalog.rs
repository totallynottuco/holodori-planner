//! Local last-good optimizer bundle, separate from account data.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 24_000_000;
const BANNER_LIMIT: usize = 1_500_000;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
pub struct Bundle { id: String, json: String }

const MOBILE_LIMIT: usize = 18_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileFeed { public_key: String, url: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileBundle { id: String, json: String, public_key: String }

fn mobile_feed(dir: &Path) -> Result<Option<MobileFeed>> {
    let path = dir.join("mobile-feed.json");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= 4096 => (),
        Ok(_) => return Err("Invalid Mobile scoring feed settings file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    }
    let bytes = fs::read(&path).map_err(err)?;
    let feed: MobileFeed = serde_json::from_slice(&bytes).map_err(err)?;
    if base64::engine::general_purpose::STANDARD.decode(&feed.public_key).map_err(err)?.len() != 32 {
        return Err("Invalid Mobile scoring feed public key.".into());
    }
    Ok(Some(feed))
}

fn active_mobile(dir: &Path) -> Option<Bundle> {
    read(&dir.join("mobile-last-good.json")).or_else(|| read(&dir.join("mobile-last-good.bak")))
}

#[tauri::command]
pub async fn desktop_mobile_scoring_read(app: AppHandle) -> Result<Option<MobileBundle>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(err)?;
        let dir = folder(&app.state::<crate::Native>().root);
        let Some(feed) = mobile_feed(&dir)? else { return Ok(None); };
        Ok(active_mobile(&dir).map(|bundle| MobileBundle { id:bundle.id, json:bundle.json, public_key:feed.public_key }))
    }).await.map_err(err)?
}

fn mobile_download(dir: &Path, feed: &MobileFeed) -> Result<Option<String>> {
    if let Some(url) = &feed.url {
        let url = tauri::Url::parse(url).map_err(err)?;
        if url.scheme() != "https" || url.host_str() != Some("raw.githubusercontent.com")
            || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
            || url.query().is_some() || url.fragment().is_some() {
            return Err("Use a raw.githubusercontent.com HTTPS URL for the Mobile scoring feed.".into());
        }
        let bytes = crate::catalog_update::fetch_with_headers("raw.githubusercontent.com",url.path(),MOBILE_LIMIT,"")?;
        return String::from_utf8(bytes).map(Some).map_err(err);
    }
    let path = dir.join("mobile-update.json");
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MOBILE_LIMIT as u64 => fs::read_to_string(path).map(Some).map_err(err),
        Ok(_) => Err("Invalid Mobile scoring update file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(err(error)),
    }
}

#[tauri::command]
pub async fn desktop_mobile_scoring_stage(app: AppHandle) -> Result<Option<MobileBundle>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = folder(&app.state::<crate::Native>().root);
        let Some(feed) = mobile_feed(&dir)? else { return Ok(None); };
        let Some(json) = mobile_download(&dir,&feed)? else { return Ok(None); };
        let id = digest(&json);
        let _guard = LOCK.lock().map_err(err)?;
        if active_mobile(&dir).is_some_and(|record| record.id == id) { return Ok(None); }
        let bundle = Bundle { id, json };
        let bytes = serde_json::to_vec(&bundle).map_err(err)?;
        if bytes.len() > LIMIT { return Err("Mobile scoring release exceeds the local cache limit.".into()); }
        crate::store::atomic(&dir.join("mobile-pending.json"),&bytes)?;
        Ok(Some(MobileBundle { id:bundle.id, json:bundle.json, public_key:feed.public_key }))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn desktop_mobile_scoring_commit(app: AppHandle, id: String, public_key: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = folder(&app.state::<crate::Native>().root);
        let bundle = {
            let _guard = LOCK.lock().map_err(err)?;
            if !mobile_feed(&dir)?.is_some_and(|feed| feed.public_key == public_key) {
                return Err("The Mobile scoring feed changed during verification.".into());
            }
            let bundle = read(&dir.join("mobile-pending.json")).filter(|record| record.id == id)
                .ok_or("The verified Mobile scoring release is no longer staged.")?;
            let path=dir.join("mobile-last-good.json");
            let backup=path.with_extension("bak");
            if path.exists() && read(&path).is_none() && read(&backup).is_some() {
                fs::copy(backup,&path).map_err(err)?;
            }
            crate::store::atomic(&path,&serde_json::to_vec(&bundle).map_err(err)?)?;
            bundle
        };
        tauri::async_runtime::spawn_blocking(move || cache_game_event_banners(&dir, &bundle.json));
        Ok(())
    }).await.map_err(err)?
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    banner_hash: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWindow { id: String, start_time: u64, end_time: u64 }

#[tauri::command]
pub async fn desktop_optimizer_event_windows(app: AppHandle) -> Result<Option<Vec<EventWindow>>> {
    #[derive(Deserialize)]
    struct Schedule { events: Vec<EventWindow> }
    #[derive(Deserialize)]
    struct Catalog { events: Schedule }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(err)?;
        Ok(active(&folder(&app.state::<crate::Native>().root))
            .and_then(|bundle| serde_json::from_str::<Catalog>(&bundle.json).ok())
            .map(|catalog| catalog.events.events))
    }).await.map_err(err)?
}
fn digest(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
fn err(error: impl std::fmt::Display) -> String { error.to_string() }
fn folder(root: &Path) -> PathBuf { root.join("optimizer-catalog") }
fn read(path: &Path) -> Option<Bundle> {
    if fs::metadata(path).ok()?.len() > LIMIT as u64 { return None; }
    let record: Bundle = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (digest(&record.json) == record.id).then_some(record)
}
fn active(dir: &Path) -> Option<Bundle> {
    read(&dir.join("last-good.json")).or_else(|| read(&dir.join("last-good.bak")))
}

#[tauri::command]
pub async fn desktop_optimizer_catalog_bytes(app: AppHandle, mobile: bool) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = folder(&app.state::<crate::Native>().root);
        let _guard = LOCK.lock().map_err(err)?;
        let (bundle, key) = if mobile {
            let Some(feed) = mobile_feed(&dir)? else {
                return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
            };
            (active_mobile(&dir), Some(feed.public_key))
        } else {
            (active(&dir), None)
        };
        let Some(bundle) = bundle else {
            return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
        };
        let mut bytes = serde_json::to_vec(&json!({"id":bundle.id,"publicKey":key})).map_err(err)?;
        bytes.reserve(1 + bundle.json.len());
        bytes.push(b'\n');
        bytes.extend(bundle.json.into_bytes());
        Ok(tauri::ipc::Response::new(bytes))
    }).await.map_err(err)?
}

fn banner_path(dir: &Path, hash: &str) -> Option<PathBuf> {
    (hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        .then(|| dir.join("event-banners").join(format!("{hash}.webp")))
}

fn read_banner(dir: &Path, hash: &str) -> Option<Vec<u8>> {
    let path = banner_path(dir, hash)?;
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > BANNER_LIMIT as u64 { return None; }
    let bytes = fs::read(path).ok()?;
    (format!("{:x}", Sha256::digest(&bytes)) == hash).then_some(bytes)
}

#[tauri::command]
pub async fn desktop_optimizer_event_banner(app: AppHandle, hash: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = folder(&app.state::<crate::Native>().root);
        Ok(read_banner(&dir, &hash).map(|bytes| format!("data:image/webp;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes))))
    }).await.map_err(err)?
}

fn game_event_banner_source(id: &str) -> Option<String> {
    let suffix = id.strip_prefix("marathon_event-relay-").or_else(|| id.strip_prefix("marathon_event-normal-"))?;
    if suffix.len() != 3 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
    let key = format!("img_banner_full_{id}_lang-eng");
    Some(format!("/assets/assetbundles/{key}/{key}_unsquished.webp"))
}

fn signed_game_event_ids(json: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct SignedRelease { payload: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload { game_events: Option<Vec<GameEvent>> }
    #[derive(Deserialize)]
    struct GameEvent { id: String }
    serde_json::from_str::<SignedRelease>(json).ok()
        .and_then(|envelope| serde_json::from_str::<Payload>(&envelope.payload).ok())
        .and_then(|payload| payload.game_events)
        .unwrap_or_default().into_iter().map(|event| event.id).collect()
}

fn game_event_banner_pointer(dir: &Path, id: &str) -> PathBuf {
    dir.join("event-banners").join(format!("{id}.sha256"))
}

fn read_game_event_banner(dir: &Path, id: &str) -> Option<Vec<u8>> {
    let pointer = game_event_banner_pointer(dir, id);
    let meta = fs::symlink_metadata(&pointer).ok()?;
    if !meta.is_file() || meta.len() != 64 { return None; }
    read_banner(dir, &fs::read_to_string(&pointer).ok()?)
}

fn cache_game_event_banners(dir: &Path, json: &str) {
    let bundled: Value = serde_json::from_str(include_str!("../../evidence/team-optimizer/reference/event-titles.json")).unwrap_or_default();
    for id in signed_game_event_ids(json).into_iter().take(20) {
        let Some(path) = game_event_banner_source(&id) else { continue; };
        if bundled.get(&id).is_some() || read_game_event_banner(dir, &id).is_some() { continue; }
        if let Ok(hash) = cache_banner(dir, &path) {
            let _ = crate::store::atomic(&game_event_banner_pointer(dir, &id), hash.as_bytes());
        }
    }
}

#[tauri::command]
pub async fn desktop_optimizer_game_event_banner(app: AppHandle, event_id: String, release_id: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        if game_event_banner_source(&event_id).is_none() { return Ok(None); }
        let dir = folder(&app.state::<crate::Native>().root);
        let release = {
            let _guard = LOCK.lock().map_err(err)?;
            active_mobile(&dir).filter(|bundle| bundle.id == release_id)
        };
        // A candidate reaches the active file only after the catalog worker
        // checks its trusted signature, checksum and event identities.
        let authorized = release.is_some_and(|bundle| signed_game_event_ids(&bundle.json).contains(&event_id));
        if !authorized { return Ok(None); }
        Ok(read_game_event_banner(&dir, &event_id).map(|bytes|
            format!("data:image/webp;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
    }).await.map_err(err)?
}

fn event_title(event: &Value, notices: &Value) -> Option<String> {
    let id = event["id"].as_str()?;
    let notice_id = format!("notice-{id}");
    let asset_id = format!("img_banner_full_{id}");
    let title = notices["categories"].as_array()?.iter()
        .filter_map(|category| category["notices"].as_array()).flatten()
        .filter(|notice| notice["type"] == 2)
        .find(|notice| notice["id"] == notice_id || notice["bannerAssetId"] == asset_id)?["title"].as_str()?;
    let name = title.split_once('"').and_then(|(_, rest)| rest.split_once('"'))
        .or_else(|| title.split_once('“').and_then(|(_, rest)| rest.split_once('”')))?.0.trim();
    (!name.is_empty() && name.len() <= 240 && !name.chars().any(char::is_control) &&
        !matches!(name.to_ascii_lowercase().as_str(), "score challenge event" | "point rally event" | "spotlight event"))
        .then(|| name.to_owned())
}

fn event_banner_source(id: &str, metadata: &Value) -> Option<String> {
    if !id.starts_with("marathon_event-") || id.len() > 80 ||
        !id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')) {
        return None;
    }
    let banner = metadata["events"].as_array()?.iter().find(|row| row["eventId"] == id)?["banner"].as_str()?;
    let key = format!("img_banner_full_{id}_lang-eng");
    (banner == format!("assetbundles/{key}/{key}")).then(|| format!("/assets/{banner}_unsquished.webp"))
}

fn cache_banner(dir: &Path, path: &str) -> Result<String> {
    let bytes = crate::catalog_update::fetch_with_headers("cdn.holodori.dev", path, BANNER_LIMIT, "")?;
    let (width, height) = crate::catalog_update::webp_size(&bytes)?;
    if width == 0 || height == 0 || width > 4096 || height > 4096 { return Err("Invalid event banner size.".into()); }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let destination = banner_path(dir, &hash).ok_or("Invalid event banner hash.")?;
    fs::create_dir_all(destination.parent().ok_or("Missing event banner directory.")?).map_err(err)?;
    crate::store::atomic(&destination, &bytes)?;
    Ok(hash)
}

fn archive_events(fresh: &[Value], previous: &Value) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    fresh.iter().chain(previous["events"]["events"].as_array().into_iter().flatten())
        .filter(|event| event["id"].as_str().is_some_and(|id| seen.insert(id)))
        .cloned().collect()
}

fn refresh_event_display(dir: &Path, fresh: &[Value], public: &Value, previous: &Value) -> BTreeMap<String, EventDisplay> {
    let mut display: BTreeMap<String, EventDisplay> = serde_json::from_value(previous["eventDisplay"].clone()).unwrap_or_default();
    let bundled: Value = serde_json::from_str(include_str!("../../evidence/team-optimizer/reference/event-titles.json")).unwrap_or_default();
    for event in fresh {
        let Some(id) = event["id"].as_str() else { continue; };
        let entry = display.entry(id.to_owned()).or_default();
        if let Some(title) = event_title(event, &public["notices"]) { entry.title = Some(title); }
        if bundled.get(id).is_none() && entry.banner_hash.as_ref().and_then(|hash| read_banner(dir, hash)).is_none() {
            if let Some(path) = event_banner_source(id, &public["eventList"]) {
                if let Ok(hash) = cache_banner(dir, &path) { entry.banner_hash = Some(hash); }
            }
        }
    }
    display.retain(|_, entry| entry.title.is_some() || entry.banner_hash.is_some());
    display
}

#[tauri::command]
pub async fn desktop_optimizer_catalog_read(app: AppHandle) -> Result<Option<Bundle>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(err)?;
        Ok(active(&folder(&app.state::<crate::Native>().root)))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn desktop_optimizer_catalog_stage(app: AppHandle) -> Result<Option<Bundle>> {
    tauri::async_runtime::spawn_blocking(move || {
        let public = fetch_public(&app)?;
        let data = public.get("data").filter(|value| value.is_object()).ok_or("Optimizer data is missing.")?;
        let songs = public["songs"].as_array().filter(|rows| !rows.is_empty() && rows.len() <= 10_000)
            .ok_or("Song unlock catalog is missing.")?;
        let fresh_events = public["events"]["events"].as_array().ok_or("Optimizer event data is missing.")?;
        let dir = folder(&app.state::<crate::Native>().root);
        let previous = {
            let _guard = LOCK.lock().map_err(err)?;
            active(&dir).and_then(|record| serde_json::from_str::<Value>(&record.json).ok()).unwrap_or_default()
        };
        let mut lengths = serde_json::Map::new();
        let mut unlocks = serde_json::Map::new();
        for row in songs {
            let id = row["id"].as_str().filter(|id| id.len() == 5 && id.starts_with('m') && id[1..].bytes().all(|c| c.is_ascii_digit()))
                .ok_or("Invalid song identity.")?;
            let auto_given = row["autoGiven"].as_bool().ok_or("Missing automatic song unlock rule.")?;
            for key in ["mainQuestUnlock", "holomemUnlock"] {
                if row.get(key).is_none() { return Err("Missing song unlock rule.".into()); }
            }
            let length = row["length"].as_f64().filter(|n| *n > 0.0 && *n <= 3600.0).ok_or("Invalid song length.")?;
            if unlocks.insert(id.into(),json!({"autoGiven":auto_given,"mainQuestUnlock":row["mainQuestUnlock"],"holomemUnlock":row["holomemUnlock"]})).is_some() {
                return Err("Duplicate song unlock rule.".into());
            }
            lengths.insert(id.into(),json!(length));
        }
        let event_display = refresh_event_display(&dir, fresh_events, &public, &previous);
        let events = archive_events(fresh_events, &previous);
        let bundle = json!({"schema":1,"data":data,"events":{"events":events},
            "eventDisplay":event_display,"unlocks":unlocks,"lengths":lengths});
        let json = serde_json::to_string(&bundle).map_err(err)?;
        let id = digest(&json);
        let _guard = LOCK.lock().map_err(err)?;
        if active(&dir).is_some_and(|record| record.id == id) { return Ok(None); }
        let bundle = Bundle { id, json };
        let bytes = serde_json::to_vec(&bundle).map_err(err)?;
        if bytes.len() > LIMIT { return Err("Optimizer catalog exceeds the local cache limit.".into()); }
        fs::create_dir_all(&dir).map_err(err)?;
        crate::store::atomic(&dir.join("pending.json"), &bytes)?;
        Ok(Some(bundle))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn desktop_optimizer_catalog_commit(app: AppHandle, id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(err)?;
        let dir = folder(&app.state::<crate::Native>().root);
        let bundle = read(&dir.join("pending.json")).filter(|record| record.id == id)
            .ok_or("The verified optimizer download is no longer staged.")?;
        let path=dir.join("last-good.json");
        // Repair a damaged primary from the backup before rotating the files.
        if path.exists() && read(&path).is_none() && read(&dir.join("last-good.bak")).is_some() {
            fs::copy(dir.join("last-good.bak"),&path).map_err(err)?;
        }
        crate::store::atomic(&path, &serde_json::to_vec(&bundle).map_err(err)?)
    }).await.map_err(err)?
}

#[cfg(not(windows))]
fn fetch_public(_: &AppHandle) -> Result<Value> { Err("Optimizer updates require WebView2.".into()) }

#[cfg(windows)]
fn fetch_public(app: &AppHandle) -> Result<Value> {
    use std::{sync::mpsc, thread, time::{Duration, Instant}};
    use tauri::{webview::{NewWindowResponse, PageLoadEvent}, WebviewUrl, WebviewWindowBuilder};
    use webview2_com::{CoTaskMemPWSTR, ExecuteScriptCompletedHandler};
    const PAGE: &str = "https://holodori.best/robots.txt";
    const SCRIPT: &str = r#"
      if (window.top === window && location.href === "https://holodori.best/robots.txt") {
        (async () => {
          const fetchPublic = async (path, maxBytes) => {
            const response = await fetch("https://api.holodori.best" + path, {
              credentials: "omit", redirect: "error", signal: AbortSignal.timeout(12000)
            });
            if (!response.ok || !response.headers.get("content-type")?.includes("json")) throw Error("Public catalog unavailable");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parts = [];
            let bytes = 0;
            while (true) {
              const {done,value} = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > maxBytes) { await reader.cancel(); throw Error("Public catalog too large"); }
              parts.push(decoder.decode(value,{stream:true}));
            }
            return JSON.parse(parts.join("") + decoder.decode());
          };
          try {
            const [data,songs,events,eventList,notices] = await Promise.all([
              fetchPublic("/api/optimizer?lang=eng",16_000_000),
              fetchPublic("/api/songs?lang=eng",3_000_000),
              fetchPublic("/api/optimizer/events",3_000_000),
              fetchPublic("/api/events/list?region=us&language=eng",3_000_000).catch(()=>null),
              fetchPublic("/api/announcements?lang=eng",3_000_000).catch(()=>null)
            ]);
            globalThis.__holodoriPublicOptimizerResult = {data,songs,events,eventList,notices};
          } catch { globalThis.__holodoriPublicOptimizerResult = {error:true}; }
        })();
      }
    "#;
    let url = PAGE.parse::<tauri::Url>().map_err(err)?;
    let window = WebviewWindowBuilder::new(app, "optimizer-catalog-fetch", WebviewUrl::External("about:blank".parse().map_err(err)?))
        .visible(false).focused(false).incognito(true)
        .on_navigation(|url| matches!(url.as_str(), "about:blank" | PAGE))
        .on_page_load(|window, page| {
            if page.event() == PageLoadEvent::Finished && page.url().as_str() == PAGE {
                let _ = window.eval(SCRIPT);
            }
        })
        .on_new_window(|_,_| NewWindowResponse::Deny)
        .on_download(|_,_| false)
        .build().map_err(err)?;
    let outcome = (|| {
        window.navigate(url).map_err(err)?;
        let deadline=Instant::now()+Duration::from_secs(28);
        let probe = r#"location.href === "https://holodori.best/robots.txt" ? globalThis.__holodoriPublicOptimizerResult ?? null : null"#;
        while Instant::now()<deadline {
            let (send,receive)=mpsc::sync_channel(1);
            window.with_webview(move |platform| {
                let fallback=send.clone();
                let submitted=(|| unsafe {
                    let view=platform.controller().CoreWebView2()?;
                    let script=CoTaskMemPWSTR::from(probe);
                    view.ExecuteScript(*script.as_ref().as_pcwstr(),&ExecuteScriptCompletedHandler::create(Box::new(move |status,result|{
                        let _=send.try_send(status.map(|_|result).map_err(err));
                        Ok(())
                    })))
                })();
                if let Err(error)=submitted { let _=fallback.try_send(Err(err(error))); }
            }).map_err(err)?;
            if let Ok(Ok(raw))=receive.recv_timeout(Duration::from_secs(3)) {
                if raw=="null" || raw.is_empty() {
                    thread::sleep(Duration::from_millis(250));
                    continue;
                }
                if raw.len()>LIMIT { return Err("Public optimizer catalog exceeds the download limit.".into()); }
                let value:Value=serde_json::from_str(&raw).map_err(err)?;
                if value["error"]==true { return Err("Public optimizer data could not be reached.".into()); }
                return Ok(value);
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err("Public optimizer catalog download timed out.".into())
    })();
    let _ = window.destroy();
    outcome
}
