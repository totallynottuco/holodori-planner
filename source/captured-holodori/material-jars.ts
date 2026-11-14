import type {GameAccountSnapshot,ResourceKey} from '../hololive/vendor/shared/types';
import {inventoryEventTime} from './inventory-events';
import {conversionRecipes,exchangeOutput,fundMaterialExchanges} from './conversions';

const attributes=['cute','pure','happy'] as const;
const families=['Beads','Crystals'] as const;
const sizes=[{size:'L',amount:300,asset:'03'},{size:'M',amount:100,asset:'02'},{size:'S',amount:10,asset:'01'}] as const;

// Item and LangItem_Eng master tables describe these as selectable rewards.
// Each container provides its full yield to exactly one attribute.
const jars=families.map((family,index)=>sizes.map(({size,amount,asset})=>({
  id:`item-selectable_reward_box-item-card_limit_break-attribute_${index+1}-${amount}`,
  name:family==='Beads'?`Beads Bundle ${size}`:`A Jar of Crystals ${size}`,
  amount,image:`/assets/game-inventory/icons/img_item_thumb_selectable-limit-break-attribute-box-0${index+1}-${asset}.webp`,
})));
const jarIds=new Set(jars.flat().map(jar=>jar.id));
type Jar=typeof jars[number][number];
type JarUse=Jar&{quantity:number};
type JarEntry={covered:number;extra:number;uses:JarUse[];forExchange?:number};
export type MaterialJarPlan=Partial<Record<ResourceKey,JarEntry>>;
type InventoryRow={type:string;item:string;tier:number;value:number};
type CrystalFunding={limits:Partial<Record<ResourceKey,number>>;available:number;evaluate?:AllocationEvaluator;splitLimit?:bigint};

export function materialJarStock(inventory:readonly InventoryRow[],snapshot?:GameAccountSnapshot,now=Date.now()) {
  const stock=new Map<string,bigint>();
  const time=inventoryEventTime(snapshot,now);
  for(const row of snapshot?.tables.items??[]){
    if(!jarIds.has(row.itemId))continue;
    const expiration=Number(row.expiredTime);
    if(row.expiredTime!=='0'&&(!Number.isSafeInteger(expiration)||expiration<=time))continue;
    stock.set(row.itemId,(stock.get(row.itemId)??0n)+BigInt(row.quantity));
  }
  for(const row of inventory){
    if(row.type!==row.item||row.tier!==0||!jarIds.has(row.item))continue;
    const quantity=Number(row.value);
    if(Number.isSafeInteger(quantity)&&quantity>=0)stock.set(row.item,BigInt(quantity));
  }
  return stock;
}

const min=(a:bigint,b:bigint)=>a<b?a:b;
const sum=(values:bigint[])=>values.reduce((total,value)=>total+value,0n);
const colorOrders=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];

type AllocationScore=[missing:bigint,secondary:bigint,extra:bigint,opened:bigint];
type AllocationEvaluator=(remaining:bigint[],used:bigint[][],overage:bigint)=>AllocationScore;
function allocateFamily(demand:bigint[],stock:bigint[],denominations:bigint[],funding?:{limits:number[];available:number},
  evaluate?:AllocationEvaluator,splitLimit=12n) {
  let best:{score:AllocationScore;used:bigint[][]}|undefined;
  const flexible=!!(funding?.available||evaluate);
  function visit(index:number,remaining:bigint[],extra:bigint,used:bigint[][]) {
    if(index===denominations.length){
      const funded=!evaluate&&funding?fundMaterialExchanges(remaining.map(Number),funding.limits,funding.available):[0,0,0];
      const score=evaluate?.(remaining,used,extra)??[
        exchangeShortfall(remaining.map(Number),funded),sum(funded.map(BigInt)),extra,sum(used.map(sum)),
      ];
      if(!best||compareAllocation(score,best.score)<0n)best={score,used};
      return;
    }
    const amount=denominations[index];
    const priority=remaining.map((_,color)=>color).sort((a,b)=>remaining[a]===remaining[b]?a-b:remaining[a]>remaining[b]?-1:1);
    // Full jars do not overfill. The smaller denominations all divide this
    // size, so full allocations preserve each attribute's smaller remainder.
    const orders=flexible?[priority,...colorOrders]:[priority];
    const fullSlots=remaining.map(need=>need/amount);
    const fullStock=min(stock[index],sum(fullSlots));
    const examined=new Set<string>();
    function useFullJars(counts:bigint[],fullCount:bigint){
      const key=counts.join(',');
      if(examined.has(key))return;
      examined.add(key);
      const next=remaining.map((need,color)=>need-counts[color]*amount);
      // At most one partial jar can be useful per attribute. Try leaving it
      // sealed as well, since smaller jars or exchanges may make a better fit.
      function partial(color:number,left:bigint,overage:bigint,redirected:bigint){
        if(redirected>BigInt(next.length-color))return;
        if(color===next.length){visit(index+1,[...next],overage,[...used,[...counts]]);return;}
        partial(color+1,left,overage,redirected);
        const shortage=next[color];
        if(left===0n||shortage===0n||shortage>=amount)return;
        counts[color]++;
        next[color]=0n;
        partial(color+1,left-1n,overage+amount-shortage,redirected>0n?redirected-1n:0n);
        next[color]=shortage;
        counts[color]--;
      }
      partial(0,stock[index]-fullCount,extra,fullStock-fullCount);
    }
    const priorityCaps=funding?.available?[
      fullSlots,
      ...[funding.limits,fundMaterialExchanges(remaining.map(Number),funding.limits,funding.available)].map(limits=>
        remaining.map((need,color)=>{
          const convertible=BigInt(limits[color])*BigInt(exchangeOutput);
          return need>convertible?(need-convertible+amount-1n)/amount:0n;
        })),
    ]:[fullSlots];
    // An exchange can make it worth sending a jar to a color that needs less
    // than its full yield. There is at most one such jar per color.
    const maxRedirected=flexible?min(fullStock,3n-min(stock[index]-fullStock,3n)):0n;
    for(let redirected=0n;redirected<=maxRedirected;redirected++){
      const fullCount=fullStock-redirected;
      if(flexible&&fullCount<=splitLimit&&fullCount<sum(fullSlots)){
        for(let first=0n;first<=min(fullCount,fullSlots[0]);first++){
          for(let second=0n;second<=min(fullCount-first,fullSlots[1]);second++){
            const third=fullCount-first-second;
            if(third<=fullSlots[2])useFullJars([first,second,third],fullCount);
          }
        }
        continue;
      }
      for(const order of orders)for(const caps of priorityCaps){
        let available=fullCount;
        const counts=demand.map(()=>0n);
        for(const color of order){
          const full=min(available,min(fullSlots[color],caps[color]));
          counts[color]=full;
          available-=full;
        }
        for(const color of order){
          const full=min(available,fullSlots[color]-counts[color]);
          counts[color]+=full;
          available-=full;
        }
        useFullJars(counts,fullCount);
      }
    }
  }
  visit(0,demand,0n,[]);
  return best!.used;
}

function compareAllocation(a:AllocationScore,b:AllocationScore) {
  return a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3];
}
const exchangeShortfall=(needs:number[],funded:number[])=>sum(needs.map((need,index)=>
  BigInt(Math.max(0,need-funded[index]*exchangeOutput))));

const beadBundles=jars[0];
const bundleAmounts=beadBundles.map(jar=>BigInt(jar.amount));

export function remainingBeadBundles(jarStock:ReadonlyMap<string,bigint>,directJars:MaterialJarPlan) {
  const stock=beadBundles.map(jar=>(jarStock.get(jar.id)??0n)-sum(conversionRecipes.map(({from})=>
    BigInt(directJars[from]?.uses.find(use=>use.id===jar.id)?.quantity??0))));
  return stock;
}

/** Allocate still-sealed bundles by whole exchanges, after direct bead goals. */
export function planBundleExchanges(crystalNeeds:number[],surplusBeads:number[],stock:bigint[],available:number,outputLimits:number[]) {
  const input=conversionRecipes[0].input;
  const directLimits=surplusBeads.map((beads,index)=>Math.min(outputLimits[index],Math.floor(beads/input)));
  const maxBatches=crystalNeeds.map((need,index)=>Math.min(available,outputLimits[index],Math.ceil(need/exchangeOutput)));
  const demand=maxBatches.map((count,index)=>BigInt(Math.max(0,count*input-surplusBeads[index])));
  const fund=(limits:number[])=>fundMaterialExchanges(crystalNeeds,limits,available,directLimits);
  const base=fund(directLimits);
  const missing=(funded:number[])=>exchangeShortfall(crystalNeeds,funded);
  if(!missing(base)||!stock.some(quantity=>quantity>0n)||!demand.some(Boolean))return {funded:base,additions:{}};

  const produced=(used:bigint[][],color:number)=>sum(used.map((counts,index)=>counts[color]*bundleAmounts[index]));
  const fundedBy=(used:bigint[][])=>fund(surplusBeads.map((beads,index)=>Number(min(BigInt(maxBatches[index]),
    (BigInt(beads)+produced(used,index))/BigInt(input)))));
  function score(used:bigint[][],funded:number[]):AllocationScore{
    const added=funded.map((count,index)=>BigInt(Math.max(0,count*input-surplusBeads[index])));
    return [missing(funded),sum(added),sum(added.map((need,index)=>need?produced(used,index)-need:0n)),
      sum(used.map(counts=>sum(counts.filter((_,index)=>added[index]>0n))))];
  }
  const used=allocateFamily(demand,stock,bundleAmounts,undefined,(_,candidate)=>score(candidate,fundedBy(candidate)),sum(stock)<=12n?12n:4n);
  const funded=fundedBy(used);
  const additions:MaterialJarPlan={};
  for(const [color,recipe] of conversionRecipes.entries()){
    const need=BigInt(Math.max(0,funded[color]*input-surplusBeads[color]));
    if(!need)continue;
    const trimmed=allocateFamily([need,0n,0n],used.map(counts=>counts[color]),bundleAmounts);
    const uses=beadBundles.flatMap((jar,index)=>trimmed[index][0]?[{...jar,quantity:Number(trimmed[index][0])}]:[]);
    additions[recipe.from]={covered:0,extra:Number(produced(trimmed,0)),uses};
  }
  return {funded,additions};
}

export function planCrystalSupply(needs:number[],surplusBeads:number[],stock:ReadonlyMap<string,bigint>,
  unusedBundles:bigint[],available:number,outputLimits:number[]) {
  const bundleYield=sum(unusedBundles.map((count,index)=>count*bundleAmounts[index]));
  const input=BigInt(conversionRecipes[0].input);
  const batchLimits=(budget:bigint)=>surplusBeads.map((beads,index)=>Number(min(
    BigInt(Math.min(outputLimits[index],available)),(BigInt(beads)+budget)/input)));
  const loose=batchLimits(0n);
  const possible=batchLimits(bundleYield);
  const byCrystal=<T>(values:T[])=>Object.fromEntries(conversionRecipes.map(({to},index)=>[to,values[index]]));
  const needsByCrystal=byCrystal(needs);
  const crystalCount=sum(jars[1].map(jar=>stock.get(jar.id)??0n));
  const smallStock=crystalCount+sum(unusedBundles)<=8n;
  const candidates=new Map<string,ReturnType<typeof planBundleExchanges>>();
  function resolve(remaining:number[]) {
    const key=remaining.join(',');
    const result=candidates.get(key)??planBundleExchanges(remaining,surplusBeads,unusedBundles,available,outputLimits);
    candidates.set(key,result);
    return result;
  }
  function score(remaining:number[],resolved:ReturnType<typeof planBundleExchanges>,overage:bigint,opened:bigint):AllocationScore {
    const {funded,additions}=resolved;
    const bundles=Object.values(additions).flatMap(entry=>entry.uses);
    return [exchangeShortfall(remaining,funded),sum(funded.map(BigInt)),overage,
      opened+sum(bundles.map(use=>BigInt(use.quantity)))];
  }
  function evaluatePlan(limits:number[],evaluate?:AllocationEvaluator) {
    const crystals=planMaterialJars(needsByCrystal,stock,{available,limits:byCrystal(limits),evaluate,
      splitLimit:smallStock||!bundleYield?12n:4n});
    const remaining=conversionRecipes.map(({to},index)=>needs[index]-(crystals[to]?.covered??0));
    const result=resolve(remaining);
    const entries=Object.values(crystals);
    return {...result,crystals,score:score(remaining,result,sum(entries.map(entry=>BigInt(entry.extra))),
      sum(entries.flatMap(entry=>entry.uses.map(use=>BigInt(use.quantity)))))};
  }
  const initial=evaluatePlan(loose);
  if(!bundleYield||!available||!Object.keys(initial.crystals).length||initial.score[0]===0n&&initial.score[1]===0n)return initial;

  if(smallStock){
    // Score each candidate against the real shared bundle and coin balances.
    return evaluatePlan(possible,(remaining,used,overage)=>{
      const crystalNeeds=remaining.map(Number);
      return score(crystalNeeds,resolve(crystalNeeds),overage,sum(used.map(sum)));
    });
  }

  // Keep larger inventories responsive by comparing allocations for a shared
  // estimate and for concentrating bundle-funded exchanges in each color.
  let best=initial;
  const alternatives=[possible,batchLimits(bundleYield/3n),...possible.map((cap,color)=>loose.map((count,index)=>index===color?cap:count))];
  for(const limits of alternatives){
    const candidate=evaluatePlan(limits);
    if(compareAllocation(candidate.score,best.score)<0n)best=candidate;
  }
  return best;
}

export function planMaterialJars(shortages:Partial<Record<ResourceKey,number>>,stock:ReadonlyMap<string,bigint>,funding?:CrystalFunding):MaterialJarPlan {
  const plan:MaterialJarPlan={};
  for(const [index,family] of families.entries()){
    const keys=attributes.map(attribute=>`${attribute}${family}` as ResourceKey);
    const demand=keys.map(key=>BigInt(Math.max(0,Math.trunc(shortages[key]??0))));
    const containers=jars[index];
    const available=containers.map(jar=>stock.get(jar.id)??0n);
    if(!available.some(quantity=>quantity>0n)||!demand.some(value=>value>0n))continue;
    const amounts=containers.map(jar=>BigInt(jar.amount));
    const limits=keys.map(key=>funding?.limits[key]??0);
    const exchanges=family==='Crystals'&&funding?.available&&limits.some(Boolean)?{available:funding.available,limits}:undefined;
    const used=allocateFamily(demand,available,amounts,exchanges,family==='Crystals'?funding?.evaluate:undefined,funding?.splitLimit);
    for(const [color,key] of keys.entries()){
      const uses=containers.flatMap((jar,i)=>used[i][color]>0n?[{...jar,quantity:Number(used[i][color])}]:[]);
      if(!uses.length)continue;
      const produced=sum(used.map((counts,i)=>counts[color]*amounts[i]));
      const covered=min(demand[color],produced);
      plan[key]={uses,covered:Number(covered),extra:Number(produced-covered)};
    }
  }
  return plan;
}
