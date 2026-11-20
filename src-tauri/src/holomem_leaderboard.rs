use crate::{catalog_update, game_import, store, Native};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{ipc::Channel, AppHandle, Manager};

const FEED_PATH: &str = "/totallynottuco/hololive-dreams-planner-media/main/leaderboards/v1";
const FEED_LIMIT: usize = 3_000_000;
const REFRESH_INTERVAL: Duration = Duration::from_secs(900);
static CHECKED: [Mutex<Option<(PathBuf, Instant, bool)>>; 3] = [const { Mutex::new(None) }; 3];
static CACHE_WRITE: Mutex<()> = Mutex::new(());
static GAME_REFRESH: AtomicBool = AtomicBool::new(false);

struct GameRefresh;

impl GameRefresh {
    fn begin() -> store::Result<Self> {
        GAME_REFRESH.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| "A leaderboard refresh is already running.".into())
    }
}

impl Drop for GameRefresh {
    fn drop(&mut self) { GAME_REFRESH.store(false, Ordering::Release); }
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Region { Global, Japan, Asia }

impl Region {
    fn slug(self) -> &'static str {
        match self { Self::Global => "global", Self::Japan => "japan", Self::Asia => "asia" }
    }
    fn game_code(self) -> u8 {
        match self { Self::Global => 2, Self::Japan => 1, Self::Asia => 3 }
    }
    fn label(self) -> &'static str {
        match self { Self::Global => "Global", Self::Japan => "Japan", Self::Asia => "Asia" }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leaderboard {
    character_id: String,
    captured_at: String,
    region: Option<u8>,
    rows: Vec<Standing>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Standing {
    rank: u32,
    rating: u64,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fan_mark_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    emblems: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct Snapshot {
    schema: u32,
    region: Region,
    boards: BTreeMap<String, Leaderboard>,
}

#[derive(Serialize)]
struct Collection { snapshot: Option<Snapshot>, error: Option<String> }

fn valid_member(id: &str) -> bool {
    id.strip_prefix("chr-").is_some_and(|number| number.len() == 5 && number.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_roster(members: &[String]) -> store::Result<()> {
    let mut seen = BTreeSet::new();
    if members.is_empty() || members.len() > 256 || members.iter().any(|id| !valid_member(id) || !seen.insert(id)) {
        return Err("Invalid leaderboard roster.".into());
    }
    Ok(())
}

fn valid_board(board: &Leaderboard, character: &str, region: Region) -> bool {
    let date = board.captured_at.as_bytes();
    board.character_id == character && valid_member(character)
        && board.region == Some(region.game_code())
        && date.len() == 24
        && date.iter().enumerate().all(|(i, &b)| match i {
            4 | 7 => b == b'-', 10 => b == b'T', 13 | 16 => b == b':',
            19 => b == b'.', 23 => b == b'Z', _ => b.is_ascii_digit(),
        })
        && board.rows.len() <= 128
        && board.rows.iter().all(|row| row.rank > 0 && row.name.len() <= 1024 && row.rating <= 9_007_199_254_740_991
            && row.fan_mark_id.as_deref().is_none_or(|id| valid_cosmetic(id, "fan_mark-"))
            && row.emblems.len() <= 16 && row.emblems.iter().all(|id| valid_cosmetic(id, "emblem-")))
        && board.rows.windows(2).all(|rows| rows[0].rank <= rows[1].rank)
}

fn valid_cosmetic(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|value| !value.is_empty() && id.len() <= 160
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

fn parse_snapshot(bytes: &[u8], region: Region) -> store::Result<Snapshot> {
    let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if snapshot.schema != 1 || snapshot.region != region || snapshot.boards.is_empty()
        || snapshot.boards.len() > 256 || !snapshot.boards.iter().all(|(id, board)| valid_board(board, id, region))
    {
        return Err("The shared leaderboard snapshot is invalid.".into());
    }
    Ok(snapshot)
}

fn read_bounded(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(FEED_LIMIT as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= FEED_LIMIT).then_some(bytes)
}

fn cache_path(dir: &Path, region: Region) -> PathBuf {
    dir.join(format!("shared-{}.json", region.slug()))
}

fn cached(path: &Path, region: Region) -> Option<Snapshot> {
    [path.to_path_buf(), path.with_extension("bak")].iter()
        .find_map(|path| parse_snapshot(&read_bounded(path)?, region).ok())
}

fn update_cache(path: &Path, snapshot: Snapshot) -> store::Result<()> {
    let _writer = CACHE_WRITE.lock().map_err(|error| error.to_string())?;
    let mut boards = cached(path, snapshot.region).map(|saved| saved.boards).unwrap_or_default();
    let mut changed = false;
    for (id, board) in snapshot.boards {
        if boards.get(&id).is_none_or(|saved| board.captured_at > saved.captured_at) {
            boards.insert(id, board);
            changed = true;
        }
    }
    if changed {
        let merged = Snapshot { boards, ..snapshot };
        let bytes = serde_json::to_vec(&merged).map_err(|error| error.to_string())?;
        if bytes.len() > FEED_LIMIT { return Err("Leaderboard cache exceeds its size limit.".into()); }
        fs::create_dir_all(path.parent().ok_or("Invalid leaderboard cache folder.")?).map_err(|error| error.to_string())?;
        let backup = path.with_extension("bak");
        if path.exists() && read_bounded(path).is_none_or(|bytes| parse_snapshot(&bytes, merged.region).is_err())
            && read_bounded(&backup).is_some_and(|bytes| parse_snapshot(&bytes, merged.region).is_ok()) {
            fs::copy(&backup, path).map_err(|error| error.to_string())?;
        }
        store::atomic(path, &bytes)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_holomem_leaderboard(
    app: AppHandle, profile: String, character: String, region: Region,
) -> store::Result<Option<Leaderboard>> {
    if !store::valid_id(&profile) || !valid_member(&character) {
        return Err("Invalid profile or Holomem.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app.state::<Native>().root.join("leaderboards");
        let shared = cached(&cache_path(&directory, region), region).and_then(|mut snapshot| snapshot.boards.remove(&character));
        let old = directory.join(format!("profile-{profile}-{character}.json"));
        let local = [old.clone(), old.with_extension("bak")].iter()
            .find_map(|path| {
                let board: Leaderboard = serde_json::from_slice(&read_bounded(path)?).ok()?;
                valid_board(&board, &character, region).then_some(board)
            });
        Ok([shared, local].into_iter().flatten().max_by(|a, b| a.captured_at.cmp(&b.captured_at)))
    }).await.map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingStandings {
    captured_at: String,
    rows: Vec<(u32, u64)>,
}

#[tauri::command]
pub async fn desktop_holomem_rating_standings(app: AppHandle, region: Region) -> store::Result<BTreeMap<String, RatingStandings>> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app.state::<Native>().root.join("leaderboards");
        let Some(snapshot) = cached(&cache_path(&directory, region), region) else {
            return Ok(BTreeMap::new());
        };
        Ok(snapshot.boards.into_iter().map(|(id, board)| (id, RatingStandings {
            captured_at: board.captured_at,
            rows: board.rows.into_iter().take(100).map(|row| (row.rank, row.rating)).collect(),
        })).collect())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_refresh_holomem_rankings(app: AppHandle, region: Region, force: bool) -> store::Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.state::<Native>().root.join("leaderboards");
        let mut checked = CHECKED[usize::from(region.game_code() - 1)].lock().map_err(|error| error.to_string())?;
        if !force {
            if let Some((_, _, available)) = checked.as_ref().filter(|(root, when, _)| *root == dir && when.elapsed() < REFRESH_INTERVAL) {
                return Ok(*available);
            }
        }
        let remote = format!("{FEED_PATH}/{}.json", region.slug());
        let available = catalog_update::fetch_with_headers("raw.githubusercontent.com", &remote, FEED_LIMIT, "")
            .and_then(|bytes| parse_snapshot(&bytes, region))
            .and_then(|snapshot| update_cache(&cache_path(&dir, region), snapshot))
            .is_ok();
        *checked = Some((dir, Instant::now(), available));
        Ok(available)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_refresh_holomem_from_game(
    app: AppHandle, members: Vec<String>, region: Region, on_progress: Channel<usize>,
) -> store::Result<()> {
    validate_roster(&members)?;
    let reader = app.path().resource_dir().map_err(|error| error.to_string())?
        .join("capture/holodori-account-reader.dll");
    let directory = app.state::<Native>().root.join("leaderboards");
    let refresh = GameRefresh::begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _refresh = refresh;
        let snapshot = collect(region, &members, |id| capture_board(&reader, id), |completed| {
            let _ = on_progress.send(completed);
        })?;
        update_cache(&cache_path(&directory, region), snapshot)
    }).await.map_err(|error| error.to_string())?
}

fn capture_board(reader: &Path, id: &str) -> store::Result<Leaderboard> {
    serde_json::from_value(game_import::capture_leaderboard(reader, id)?).map_err(|error| error.to_string())
}

fn collect(
    region: Region, members: &[String], mut capture: impl FnMut(&str) -> store::Result<Leaderboard>,
    mut progress: impl FnMut(usize),
) -> store::Result<Snapshot> {
    let mut boards = BTreeMap::new();
    for id in members {
        let mut board = capture(id)?;
        if board.region != Some(region.game_code()) {
            let actual = [Region::Global, Region::Japan, Region::Asia].into_iter()
                .find(|candidate| board.region == Some(candidate.game_code()));
            return Err(match actual {
                Some(actual) => format!("Your Steam game is signed in to {}. Select {} to refresh its rankings.", actual.label(), actual.label()),
                None => "Could not verify the game’s region. Return to its home screen and try again.".into(),
            });
        }
        board.rows.sort_by_key(|row| row.rank);
        if !valid_board(&board, id, region) || boards.insert(id.clone(), board).is_some() {
            return Err(format!("The game returned invalid standings for {id}."));
        }
        progress(boards.len());
    }
    Ok(Snapshot { schema: 1, region, boards })
}

pub fn collect_from_cli() -> Option<store::Result<()>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--collect-holomem-rankings")) { return None; }
    Some((|| {
        let region = match args.next().as_deref().and_then(std::ffi::OsStr::to_str) {
            Some("global") => Region::Global, Some("japan") => Region::Japan, Some("asia") => Region::Asia,
            _ => return Err("Invalid collector region.".into()),
        };
        let output = PathBuf::from(args.next().ok_or("Missing collector output path.")?);
        let members = args.map(|id| id.into_string().map_err(|_| "Invalid collector Holomem id.")).collect::<Result<Vec<_>, _>>()?;
        validate_roster(&members)?;
        let reader = std::env::current_exe().map_err(|error| error.to_string())?
            .with_file_name("capture").join("holodori-account-reader.dll");
        let result = match collect(region, &members, |id| capture_board(&reader, id), |_| {}) {
            Ok(snapshot) => Collection { snapshot: Some(snapshot), error: None },
            Err(error) => Collection { snapshot: None, error: Some(error) },
        };
        let bytes = serde_json::to_vec(&result).map_err(|error| error.to_string())?;
        store::atomic(&output, &bytes)
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_refresh_rejects_duplicates_and_allows_retry_after_release() {
        let first = GameRefresh::begin().unwrap();
        assert_eq!(GameRefresh::begin().err().as_deref(), Some("A leaderboard refresh is already running."));
        drop(first);
        assert!(GameRefresh::begin().is_ok());
    }

    #[test]
    fn collects_the_entire_roster_in_one_pass() {
        let members = ["chr-00001".to_owned(), "chr-00002".to_owned(), "chr-00003".to_owned()];
        validate_roster(&members).unwrap();
        assert!(validate_roster(&[members[0].clone(), members[0].clone()]).is_err());
        let mut visited = Vec::new();
        let mut updates = Vec::new();
        let snapshot = collect(Region::Japan, &members, |id| {
            visited.push(id.to_owned());
            Ok(Leaderboard { character_id: id.into(), captured_at: "2026-11-16T12:00:00.000Z".into(),
                region: Some(Region::Japan.game_code()), rows: vec![] })
        }, |completed| updates.push(completed)).unwrap();
        assert_eq!(visited, members);
        assert_eq!(updates, [1, 2, 3]);
        assert_eq!(snapshot.boards.len(), members.len());
    }

    #[test]
    fn a_live_refresh_replaces_only_the_newer_board_in_the_shared_cache() {
        let directory = std::env::temp_dir().join(format!("planner-rankings-{}-{}", std::process::id(), store::now()));
        let path = cache_path(&directory, Region::Global);
        let fixture = |boards: &[(&str, &str, u64)]| Snapshot { schema: 1, region: Region::Global,
            boards: boards.iter().map(|&(id, date, rating)| (id.into(), Leaderboard {
                character_id: id.into(), captured_at: date.into(), region: Some(2),
                rows: vec![Standing { rank: 1, rating, name: "Player".into(), fan_mark_id: None, emblems: vec![] }],
            })).collect() };
        let older = "2026-11-15T12:00:00.000Z";
        let newer = "2026-11-16T12:00:00.000Z";
        update_cache(&path, fixture(&[("chr-00001", older, 100), ("chr-00002", older, 200)])).unwrap();
        update_cache(&path, fixture(&[("chr-00001", newer, 300)])).unwrap();
        update_cache(&path, fixture(&[("chr-00001", older, 100)])).unwrap();
        let snapshot = cached(&path, Region::Global).unwrap();
        assert_eq!(snapshot.boards["chr-00001"].rows[0].rating, 300);
        assert_eq!(snapshot.boards["chr-00002"].rows[0].rating, 200);
        assert!(cached(&path, Region::Japan).is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
