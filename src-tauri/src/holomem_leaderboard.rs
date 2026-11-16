use crate::{catalog_update, game_import, store, Native};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Manager};

const FEED_PATH: &str = "/totallynottuco/hololive-dreams-planner-media/main/leaderboards/v1";
const FEED_LIMIT: usize = 3_000_000;
const REFRESH_INTERVAL: Duration = Duration::from_secs(900);
static CHECKED: [Mutex<Option<(PathBuf, Instant, bool)>>; 3] = [const { Mutex::new(None) }; 3];

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

fn collect(reader: &Path, region: Region, members: &[String]) -> store::Result<Snapshot> {
    let mut boards = BTreeMap::new();
    for id in members {
        let mut board: Leaderboard = serde_json::from_value(game_import::capture_leaderboard(reader, id)?)
            .map_err(|error| error.to_string())?;
        if board.region != Some(region.game_code()) {
            return Err(format!("The game session reported region {:?}; the collector requested {}.", board.region, region.slug()));
        }
        board.rows.sort_by_key(|row| row.rank);
        if !valid_board(&board, id, region) || boards.insert(id.clone(), board).is_some() {
            return Err(format!("The game returned invalid standings for {id}."));
        }
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
        if members.is_empty() || members.len() > 256 || members.iter().any(|id| !valid_member(id)) {
            return Err("Invalid collector Holomem roster.".into());
        }
        let reader = std::env::current_exe().map_err(|error| error.to_string())?
            .with_file_name("capture").join("holodori-account-reader.dll");
        let result = match collect(&reader, region, &members) {
            Ok(snapshot) => Collection { snapshot: Some(snapshot), error: None },
            Err(error) => Collection { snapshot: None, error: Some(error) },
        };
        let bytes = serde_json::to_vec(&result).map_err(|error| error.to_string())?;
        store::atomic(&output, &bytes)
    })())
}
