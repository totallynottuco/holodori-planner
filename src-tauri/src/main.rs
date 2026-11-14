#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod store;
mod game_import;
mod catalog_update;
mod catalog_preloads;
mod optimizer_catalog;
mod outfit_assets;
mod reset_data;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use store::{atomic, safe_art_name, Backup, Result, Store, Values};
use tauri::{Manager, State};
struct Native {
    root: PathBuf,
    store: Mutex<Option<Result<Store>>>,
    pending_restore: Mutex<Option<Backup>>,
    pending_delete: Mutex<Option<DeleteTicket>>,
    closing: AtomicBool,
    smoke: Option<PathBuf>,
    stage: String,
}
struct DeleteTicket { token: String, revision: u64, prepared: std::time::Instant }
static DELETE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
#[derive(Serialize)]
struct DeleteReceipt { completed: bool, pending: bool, error: Option<String> }
#[tauri::command]
async fn desktop_prepare_delete_data(app: tauri::AppHandle) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<Native>();
        let mut pending=state.pending_delete.lock().map_err(|e|e.to_string())?;
        let revision=locked(&state,|s| {if s.restore_pending()||s.reset_pending(){return Err("Finish the current data operation first.".into());}Ok(s.snapshot.revision)})?;
        let token=format!("{}-{}-{}",std::process::id(),store::now(),DELETE_SEQUENCE.fetch_add(1,Ordering::SeqCst));
        *pending=Some(DeleteTicket {token:token.clone(),revision,prepared:std::time::Instant::now()});
        Ok(token)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn desktop_cancel_delete_data(state: State<Native>) -> Result<()> {
    *state.pending_delete.lock().map_err(|e|e.to_string())?=None;
    Ok(())
}
#[tauri::command]
async fn desktop_delete_all_data(app: tauri::AppHandle, token: String) -> Result<DeleteReceipt> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<Native>();
        let mut pending=state.pending_delete.lock().map_err(|e|e.to_string())?;
        let ticket=pending.as_ref().ok_or("Review both delete warnings first.")?;
        if ticket.token!=token {return Err("This deletion confirmation has expired. Cancel and start again.".into());}
        if ticket.prepared.elapsed()<std::time::Duration::from_millis(750) {return Err("Review the final warning before confirming.".into());}
        let result=locked(&state,|s| {
            if !s.reset_pending()&&s.snapshot.revision!=ticket.revision {return Err("Your data changed after the warning. Cancel and start again.".into());}
            match s.delete_all_data() {
                Ok(())=>Ok(DeleteReceipt {completed:true,pending:false,error:None}),
                Err(e)=>Ok(DeleteReceipt {completed:false,pending:s.reset_pending(),error:Some(e)}),
            }
        })?;
        if result.completed {*pending=None;*state.pending_restore.lock().map_err(|e|e.to_string())?=None;}
        Ok(result)
    }).await.map_err(|e|e.to_string())?
}
fn file_dialog(app: &tauri::AppHandle, title: &str) -> rfd::FileDialog {
    let dialog = rfd::FileDialog::new().set_title(title);
    match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    }
}
impl Native {
    fn open_store(&self) -> Result<std::sync::MutexGuard<'_, Option<Result<Store>>>> {
        let mut lock = self.store.lock().map_err(|e| e.to_string())?;
        if lock.is_none() {
            // The first IPC call opens the workspace on a blocking worker.
            *lock = Some(Store::open(self.root.clone()));
        }
        Ok(lock)
    }
}
fn locked<T>(state: &Native, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let mut lock = state.open_store()?;
    f(lock.as_mut().unwrap().as_mut().map_err(|e| e.clone())?)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    values: Values,
    data_dir: String,
    recovery: Vec<String>,
    revision: u64,
    smoke: Option<String>,
    animation_dir: String,
    catalog: Option<catalog_update::Bootstrap>,
    catalog_preloads: Option<catalog_preloads::Status>,
}
#[tauri::command]
async fn desktop_bootstrap(app: tauri::AppHandle) -> Result<Bootstrap> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Native>();
        let mut boot = locked(&state, |s| {
            // A WebView reload must finish a previously confirmed reset too.
            if s.reset_pending() { s.delete_all_data()?; }
            Ok(Bootstrap {
                values: s.snapshot.values.clone(),
                data_dir: s.root.display().to_string(),
                recovery: s.recovery.clone(),
                revision: s.snapshot.revision,
                animation_dir: app
                    .path()
                    .resource_dir()
                    .map_err(|e| e.to_string())?
                    .join("animations")
                    .display()
                    .to_string(),
                smoke: state.smoke.as_ref().map(|_| state.stage.clone()),
                catalog: None,
                catalog_preloads: None,
            })
        })?;
        boot.catalog = catalog_update::bootstrap(&state.root).ok();
        boot.catalog_preloads = catalog_preloads::cached_status(&state.root);
        Ok(boot)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_catalog_check(app: tauri::AppHandle) -> Result<catalog_update::Candidate> {
    tauri::async_runtime::spawn_blocking(move || catalog_update::check(&app.state::<Native>().root))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_catalog_preloads_check(app: tauri::AppHandle) -> Result<catalog_preloads::Status> {
    tauri::async_runtime::spawn_blocking(move || catalog_preloads::check(&app.state::<Native>().root))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_catalog_asset(app: tauri::AppHandle, id: String, asset_id: String, kind: String) -> Result<catalog_update::Asset> {
    tauri::async_runtime::spawn_blocking(move || catalog_update::asset(&app.state::<Native>().root, &id, &asset_id, &kind))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_catalog_write_derived(app: tauri::AppHandle, id: String, asset_id: String, kind: String, data: String) -> Result<catalog_update::Asset> {
    tauri::async_runtime::spawn_blocking(move || catalog_update::write_derived(&app.state::<Native>().root, &id, &asset_id, &kind, &data))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_catalog_commit(app: tauri::AppHandle, id: String, normalized_asset_ids: Vec<String>) -> Result<catalog_update::Bootstrap> {
    tauri::async_runtime::spawn_blocking(move || catalog_update::commit(&app.state::<Native>().root, &id, normalized_asset_ids))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_save(
    app: tauri::AppHandle,
    patch: BTreeMap<String, Option<String>>,
) -> Result<SaveReceipt> {
    tauri::async_runtime::spawn_blocking(move || locked(&app.state::<Native>(), |s| {
        let revision = s.apply(patch)?;
        Ok(SaveReceipt { revision, backup_warning: s.backup_warning.clone() })
    }))
        .await
        .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveReceipt {
    revision: u64,
    backup_warning: Option<String>,
}
#[tauri::command]
async fn desktop_backup(app: tauri::AppHandle) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || locked(&app.state::<Native>(), |s| s.backup()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_export(app: tauri::AppHandle) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = file_dialog(&app, "Export all profiles")
            .set_file_name("Holodori-Desktop-Backup.json")
            .add_filter("Holodori backup", &["json"])
            .save_file()
        else {
            return Ok(false);
        };
        let bytes = locked(&app.state::<Native>(), |s| {
            serde_json::to_vec_pretty(&s.export()?).map_err(|e| e.to_string())
        })?;
        atomic(&path, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_import(app: tauri::AppHandle) -> Result<Option<RestorePreview>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Native>();
        *state.pending_restore.lock().map_err(|e| e.to_string())? = None;
        let Some(path) = file_dialog(&app, "Restore backup")
            .add_filter("Holodori backup", &["json"])
            .pick_file()
        else {
            return Ok(None);
        };
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 256_000_000 {
            return Err("Backup exceeds the supported size.".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() > 256_000_000 {
            return Err("Backup exceeds the supported size.".into());
        }
        let backup: Backup = serde_json::from_slice(&bytes).map_err(|e| {
            format!("Invalid desktop backup: {e}. Choose a backup exported by Hololive Dreams Planner.")
        })?;
        if backup.format != "holodori-desktop-backup-v1" {
            return Err(
                "Not a desktop backup. Use Settings → Import profile for an individual profile."
                    .into(),
            );
        }
        store::validate(&backup.workspace)?;
        let mut ids: std::collections::BTreeSet<String> =
            serde_json::from_str::<Vec<String>>(&backup.workspace.values["accounts"])
                .map_err(|e| e.to_string())?
                .into_iter()
                .collect();
        ids.insert("main".into());
        let preview = RestorePreview {
            file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            profile_count: ids.len(),
            values: backup.workspace.values.clone(),
        };
        *state.pending_restore.lock().map_err(|e| e.to_string())? = Some(backup);
        Ok(Some(preview))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RestorePreview {
    file_name: String,
    profile_count: usize,
    values: Values,
}
#[tauri::command]
async fn desktop_restore(app: tauri::AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Native>();
        let mut pending = state.pending_restore.lock().map_err(|e| e.to_string())?;
        let backup = pending.as_ref().ok_or("Choose a desktop backup first.")?;
        locked(&state, |s| s.restore(backup))?;
        *pending = None;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn desktop_cancel_restore(state: State<Native>) -> Result<()> {
    *state.pending_restore.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
#[tauri::command]
async fn desktop_download(app: tauri::AppHandle, name: String, data: String) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let safe = std::path::Path::new(&name)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Holodori-export.json");
        let Some(path) = file_dialog(
            &app,
            if safe.to_ascii_lowercase().ends_with(".json") {
                "Export profile"
            } else {
                "Save image"
            },
        )
        .set_file_name(safe)
        .save_file() else {
            return Ok(false);
        };
        if data.len() > 100_000_000 {
            return Err("Export is too large.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        atomic(&path, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_art(
    app: tauri::AppHandle,
    op: String,
    key: String,
    data: Option<String>,
) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        locked(&app.state::<Native>(), |s| {
            if op != "get" && s.restore_pending() {
                return Err("Desktop restore is pending. Finish restoring or reopen Hololive Dreams Planner before editing artwork.".into());
            }
            if !safe_art_name(&key) {
                return Err("Invalid artwork key.".into());
            }
            let dir = s.root.join("artwork");
            let path = dir.join(format!("{key}.json"));
            match op.as_str() {
                "get" => {
                    if path.exists() {
                        Ok(Some(
                            std::fs::read_to_string(path).map_err(|e| e.to_string())?,
                        ))
                    } else {
                        Ok(None)
                    }
                }
                "put" => {
                    let data = data.ok_or("Missing artwork")?;
                    if data.len() > 3_000_000 {
                        return Err("Artwork exceeds the supported size.".into());
                    }
                    atomic(&path, data.as_bytes())?;
                    Ok(None)
                }
                "remove" => {
                    if path.exists() {
                        std::fs::remove_file(path).map_err(|e| e.to_string())?;
                    }
                    Ok(None)
                }
                "clear" => {
                    for f in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                        let f = f.map_err(|e| e.to_string())?;
                        if f.file_name()
                            .to_string_lossy()
                            .starts_with(&format!("{key}-"))
                        {
                            std::fs::remove_file(f.path()).map_err(|e| e.to_string())?;
                        }
                    }
                    Ok(None)
                }
                _ => Err("Unknown artwork operation.".into()),
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn desktop_open_folder(state: State<Native>) -> Result<()> {
    std::process::Command::new("explorer.exe")
        .arg(&state.root)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn desktop_close(app: tauri::AppHandle) -> Result<()> {
    let copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = copy.state::<Native>();
        let mut guard = state.open_store()?;
        if let Some(Ok(s)) = guard.as_mut() {
            if !s.restore_pending() && !s.reset_pending() {
                s.backup()?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    app.state::<Native>().closing.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn desktop_smoke_report(app: tauri::AppHandle, report: serde_json::Value) -> Result<()> {
    let s = app.state::<Native>();
    let Some(path) = &s.smoke else {
        return Err("Smoke test mode is disabled.".into());
    };
    atomic(
        path,
        &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )?;
    app.exit(if report["ok"] == true { 0 } else { 1 });
    Ok(())
}
#[tauri::command]
fn desktop_show_ready(app: tauri::AppHandle) -> Result<()> {
    let window = app.get_webview_window("main").ok_or("Main window is unavailable.")?;
    if !window.is_visible().map_err(|e| e.to_string())? {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}
fn main() {
    let mut context = tauri::generate_context!();
    let exe = std::env::current_exe().expect("Could not locate Hololive Dreams Planner");
    let directory = exe.parent().unwrap().join("outfits");
    let embedded = context.set_assets(Box::new(tauri::utils::assets::EmbeddedAssets::new(
        Default::default(), &[], Default::default(),
    )));
    context.set_assets(Box::new(outfit_assets::OutfitAssets { embedded, directory }));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false)) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
            .with_filter(|label| label == "main")
            .build())
        .setup(|app| {
            let exe = std::env::current_exe()?.parent().unwrap().to_path_buf();
            let root = std::env::var_os("HOLODORI_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    if exe.join("portable.mode").exists() {
                        exe.join("data")
                    } else {
                        app.path().app_local_data_dir().unwrap()
                    }
                });
            let args = std::env::args().collect::<Vec<_>>();
            let smoke = args
                .iter()
                .position(|s| s == "--smoke-test")
                .and_then(|i| args.get(i + 1))
                .map(PathBuf::from);
            if smoke.is_some()&&std::env::var_os("HOLODORI_DATA_DIR").is_none(){return Err("Native tests require an explicit isolated data folder.".into());}
            if args.iter().any(|s|s=="--verify-reset") && (root.file_name().and_then(|s|s.to_str())!=Some("data") || !root.parent().and_then(|p|p.file_name()).and_then(|s|s.to_str()).is_some_and(|s|s.starts_with("reset-native-smoke-")) || root.parent().and_then(|p|p.parent()).and_then(|p|p.file_name()).and_then(|s|s.to_str())!=Some("evidence")){return Err("Reset tests require a dedicated evidence/reset-native-smoke-*/data folder.".into());}
            let stage = if args.iter().any(|s|s=="--verify-filters") {
                if args.iter().any(|s|s=="--verify-restart"){ "filters-restart" }else{ "filters" }
            } else if args.iter().any(|s|s=="--verify-reset") {
                if args.iter().any(|s|s=="--verify-restart"){ "reset-restart" }else{ "reset" }
            } else if args.iter().any(|s| s == "--verify-catalog") {
                if args.iter().any(|s| s == "--verify-restart") { "catalog-restart" } else { "catalog" }
            } else if args.iter().any(|s| s == "--verify-account") {
                if args.iter().any(|s| s == "--verify-restart") { "account-restart" } else { "account" }
            } else if args.iter().any(|s| s == "--verify-restart") {
                "restart"
            } else {
                "write"
            }
            .into();
            app.manage(Native {
                store: Mutex::new(None),
                root: root.clone(),
                pending_restore: Mutex::new(None),
                pending_delete: Mutex::new(None),
                closing: AtomicBool::new(false),
                smoke,
                stage,
            });
            app.asset_protocol_scope().allow_directory(root.join("catalog-update"), true)?;
            tauri::async_runtime::spawn_blocking(move || catalog_update::prune(&root));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<Native>().closing.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(w) = window.app_handle().get_webview_window("main") {
                        let _ = w.eval("window.__holodoriDesktop?.requestClose()");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            game_import::desktop_capture_game_account,
            desktop_catalog_check,
            desktop_catalog_preloads_check,
            optimizer_catalog::desktop_optimizer_catalog_read,
            optimizer_catalog::desktop_optimizer_catalog_bytes,
            optimizer_catalog::desktop_optimizer_event_windows,
            optimizer_catalog::desktop_optimizer_event_banner,
            optimizer_catalog::desktop_optimizer_game_event_banner,
            optimizer_catalog::desktop_optimizer_catalog_stage,
            optimizer_catalog::desktop_optimizer_catalog_commit,
            optimizer_catalog::desktop_mobile_scoring_read,
            optimizer_catalog::desktop_mobile_scoring_stage,
            optimizer_catalog::desktop_mobile_scoring_commit,
            desktop_catalog_asset,
            desktop_catalog_write_derived,
            desktop_catalog_commit,
            desktop_bootstrap,
            desktop_show_ready,
            desktop_prepare_delete_data,
            desktop_cancel_delete_data,
            desktop_delete_all_data,
            desktop_save,
            desktop_backup,
            desktop_export,
            desktop_import,
            desktop_restore,
            desktop_cancel_restore,
            desktop_download,
            desktop_art,
            desktop_open_folder,
            desktop_close,
            desktop_smoke_report
        ])
        .run(context)
        .expect("Could not start Hololive Dreams Planner");
}
