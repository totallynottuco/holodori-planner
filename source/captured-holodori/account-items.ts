import {diamondInventoryIds,isGameInventoryId,type GameAccountSnapshot,type ResourceKey} from '../hololive/vendor/shared/types';
import {boardResourceIds} from './board-resource-ids';

/** Reviewed game Item IDs shared by import and the current inventory. */
export const ACCOUNT_RESOURCE_ITEM_IDS:Record<ResourceKey,string>={
  lessonPoints:'item-card_level_up',cuteBeads:'item-card_limit_break-attribute_1-1',cuteCrystals:'item-card_limit_break-attribute_1-2',
  pureBeads:'item-card_limit_break-attribute_2-1',pureCrystals:'item-card_limit_break-attribute_2-2',happyBeads:'item-card_limit_break-attribute_3-1',happyCrystals:'item-card_limit_break-attribute_3-2',
  hololium:'item-card_limit_break-cmn-sr',...boardResourceIds,
  hologold:'item-gold',harmonyGardenCoin:'item-mini-game-chase-coin',megaSphereCoin:'item-mini_game_bet_coin',bloomStones:'item-card-potential-upgrade-cmn',
};
const planned=new Set(Object.values(ACCOUNT_RESOURCE_ITEM_IDS));

export function observedGameQuantities(snapshot?:GameAccountSnapshot){
  const totals:Record<string,bigint>={};
  for(const row of snapshot?.tables.items??[]){
    if(!isGameInventoryId(row.itemId)||planned.has(row.itemId))continue;
    totals[row.itemId]=(totals[row.itemId]??0n)+BigInt(row.quantity);
  }
  for(const row of snapshot?.tables.fishingBaits??[]){
    if(isGameInventoryId(row.parkFishingBaitId))totals[row.parkFishingBaitId]=BigInt(row.quantity);
  }
  const values:Record<string,number>={};
  for(const [id,total] of Object.entries(totals)){
    if(total<0n||total>BigInt(Number.MAX_SAFE_INTEGER))throw Error('An inventory quantity exceeds the exact integer range.');
    values[id]=Number(total);
  }
  for(const kind of ['free','paid'] as const)if(snapshot?.balances[kind]!=null)values[diamondInventoryIds[kind]]=snapshot.balances[kind];
  return values;
}
