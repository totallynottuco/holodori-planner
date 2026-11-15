import {accountManifest,resolveBoardNodes} from '../hololive/vendor/shared/account-data';
import {boardChanges,type SavedBoards} from './saved-boards';

type Amounts=Record<string,number>;
export type BoardBill={bought:Amounts;refunded:Amounts;resets:number};
type Limits={stock:Amounts;maxResets:number|null;infiniteMaterials:boolean};

export function boardBill(before:SavedBoards,targets:SavedBoards,allowRefunds=true):BoardBill{
  const bought:Amounts={},refunded:Amounts={};
  let resets=0;
  for(const [owner,target] of Object.entries(targets)){
    const changes=boardChanges(before[owner],target).filter(change=>change.kind!=='connect');
    if(!changes.length)continue;
    const nodes=new Map(resolveBoardNodes(owner).map(node=>[node.groupId,node]));
    for(const {id,kind} of changes){
      const node=nodes.get(id);
      if(!node)throw Error(`Board node ${id} for ${owner} is unavailable in the local catalog.`);
      if(!node.boardPointCost)continue;
      if(kind==='reset')resets++;
      if(kind==='reset'&&!allowRefunds)continue;
      const ledger=kind==='reset'?refunded:bought;
      for(const {resource,quantity} of node.costs)ledger[resource]=(ledger[resource]??0)+quantity;
    }
  }
  return {bought,refunded,resets};
}

export const resetGold=(resets:number)=>resets*accountManifest.boardReset.hologoldCostPerRemovedNode;

export function quoteBoardBudget(bill:BoardBill,{stock,maxResets,infiniteMaterials}:Limits){
  const remaining:Amounts={};
  const short:Amounts={};
  for(const key of new Set([...Object.keys(stock),...Object.keys(bill.bought),...Object.keys(bill.refunded)])){
    if(key==='hologold')continue;
    const balance=(stock[key]??0)+(bill.refunded[key]??0)-(bill.bought[key]??0);
    remaining[key]=Math.max(0,balance);
    if(!infiniteMaterials&&balance<0)short[key]=-balance;
  }
  const gold=(stock.hologold??0)-resetGold(bill.resets);
  if(gold<0)short.hologold=-gold;
  const overResets=maxResets===null?0:Math.max(0,bill.resets-maxResets);
  return {remaining,short,overResets,fits:!overResets&&!Object.keys(short).length};
}

export function optimizerResetLimit(reservedResets:number,resetCeiling:number,{stock,maxResets}:Limits){
  const bySetting=maxResets===null?-1:Math.max(0,maxResets-reservedResets);
  const byGold=Math.max(0,Math.floor((stock.hologold??0)/resetGold(1))-reservedResets);
  // Leave the original limit in place when gold covers every possible
  // reset. Some search paths choose a different order for finite limits.
  if(byGold>=resetCeiling)return bySetting;
  return bySetting<0?byGold:Math.min(bySetting,byGold);
}
