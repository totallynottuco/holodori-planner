import {afterEach, expect, it, vi} from 'vitest';
import {loadInventoryEvents, inventoryEventCurrency} from './inventory-events';

afterEach(() => vi.unstubAllGlobals());

it('keeps bundled and cache-only currencies and applies updated dates to overlapping events', async () => {
  const bundled = [
    {id:'bundled', startTime:10, endTime:20},
    {id:'overlap', startTime:1, endTime:5},
  ];
  const cached = [
    {id:'cached', startTime:10, endTime:20},
    {id:'overlap', startTime:12, endTime:14},
  ];
  const fetchEvents = vi.fn()
    .mockRejectedValueOnce(Error('temporarily unavailable'))
    .mockResolvedValue(Response.json({events:bundled}));
  vi.stubGlobal('fetch', fetchEvents);
  expect(await loadInventoryEvents(async () => cached)).toEqual(cached);
  const windows = await loadInventoryEvents(async () => cached);
  expect(windows).toHaveLength(3);
  const keep = inventoryEventCurrency(windows, 13);
  for (const id of ['bundled','overlap','cached']) expect(keep('item-event_badge-'+id+'-01')).toBe(true);
  expect(inventoryEventCurrency(windows, 15)('item-event_badge-overlap-01')).toBe(false);
  expect(await loadInventoryEvents(async () => [])).toEqual(bundled);
  expect(fetchEvents).toHaveBeenCalledTimes(2);
});
