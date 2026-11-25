import type { Attribute, ResourceKey } from "../hololive/vendor/shared/types";

export const sodaPopCoin = "item-mini_game_fishing_coin" as const;
export type PlannerResource = ResourceKey | typeof sodaPopCoin;
type MaterialAmount = Readonly<{key: ResourceKey; quantity: number}>;
export type ConversionRecipe = Readonly<{
  id: string;
  attribute: Attribute;
  inputs: readonly MaterialAmount[];
  to: ResourceKey;
  output: number;
  feeKey: "megaSphereCoin" | typeof sodaPopCoin;
  fee: number;
}>;
export type ConversionInventory = Readonly<Partial<Record<PlannerResource, number>>>;
export const exchangeOutput = 10;
const attributes = ["cute", "pure", "happy"] as const;

export const upgradeRecipes = Object.freeze(attributes.map(attribute => {
  const from = `${attribute}Beads` as const;
  return Object.freeze({
    id: attribute, attribute, from, input: 30, to: `${attribute}Crystals` as const,
    inputs: Object.freeze([Object.freeze({key: from, quantity: 30})]),
    output: exchangeOutput, feeKey: "megaSphereCoin" as const, fee: 200,
  });
}));

// Live booth records: evidence/update-130-audit/vip-conversion-verified-recipes.json
export const loungeRecipes = Object.freeze((["Beads", "Crystals"] as const).flatMap(family =>
  attributes.map(attribute => Object.freeze({
    id: `lounge-${attribute}${family}`, attribute, to: `${attribute}${family}` as const,
    inputs: Object.freeze(attributes.filter(other => other !== attribute)
      .map(other => Object.freeze({key: `${other}${family}` as const, quantity: 5}))),
    output: exchangeOutput, feeKey: sodaPopCoin, fee: family === "Beads" ? 50 : 150,
  }))
));
export const conversionRecipes: readonly ConversionRecipe[] = Object.freeze([...upgradeRecipes, ...loungeRecipes]);
export function conversionRecipe(id: string): ConversionRecipe {
  const recipe = conversionRecipes.find(value => value.id === id);
  if (!recipe) throw new Error("Choose a supported material conversion.");
  return recipe;
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
function stock(inventory: ConversionInventory, key: PlannerResource) {
  return quantity(inventory[key] ?? 0, "Inventory quantity");
}
export function batchAmounts(recipe: ConversionRecipe, batches: number) {
  if (!Number.isSafeInteger(batches) || batches < 1)
    throw new Error("Enter a positive number of exchanges.");
  return {
    recipeId: recipe.id, to: recipe.to, batches,
    inputs: recipe.inputs.map(({key, quantity: units}) => ({key, quantity: quantity(batches * units, "Exchange input")})),
    output: quantity(batches * recipe.output, "Exchange output"),
    feeKey: recipe.feeKey, fee: quantity(batches * recipe.fee, "Exchange fee"),
  };
}

export function maxManualBatches(inventory: ConversionInventory, id: string) {
  const recipe = conversionRecipe(id);
  return Math.min(
    ...recipe.inputs.map(input => Math.floor(stock(inventory, input.key) / input.quantity)),
    Math.floor(stock(inventory, recipe.feeKey) / recipe.fee),
    Math.floor((Number.MAX_SAFE_INTEGER - stock(inventory, recipe.to)) / recipe.output),
  );
}
export function manualQuote(inventory: ConversionInventory, id: string, batches: number) {
  const recipe = conversionRecipe(id);
  const amounts = batchAmounts(recipe, batches);
  const maxBatches = maxManualBatches(inventory, id);
  return { recipe, ...amounts, canApply: batches <= maxBatches, maxBatches };
}
export function applyManualConversion(inventory: ConversionInventory, id: string, batches: number) {
  const quote = manualQuote(inventory, id, batches);
  if (!quote.canApply)
    throw new Error("There are not enough materials or coins, or the result exceeds the supported quantity.");
  const next = {...inventory};
  for (const input of quote.inputs) next[input.key] = stock(inventory, input.key) - input.quantity;
  next[quote.feeKey] = stock(inventory, quote.feeKey) - quote.fee;
  next[quote.to] = quantity(stock(inventory, quote.to) + quote.output);
  return next;
}
