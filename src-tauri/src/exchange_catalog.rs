//! Public listing data observed through the supported Steam client. Stored outside profiles.
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
const SCHEMA: &str = "holodori-exchange-catalog-v1";
const MAX_BYTES: usize = 2_000_000;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Offer {
    id: String,
    card: String,
    price: u32,
    limit: u32,
    start_time: Option<u64>,
    end_time: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pool { point: String, banner: String, end_time: Option<u64>, offers: Vec<Offer> }

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Capture { schema: String, pools: Vec<Pool> }

fn identifier(id: &str, prefix: &str) -> bool {
    id.len() > prefix.len() && id.len() <= 160 && id.starts_with(prefix) && id.bytes().all(|c|
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_'))
}

fn valid(data: &Capture) -> bool {
    let mut pools = BTreeSet::new();
    let time = |value: u64| (1_000_000_000_000..=4_102_444_800_000).contains(&value);
    data.schema == SCHEMA && !data.pools.is_empty() && data.pools.len() <= 128 && data.pools.iter().all(|pool| {
        let mut ids = BTreeSet::new();
        identifier(&pool.point, "gacha_point-") && pools.insert(&pool.point) &&
            !pool.banner.trim().is_empty() && pool.banner.len() <= 512 && pool.end_time.is_none_or(time) && pool.offers.len() <= 256 &&
            pool.offers.iter().all(|offer| identifier(&offer.id, "exchange_booth_") && ids.insert(&offer.id) &&
                identifier(&offer.card, "card-") && (1..=1_000_000_000).contains(&offer.price) &&
                (1..=1_000_000).contains(&offer.limit) && offer.start_time.is_none_or(time) &&
                offer.end_time.is_none_or(time) && offer.end_time.is_none_or(|end| end > offer.start_time.unwrap_or(0)))
    })
}

fn path(root: &Path) -> PathBuf { root.join("optimizer-catalog/exchange-last-good.json") }

fn read(file: &Path) -> Option<Capture> {
    crate::catalog_update::read_json(file, MAX_BYTES).ok().filter(valid)
}

fn active(file: &Path) -> Option<Capture> { read(file).or_else(|| read(&file.with_extension("bak"))) }

fn activate(root: &Path, observed: Capture, now: u64) -> Result<Option<Capture>> {
    if !valid(&observed) { return Err("The game returned an invalid exchange catalog.".into()); }
    let file = path(root);
    let current = active(&file);
    let mut pools = BTreeMap::new();
    for pool in current.iter().flat_map(|data| &data.pools) {
        if (pool.offers.is_empty() && pool.end_time.is_none_or(|end| end > now)) ||
            pool.offers.iter().any(|offer| offer.end_time.is_none_or(|end| end > now)) {
            pools.insert(pool.point.clone(), pool.clone());
        }
    }
    // A successful empty booth is authoritative. A booth absent from the capture may have failed.
    for mut pool in observed.pools {
        pool.banner = pool.banner.split_whitespace().collect::<Vec<_>>().join(" ");
        pool.offers.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        pools.insert(pool.point.clone(), pool);
    }
    let next = Capture { schema: SCHEMA.into(), pools: pools.into_values().collect() };
    if current.as_ref() == Some(&next) { return Ok(None); }
    if !valid(&next) || serde_json::to_vec(&next).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("The combined exchange catalog exceeds the supported size.".into());
    }
    // Keep a valid backup through the next atomic write after recovering a damaged primary.
    let backup = file.with_extension("bak");
    if file.exists() && read(&file).is_none() && read(&backup).is_some() {
        std::fs::copy(backup, &file).map_err(|e| e.to_string())?;
    }
    crate::catalog_update::write_json(&file, &next)?;
    Ok(Some(next))
}

#[tauri::command]
pub async fn desktop_optimizer_exchange_catalog_read(app: tauri::AppHandle) -> Result<Option<Capture>> {
    let root = app.state::<crate::Native>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        Ok(active(&path(&root)))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn desktop_optimizer_exchange_catalog_refresh(app: tauri::AppHandle) -> Result<Option<Capture>> {
    let root = app.state::<crate::Native>().root.clone();
    let reader = app.path().resource_dir().map_err(|e| e.to_string())?.join("capture/holodori-account-reader.dll");
    tauri::async_runtime::spawn_blocking(move || {
        // The game can be closed or signed out during a background catalog check.
        let Ok(observed) = crate::game_import::capture_exchanges(&reader) else { return Ok(None); };
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        activate(&root, observed, crate::store::now())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(all(test, windows))]
#[test]
#[ignore = "Uses the signed-in Steam client; leaves the planner store untouched"]
fn live_exchange_capture() {
    let reader = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/capture/holodori-account-reader.dll");
    let observed = crate::game_import::capture_exchanges(&reader).expect("Read Gacha booths from the main lobby");
    assert!(valid(&observed), "Invalid listing data: {observed:?}");
    for pool in &observed.pools {
        println!("{}: {} verified listings", pool.point, pool.offers.len());
    }
    assert!(observed.pools.iter().any(|pool| !pool.offers.is_empty()));
}
