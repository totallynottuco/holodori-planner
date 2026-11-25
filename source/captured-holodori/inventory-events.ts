import type { GameAccountSnapshot } from '../hololive/vendor/shared/types';

export type InventoryEventWindow = { id: string; startTime: number; endTime: number };
const badgePrefix = 'item-event_badge-';
export const isEventCurrency = (id: string) => id.startsWith(badgePrefix);

export function inventoryEventTime(snapshot: GameAccountSnapshot | undefined, localTime: number) {
  const status = snapshot?.accountStatus;
  if (!status) return localTime;
  const offset = Number(status.serverTimeMs) - Date.parse(status.observedAt);
  return Number(status.serverTimeMs) > 0 && Number.isFinite(offset) ? localTime + offset : localTime;
}

export function inventoryEventCurrency(windows: readonly InventoryEventWindow[], time: number) {
  const prefixes = windows.filter(event => event.startTime <= time && time <= event.endTime)
    .map(event => badgePrefix + event.id + '-');
  return (id: string) => !isEventCurrency(id) || prefixes.some(prefix => id.startsWith(prefix));
}

let bundledEvents: Promise<InventoryEventWindow[]> | undefined;
function readWindows(data: unknown): InventoryEventWindow[] | null {
  if (!Array.isArray(data)) return null;
  return data.flatMap(event => {
    const {id,startTime,endTime} = event ?? {};
    return typeof id === 'string' && /^[a-z0-9_-]{1,100}$/.test(id)
      && Number.isSafeInteger(startTime) && Number.isSafeInteger(endTime) && startTime < endTime
      ? [{id,startTime,endTime}] : [];
  });
}

export async function loadInventoryEvents(invoke: (name: string) => Promise<unknown>) {
  bundledEvents ??= fetch('/assets/team-optimizer/optimizer-events.json').then(async response => {
    if (!response.ok) throw Error('Event schedule unavailable');
    return readWindows((await response.json()).events) ?? [];
  }).catch(() => { bundledEvents = undefined; return []; });
  const [bundled, cached] = await Promise.all([
    bundledEvents, invoke('desktop_optimizer_event_windows').then(readWindows).catch(() => null),
  ]);
  const windows = new Map(bundled.map(event => [event.id, event]));
  for (const event of cached ?? []) windows.set(event.id, event);
  return [...windows.values()];
}
