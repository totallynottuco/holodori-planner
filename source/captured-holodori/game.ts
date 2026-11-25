/** Game-only boundary for the preserved Seelie Vue runtime.
 * No renderer, component, stylesheet or application bootstrap is imported here.
 * Original contract: $k.data / Sk.computed.totalCosts / Sk.methods at
 * upstream-app.js 58844–59743. The game formulas below use the reviewed
 * Holodori manifest; the captured components remain the UI implementation.
 */
import { progressionManifest as manifest } from "../hololive/vendor/shared/manifest";
import { resourceKeys as storedResourceKeys } from "../hololive/vendor/shared/types";
import { accountManifest, refreshAccountCatalogIndexes } from "../hololive/vendor/shared/account-data";
import type { CatalogOverlay } from "./catalog-update";
import {materialJarStock,planBundleExchanges,planCrystalSupply,planMaterialJars,remainingBeadBundles,type MaterialJarPlan} from "./material-jars";
import {
  upgradeRecipes, loungeRecipes, sodaPopCoin, batchAmounts, conversionRecipe,
  type PlannerResource,
  applyManualConversion,
} from "./conversions";
import type {
  CardCatalogEntry,
  AppProfileV2,
  GameAccountSnapshot,
  ResourceKey as MaterialKey,
  Rarity,
} from "../hololive/vendor/shared/types";

type ResourceKey = PlannerResource;
export const resourceKeys = [...storedResourceKeys, sodaPopCoin] as const;
export { manifest };
export type LevelState = {
  level: number;
  asc: number;
  expIntoLevel?: number;
  text?: string;
};
export type CharacterGoal = {
  type: "character";
  character: string;
  current: LevelState;
  goal: LevelState;
  eidolon?: number;
  goalBloom?: number;
  favorite?: boolean;
  [key: string]: unknown;
};
export type TrainingGoal = {
  type: "trace";
  character: string;
  sp: { current: number; goal: number };
  bonus?: Record<string, boolean>;
  [key: string]: unknown;
};
export type SeelieGoal =
  | CharacterGoal
  | TrainingGoal
  | { type: string; character?: string; [key: string]: any };
export type InventoryEntry = {
  type: string;
  item: string;
  tier: number;
  value: number;
};
export type Cost = {
  type: ResourceKey;
  item: ResourceKey;
  need: number;
  characters?: string[];
  cones?: never[];
  custom?: boolean;
  exchangeFee?: number;
};
export type Costs = Partial<Record<ResourceKey, Cost>>;
export type GameContext = {
  account?: string;
  $root?: {data?: Record<string,any>;materialSupply?:MaterialSupply};
  getNeed?: (type:string,item:string,tier:number)=>number;
  goals?: SeelieGoal[];
  inventory?: InventoryEntry[];
  inactive?: Record<string, boolean>;
  custom_items?: { type: string; item: string; tier: number; value: number }[];
  setInventory?: (
    type: string,
    item: string,
    tier: number,
    value: number,
  ) => void;
};

const catalog = new Map(manifest.cards.map((card) => [card.id, card]));
type CardImages = Partial<Record<"grid" | "full" | "vertical" | "landscape", string>>;
let catalogImages: ReadonlyMap<string, CardImages> = new Map();
const validResource = new Set<string>(resourceKeys);
const clamp = (value: unknown, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)));
const stage = (value: unknown) => clamp(value, 0, 4);
export const resourceType = (key: ResourceKey) => key;
export const resourceGroups: Record<
  ResourceKey,
  "level" | "training" | "bloom" | "other"
> = {
  lessonPoints: "level",
  cuteBeads: "training",
  cuteCrystals: "training",
  pureBeads: "training",
  pureCrystals: "training",
  happyBeads: "training",
  happyCrystals: "training",
  hololium: "training",
  redCube: "other",
  redHexa: "other",
  redStarCube: "other",
  blueCube: "other",
  blueHexa: "other",
  yellowCube: "other",
  yellowHexa: "other",
  greenCube: "other",
  greenHexa: "other",
  hologold: "other",
  harmonyGardenCoin: "other",
  megaSphereCoin: "other",
  [sodaPopCoin]: "other",
  bloomStones: "bloom",
};
export const resourceLabels: Record<ResourceKey, string> = {
  lessonPoints: "Lesson Pt",
  cuteBeads: "Cute Beads",
  cuteCrystals: "Cute Crystals",
  pureBeads: "Pure Beads",
  pureCrystals: "Pure Crystals",
  happyBeads: "Happy Beads",
  happyCrystals: "Happy Crystals",
  hololium: "Hololium",
  redCube: "Red Cube",
  redHexa: "Red Hexa",
  redStarCube: "Red Star Cube",
  blueCube: "Blue Cube",
  blueHexa: "Blue Hexa",
  yellowCube: "Yellow Cube",
  yellowHexa: "Yellow Hexa",
  greenCube: "Green Cube",
  greenHexa: "Green Hexa",
  hologold: "Hologold",
  harmonyGardenCoin: "Harmony Garden Coin",
  megaSphereCoin: "Mega Sphere Coin",
  [sodaPopCoin]: "Soda Pop Coin",
  bloomStones: "Bloom Stones",
};
export function getCard(id: string): CardCatalogEntry | undefined {
  return catalog.get(id);
}

export function rulesFor(id: string | Rarity) {
  const rarity = typeof id === "number" ? id : catalog.get(id)?.rarity;
  if (!rarity) throw new Error(`Unknown Holodori card: ${id}`);
  return manifest.rarities[String(rarity) as "3" | "4" | "5"];
}
export function minimumStage(id: string, level: number) {
  const rules = rulesFor(id);
  if (level <= rules.initialLevelCap) return 0;
  const training = rules.trainingStages.find((item) => level <= item.levelCap);
  if (!training) throw new Error(`Level ${level} exceeds this card's maximum`);
  return training.stage;
}

/** Original Ih picker state shape; distinct cap/SP-upgrade states remain distinct. */
export function levelStates(id: string): LevelState[] {
  const rules = rulesFor(id),
    states: LevelState[] = [{ level: 1, asc: 0 }];
  for (let level = 10; level <= rules.initialLevelCap; level += 10)
    states.push({ level, asc: 0 });
  let previousCap = rules.initialLevelCap;
  for (const training of rules.trainingStages) {
    states.push({ level: previousCap, asc: training.stage });
    for (let level = previousCap + 10; level <= training.levelCap; level += 10)
      states.push({ level, asc: training.stage });
    previousCap = training.levelCap;
  }
  return states;
}
export const trainingStates = () =>
  Array.from({ length: 5 }, (_, level) => ({ level, asc: 0 }));
export function ascendedLevels(id: string) {
  const rules = rulesFor(id),
    result: Record<number, number> = {};
  let cap = rules.initialLevelCap;
  for (const training of rules.trainingStages) {
    result[cap] = training.stage;
    cap = training.levelCap;
  }
  return result;
}

export const characters = Object.fromEntries(
  manifest.cards.map((card) => [
    card.id,
    {
      id: card.id,
      name: `${card.memberName} · ${card.cardName}`,
      memberName: card.memberName,
      cardName: card.cardName,
      tier: card.rarity,
      type: card.attribute,
      path: card.stat,
      release: "2020-01-01",
      show: "2020-01-01",
      assetId: card.assetId,
      group: card.groupLabel,
      eidolons: {},
      maxLevel: rulesFor(card.rarity).maxLevel,
    },
  ]),
) as Record<
  string,
  {
    id: string;
    name: string;
    memberName: string;
    cardName: string;
    tier: Rarity;
    type: string;
    path: string;
    release: string;
    show: string;
    assetId: string;
    group: string;
    eidolons: Record<string, never>;
    maxLevel: number;
  }
>;
export const items = Object.fromEntries(
  resourceKeys.map((key) => [
    key,
    {
      type: key,
      group: resourceGroups[key],
      name: resourceLabels[key],
      release: "2020-01-01",
      show: "2020-01-01",
    },
  ]),
) as Record<
  ResourceKey,
  {
    type: ResourceKey;
    group: string;
    name: string;
    release: string;
    show: string;
  }
>;
export const translations: Record<string, string> = {
  ...Object.fromEntries(
    manifest.cards.map((card) => [
      card.id,
      `${card.memberName} · ${card.cardName}`,
    ]),
  ),
  ...resourceLabels,
  cute: "Cute",
  pure: "Pure",
  happy: "Happy",
  performance: "Performance",
  technique: "Technique",
  sense: "Sense",
  sp: "SP Training",
};
export function data() {
  return {
    characters,
    items,
    types: ["cute", "pure", "happy"],
    paths: ["performance", "technique", "sense"],
    cones: {},
    relics: {},
    farming: {},
    drops: {},
    resin: {},
    bonusTraces: [],
    newBonusTraces: [],
    customBonus: [],
    maxTier: {},
    talentTypes: {
      sp: { key: "sp", short: "SP", class: "from-purple-500 to-purple-700/80" },
    },
    tierClass: {},
    itemTierClass: Object.fromEntries(
      resourceKeys.map((key) => [key, "from-gray-500 to-gray-900"]),
    ),
  };
}

const bundledAccount = { ...accountManifest };

/** Install only normalized, fully cached data before the captured app hydrates.
 * Existing objects retain their identities for the captured renderer contracts. */
export function installCatalogData(overlay: CatalogOverlay, images: Record<string, CardImages>) {
  const nextImages = new Map<string, CardImages>();
  for (const [id, variants] of Object.entries(images)) {
    for (const url of Object.values(variants))
      if (!/^(?:asset:|https?:\/\/asset\.localhost\/)/.test(url)) throw Error("Catalog artwork must be local.");
    nextImages.set(id, Object.freeze({ ...variants }));
  }
  manifest.cards.splice(0, manifest.cards.length, ...overlay.cards);
  manifest.cumulativeExperience = [...overlay.cumulativeExperience];
  manifest.rarities = overlay.rarities;
  manifest.metadata.catalogVersion = overlay.catalogVersion;
  manifest.metadata.sourceCommit = overlay.sourceCommit;
  accountManifest.metadata.sourceCommit = overlay.sourceCommit;
  // Catalog overlays carry collection artwork. Board definitions are reviewed independently.
  // Keep positions that an older collection cache predates unless a newer position occupies that cell.
  const templates = new Map(bundledAccount.templates.map(template => [template.id, template]));
  for (const template of overlay.templates) {
    const missing = (templates.get(template.id)?.nodes ?? []).filter(node => !template.nodes.some(row =>
      row.nodeGroupId === node.nodeGroupId || (row.x === node.x && row.y === node.y)));
    templates.set(template.id, { ...template, nodes: [...template.nodes, ...missing] });
  }
  accountManifest.templates = [...templates.values()];
  const connectIds = { ...bundledAccount.cardConnectEffectIds };
  for (const id of Object.keys(overlay.cardParameterProfiles)) delete connectIds[id];
  accountManifest.cardConnectEffectIds = { ...connectIds, ...overlay.cardConnectEffectIds };
  for (const key of ["cardParameterProfiles", "cardLevelBases", "cardPotentialParameterBonuses", "connectEffects", "connectExtents"] as const)
    Object.assign(accountManifest, { [key]: { ...bundledAccount[key], ...overlay[key] } });
  for (const key of ["characters", "productions", "groups", "memberLevelGroups", "costumes"] as const)
    Object.assign(accountManifest, { [key]: overlay[key] });
  refreshAccountCatalogIndexes();
  catalog.clear();
  for (const id of Object.keys(characters)) { delete characters[id]; delete translations[id]; }
  for (const card of overlay.cards) {
    catalog.set(card.id, card);
    const name = `${card.memberName} · ${card.cardName}`;
    characters[card.id] = { id: card.id, name, memberName: card.memberName, cardName: card.cardName, tier: card.rarity, type: card.attribute, path: card.stat, release: "2020-01-01", show: "2020-01-01", assetId: card.assetId, group: card.groupLabel, eidolons: {}, maxLevel: rulesFor(card.rarity).maxLevel };
    translations[card.id] = name;
  }
  catalogImages = nextImages;
}

function cardGoals(goals: SeelieGoal[], id: string) {
  return {
    level: goals.find(
      (goal) => goal.type === "character" && goal.character === id,
    ) as CharacterGoal | undefined,
    training: goals.find(
      (goal) => goal.type === "trace" && goal.character === id,
    ) as TrainingGoal | undefined,
  };
}

// Android UserCard.CanPotentialUpgradeAtTargetCount (0xE7F29F4) compares
// card points plus usable stones with target minus current. The master
// CardPotentialUpgradeItem table supplies the stone only for five-star cards.
export function bloomRequirements(context: GameContext) {
  const profile=context.$root?.data?.[`${context.account??'main'}-holodori`] as AppProfileV2|undefined;
  const balances=new Map(profile?.currentDataVersion===1?[]:profile?.gameAccountImport?.snapshot.tables.cards.map(row=>[row.cardId,row.potentialUpgradePointQuantity]));
  for(const [id,card] of Object.entries(profile?.cards??{}))balances.set(id,card.bloomPoints);
  const seen=new Set<string>();
  return (context.goals??[]).flatMap(record=>{
    if(record.type!=='character'||!record.character||seen.has(record.character))return [];
    const goal=record as CharacterGoal, id=goal.character, card=catalog.get(id);
    seen.add(id);
    if(!card||context.inactive?.[id])return [];
    const current=clamp(goal.eidolon,0,manifest.bloom.maxStage);
    const target=clamp(goal.goalBloom,current,manifest.bloom.maxStage);
    if(current===target)return [];
    const points=Math.min(target-current,balances.get(id)??0);
    return [{id,current,target,points,remaining:target-current-points,usesStones:card.rarity===5}];
  });
}
function currentStage(context: GameContext, goal: SeelieGoal) {
  const all = cardGoals(context.goals || [], String(goal.character));
  return Math.max(
    stage(goal.type === "character" ? goal.current?.asc : goal.sp?.current),
    stage(all.level?.current.asc),
    stage(all.training?.sp?.current),
  );
}
function add(costs: Costs, key: ResourceKey, need: number) {
  if (need > 0)
    costs[key] = {
      ...costs[key],
      type: key,
      item: key,
      need: (costs[key]?.need || 0) + need,
    };
}
function trainingCosts(id: string, from: number, to: number) {
  const card = catalog.get(id),
    costs: Costs = {};
  if (!card) return costs;
  const beads = `${card.attribute}Beads` as ResourceKey,
    crystals = `${card.attribute}Crystals` as ResourceKey;
  for (const training of rulesFor(id).trainingStages)
    if (training.stage > from && training.stage <= to) {
      add(costs, beads, training.cost.beads);
      add(costs, crystals, training.cost.crystals);
      add(costs, "hologold", training.cost.hologold);
      add(costs, "hololium", training.cost.hololium);
    }
  return costs;
}
function merge(into: Costs, from: Costs) {
  for (const [key, cost] of Object.entries(from))
    if (cost) add(into, key as ResourceKey, cost.need);
  return into;
}
const ordered = (costs: Costs) =>
  Object.fromEntries(
    resourceKeys.filter((key) => costs[key]).map((key) => [key, costs[key]]),
  ) as Costs;
/** Read legacy captured quantities without rewriting the original saved data. */
export function inventoryQuantity(value: unknown) {
  if(typeof value!=="number"&&typeof value!=="string")return 0;
  const amount=Number(value);
  return Number.isFinite(amount)?Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.trunc(amount))):0;
}
function held(context: GameContext, key: ResourceKey) {
  return inventoryQuantity(
    context.inventory?.find(
      (entry) => entry.item === key && entry.type === key && entry.tier === 0,
    )?.value || 0
  );
}
export type Conversion = ReturnType<typeof batchAmounts>;
export function projectedConversions(context: GameContext, costs: Costs): Conversion[] {
  const supply = allocateMaterialSupply(costs, key => held(context, key), new Map(), true);
  const counts = new Map<string,number>();
  for (const exchange of supply.conversions)
    counts.set(exchange.recipeId, (counts.get(exchange.recipeId) ?? 0) + exchange.batches);
  return Array.from(counts, ([id, batches]) => batchAmounts(conversionRecipe(id), batches));
}
function withConversionFees(context: GameContext, costs: Costs, conversions=projectedConversions(context,costs)) {
  const next: Costs = Object.fromEntries(
    Object.entries(costs).map(([key, cost]) => [key, { ...cost }]),
  );
  for (const conversion of conversions) {
    add(next, conversion.feeKey, conversion.fee);
    const cost = next[conversion.feeKey]!;
    cost.exchangeFee = (cost.exchangeFee ?? 0) + conversion.fee;
  }
  return ordered(next);
}

/** Bind as Sk.methods.characterCosts. No XP-item conversion or unrelated currency cost. */
function rawCharacterCosts(context: GameContext, goal: CharacterGoal, knownCurrentSP?: number): Costs {
  const id = goal.character;
  if (!catalog.has(id)) return {};
  const max = rulesFor(id).maxLevel,
    current = clamp(goal.current?.level, 1, max),
    target = clamp(goal.goal?.level, current, max),
    from = knownCurrentSP ?? currentStage(context, goal),
    to = Math.max(from, stage(goal.goal?.asc), minimumStage(id, target)),
    costs = trainingCosts(id, from, to);
  const partial = clamp(
    goal.current?.expIntoLevel,
    0,
    (manifest.cumulativeExperience[current] || 0) -
      (manifest.cumulativeExperience[current - 1] || 0) -
      1,
  );
  add(
    costs,
    "lessonPoints",
    Math.max(
      0,
      manifest.cumulativeExperience[target - 1] -
        manifest.cumulativeExperience[current - 1] -
        partial,
    ),
  );
  return ordered(costs);
}
export function characterCosts(this: GameContext, goal: CharacterGoal): Costs {
  return withConversionFees(this, rawCharacterCosts(this, goal));
}

export function traceCosts(this: GameContext, goal: TrainingGoal): Costs {
  if (!catalog.has(goal.character)) return {};
  return withConversionFees(
    this,
    trainingCosts(
      goal.character,
      currentStage(this, goal),
      Math.max(currentStage(this, goal), stage(goal.sp?.goal)),
    ),
  );
}
export function goalCosts(this: GameContext, goal: SeelieGoal): Costs {
  return goal.type === "character"
    ? characterCosts.call(this, goal as CharacterGoal)
    : goal.type === "trace"
      ? traceCosts.call(this, goal as TrainingGoal)
      : {};
}

/** Bind as Sk.computed.totalCosts. Level/SP share training costs once per card. */
function rawTotalCosts(context: GameContext): Costs {
  const total: Costs = {};
  // Index only for this calculation. Vue changes nested records in place, so
  // an array-identity cache would retain stale current/target/profile data.
  const groups = new Map<string, {level?: CharacterGoal; training?: TrainingGoal}>();
  for (const goal of context.goals || []) {
    const id = goal.character;
    if (!id || !catalog.has(id)) continue;
    let group = groups.get(id);
    if (!group) groups.set(id, group = {});
    // Match the original find() contract for duplicate imported records.
    if (goal.type === "character" && !group.level) group.level = goal as CharacterGoal;
    if (goal.type === "trace" && !group.training) group.training = goal as TrainingGoal;
  }
  for (const [id, group] of groups) {
    if (context.inactive?.[id]) continue;
    const level = group.level,
      trace = group.training,
      from = Math.max(stage(level?.current.asc), stage(trace?.sp.current)),
      targetLevel = level
        ? clamp(
            level.goal.level,
            clamp(level.current.level, 1, rulesFor(id).maxLevel),
            rulesFor(id).maxLevel,
          )
        : 1,
      to = Math.max(
        from,
        stage(level?.goal.asc),
        stage(trace?.sp.goal),
        minimumStage(id, targetLevel),
      ),
      costs = trainingCosts(id, from, to);
    if (level) {
      const raw = rawCharacterCosts(context, level, from).lessonPoints;
      if (raw) add(costs, "lessonPoints", raw.need);
    }
    for (const [key, cost] of Object.entries(costs)) {
      if (!cost) continue;
      const resource = key as ResourceKey;
      add(total, resource, cost.need);
      total[resource]!.characters ??= [];
      total[resource]!.characters!.push(id);
    }
  }
  for(const bloom of bloomRequirements(context))if(bloom.usesStones&&bloom.remaining){
    add(total,'bloomStones',bloom.remaining);
    total.bloomStones!.characters??=[];
    total.bloomStones!.characters!.push(bloom.id);
  }
  if (!context.inactive?.custom)
    for (const custom of context.custom_items || [])
      if (validResource.has(custom.item)) {
        const value = inventoryQuantity(custom.value);
        if (!value) continue;
        const key = custom.item as ResourceKey;
        add(total, key, value);
        total[key]!.custom = true;
      }
  return ordered(total);
}
export function totalCosts(this: GameContext): Cost[] {
  const {costs,conversions}=materialSupplyFor(this);
  const resolved = withConversionFees(this, costs, conversions);
  return resourceKeys
    .filter((key) => resolved[key])
    .map((key) => ({
      ...resolved[key]!,
      characters: resolved[key]?.characters || [],
      cones: [],
      custom: !!resolved[key]?.custom,
    }));
}

type PlannedExchange=Conversion&{fromBundles:number; looseBatches:number};
type PendingExchange=Conversion&{covered:number;bundles:NonNullable<MaterialJarPlan[MaterialKey]>['uses']};
type MaterialSupply={costs:Costs;jars:MaterialJarPlan;conversions:Conversion[];exchanges:PlannedExchange[];
  pendingExchanges:PendingExchange[];exchangeCoinShortfall:number;sodaCoinShortfall:number;
  craftable:Partial<Record<ResourceKey,number>>;exchangeOutput:Partial<Record<ResourceKey,number>>};
export function materialSupply(this:GameContext):MaterialSupply {
  const profile=this.$root?.data?.[`${this.account??'main'}-holodori`] as AppProfileV2|undefined;
  const quantities=Object.entries(profile?.gameInventory??{}).map(([item,value])=>({type:item,item,tier:0,value}));
  const stock=materialJarStock([...quantities,...this.inventory??[]],profile?.currentDataVersion===1?undefined:profile?.gameAccountImport?.snapshot);
  return allocateMaterialSupply(rawTotalCosts(this),key=>held(this,key),stock,true);
}
function allocateMaterialSupply(costs:Costs,amount:(key:ResourceKey)=>number,stock:ReadonlyMap<string,bigint>,includePending:boolean):MaterialSupply {
  const shortages=Object.fromEntries(resourceKeys.map(key=>[
    key,inventoryQuantity((costs[key]?.need??0)-amount(key)),
  ]));
  const coinBudget=Math.max(0,amount('megaSphereCoin')-(costs.megaSphereCoin?.need??0));
  const available=Math.floor(coinBudget/upgradeRecipes[0].fee);
  const directBeads=planMaterialJars(Object.fromEntries(upgradeRecipes.map(({from})=>[from,shortages[from]])),stock);
  const unusedBundles=remainingBeadBundles(stock,directBeads);
  const surplusBeads=upgradeRecipes.map(({from})=>inventoryQuantity(
    amount(from)+(directBeads[from]?.covered??0)+(directBeads[from]?.extra??0)-(costs[from]?.need??0)));
  const outputLimits=upgradeRecipes.map(({to,output})=>Math.floor((Number.MAX_SAFE_INTEGER-amount(to))/output));
  const looseLimits=upgradeRecipes.map(({from,input},index)=>Math.min(outputLimits[index],
    Math.floor(Math.max(0,amount(from)-(costs[from]?.need??0))/input)));
  const selected=planCrystalSupply(upgradeRecipes.map(({to})=>shortages[to]),surplusBeads,stock,unusedBundles,available,outputLimits);
  const jars={...directBeads,...selected.crystals};
  const exchanges:PlannedExchange[]=[];
  const craftable:MaterialSupply['craftable']={};
  const exchangeOutput:MaterialSupply['exchangeOutput']={};
  for(const [index,recipe] of upgradeRecipes.entries()){
    const {from,to,input,output}=recipe;
    const batches=selected.funded[index];
    if(!batches)continue;
    const addition=selected.additions[from];
    if(addition){
      const direct=directBeads[from];
      const uses=new Map((direct?.uses??[]).map(use=>[use.id,use]));
      for(const use of addition.uses)uses.set(use.id,{...use,quantity:use.quantity+(uses.get(use.id)?.quantity??0)});
      jars[from]={covered:direct?.covered??0,extra:(direct?.extra??0)+addition.extra,uses:[...uses.values()]};
    }
    const fromBundles=Math.max(0,batches*input-Math.max(0,amount(from)-(costs[from]?.need??0)));
    if(jars[from])jars[from]={...jars[from]!,forExchange:fromBundles};
    exchanges.push({...batchAmounts(recipe,batches),fromBundles,looseBatches:Math.min(batches,looseLimits[index])});
    exchangeOutput[to]=batches*output;
    craftable[to]=Math.min(batches,looseLimits[index])*output;
  }
  // Each donor has a single budget across both shops. Reserve direct goals and
  // previously allocated batches before offering its loose stock or jar surplus.
  const loose: Partial<Record<MaterialKey,number>> = {};
  const surplus: Partial<Record<MaterialKey,number>> = {};
  for (const [i, {from,to,input}] of upgradeRecipes.entries()) {
    loose[from] = Math.max(0,amount(from) - (costs[from]?.need ?? 0) - selected.funded[i]*input);
    loose[to] = Math.max(0,amount(to) - (costs[to]?.need ?? 0));
    surplus[from] = loose[from] + (jars[from]?.extra ?? 0) - (jars[from]?.forExchange ?? 0);
    surplus[to] = loose[to] + (jars[to]?.extra ?? 0);
  }
  const sodaBudget = Math.max(0,amount(sodaPopCoin) - (costs[sodaPopCoin]?.need ?? 0));
  let sodaSpent = 0;
  const pendingExchanges:PendingExchange[]=[];
  const fundedFees=exchanges.reduce((total,exchange)=>total+exchange.fee,0);
  const outstanding = (key:MaterialKey) => Math.max(0, shortages[key] - (jars[key]?.covered ?? 0) - (exchangeOutput[key] ?? 0));
  function planLounge(pending:boolean) {
    // Prefer the larger remaining shortage within each material family. Keeping
    // exchange outputs out of the donor pool prevents circular recommendations.
    const pendingOutput = new Map(pendingExchanges.map(e=>[e.to,e.output]));
    const need = (to:MaterialKey) => Math.max(0,outstanding(to) - (pendingOutput.get(to) ?? 0));
    for (const recipe of [...loungeRecipes].sort((a,b)=>a.fee-b.fee || need(b.to)-need(a.to))) {
      const batches = Math.min(
        Math.ceil(need(recipe.to)/recipe.output),
        Math.floor((Number.MAX_SAFE_INTEGER - amount(recipe.to) - (exchangeOutput[recipe.to] ?? 0) - (pendingOutput.get(recipe.to) ?? 0))/recipe.output),
        Math.floor(((pending ? Number.MAX_SAFE_INTEGER : sodaBudget) - sodaSpent)/recipe.fee),
        ...recipe.inputs.map(({key,quantity})=>Math.floor((surplus[key] ?? 0)/quantity))
      );
      if (batches < 1) continue;
      const exchange = batchAmounts(recipe,batches);
      const looseBatches = Math.min(batches,...recipe.inputs.map(({key,quantity})=>Math.floor((loose[key] ?? 0)/quantity)));
      let fromBundles = 0;
      for (const {key,quantity} of exchange.inputs) {
        const fromJar = Math.max(0,quantity - (loose[key] ?? 0));
        fromBundles += fromJar;
        loose[key] = Math.max(0,(loose[key] ?? 0)-quantity);
        surplus[key] = (surplus[key] ?? 0)-quantity;
        if (!pending && fromJar && jars[key]) jars[key]!.forExchange = (jars[key]!.forExchange ?? 0)+fromJar;
      }
      sodaSpent += exchange.fee;
      if (pending) {
        pendingExchanges.push({...exchange,covered:Math.min(need(recipe.to),exchange.output),bundles:[]});
      } else {
        exchanges.push({...exchange,looseBatches,fromBundles});
        craftable[recipe.to] = (craftable[recipe.to] ?? 0) + looseBatches*recipe.output;
        exchangeOutput[recipe.to] = (exchangeOutput[recipe.to] ?? 0) + exchange.output;
      }
    }
  }
  planLounge(false);
  const remainingCrystals=upgradeRecipes.map(({to})=>Math.max(0,
    shortages[to]-(jars[to]?.covered??0)-(exchangeOutput[to]??0)));
  let exchangeCoinShortfall=0;
  if(includePending&&remainingCrystals.some(Boolean)){
    // Quote the next exchanges using only stock left after the current plan.
    const remainingBeads=upgradeRecipes.map(({from})=>surplus[from] ?? 0);
    const remainingLimits=upgradeRecipes.map(({to,output})=>Math.floor((Number.MAX_SAFE_INTEGER-amount(to)-(exchangeOutput[to]??0))/output));
    const {funded:pending,additions}=planBundleExchanges(remainingCrystals,remainingBeads,remainingBeadBundles(stock,jars),
      Math.floor((Number.MAX_SAFE_INTEGER-fundedFees)/upgradeRecipes[0].fee),remainingLimits);
    const quote=upgradeRecipes.flatMap((recipe,index)=>{
      const {from,output}=recipe;
      const batches=pending[index];
      return batches?[{...batchAmounts(recipe,batches),
        covered:Math.min(remainingCrystals[index],batches*output),bundles:additions[from]?.uses??[]}]:[];
    });
    exchangeCoinShortfall=Math.max(0,quote.reduce((total,exchange)=>total+exchange.fee,0)-(coinBudget-fundedFees));
    if(exchangeCoinShortfall) {
      pendingExchanges.push(...quote);
      for(const e of quote) for(const {key,quantity} of e.inputs)
        surplus[key]=Math.max(0,(surplus[key] ?? 0)-quantity);
    }
  }
  if(includePending) planLounge(true);
  const sodaCoinShortfall = Math.max(0,sodaSpent-sodaBudget);
  const conversions=[...exchanges,...pendingExchanges];
  return {costs,jars,conversions,exchanges,pendingExchanges,exchangeCoinShortfall,sodaCoinShortfall,craftable,exchangeOutput};
}

export function materialSupplyFor(context:GameContext):MaterialSupply {
  return context.$root?.materialSupply??materialSupply.call(context);
}

export function normalizeProgress(before: SeelieGoal, after: SeelieGoal): SeelieGoal {
  if (before.type !== "character" || after.type !== "character") return after;
  if (Number(before.current?.level) !== Number(after.current?.level))
    return {...after, current: {...after.current, expIntoLevel: 0}};
  // Original g1 copies the goal into current when a goal completes. Its goal
  // has no partial-EXP field, even when completion only advanced SP.
  if (after.current?.expIntoLevel === undefined && before.current?.expIntoLevel !== undefined)
    return {...after, current: {...after.current, expIntoLevel: before.current.expIntoLevel}};
  return after;
}
export function progressCosts(
  this: GameContext,
  goal: SeelieGoal,
  progress: Record<string, unknown>,
): Costs {
  const raw = (value: SeelieGoal) =>
    value.type === "character"
      ? rawCharacterCosts(this, value as CharacterGoal)
      : value.type === "trace"
        ? trainingCosts(
            String(value.character),
            currentStage(this, value),
            stage(value.sp?.goal),
          )
        : {};
  const after: SeelieGoal = normalizeProgress(goal,
    goal.type === "character"
      ? {
          ...goal,
          current: {
            ...goal.current,
            ...Object.fromEntries(
              Object.entries(progress)
                .filter(([key]) => key === "level" || key === "asc")
                .map(([key, value]) => [key, Number(value)]),
            ),
          },
        }
      : goal.type === "trace"
        ? {
            ...goal,
            sp: {
              ...goal.sp,
              current:
                progress.sp === undefined
                  ? goal.sp?.current
                  : stage(progress.sp),
            },
          }
        : goal);
  const beforeCosts = raw(goal),
    afterCosts = raw(after),
    delta: Costs = {};
  for (const key of resourceKeys)
    add(
      delta,
      key,
      Math.max(0, (beforeCosts[key]?.need || 0) - (afterCosts[key]?.need || 0)),
    );
  return withConversionFees(this, delta);
}
export function consumeCosts(this: GameContext, costs: Costs | Cost[]) {
  if (!this.setInventory)
    throw new Error("The captured inventory setter is unavailable");
  const byKey: Costs = Array.isArray(costs)
      ? Object.fromEntries(costs.map((cost) => [cost.item, cost]))
      : costs,
    inventory = Object.fromEntries(
      resourceKeys.map((key) => [key, held(this, key)]),
    ) as Record<ResourceKey, number>;
  const direct: Costs = {};
  for (const cost of Object.values(byKey))
    add(direct, cost.item, cost.need - (cost.exchangeFee ?? 0));
  const funded = allocateMaterialSupply(direct, key => inventory[key], new Map(), false).exchanges;
  for (const exchange of funded) {
    for (const {key,quantity} of exchange.inputs) inventory[key] -= quantity;
    inventory[exchange.feeKey] -= exchange.fee;
    inventory[exchange.to] += exchange.output;
  }
  for (const key of resourceKeys) {
    const next = Math.max(0, inventory[key] - (direct[key]?.need ?? 0));
    if (next !== held(this,key)) this.setInventory(key, key, 0, next);
  }
}
/** Preserve the captured Inventory craft control, replace only its game formula. */
export function getCraft(
  this: GameContext,
  _type: string,
  item: string,
  _tier = 0,
) {
  return materialSupplyFor(this).craftable[item as ResourceKey] ?? 0;
}
export function getTotal(
  this: GameContext,
  type: string,
  item: string,
  tier = 0,
) {
  return (
    getInventory.call(this, type, item, tier) +
    getCraft.call(this, type, item, tier)
  );
}
export function getMissing(this:GameContext,type:string,item:string,tier=0) {
  const need=this.getNeed?this.getNeed(type,item,tier):totalCosts.call(this).find(cost=>cost.item===item)?.need??0;
  const supply=materialSupplyFor(this);
  const jars=tier===0?supply.jars[item as MaterialKey]?.covered??0:0;
  const exchange=tier===0?supply.exchangeOutput[item as ResourceKey]??0:0;
  return Math.ceil(Math.max(0,need-getInventory.call(this,type,item,tier)-jars-exchange));
}
export function getReplace() {
  return 0;
}
export function craft(this: GameContext, item: string) {
  if (!this.setInventory) return false;
  const planned = materialSupplyFor(this).exchanges.filter(e => e.to === item && e.looseBatches > 0);
  if (!planned.length) return false;
  const before = Object.fromEntries(resourceKeys.map(key => [key, held(this,key)]));
  let next = before;
  for (const exchange of planned)
    next = applyManualConversion(next,exchange.recipeId,exchange.looseBatches);
  for (const key of resourceKeys)
    if (before[key] !== next[key]) this.setInventory(key,key,0,next[key]!);
  return true;
}

/** Synchronize the captured Level/SP records after an edit or completion.
 * A changed SP record owns intentional SP target/current decreases. Level
 * edits preserve a higher existing SP target, as the reference planner does.
 * SP unlocks a cap; it never awards levels or Lesson Pt.
 */
export function normalizeGoals(
  goals: SeelieGoal[],
  changed?: SeelieGoal,
): SeelieGoal[] {
  const result: SeelieGoal[] = goals.map((goal) => ({
    ...goal,
    ...(goal.type === "character"
      ? { current: { ...goal.current }, goal: { ...goal.goal } }
      : goal.type === "trace"
        ? { sp: { ...goal.sp }, bonus: { ...(goal.bonus || {}) } }
        : {}),
  }));
  let nextId = result.reduce(
    (max, goal) => typeof goal.id === "number" && Number.isSafeInteger(goal.id)
      ? Math.max(max, goal.id) : max,
    0,
  );
  for (const goal of result)
    if ((goal.type === "character" || goal.type === "trace") &&
        catalog.has(String(goal.character)) && goal.id == null)
      goal.id = ++nextId;
  for (const id of new Set(
    result
      .map((goal) => goal.character)
      .filter((id): id is string => !!id && catalog.has(id)),
  )) {
    let { level, training } = cardGoals(result, id);
    const
      max = rulesFor(id).maxLevel,
      currentLevel = level ? clamp(level.current.level, 1, max) : 1;
    const authoritative =
      changed?.character === id
        ? changed.type === "character"
          ? changed.current?.asc
          : changed.type === "trace"
            ? changed.sp?.current
            : undefined
        : undefined;
    const current = Math.max(
      minimumStage(id, currentLevel),
      authoritative === undefined
        ? Math.max(stage(level?.current.asc), stage(training?.sp.current))
        : stage(authoritative),
    );
    const targetLevel = level ? clamp(level.goal.level, currentLevel, max) : currentLevel;
    const requestedSP = changed?.character === id && changed.type === "trace"
      ? stage(changed.sp?.goal)
      : Math.max(stage(level?.goal.asc), stage(training?.sp.goal));
    const targetSP = Math.max(current, minimumStage(id, targetLevel), requestedSP);
    if (!level) {
      level = {
        id: ++nextId, type: "character", character: id,
        current: {level: currentLevel, asc: current},
        goal: {level: targetLevel, asc: targetSP}, eidolon: 0,
      };
      result.push(level);
    } else {
      level.current.level = currentLevel;
      level.current.asc = current;
      level.goal.level = targetLevel;
      level.goal.asc = targetSP;
      level.eidolon = clamp(level.eidolon, 0, 5);
      if(level.goalBloom!==undefined)level.goalBloom=clamp(level.goalBloom,level.eidolon,manifest.bloom.maxStage);
    }
    if (!training) {
      training = {
        id: ++nextId, type: "trace", character: id,
        sp: {current, goal: targetSP}, bonus: {},
      };
      result.push(training);
    } else {
      training.sp = {...training.sp, current, goal: targetSP};
      training.bonus = {};
    }
  }
  return result;
}

export function getType(key: string) {
  return validResource.has(key) ? key : "";
}
export function getInventory(
  this: GameContext,
  type: string,
  item: string,
  tier = 0,
) {
  return inventoryQuantity(
    this.inventory?.find(
      (entry) =>
        entry.type === type && entry.item === item && entry.tier === tier,
    )?.value || 0
  );
}
export function resourceImage(key: ResourceKey | "bloomPoints") {
  if (key === sodaPopCoin) return "/assets/game-inventory/icons/img_item_thumb_mini-game-fishing-coin.webp";
  return `/assets/materials/${manifest.resourceAssets[key].fileName}`;
}
export function cardImage(
  id: string,
  kind: "grid" | "full" | "vertical" | "landscape" = "grid",
) {
  const card = catalog.get(id);
  return card ? catalogImages.get(card.assetId)?.[kind] || `/assets/cards/${kind}/${card.assetId}.webp` : "";
}

/** Read-only cost/stock projection consumed by the original T1/R4/B4/Os share
 * readiness machinery. SP material costs belong to its SP row once; Level
 * retains its XP costs. A level-cap dependency creates a presentation-only
 * SP record when no explicit one exists. Persistent goals are never changed.
 */
export function readinessContext<T extends GameContext>(
  context: T,
  id: string,
  mode: "goal" | "max" = "goal",
): T {
  if (!catalog.has(id)) return context;
  const group = cardGoals(context.goals || [], id),
    currentLevel = group.level
      ? clamp(group.level.current.level, 1, rulesFor(id).maxLevel)
      : 1,
    currentSP = Math.max(
      minimumStage(id, currentLevel),
      stage(group.level?.current.asc),
      stage(group.training?.sp.current),
    ),
    targetLevel =
      mode === "max"
        ? rulesFor(id).maxLevel
        : group.level
          ? clamp(group.level.goal.level, currentLevel, rulesFor(id).maxLevel)
          : currentLevel,
    targetSP =
      mode === "max"
        ? 4
        : Math.max(
            currentSP,
            stage(group.level?.goal.asc),
            stage(group.training?.sp.goal),
            minimumStage(id, targetLevel),
          );
  const displayed = (context.goals || []).map((goal) => {
    if (goal.character !== id) return goal;
    if (goal.type === "character")
      return {
        ...goal,
        current: { ...goal.current, asc: currentSP },
        goal: { ...goal.goal },
      };
    if (goal.type === "trace")
      return {
        ...goal,
        sp: {
          current: currentSP,
          goal:
            mode === "max"
              ? Math.max(
                  currentSP,
                  stage(group.level?.goal.asc),
                  stage(group.training?.sp.goal),
                  minimumStage(id, targetLevel),
                )
              : targetSP,
        },
        bonus: {},
      };
    return goal;
  });
  if (!group.training && (currentSP > 0 || targetSP > 0))
    displayed.push({
      type: "trace",
      character: id,
      sp: { current: currentSP, goal: targetSP },
      bonus: {},
    });

  // Only future conversion batches are known. Keep that exact fee constant
  // across T1's baseline/remaining cost callbacks so its source subtraction
  // does not manufacture past fees by rounding two unrelated batch plans.
  const futureCosts = trainingCosts(id, currentSP, targetSP),
    conversions = projectedConversions(context, futureCosts),
    projectedStock = Object.fromEntries(
      resourceKeys.map((key) => [key, held(context, key)]),
    ) as Record<ResourceKey, number>;
  for (const conversion of conversions) {
    for (const {key,quantity} of conversion.inputs) projectedStock[key] -= quantity;
    projectedStock[conversion.to] += conversion.output;
  }

  const costOf = (goal: SeelieGoal): Costs => {
    if (goal.character !== id) return goalCosts.call(context, goal);
    if (goal.type === "character") {
      const all = rawCharacterCosts({}, goal as CharacterGoal);
      return all.lessonPoints ? { lessonPoints: { ...all.lessonPoints } } : {};
    }
    if (goal.type === "trace") {
      const costs = trainingCosts(
        id,
        stage(goal.sp?.current),
        stage(goal.sp?.goal),
      );
      for (const exchange of conversions) add(costs, exchange.feeKey, exchange.fee);
      return ordered(costs);
    }
    return {};
  };
  const overrides: Record<string, unknown> = {
    goals: displayed,
    characterCosts: costOf,
    traceCosts: costOf,
    goalCosts: costOf,
    getInventory: (type: string, item: string, tier = 0) =>
      type === item && tier === 0 && validResource.has(item)
        ? projectedStock[item as ResourceKey]
        : getInventory.call(context, type, item, tier),
  };
  return new Proxy(context, {
    get(target, property) {
      return typeof property === "string" && Object.hasOwn(overrides, property)
        ? overrides[property]
        : Reflect.get(target, property, target);
    },
    set() {
      throw new Error("Readiness projections are read-only.");
    },
    deleteProperty() {
      throw new Error("Readiness projections are read-only.");
    },
  });
}

export const gameMethods = {
  characterCosts,
  traceCosts,
  goalCosts,
  progressCosts,
  consumeCosts,
  getType,
  getInventory,
  getCraft,
  getTotal,
  getReplace,
};
export const game = {
  inventoryQuantity,
  data,
  characters,
  items,
  translations,
  resourceKeys,
  resourceGroups,
  resourceLabels,
  resourceType,
  getCard,
  rulesFor,
  minimumStage,
  levelStates,
  trainingStates,
  ascendedLevels,
  normalizeGoals,
  normalizeProgress,
  characterCosts,
  traceCosts,
  goalCosts,
  totalCosts,
  progressCosts,
  consumeCosts,
  projectedConversions,
  materialSupply,
  materialSupplyFor,
  getType,
  getInventory,
  getCraft,
  getTotal,
  getMissing,
  getReplace,
  craft,
  resourceImage,
  cardImage,
  readinessContext,
};
