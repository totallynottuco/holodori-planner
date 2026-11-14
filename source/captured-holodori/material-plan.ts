/** Data adapter for captured rb/Mb and B6/vg, not a replacement renderer.
 * Source: upstream-app.js 26499–27011 and 33505–34150.
 * A material is a planning requirement, not an invented farming location.
 */
import {
  game,
  resourceGroups,
  type Cost,
  type Costs,
  type GameContext,
} from "./game";

export const materialGroups = ["level", "training", "bloom", "other"] as const;
export type MaterialGroup = (typeof materialGroups)[number];
export type PlannedMaterial = Cost & { missing: number; jarPlanned?:true };
// Mb iterates cost/category -> location type -> location -> material dictionary.
// Its empty location-type key suppresses a redundant subsection heading.
export type MaterialActivities = Record<
  MaterialGroup,
  Record<string, Record<string, Record<string, PlannedMaterial>>>
>;
export type MaterialPlanContext = GameContext & {
  getMissing?: (type: string, item: string, tier: number) => number;
  getTotal?: (type: string, item: string, tier: number) => number;
};

function cloneCost(cost: Cost): Cost {
  return {
    ...cost,
    characters: [...(cost.characters || [])],
    cones: [],
  };
}

/** Snapshot preserves the captured Item's global need/have/missing semantics.
 * Missing materials appear once globally, with all contributing card portraits.
 * The original Item's add-input and original portrait handlers remain intact.
 */
export function materialPlan(context: MaterialPlanContext) {
  const supply=game.materialSupplyFor(context);
  const totalCosts = game.totalCosts.call(context).map(cloneCost);
  const costs: Costs = Object.fromEntries(
    totalCosts.map((cost) => [cost.item, cost]),
  );
  // Fees are shared requirements. Attach the real recipients to the existing
  // coin row without allocating (or double-charging) one fee per portrait.
  const fee = costs.megaSphereCoin;
  if (fee) {
    const characters = new Set(fee.characters);
    for (const conversion of supply.conversions) {
      const recipient = costs[conversion.to];
      for (const id of recipient?.characters || []) characters.add(id);
      if (recipient?.custom) fee.custom = true;
    }
    fee.characters = [...characters];
  }
  const activities: MaterialActivities = {
    level: { "": {} },
    training: { "": {} },
    bloom: { "": {} },
    other: { "": {} },
  };
  const count = Object.fromEntries(
    materialGroups.map((group) => [group, 0]),
  ) as Record<MaterialGroup, number> & { total: number };
  for (const cost of totalCosts) {
    const missing = context.getMissing
      ? context.getMissing.call(context, cost.type, cost.item, 0)
      : game.getMissing.call(context,cost.type,cost.item,0);
    const jarPlanned=!!(supply.jars[cost.item]||supply.exchanges.some(exchange=>exchange.to===cost.item&&exchange.fromBundles));
    if (missing <= 0&&!jarPlanned) continue;
    const group = resourceGroups[cost.item];
    activities[group][""][cost.item] = {
      [cost.item]: { ...cost, missing, ...(jarPlanned?{jarPlanned:true}:{}) },
    };
    count[group]++;
  }
  count.total = materialGroups.reduce((sum, group) => sum + count[group], 0);
  return { activities, count, totalCosts };
}

export function plannerMaterials(context: MaterialPlanContext) {
  return materialPlan(context).activities;
}
