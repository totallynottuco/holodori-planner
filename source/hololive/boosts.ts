export type BoostKind = "minigame" | "live";
export type BoostRecord = { amount: number; at: number };
export type Boosts = {
  minigame: BoostRecord | null;
  live: BoostRecord | null;
  holoPassport: boolean;
};
export const defaultBoosts = (): Boosts => ({
  minigame: null,
  live: null,
  holoPassport: false,
});
export const boostRules = {
  minigame: { name: "Minigame Boost", interval: 7 * 60_000, cap: 100 },
  live: { name: "Live Boost", interval: 45 * 60_000, cap: 10 },
};
export function boostCap(kind: BoostKind, passport: boolean) {
  return boostRules[kind].cap * (passport ? 2 : 1);
}
export function sampleBoost(
  record: BoostRecord,
  cap: number,
  interval: number,
  now: number,
) {
  const elapsed = Math.max(0, now - record.at),
    ticks = Math.floor(elapsed / interval),
    amount = Math.min(cap, record.amount + ticks);
  const anchor = amount >= cap ? now : record.at + ticks * interval;
  return {
    amount,
    anchor,
    nextAt: amount < cap ? anchor + interval : null,
    fullAt: amount < cap ? anchor + (cap - amount) * interval : null,
  };
}
export function setPassport(
  boosts: Boosts,
  enabled: boolean,
  now: number,
): Boosts {
  const adjusted = (kind: BoostKind): BoostRecord | null => {
    const record = boosts[kind];
    if (!record) return null;
    const sample = sampleBoost(record, boostCap(kind, boosts.holoPassport), boostRules[kind].interval, now);
    return {amount:Math.min(sample.amount, boostCap(kind, enabled)),at:sample.anchor};
  };
  return {
    ...boosts,
    holoPassport: enabled,
    minigame: adjusted("minigame"),
    live: adjusted("live"),
  };
}
