const directory = '/assets/team-optimizer/soundtracks/';
const updateDirectory = '/assets/team-optimizer/soundtrack-updates/';
const streamTypes = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
};
const maximumFileBytes = 80 * 1024 * 1024;
let index;
let updateIndex;
let database;

function audioDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('holodori-preview-soundtracks', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('songs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    database = undefined;
    throw error;
  });
  return database;
}

async function soundtrackTransaction(mode, operation) {
  const db = await audioDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('songs', mode);
    const request = operation(transaction.objectStore('songs'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}

function openBlob(blob) {
  const url = URL.createObjectURL(blob);
  return {url, release: () => URL.revokeObjectURL(url)};
}

export async function previewSoundtrack(songId, signal) {
  if (!/^m\d+$/.test(songId ?? '')) return null;
  const local = await soundtrackTransaction('readonly', store => store.get(songId)).catch(() => null);
  signal?.throwIfAborted();
  if (local instanceof Blob) return openBlob(local);
  index ??= fetch(directory + 'index.json').then(response => response.ok ? response.json() : {}).catch(() => ({}));
  updateIndex ??= fetch(updateDirectory + 'index.json', {cache: 'no-store'}).then(response => response.ok ? response.json() : {})
    .catch(() => ({})).finally(() => { updateIndex = undefined; });
  const update = (await updateIndex)[songId];
  if (/^[0-9a-f]{32}$/.test(update?.bankMd5) && update.name === `${songId}-${update.bankMd5}.ogg`) {
    const track = await loadTrack(updateDirectory, update, signal).catch(() => null);
    if (track) return track;
    signal?.throwIfAborted();
  }
  const track = (await index)[songId];
  if (track?.name !== songId + '.ogg') return null;
  return loadTrack(directory, track, signal);
}

async function loadTrack(root, track, signal) {
  const response = await fetch(root + track.name, {signal});
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  signal?.throwIfAborted();
  if (!bytes.byteLength) return null;
  return {...openBlob(new Blob([bytes], {type: 'audio/ogg; codecs=opus'})), duration: track.duration};
}

export async function rememberPreviewSoundtrack(songId, file) {
  if (!/^m\d+$/.test(songId ?? '')) throw new Error('Select a song first.');
  const extension = file?.name?.split('.').at(-1)?.toLowerCase();
  const type = streamTypes[extension];
  if (!type || !file.size || file.size > maximumFileBytes)
    throw new Error('Choose a supported audio file under 80 MB.');
  const blob = file.slice(0, file.size, type);
  const track = openBlob(blob);
  try {
    await new Promise((resolve, reject) => {
      const audio = new Audio();
      const result = playable => {
        clearTimeout(deadline);
        audio.onloadedmetadata = audio.onerror = null;
        audio.removeAttribute('src');
        audio.load();
        playable ? resolve() : reject(new Error('This audio file could not be played.'));
      };
      const deadline = setTimeout(() => result(false), 5000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => result(Number.isFinite(audio.duration) && audio.duration > 0);
      audio.onerror = () => result(false);
      audio.src = track.url;
    });
    await soundtrackTransaction('readwrite', store => store.put(blob, songId));
    return track;
  } catch (error) {
    track.release();
    throw error;
  }
}
