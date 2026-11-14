/** Reviewed Holodori conversion arithmetic only. No renderer or persistence.
 * Reference: holodori/planner/src/shared/planner.ts 18–81 and 235–249;
 * manual behavior: retired source/hololive/exchange.ts.
 */
import type { Attribute, ResourceKey } from "../hololive/vendor/shared/types";

export type ConversionRecipe = Readonly<{
  id: Attribute;
  attribute: Attribute;
  from: ResourceKey;
  to: ResourceKey;
  input: 30;
  output: 10;
  fee: 200;
}>;
export type ConversionInventory = Readonly<Partial<Record<ResourceKey, number>>>;
export const conversionFeeKey = "megaSphereCoin" as const;
export const exchangeOutput=10;
export const conversionRecipes: readonly ConversionRecipe[] = Object.freeze(
  (["cute", "pure", "happy"] as const).map((attribute) =>
    Object.freeze({
      id: attribute,
      attribute,
      from: `${attribute}Beads` as ResourceKey,
      to: `${attribute}Crystals` as ResourceKey,
      input: 30 as const,
      output: exchangeOutput,
      fee: 200 as const,
    }),
  ),
);

export function conversionRecipe(id: string): ConversionRecipe {
  const recipe = conversionRecipes.find((value) => value.id === id);
  if (!recipe) throw new Error("Choose a supported material conversion.");
  return recipe;
}
export function conversionForTarget(item: string) {
  return conversionRecipes.find((recipe) => recipe.to === item);
}

/** Fund whole batches that fill their full yield first. A final partial
 * batch goes to the largest remaining shortage that can use it. */
export function fundMaterialExchanges(shortages:readonly number[],limits:readonly number[],available:number,
  preferredLimits?:readonly number[]) {
  const funded=shortages.map(()=>0);
  const fundFullBatches=(batchLimits:readonly number[])=>{
    for(const [index,need] of shortages.entries()){
      const count=Math.min(Math.floor(need/exchangeOutput),limits[index],batchLimits[index])-funded[index];
      const next=Math.min(count,available);
      funded[index]+=next;
      available-=next;
    }
  };
  if(preferredLimits)fundFullBatches(preferredLimits);
  fundFullBatches(limits);
  const preferred=(index:number)=>Number(funded[index]<(preferredLimits?.[index]??0));
  const tails=shortages.map((need,index)=>({index,need:need-funded[index]*exchangeOutput}))
    .filter(({index,need})=>need>0&&funded[index]<limits[index])
    .sort((a,b)=>b.need-a.need||preferred(b.index)-preferred(a.index)||a.index-b.index);
  for(const {index} of tails){
    if(!available)break;
    funded[index]++;
    available--;
  }
  return funded;
}
function quantity(value: number, label = "Quantity") {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative safe integer.`);
  return value;
}
function stock(inventory: ConversionInventory, key: ResourceKey) {
  return quantity(inventory[key] ?? 0, "Inventory quantity");
}
function batchAmounts(recipe: ConversionRecipe, batches: number) {
  if (!Number.isSafeInteger(batches) || batches < 1)
    throw new Error("Enter a positive number of exchanges.");
  return {
    recipeId: recipe.id,
    batches,
    from: recipe.from,
    to: recipe.to,
    input: quantity(batches * recipe.input, "Exchange input"),
    output: quantity(batches * recipe.output, "Exchange output"),
    fee: quantity(batches * recipe.fee, "Exchange fee"),
  };
}

/** Manual exchanges are independent of goals and may spend any recorded beads. */
export function maxManualBatches(inventory: ConversionInventory, id: string) {
  const recipe = conversionRecipe(id);
  return Math.min(
    Math.floor(stock(inventory, recipe.from) / recipe.input),
    Math.floor(stock(inventory, conversionFeeKey) / recipe.fee),
    Math.floor((Number.MAX_SAFE_INTEGER - stock(inventory, recipe.to)) / recipe.output),
  );
}
export function manualQuote(
  inventory: ConversionInventory,
  id: string,
  batches: number,
) {
  const recipe = conversionRecipe(id);
  const amounts = batchAmounts(recipe, batches);
  const maxBatches = maxManualBatches(inventory, id);
  return { recipe, ...amounts, canApply: batches <= maxBatches, maxBatches };
}
export function applyManualConversion(
  inventory: ConversionInventory,
  id: string,
  batches: number,
): Partial<Record<ResourceKey, number>> {
  const quote = manualQuote(inventory, id, batches);
  if (!quote.canApply)
    throw new Error("There are not enough beads or Mega Sphere Coins, or the result exceeds the supported quantity.");
  return {
    ...inventory,
    [quote.from]: stock(inventory, quote.from) - quote.input,
    [quote.to]: quantity(stock(inventory, quote.to) + quote.output),
    [conversionFeeKey]: stock(inventory, conversionFeeKey) - quote.fee,
  };
}

/** Goal projection reserves direct bead costs and shows full planned fees even
 * when the recorded coins do not yet fund them. No inventory is changed here.
 */
export function planConversion(
  id: string,
  availableBeads: number,
  availableCrystals: number,
  requiredBeads: number,
  requiredCrystals: number,
) {
  const recipe = conversionRecipe(id);
  const excess = Math.max(0, quantity(availableBeads) - quantity(requiredBeads));
  const missing = Math.max(0, quantity(requiredCrystals) - quantity(availableCrystals));
  const batches = Math.min(
    Math.floor(excess / recipe.input),
    Math.ceil(missing / recipe.output),
  );
  return batches > 0 ? batchAmounts(recipe, batches) : null;
}
