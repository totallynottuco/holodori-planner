const bundled = '/assets/team-optimizer/hit-sounds/';
const updates = '/assets/team-optimizer/hit-sound-updates/';
const cues = [
  'note-perfect', 'flick', 'critical', 'critical-flick', 'middle',
  'note-long-loop', 'critical-long-loop',
];
const rawSets = new Map();
const contexts = new WeakMap();
let bundledIndex;
let updatedIndex;
let updateCheckedAt = 0;

function fetchIndex(directory) {
  return fetch(directory + 'index.json', {cache: 'no-cache'})
    .then(response => response.ok ? response.json() : {})
    .catch(() => ({}));
}

async function libraries() {
  bundledIndex ??= fetchIndex(bundled);
  if (!updatedIndex || Date.now() - updateCheckedAt > 30_000) {
    updatedIndex = fetchIndex(updates);
    updateCheckedAt = Date.now();
  }
  return Promise.all([bundledIndex, updatedIndex]);
}

export async function previewHitSoundTypes() {
  const indexes = await libraries();
  return [...new Set(indexes.flatMap(index => Object.entries(index || {})
    .filter(([type, entry]) => /^type[1-9]\d{0,2}$/.test(type) && validEntry(entry))
    .map(([type]) => type)))]
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

function validEntry(entry) {
  return entry && /^[a-f0-9]{32}$/.test(entry.bankMd5) &&
    cues.every(cue => /^[a-f0-9]{32}\.wav$/.test(entry.cues?.[cue]));
}

function rawCues(directory, entry) {
  if (!validEntry(entry)) return null;
  const key = directory + entry.bankMd5;
  let result = rawSets.get(key);
  rawSets.delete(key);
  if (!result) {
    result = Promise.all(cues.map(async cue => {
      const response = await fetch(directory + entry.cues[cue]);
      if (!response.ok) throw new Error('Chart sound is unavailable');
      const bytes = await response.arrayBuffer();
      const header = new DataView(bytes);
      if (header.byteLength < 44 || header.getUint32(0) !== 0x52494646 ||
          header.getUint32(8) !== 0x57415645 || header.getUint32(4, true) + 8 !== header.byteLength) {
        throw new Error('Invalid chart sound');
      }
      return [cue, bytes];
    })).then(Object.fromEntries).catch(() => {
      if (rawSets.get(key) === result) rawSets.delete(key);
      return null;
    });
  }
  rawSets.set(key, result);
  if (rawSets.size > 4) rawSets.delete(rawSets.keys().next().value);
  return result;
}

async function soundSet(type) {
  const [original, update] = await libraries();
  for (const [directory, entry] of [[updates, update?.[type]], [bundled, original?.[type]]]) {
    const bytes = await rawCues(directory, entry);
    if (bytes) return {bytes, key: directory + entry.bankMd5};
  }
  return null;
}

export async function preloadPreviewHitSounds(type = 'type1') {
  await soundSet(type);
}

export async function loadPreviewHitSounds(context, type = 'type1') {
  const assets = await soundSet(type);
  if (!assets) return {};
  let decoded = contexts.get(context);
  if (!decoded) {
    decoded = new Map();
    contexts.set(context, decoded);
  }
  let sound = decoded.get(assets.key);
  if (!sound) {
    sound = Promise.all(Object.entries(assets.bytes).map(async ([cue, bytes]) => {
      try {
        // Web Audio can detach its input, so keep the preloaded bytes reusable.
        return [cue, await context.decodeAudioData(bytes.slice(0))];
      } catch {
        return [cue, null];
      }
    })).then(pairs => Object.fromEntries(pairs.filter(([, buffer]) => buffer)));
    decoded.set(assets.key, sound);
    if (decoded.size > 4) decoded.delete(decoded.keys().next().value);
  }
  return sound;
}
