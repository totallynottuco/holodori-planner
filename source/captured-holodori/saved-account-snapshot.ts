import {parseAccountSnapshot} from './account-import';
import type {GameAccountSnapshot} from '../hololive/vendor/shared/types';

interface SavedAccountSnapshot {
  profileName: string;
  snapshot: GameAccountSnapshot;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(text: unknown, message: string): unknown {
  if (typeof text !== 'string') throw Error(message);
  try { return JSON.parse(text); } catch { throw Error(message); }
}

function profileLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback;
}

function readSnapshot(value: unknown): GameAccountSnapshot {
  try { return parseAccountSnapshot(value); }
  catch { throw Error('This saved capture has incomplete or incompatible account data.'); }
}

function fromProfile(profile: unknown, profileName: string): SavedAccountSnapshot | undefined {
  if (!record(profile)) throw Error('This file contains an unreadable planner profile.');
  const imported = profile.gameAccountImport;
  if (imported == null) return undefined;
  if (!record(imported)) throw Error('This profile contains an unreadable account import.');
  const snapshot = readSnapshot(imported.snapshot);
  const identity = snapshot.accountStatus?.identity;
  if (imported.identity != null && (!record(imported.identity) ||
      (identity && imported.identity.publicUserId !== identity.publicUserId))) {
    throw Error('The saved capture and its planner profile identify different accounts.');
  }
  return {profileName, snapshot};
}

/** Read only the retained account observations. Workspace settings, editable
 * progress, derived totals and artwork never become inputs to the account merge. */
export function savedAccountSnapshots(text: string): SavedAccountSnapshot[] {
  if (text.length > 256_000_000) throw Error('This file exceeds the desktop backup size limit.');
  const file = readJson(text.replace(/^\uFEFF/, ''), 'Choose a JSON file containing a planner account capture.');
  if (!record(file)) throw Error('This file has no planner account capture.');
  if (file.schema === 'holodori-steam-account-v1') {
    return [{profileName: 'Account snapshot', snapshot: readSnapshot(file)}];
  }
  const emptyMessage = 'This file contains no saved game account capture.';
  if (file.game === 'hololive-dreams' &&
      (file.format === 'holodori-planner-profile-v1' || file.format === 'holodori-planner-profile-v2')) {
    const entry = fromProfile(file.profile, profileLabel(file.profileName, 'Planner profile'));
    if (!entry) throw Error(emptyMessage);
    return [entry];
  }
  if (file.format !== 'holodori-desktop-backup-v1' || !record(file.workspace) ||
      file.workspace.schema !== 1 || !record(file.workspace.values) ||
      file.workspace.values.game_id !== 'hololive-dreams') {
    throw Error('Choose a Hololive Dreams Planner desktop backup, exported profile, or account snapshot.');
  }

  const values = file.workspace.values;
  const invalidList = 'This backup contains an unreadable profile list.';
  const accounts = readJson(values.accounts, invalidList);
  if (!Array.isArray(accounts) || accounts.length > 1000 ||
      !accounts.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id))) {
    throw Error(invalidList);
  }
  const settings = values.settings === undefined ? {} : readJson(values.settings, 'This backup contains unreadable settings.');
  const names = record(settings) && record(settings.account_names) ? settings.account_names : {};
  const entries: SavedAccountSnapshot[] = [];
  for (const id of new Set<string>(['main', ...accounts])) {
    const stored = values[`${id}-holodori`];
    if (stored === undefined) continue;
    const profile = readJson(stored, 'This backup contains an unreadable planner profile.');
    const slot = id === 'main' ? 'Main' : id;
    const name = profileLabel(Object.hasOwn(names, id) ? names[id] : undefined, slot);
    const entry = fromProfile(profile, name === slot ? slot : `${name} (${slot})`);
    if (entry) entries.push(entry);
  }
  if (!entries.length) throw Error(emptyMessage);
  return entries;
}
