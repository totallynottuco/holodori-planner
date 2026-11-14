//! Read-only comparison of names in the public Octo asset list.
use crate::catalog_update::{fetch_with_headers, read_json, write_json};
use regex::RegexSet;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

type Result<T> = std::result::Result<T, String>;
const MAX_LIST_BYTES: usize = 24_000_000;
const MAX_CACHE_BYTES: usize = 8_000_000;
const BASELINE: &str = include_str!("../data/preload-baseline.json");
static CHECK_LOCK: Mutex<()> = Mutex::new(());
static ASSET_PATTERNS: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"^img_card_(?:full|live_thumb|thin|thumb|vert)_[0-9]{5}-[1-9]-[a-z0-9-]+$",
        r"^mov_card_(?:full_[01]|sign)_[0-9]{5}-[1-9]-[a-z0-9-]+\.usm$",
        r"^img_(?:banner_|gacha_(?:logo|group_icon)_)[a-z0-9_-]+$",
        r"^img_chr_(?:full|icon_(?:mini|normal|sd)|mem_thumb|motif_(?:main|sub))_[0-9]{5}(?:[-_][a-z0-9_-]+)?$",
        r"^(?:live2d_mdl|mdl_chr_drs)_[0-9]{5}[-_][a-z0-9_-]+$",
    ])
    .expect("Static asset patterns")
});

#[derive(Deserialize, Serialize)]
struct Snapshot {
    revision: u64,
    assets: BTreeSet<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    revision: u64,
    checked_at: u64,
    added: usize,
    last_changes: Option<Changes>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    from_revision: u64,
    to_revision: u64,
    cards: BTreeMap<String, Vec<String>>,
    banners: BTreeMap<String, Vec<String>>,
    characters: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize, Serialize)]
struct Cache {
    snapshot: Snapshot,
    status: Status,
}

impl Changes {
    fn between(previous: &Snapshot, next: &Snapshot) -> Self {
        let mut result = Self {
            from_revision: previous.revision,
            to_revision: next.revision,
            cards: BTreeMap::new(),
            banners: BTreeMap::new(),
            characters: BTreeMap::new(),
        };
        for name in next.assets.difference(&previous.assets) {
            let Some(kind) = ASSET_PATTERNS.matches(name).into_iter().next() else {
                continue;
            };
            let (group, id) = match kind {
                0 | 1 => (
                    &mut result.cards,
                    name.rsplit('_').next().unwrap().trim_end_matches(".usm"),
                ),
                2 => (
                    &mut result.banners,
                    name.split_once("_lang-")
                        .map_or(name.as_str(), |(base, _)| base),
                ),
                _ => {
                    let member = name
                        .split('_')
                        .find_map(|part| {
                            let id = part.split('-').next()?;
                            (id.len() == 5 && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
                        })
                        .unwrap();
                    (&mut result.characters, member)
                }
            };
            group.entry(id.into()).or_default().push(name.clone());
        }
        result
    }
    fn count(&self) -> usize {
        [&self.cards, &self.banners, &self.characters]
            .into_iter()
            .flat_map(|group| group.values())
            .map(Vec::len)
            .sum()
    }
}

fn cache_path(root: &Path) -> PathBuf {
    root.join("catalog-update/preloads.json")
}

fn read_cache(root: &Path) -> Option<Cache> {
    let path = cache_path(root);
    read_json(&path, MAX_CACHE_BYTES)
        .or_else(|_| read_json(&path.with_extension("bak"), MAX_CACHE_BYTES))
        .ok()
}

pub fn cached_status(root: &Path) -> Option<Status> {
    read_cache(root).map(|cache| cache.status)
}

fn record(root: &Path, previous: Option<Cache>, next: Snapshot) -> Result<Status> {
    let (baseline, last_changes) = match previous {
        Some(cache) => (cache.snapshot, cache.status.last_changes),
        None => (
            serde_json::from_str(BASELINE).expect("Bundled preload baseline"),
            None,
        ),
    };
    if next.revision < baseline.revision || next.assets.len() < baseline.assets.len() * 3 / 4 {
        return Err("The public asset list is older or incomplete.".into());
    }
    let changes = Changes::between(&baseline, &next);
    let added = changes.count();
    let cache = Cache {
        status: Status {
            revision: next.revision,
            checked_at: crate::store::now(),
            added,
            last_changes: if added > 0 {
                Some(changes)
            } else {
                last_changes
            },
        },
        snapshot: next,
    };
    write_json(&cache_path(root), &cache)?;
    Ok(cache.status)
}

pub fn check(root: &Path) -> Result<Status> {
    let _guard = CHECK_LOCK.lock().map_err(|error| error.to_string())?;
    let previous = read_cache(root);
    record(root, previous, fetch_snapshot()?)
}

#[derive(Deserialize)]
struct AppDescriptor {
    android_octo_key: String,
    android_app_octo_key: String,
}

fn fetch_snapshot() -> Result<Snapshot> {
    // The public client descriptor contains distribution headers shared by all
    // app installs. The request uses no account or Steam credentials.
    let descriptor: AppDescriptor = serde_json::from_slice(&fetch_with_headers(
        "raw.githubusercontent.com",
        "/HolodoriDB/holodori-app-protos/refs/heads/main/global/appver.json",
        64_000,
        "",
    )?)
    .map_err(|error| error.to_string())?;
    let valid_key = |key: &str| {
        (16..=128).contains(&key.len())
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=_-".contains(&b))
    };
    if !valid_key(&descriptor.android_octo_key) || !valid_key(&descriptor.android_app_octo_key) {
        return Err("Invalid public asset list descriptor.".into());
    }
    let headers = format!(
        "X-OCTO-KEY: {}\r\nX-APP-OCTO-KEY: {}\r\n",
        descriptor.android_octo_key, descriptor.android_app_octo_key
    );
    let body = fetch_with_headers(
        "us.game-hololive-dreams.com",
        "/asset/v2/pub/a/5/v/200001/list/0",
        MAX_LIST_BYTES,
        &headers,
    )?;
    parse_snapshot(&decode_response(&body, &descriptor.android_octo_key)?)
}

// Only the revision and bundle/resource names are needed. Ignore the other
// protobuf fields, including object URLs, without allocating their contents.
const INVALID_LIST: &str = "Invalid public asset list.";
fn take<'a>(input: &mut &'a [u8], len: usize) -> Result<&'a [u8]> {
    let (field, rest) = input.split_at_checked(len).ok_or(INVALID_LIST)?;
    *input = rest;
    Ok(field)
}
fn varint(input: &mut &[u8]) -> Result<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let byte = take(input, 1)?[0];
        if shift == 63 && byte > 1 {
            break;
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err(INVALID_LIST.into())
}

enum Field<'a> {
    Number(u64),
    Bytes(&'a [u8]),
    Skipped,
}
fn field<'a>(input: &mut &'a [u8]) -> Result<(u64, Field<'a>)> {
    let tag = varint(input)?;
    let value = match tag & 7 {
        0 => Field::Number(varint(input)?),
        2 => {
            let len = usize::try_from(varint(input)?).map_err(|_| INVALID_LIST)?;
            Field::Bytes(take(input, len)?)
        }
        1 | 5 => {
            take(input, if tag & 7 == 1 { 8 } else { 4 })?;
            Field::Skipped
        }
        _ => return Err(INVALID_LIST.into()),
    };
    Ok((tag >> 3, value))
}

fn parse_snapshot(mut input: &[u8]) -> Result<Snapshot> {
    let mut snapshot = Snapshot {
        revision: 0,
        assets: BTreeSet::new(),
    };
    while !input.is_empty() {
        match field(&mut input)? {
            (1, Field::Number(revision)) => snapshot.revision = revision,
            (2 | 3, Field::Bytes(mut entry)) => {
                while !entry.is_empty() {
                    if let (2, Field::Bytes(bytes)) = field(&mut entry)? {
                        let name = std::str::from_utf8(bytes).map_err(|_| INVALID_LIST)?;
                        if name.len() <= 160 && ASSET_PATTERNS.is_match(name) {
                            snapshot.assets.insert(name.into());
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    if snapshot.revision == 0 || snapshot.assets.is_empty() {
        return Err(INVALID_LIST.into());
    }
    Ok(snapshot)
}

#[cfg(windows)]
fn decode_response(body: &[u8], distribution_key: &str) -> Result<Vec<u8>> {
    use sha2::{Digest, Sha256};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::*;

    let Some((iv, ciphertext)) = body.split_at_checked(16) else {
        return Err(INVALID_LIST.into());
    };
    if ciphertext.is_empty() || ciphertext.len() % 16 != 0 {
        return Err(INVALID_LIST.into());
    }
    let mut iv = iv.to_vec();
    let secret = Sha256::digest(distribution_key.as_bytes());
    let mode: Vec<u16> = "ChainingModeCBC\0".encode_utf16().collect();
    let checked = |status| {
        if status < 0 {
            Err(INVALID_LIST.to_owned())
        } else {
            Ok(())
        }
    };
    struct Algorithm(BCRYPT_ALG_HANDLE);
    impl Drop for Algorithm {
        fn drop(&mut self) {
            unsafe {
                BCryptCloseAlgorithmProvider(self.0, 0);
            }
        }
    }
    struct Key(BCRYPT_KEY_HANDLE);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                BCryptDestroyKey(self.0);
            }
        }
    }
    // CNG owns the key object when the object buffer is null.
    unsafe {
        let mut algorithm = null_mut();
        checked(BCryptOpenAlgorithmProvider(
            &mut algorithm,
            BCRYPT_AES_ALGORITHM,
            null(),
            0,
        ))?;
        let algorithm = Algorithm(algorithm);
        checked(BCryptSetProperty(
            algorithm.0,
            BCRYPT_CHAINING_MODE,
            mode.as_ptr().cast(),
            (mode.len() * 2) as u32,
            0,
        ))?;
        let mut key = null_mut();
        checked(BCryptGenerateSymmetricKey(
            algorithm.0,
            &mut key,
            null_mut(),
            0,
            secret.as_ptr(),
            secret.len() as u32,
            0,
        ))?;
        let key = Key(key);
        let mut plaintext = vec![0; ciphertext.len()];
        let mut len = 0;
        checked(BCryptDecrypt(
            key.0,
            ciphertext.as_ptr(),
            ciphertext.len() as u32,
            null(),
            iv.as_mut_ptr(),
            iv.len() as u32,
            plaintext.as_mut_ptr(),
            plaintext.len() as u32,
            &mut len,
            BCRYPT_BLOCK_PADDING,
        ))?;
        plaintext.truncate(len as usize);
        Ok(plaintext)
    }
}

#[cfg(not(windows))]
fn decode_response(_body: &[u8], _distribution_key: &str) -> Result<Vec<u8>> {
    Err("Public asset list decoding requires Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_additions_and_preserves_the_report_after_an_unchanged_check() {
        let directory = std::env::temp_dir().join(format!(
            "holodori-preload-test-{}-{}",
            std::process::id(),
            crate::store::now()
        ));
        let mut next: Snapshot = serde_json::from_str(BASELINE).unwrap();
        next.revision += 1;
        next.assets.extend(
            [
                "img_card_full_09999-5-uniq-9999-00",
                "mov_card_sign_09999-5-uniq-9999-00.usm",
                "img_banner_full_gacha-pickup-qa_lang-eng",
                "img_banner_full_gacha-pickup-qa",
                "img_chr_icon_normal_09999",
                "live2d_mdl_09999-nrml-9999-00",
            ]
            .map(str::to_owned),
        );
        let first = record(&directory, None, next).unwrap();
        assert_eq!(first.added, 6);
        let report = first.last_changes.unwrap();
        assert_eq!(report.cards["09999-5-uniq-9999-00"].len(), 2);
        assert_eq!(report.banners["img_banner_full_gacha-pickup-qa"].len(), 2);
        assert_eq!(report.characters["09999"].len(), 2);
        let previous = read_cache(&directory).unwrap();
        let next = Snapshot {
            revision: previous.snapshot.revision + 1,
            assets: previous.snapshot.assets.clone(),
        };
        let later = record(&directory, Some(previous), next).unwrap();
        assert_eq!(later.added, 0);
        assert_eq!(later.last_changes.unwrap().to_revision, report.to_revision);
        assert_eq!(cached_status(&directory).unwrap().revision, later.revision);
        let older = serde_json::from_str(BASELINE).unwrap();
        assert!(record(&directory, read_cache(&directory), older).is_err());
        assert_eq!(cached_status(&directory).unwrap().revision, later.revision);
        std::fs::remove_file(cache_path(&directory)).unwrap();
        std::fs::remove_file(cache_path(&directory).with_extension("bak")).unwrap();
        std::fs::remove_dir(directory.join("catalog-update")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "requires the public asset feed"]
    fn public_asset_feed() {
        let baseline: Snapshot = serde_json::from_str(BASELINE).unwrap();
        let current = fetch_snapshot().unwrap();
        let changes = Changes::between(&baseline, &current);
        assert!(current.revision >= baseline.revision);
        assert!(current.assets.len() >= baseline.assets.len() * 3 / 4);
        println!(
            "Public asset revision {}: {} tracked names, {} additions since {}",
            current.revision,
            current.assets.len(),
            changes.count(),
            baseline.revision
        );
    }
}
