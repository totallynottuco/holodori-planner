//! Public catalog/illustration cache. Never reads or writes account profiles.
//! Candidates become last-good only after renderer validation and complete art.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

type Result<T> = std::result::Result<T, String>;
const MAX_TABLE: usize = 16_000_000;
const MAX_CANDIDATE: usize = 64_000_000;
const MAX_IMAGE: usize = 8_000_000;
const TABLES: &[&str] = &[
    "Card",
    "LangCard_Eng",
    "Character",
    "CharacterGrouping",
    "LangCharacterGrouping_Eng",
    "CharacterProduction",
    "LangCharacterProduction_Eng",
    "CharacterLevel",
    "CardLevel",
    "CardPotential",
    "CardLevelLimit",
    "Costume",
    "LangCostume_Eng",
    "SkillTreeConnectEffect",
    "SkillTreeConnectEffectExtent",
    "LangGeneratedSkillTreeConnectEffect_Eng",
    "SkillTreeNodePosition",
];
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub asset_id: String,
    pub kind: String,
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub schema: u32,
    pub candidate_id: String,
    pub source_commit: String,
    pub checked_at: u64,
    pub tables: BTreeMap<String, Value>,
    #[serde(default)]
    pub assets: BTreeMap<String, Asset>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub candidate: Option<Candidate>,
    pub asset_dir: String,
    pub warning: Option<String>,
}
#[derive(Default)]
pub struct PruneReport {
    pub removed: usize,
    pub warnings: Vec<String>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn valid_id(id: &str) -> bool {
    id.len() == 40 && id.bytes().all(|c| c.is_ascii_hexdigit())
}
fn valid_asset(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn cache(root: &Path) -> PathBuf {
    root.join("catalog-update")
}
fn directory(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err("Invalid catalog candidate.".into());
    }
    Ok(cache(root).join("candidates").join(id))
}
fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    crate::store::atomic(path, &serde_json::to_vec(value).map_err(err)?)
}
pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path, limit: usize) -> Result<T> {
    if fs::metadata(path).map_err(err)?.len() > limit as u64 {
        return Err("Catalog cache exceeds the supported size.".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    if bytes.len() > limit {
        return Err("Catalog cache exceeds the supported size.".into());
    }
    serde_json::from_slice(&bytes).map_err(err)
}
fn load(root: &Path, id: &str) -> Result<Candidate> {
    let candidate: Candidate =
        read_json(&directory(root, id)?.join("candidate.json"), MAX_CANDIDATE)?;
    if candidate.schema != 1 || candidate.candidate_id != id || candidate.source_commit != id {
        return Err("Invalid cached catalog identity.".into());
    }
    for table in TABLES {
        if !candidate.tables.get(*table).is_some_and(Value::is_array) {
            return Err(format!("Missing catalog table {table}."));
        }
    }
    Ok(candidate)
}
fn asset_ids(candidate: &Candidate) -> Result<BTreeSet<String>> {
    let rows = candidate
        .tables
        .get("Card")
        .and_then(Value::as_array)
        .ok_or("Missing card table.")?;
    if rows.is_empty() || rows.len() > 10_000 {
        return Err("Unsupported card catalog size.".into());
    }
    let mut ids = BTreeSet::new();
    for row in rows {
        let id = row
            .get("data")
            .and_then(|data| data.get("assetId"))
            .and_then(Value::as_str)
            .ok_or("Invalid card asset identity.")?;
        if !valid_asset(id) || !ids.insert(id.into()) {
            return Err("Invalid or duplicate card asset identity.".into());
        }
    }
    Ok(ids)
}
fn baseline_ids() -> BTreeSet<String> {
    let baseline: Value = serde_json::from_str(include_str!(
        "../../source/hololive/vendor/data/progression.json"
    ))
    .expect("Bundled catalog JSON");
    baseline["cards"]
        .as_array()
        .expect("Bundled cards")
        .iter()
        .filter_map(|card| card["assetId"].as_str().map(String::from))
        .collect()
}
fn image_path(asset_id: &str, kind: &str) -> Result<String> {
    if !valid_asset(asset_id) {
        return Err("Invalid card asset identity.".into());
    }
    let folder = match kind {
        "thumb" => "",
        "full" => "full/",
        "vertical" => "vertical/",
        "grid" => "grid/",
        "landscape" => "landscape/",
        _ => return Err("Unsupported card image kind.".into()),
    };
    Ok(format!("assets/cards/{folder}{asset_id}.webp"))
}
fn expected_size(kind: &str) -> Result<(u32, u32)> {
    match kind {
        "thumb" => Ok((512, 512)),
        "full" => Ok((1820, 1024)),
        "vertical" => Ok((256, 363)),
        "grid" => Ok((256, 256)),
        "landscape" => Ok((455, 256)),
        _ => Err("Unsupported card image kind.".into()),
    }
}
fn validated_bytes(
    root: &Path,
    candidate: &Candidate,
    asset_id: &str,
    kind: &str,
) -> Result<Vec<u8>> {
    let record = candidate
        .assets
        .get(&format!("{kind}:{asset_id}"))
        .ok_or("Missing cached artwork.")?;
    let expected = image_path(asset_id, kind)?;
    let size = expected_size(kind)?;
    if record.asset_id != asset_id
        || record.kind != kind
        || record.path != expected
        || record.bytes == 0
        || record.bytes > MAX_IMAGE
        || (record.width, record.height) != size
    {
        return Err("Invalid cached artwork record.".into());
    }
    let directory = directory(root, &candidate.candidate_id)?;
    let path = directory.join(expected);
    let metadata = fs::symlink_metadata(&path).map_err(err)?;
    if linked(&metadata)
        || metadata.len() != record.bytes as u64
        || !path
            .canonicalize()
            .map_err(err)?
            .starts_with(directory.canonicalize().map_err(err)?)
    {
        return Err("Cached artwork path is invalid.".into());
    }
    let bytes = fs::read(path).map_err(err)?;
    if bytes.len() != record.bytes
        || fingerprint(&bytes) != record.sha256
        || webp_size(&bytes)? != size
    {
        return Err("Cached artwork failed validation.".into());
    }
    Ok(bytes)
}
fn previous_candidates(root: &Path) -> Vec<Candidate> {
    let mut seen = BTreeSet::new();
    ["last-good.json", "last-good.bak"]
        .iter()
        .filter_map(|name| {
            let id: String = read_json(&cache(root).join(name), 256).ok()?;
            if !seen.insert(id.clone()) {
                return None;
            }
            load(root, &id).ok()
        })
        .collect()
}
fn reuse_previous_assets(root: &Path, target: &mut Candidate) {
    let Ok(ids) = asset_ids(target) else { return };
    // Return only genuinely usable records to the renderer. Otherwise a
    // truncated staged file would look cached and prevent a retry repairing it.
    let invalid: Vec<String> = target
        .assets
        .iter()
        .filter(|(_, record)| {
            !ids.contains(&record.asset_id)
                || validated_bytes(root, target, &record.asset_id, &record.kind).is_err()
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in invalid {
        target.assets.remove(&key);
    }
    for source in previous_candidates(root) {
        if source.candidate_id == target.candidate_id {
            continue;
        }
        let Ok(source_ids) = asset_ids(&source) else {
            continue;
        };
        for record in source.assets.values() {
            let id = &record.asset_id;
            let kind = &record.kind;
            if !ids.contains(id)
                || !source_ids.contains(id)
                || target.assets.contains_key(&format!("{kind}:{id}"))
            {
                continue;
            }
            let Ok(bytes) = validated_bytes(root, &source, id, kind) else {
                continue;
            };
            let Ok(relative) = image_path(id, kind) else {
                continue;
            };
            let Ok(directory) = directory(root, &target.candidate_id) else {
                continue;
            };
            let path = directory.join(relative);
            if let Some(parent) = path.parent() {
                if fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            if crate::store::atomic(&path, &bytes).is_ok() {
                target.assets.insert(format!("{kind}:{id}"), record.clone());
            }
        }
    }
}
fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn no_links_in_tree(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    if linked(&metadata) {
        return Err("Catalog cleanup skipped a linked/reparse path.".into());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(err)? {
            no_links_in_tree(&entry.map_err(err)?.path())?;
        }
    }
    Ok(())
}
/// Startup only: never call while mounted UI may still use an older cache.
/// Failures are nonfatal; unknown names and linked/reparse paths are preserved.
pub fn prune(root: &Path) -> PruneReport {
    let mut report = PruneReport::default();
    let result: Result<()> = (|| {
        let _guard = FILE_LOCK.lock().map_err(err)?;
        let base = cache(root).join("candidates");
        if !base.exists() {
            return Ok(());
        }
        for directory in [cache(root), base.clone()] {
            if linked(&fs::symlink_metadata(directory).map_err(err)?) {
                return Err("Catalog cleanup skipped a linked/reparse cache folder.".into());
            }
        }
        let base_canonical = base.canonicalize().map_err(err)?;
        if base_canonical
            != root
                .canonicalize()
                .map_err(err)?
                .join("catalog-update")
                .join("candidates")
        {
            return Err("Catalog cleanup folder is outside the intended data folder.".into());
        }
        let mut protected = BTreeSet::new();
        // Bootstrap validates these assets. Cleanup only needs to protect both
        // committed pointers, including one that may need repair on a retry.
        for pointer in ["last-good.json", "last-good.bak"] {
            if let Ok(id) = read_json::<String>(&cache(root).join(pointer), 256) {
                if valid_id(&id) { protected.insert(id); }
            }
        }
        let mut directories = Vec::new();
        let mut staged = None;
        for entry in fs::read_dir(&base).map_err(err)? {
            let entry = entry.map_err(err)?;
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !valid_id(&id) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(err)?;
            if linked(&metadata) || !metadata.is_dir() {
                report
                    .warnings
                    .push("Catalog cleanup preserved a linked or non-directory candidate.".into());
                continue;
            }
            if !protected.contains(&id) {
                if let Ok(candidate) = load(root, &id) {
                    let rank = (candidate.checked_at, id.clone());
                    if staged.as_ref().is_none_or(|previous| &rank > previous) {
                        staged = Some(rank);
                    }
                }
            }
            directories.push((id, entry.path()));
        }
        if let Some((_, id)) = staged {
            protected.insert(id);
        }
        for (id, path) in directories {
            if protected.contains(&id) {
                continue;
            }
            let deletion: Result<()> = (|| {
                // Resolve and check the final absolute target before recursive
                // removal; never follow junctions, symlinks or nested reparses.
                let target = path.canonicalize().map_err(err)?;
                if target.parent() != Some(base_canonical.as_path())
                    || target.file_name().and_then(|value| value.to_str()) != Some(id.as_str())
                {
                    return Err("Catalog cleanup target escaped its candidate folder.".into());
                }
                no_links_in_tree(&target)?;
                if path.canonicalize().map_err(err)? != target {
                    return Err("Catalog cleanup target changed.".into());
                }
                fs::remove_dir_all(&target).map_err(err)
            })();
            match deletion {
                Ok(()) => report.removed += 1,
                Err(error) => report.warnings.push(error),
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        report.warnings.push(error);
    }
    report
}
pub(crate) fn webp_size(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 30 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("Card artwork is not a complete WebP image.".into());
    }
    let riff = u32::from_le_bytes(bytes[4..8].try_into().map_err(err)?) as usize;
    if riff.checked_add(8) != Some(bytes.len()) {
        return Err("Incomplete WebP artwork.".into());
    }
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let size =
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().map_err(err)?) as usize;
        let end = offset
            .checked_add(8)
            .and_then(|n| n.checked_add(size))
            .ok_or("Invalid WebP chunk.")?;
        if end > bytes.len() {
            return Err("Incomplete WebP chunk.".into());
        }
        let data = &bytes[offset + 8..end];
        match &bytes[offset..offset + 4] {
            b"VP8X" if data.len() >= 10 => {
                let value = |p: usize| {
                    data[p] as u32 | (data[p + 1] as u32) << 8 | (data[p + 2] as u32) << 16
                };
                return Ok((value(4) + 1, value(7) + 1));
            }
            b"VP8 " if data.len() >= 10 && &data[3..6] == b"\x9d\x01\x2a" => {
                return Ok((
                    u16::from_le_bytes([data[6], data[7]]) as u32 & 0x3fff,
                    u16::from_le_bytes([data[8], data[9]]) as u32 & 0x3fff,
                ))
            }
            b"VP8L" if data.len() >= 5 && data[0] == 0x2f => {
                let bits = u32::from_le_bytes(data[1..5].try_into().map_err(err)?);
                return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            }
            _ => {}
        }
        offset = end + (size % 2);
    }
    Err("Card artwork has no supported WebP frame.".into())
}
fn verify_assets(root: &Path, candidate: &Candidate, required: &BTreeSet<String>) -> Result<()> {
    let directory = directory(root, &candidate.candidate_id)?;
    for id in required {
        for kind in ["thumb", "full", "vertical", "grid", "landscape"] {
            let record = candidate
                .assets
                .get(&format!("{kind}:{id}"))
                .ok_or("Catalog artwork is not completely cached yet.")?;
            let expected = image_path(id, kind)?;
            if record.path != expected
                || record.asset_id != *id
                || record.kind != kind
                || record.bytes > MAX_IMAGE
            {
                return Err("Invalid cached artwork record.".into());
            }
            let bytes = fs::read(directory.join(&record.path)).map_err(err)?;
            if bytes.len() != record.bytes
                || bytes.len() > MAX_IMAGE
                || fingerprint(&bytes) != record.sha256
                || webp_size(&bytes)? != expected_size(kind)?
            {
                return Err("Cached card artwork failed validation.".into());
            }
        }
    }
    Ok(())
}
pub fn bootstrap(root: &Path) -> Result<Bootstrap> {
    let mut warning = None;
    for name in ["last-good.json", "last-good.bak"] {
        let path = cache(root).join(name);
        if !path.exists() {
            continue;
        }
        let result: Result<Candidate> = (|| {
            let id: String = read_json(&path, 256)?;
            let candidate = load(root, &id)?;
            let needed = asset_ids(&candidate)?
                .difference(&baseline_ids())
                .cloned()
                .collect();
            verify_assets(root, &candidate, &needed)?;
            Ok(candidate)
        })();
        match result {
            Ok(candidate) => {
                return Ok(Bootstrap {
                    asset_dir: directory(root, &candidate.candidate_id)?
                        .to_string_lossy()
                        .into_owned(),
                    candidate: Some(candidate),
                    warning,
                })
            }
            Err(error) => {
                warning = Some(format!(
                    "Using bundled catalog; cached update could not be loaded: {error}"
                ))
            }
        }
    }
    Ok(Bootstrap {
        candidate: None,
        asset_dir: cache(root).to_string_lossy().into_owned(),
        warning,
    })
}
pub fn check(root: &Path) -> Result<Candidate> {
    // Large master-data updates can have a very large commit diff. The branch
    // reference identifies the same immutable tables without fetching a patch.
    let reference: Value = serde_json::from_slice(&fetch(
        "api.github.com",
        "/repos/HolodoriDB/holodori-db-eng-diff/git/ref/heads/main",
        16_384,
    )?)
    .map_err(err)?;
    let id = reference
        .pointer("/object/sha")
        .and_then(Value::as_str)
        .filter(|id| reference["ref"] == "refs/heads/main" && reference["object"]["type"] == "commit" && valid_id(id))
        .ok_or("Invalid public catalog commit.")?
        .to_owned();
    if load(root, &id).is_ok() {
        let _guard = FILE_LOCK.lock().map_err(err)?;
        let mut existing = load(root, &id)?;
        existing.checked_at = crate::store::now();
        reuse_previous_assets(root, &mut existing);
        write_json(&directory(root, &id)?.join("candidate.json"), &existing)?;
        return Ok(existing);
    }
    let mut tables = BTreeMap::new();
    let mut total = 0usize;
    for table in TABLES {
        let path = format!("/HolodoriDB/holodori-db-eng-diff/{id}/{table}.json");
        let bytes = fetch("raw.githubusercontent.com", &path, MAX_TABLE)?;
        total = total.saturating_add(bytes.len());
        if total > MAX_CANDIDATE / 2 {
            return Err("Public catalog exceeds the supported size.".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(err)?;
        if !value.is_array() {
            return Err(format!("Invalid public catalog table {table}."));
        }
        tables.insert((*table).into(), value);
    }
    let mut candidate = Candidate {
        schema: 1,
        candidate_id: id.clone(),
        source_commit: id.clone(),
        checked_at: crate::store::now(),
        tables,
        assets: BTreeMap::new(),
    };
    asset_ids(&candidate)?;
    let _guard = FILE_LOCK.lock().map_err(err)?;
    reuse_previous_assets(root, &mut candidate);
    write_json(&directory(root, &id)?.join("candidate.json"), &candidate)?;
    Ok(candidate)
}
fn save_asset(
    root: &Path,
    id: &str,
    asset_id: &str,
    kind: &str,
    bytes: Vec<u8>,
    return_data: bool,
) -> Result<Asset> {
    if bytes.len() > MAX_IMAGE || webp_size(&bytes)? != expected_size(kind)? {
        return Err("Card artwork has unexpected dimensions or size.".into());
    }
    let _guard = FILE_LOCK.lock().map_err(err)?;
    let mut candidate = load(root, id)?;
    if !asset_ids(&candidate)?.contains(asset_id) {
        return Err("Artwork does not belong to this public catalog.".into());
    }
    let relative = image_path(asset_id, kind)?;
    let target = directory(root, id)?.join(&relative);
    fs::create_dir_all(target.parent().ok_or("Invalid artwork path.")?).map_err(err)?;
    crate::store::atomic(&target, &bytes)?;
    let mut asset = Asset {
        asset_id: asset_id.into(),
        kind: kind.into(),
        path: relative,
        sha256: fingerprint(&bytes),
        bytes: bytes.len(),
        width: expected_size(kind)?.0,
        height: expected_size(kind)?.1,
        data: None,
    };
    candidate
        .assets
        .insert(format!("{kind}:{asset_id}"), asset.clone());
    write_json(&directory(root, id)?.join("candidate.json"), &candidate)?;
    if return_data {
        asset.data = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(asset)
}
pub fn asset(root: &Path, id: &str, asset_id: &str, kind: &str) -> Result<Asset> {
    let candidate = load(root, id)?;
    if !asset_ids(&candidate)?.contains(asset_id) {
        return Err("Unknown public card artwork.".into());
    }
    image_path(asset_id, kind)?;
    if let Ok(bytes) = validated_bytes(root, &candidate, asset_id, kind) {
        let mut result = candidate.assets[&format!("{kind}:{asset_id}")].clone();
        result.data = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
        return Ok(result);
    }
    for source in previous_candidates(root) {
        if source.candidate_id != id && asset_ids(&source).is_ok_and(|ids| ids.contains(asset_id)) {
            if let Ok(bytes) = validated_bytes(root, &source, asset_id, kind) {
                return save_asset(root, id, asset_id, kind, bytes, true);
            }
        }
    }
    let (prefix, suffix) = match kind {
        "thumb" => ("thumb", ""),
        "full" => ("full", "_unsquished"),
        "vertical" => ("vert", "_unsquished"),
        _ => return Err("Derived card artwork must be generated locally.".into()),
    };
    let name = format!("img_card_{prefix}_{asset_id}");
    let source = format!("/assets/assetbundles/{name}/{name}{suffix}.webp");
    save_asset(
        root,
        id,
        asset_id,
        kind,
        fetch("cdn.holodori.dev", &source, MAX_IMAGE)?,
        true,
    )
}
pub fn write_derived(
    root: &Path,
    id: &str,
    asset_id: &str,
    kind: &str,
    data: &str,
) -> Result<Asset> {
    if !matches!(kind, "grid" | "landscape") || data.len() > 2_800_000 {
        return Err("Invalid derived card artwork.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(err)?;
    if bytes.len() > 2_000_000 {
        return Err("Derived card artwork exceeds the supported size.".into());
    }
    save_asset(root, id, asset_id, kind, bytes, false)
}
pub fn commit(root: &Path, id: &str, normalized_asset_ids: Vec<String>) -> Result<Bootstrap> {
    let _guard = FILE_LOCK.lock().map_err(err)?;
    let candidate = load(root, id)?;
    let ids = asset_ids(&candidate)?;
    let supplied: BTreeSet<_> = normalized_asset_ids.iter().cloned().collect();
    if supplied.len() != normalized_asset_ids.len() || supplied != ids {
        return Err("Validated catalog does not match the staged public data.".into());
    }
    let needed = ids.difference(&baseline_ids()).cloned().collect();
    verify_assets(root, &candidate, &needed)?;
    let pointer = cache(root).join("last-good.json");
    if read_json::<String>(&pointer, 256).ok().as_deref() != Some(id) {
        write_json(&pointer, &id)?;
    }
    drop(_guard);
    bootstrap(root)
}

fn fetch(host: &str, path: &str, limit: usize) -> Result<Vec<u8>> {
    fetch_with_headers(host, path, limit, "")
}

pub(crate) enum PublicResponse {
    Body(Vec<u8>),
    Redirect(String),
}

pub(crate) enum PublicTransfer {
    Complete,
    Redirect(String),
}

pub(crate) fn fetch_with_headers(host: &str, path: &str, limit: usize, headers: &str) -> Result<Vec<u8>> {
    match public_request(host, path, limit, headers, false)? {
        PublicResponse::Body(bytes) => Ok(bytes),
        PublicResponse::Redirect(_) => Err("Unexpected public catalog redirect.".into()),
    }
}

pub(crate) fn public_request(host: &str, path: &str, limit: usize, headers: &str, redirect: bool) -> Result<PublicResponse> {
    let mut bytes = Vec::new();
    match public_transfer(host, path, limit, headers, redirect, None, |chunk| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })? {
        PublicTransfer::Complete => Ok(PublicResponse::Body(bytes)),
        PublicTransfer::Redirect(address) => Ok(PublicResponse::Redirect(address)),
    }
}

#[cfg(not(windows))]
pub(crate) fn public_transfer(_host: &str, _path: &str, _limit: usize, _headers: &str, _redirect: bool,
    _trusted_origin: Option<&str>, _write: impl FnMut(&[u8]) -> Result<()>) -> Result<PublicTransfer> {
    Err("Native HTTPS transport requires Windows.".into())
}
#[cfg(windows)]
pub(crate) fn public_transfer(host: &str, path: &str, limit: usize, headers: &str, redirect: bool,
    trusted_origin: Option<&str>, mut write: impl FnMut(&[u8]) -> Result<()>) -> Result<PublicTransfer> {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[link(name = "winhttp")]
    extern "system" {
        fn WinHttpOpen(
            agent: *const u16,
            access: u32,
            proxy: *const u16,
            bypass: *const u16,
            flags: u32,
        ) -> Handle;
        fn WinHttpConnect(session: Handle, server: *const u16, port: u16, reserved: u32) -> Handle;
        fn WinHttpOpenRequest(
            connection: Handle,
            verb: *const u16,
            object: *const u16,
            version: *const u16,
            referer: *const u16,
            accept: *const *const u16,
            flags: u32,
        ) -> Handle;
        fn WinHttpSetTimeouts(
            handle: Handle,
            resolve: i32,
            connect: i32,
            send: i32,
            receive: i32,
        ) -> i32;
        fn WinHttpSetOption(handle: Handle, option: u32, value: *const c_void, len: u32) -> i32;
        fn WinHttpSendRequest(
            request: Handle,
            headers: *const u16,
            len: u32,
            optional: *const c_void,
            optional_len: u32,
            total: u32,
            context: usize,
        ) -> i32;
        fn WinHttpReceiveResponse(request: Handle, reserved: *mut c_void) -> i32;
        fn WinHttpQueryHeaders(
            request: Handle,
            info: u32,
            name: *const u16,
            buffer: *mut c_void,
            len: *mut u32,
            index: *mut u32,
        ) -> i32;
        fn WinHttpReadData(request: Handle, buffer: *mut c_void, len: u32, read: *mut u32) -> i32;
        fn WinHttpCloseHandle(handle: Handle) -> i32;
    }
    struct Owned(Handle);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    if !(trusted_origin == Some(host) || matches!(
        host,
        "api.github.com" | "raw.githubusercontent.com" | "cdn.holodori.dev" | "us.game-hololive-dreams.com"
        | "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"
    )) || !path.starts_with('/')
        || path.contains('\r')
        || path.contains('\n')
    {
        return Err("Catalog URL is not allowed.".into());
    }
    let (agent, server, verb, object) = (
        wide("HololiveDreamsPlanner/1"),
        wide(host),
        wide("GET"),
        wide(path),
    );
    let failure = || {
        format!(
            "Public catalog request failed: {}",
            std::io::Error::last_os_error()
        )
    };
    let request_headers = wide(headers);
    let headers_ptr = if headers.is_empty() { std::ptr::null() } else { request_headers.as_ptr() };
    unsafe {
        let session = Owned(WinHttpOpen(
            agent.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if session.0.is_null() {
            return Err(failure());
        }
        WinHttpSetTimeouts(session.0, 1500, 3000, 3000, 8000);
        let connection = Owned(WinHttpConnect(session.0, server.as_ptr(), 443, 0));
        if connection.0.is_null() {
            return Err(failure());
        }
        let request = Owned(WinHttpOpenRequest(
            connection.0,
            verb.as_ptr(),
            object.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0x00800000,
        ));
        if request.0.is_null() {
            return Err(failure());
        }
        // No redirects, cookies or automatic authentication on public fetches.
        let disabled = 7u32;
        if WinHttpSetOption(request.0, 63, &disabled as *const _ as *const c_void, 4) == 0 {
            return Err(failure());
        }
        if WinHttpSendRequest(request.0, headers_ptr, (request_headers.len() - 1) as u32, std::ptr::null(), 0, 0, 0) == 0
            || WinHttpReceiveResponse(request.0, std::ptr::null_mut()) == 0
        {
            return Err(failure());
        }
        let mut status = 0u32;
        let mut length = 4u32;
        if WinHttpQueryHeaders(
            request.0,
            19 | 0x20000000,
            std::ptr::null(),
            &mut status as *mut _ as *mut c_void,
            &mut length,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(failure());
        }
        if redirect && matches!(status, 301 | 302 | 303 | 307 | 308) {
            let mut location = [0u16; 4096];
            let mut length = std::mem::size_of_val(&location) as u32;
            if WinHttpQueryHeaders(
                request.0, 33, std::ptr::null(), location.as_mut_ptr().cast(),
                &mut length, std::ptr::null_mut(),
            ) == 0 {
                return Err("The download redirect could not be read.".into());
            }
            let address = String::from_utf16(&location[..length as usize / 2])
                .map_err(|_| "The download redirect is invalid.")?;
            return Ok(PublicTransfer::Redirect(address.trim_end_matches('\0').to_owned()));
        }
        if status != 200 {
            return Err(format!("Public catalog request returned HTTP {status}."));
        }
        let mut received = 0usize;
        let mut buffer = [0u8; 65536];
        loop {
            let mut read = 0u32;
            if WinHttpReadData(
                request.0,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                &mut read,
            ) == 0
            {
                return Err(failure());
            }
            if read == 0 {
                break;
            }
            received = received.saturating_add(read as usize);
            if received > limit {
                return Err("Public catalog response exceeds the supported size.".into());
            }
            write(&buffer[..read as usize])?;
        }
        Ok(PublicTransfer::Complete)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn isolated_root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../evidence/catalog-update/native-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn candidate(root: &Path, id: &str, asset: &str) -> Candidate {
        let mut tables = BTreeMap::new();
        for table in TABLES {
            tables.insert((*table).into(), serde_json::json!([]));
        }
        tables.insert(
            "Card".into(),
            serde_json::json!([{"id":"qa-card","data":{"assetId":asset}}]),
        );
        let candidate = Candidate {
            schema: 1,
            candidate_id: id.into(),
            source_commit: id.into(),
            checked_at: 0,
            tables,
            assets: BTreeMap::new(),
        };
        write_json(
            &directory(root, id).unwrap().join("candidate.json"),
            &candidate,
        )
        .unwrap();
        candidate
    }
    fn fixture(kind: &str) -> Vec<u8> {
        let baseline: Value = serde_json::from_str(include_str!(
            "../../source/hololive/vendor/data/progression.json"
        ))
        .unwrap();
        let id = baseline["cards"][0]["assetId"].as_str().unwrap();
        fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../hololive-assets")
                .join(image_path(id, kind).unwrap()),
        )
        .unwrap()
    }
    #[test]
    fn rejects_paths_and_partial_art() {
        assert!(!valid_id("../"));
        assert!(!valid_asset("../other"));
        assert!(image_path("x", "unknown").is_err());
        assert!(webp_size(b"RIFF bad WEBP").is_err());
        assert!(webp_size(&[0; 64]).is_err());
    }
    #[test]
    fn candidate_cannot_drop_unsupported_card_rows() {
        let candidate = Candidate {
            schema: 1,
            candidate_id: "a".repeat(40),
            source_commit: "a".repeat(40),
            checked_at: 0,
            tables: BTreeMap::from([(
                "Card".into(),
                serde_json::json!([{"data":{"assetId":"valid-card"}},{"data":{"assetId":"../bad"}}]),
            )]),
            assets: BTreeMap::new(),
        };
        assert!(asset_ids(&candidate).is_err());
    }
    #[test]
    fn activation_requires_all_art_and_keeps_last_good_after_failure() {
        let root = isolated_root();
        let id = "b".repeat(40);
        let asset = "qa-new-card";
        candidate(&root, &id, asset);
        assert!(commit(&root, &id, vec![asset.into()]).is_err());
        assert!(bootstrap(&root).unwrap().candidate.is_none());
        for kind in ["thumb", "full", "vertical", "grid", "landscape"] {
            save_asset(&root, &id, asset, kind, fixture(kind), false).unwrap();
        }
        assert!(commit(&root, &id, vec![]).is_err());
        assert_eq!(
            commit(&root, &id, vec![asset.into()])
                .unwrap()
                .candidate
                .unwrap()
                .candidate_id,
            id
        );
        // A new candidate with incomplete files cannot replace this pointer.
        let incomplete = "c".repeat(40);
        candidate(&root, &incomplete, "qa-next-card");
        assert!(commit(&root, &incomplete, vec!["qa-next-card".into()]).is_err());
        assert_eq!(
            bootstrap(&root).unwrap().candidate.unwrap().candidate_id,
            id
        );
        let path = directory(&root, &id)
            .unwrap()
            .join(image_path(asset, "landscape").unwrap());
        fs::write(path, b"truncated").unwrap();
        let recovered = bootstrap(&root).unwrap();
        assert!(recovered.candidate.is_none());
        assert!(recovered.warning.is_some());
    }
    #[test]
    fn corrupt_primary_pointer_recovers_previous_complete_catalog() {
        let root = isolated_root();
        let asset = baseline_ids().into_iter().next().unwrap();
        for id in ["d".repeat(40), "e".repeat(40)] {
            candidate(&root, &id, &asset);
            commit(&root, &id, vec![asset.clone()]).unwrap();
        }
        fs::write(cache(&root).join("last-good.json"), b"broken").unwrap();
        let recovered = bootstrap(&root).unwrap();
        assert_eq!(recovered.candidate.unwrap().candidate_id, "d".repeat(40));
        assert!(recovered.warning.is_some());
    }
    #[test]
    fn reuses_verified_art_between_public_commits_without_network() {
        let root = isolated_root();
        let source_id = "1".repeat(40);
        let asset_id = "qa-reused-card";
        candidate(&root, &source_id, asset_id);
        for kind in ["thumb", "full", "vertical", "grid", "landscape"] {
            save_asset(&root, &source_id, asset_id, kind, fixture(kind), false).unwrap();
        }
        commit(&root, &source_id, vec![asset_id.into()]).unwrap();
        let target_id = "2".repeat(40);
        candidate(&root, &target_id, asset_id);
        // Derived artwork can never be downloaded by asset(). Its success
        // demonstrates that a different public revision reused local bytes.
        let landscape = asset(&root, &target_id, asset_id, "landscape").unwrap();
        assert_eq!(landscape.sha256, fingerprint(&fixture("landscape")));
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(landscape.data.unwrap())
                .unwrap(),
            fixture("landscape")
        );
        let mut next = candidate(&root, &"3".repeat(40), asset_id);
        reuse_previous_assets(&root, &mut next);
        assert_eq!(next.assets.len(), 5);
        for kind in ["thumb", "full", "vertical", "grid", "landscape"] {
            assert_eq!(
                validated_bytes(&root, &next, asset_id, kind).unwrap(),
                fixture(kind)
            );
        }
        // Neither a hash mismatch nor an ID outside the new master table is
        // allowed to propagate into another staged revision.
        fs::write(
            directory(&root, &source_id)
                .unwrap()
                .join(image_path(asset_id, "full").unwrap()),
            b"corrupt",
        )
        .unwrap();
        let mut damaged = load(&root, &source_id).unwrap();
        reuse_previous_assets(&root, &mut damaged);
        assert!(
            !damaged.assets.contains_key(&format!("full:{asset_id}")),
            "Broken staged records must be removed so a UI retry can repair them."
        );
        let mut broken = candidate(&root, &"4".repeat(40), asset_id);
        reuse_previous_assets(&root, &mut broken);
        assert!(!broken.assets.contains_key(&format!("full:{asset_id}")));
        let mut unrelated = candidate(&root, &"5".repeat(40), "qa-unrelated-card");
        reuse_previous_assets(&root, &mut unrelated);
        assert!(unrelated.assets.is_empty());
    }
    #[test]
    fn startup_prune_keeps_both_good_pointers_and_newest_stage_only() {
        let root = isolated_root();
        let asset = baseline_ids().into_iter().next().unwrap();
        let first = "1".repeat(40);
        let second = "2".repeat(40);
        let newest = "3".repeat(40);
        let old = "4".repeat(40);
        let stale = "5".repeat(40);
        for id in [&first, &second] {
            candidate(&root, id, &asset);
            commit(&root, id, vec![asset.clone()]).unwrap();
        }
        for (id, at) in [(&newest, 100), (&old, 50)] {
            let mut value = candidate(&root, id, &asset);
            value.checked_at = at;
            write_json(
                &directory(&root, id).unwrap().join("candidate.json"),
                &value,
            )
            .unwrap();
        }
        fs::create_dir_all(directory(&root, &stale).unwrap()).unwrap();
        let notes = cache(&root).join("candidates/my-notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("keep.txt"), b"untouched").unwrap();
        let result = prune(&root);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert_eq!(result.removed, 2);
        for id in [&first, &second, &newest] {
            assert!(directory(&root, id).unwrap().exists());
        }
        for id in [&old, &stale] {
            assert!(!directory(&root, id).unwrap().exists());
        }
        assert_eq!(fs::read(notes.join("keep.txt")).unwrap(), b"untouched");
        assert_eq!(
            bootstrap(&root).unwrap().candidate.unwrap().candidate_id,
            second
        );
        assert_eq!(prune(&root).removed, 0);
    }
    #[test]
    #[ignore = "Explicit live public-network check; no account data is read or sent."]
    fn live_public_feed_uses_native_https_transport() {
        let root = isolated_root();
        let public = check(&root).unwrap();
        assert!(asset_ids(&public).unwrap().len() >= baseline_ids().len());
        assert_eq!(
            load(&root, &public.candidate_id).unwrap().source_commit,
            public.source_commit
        );
    }
}
