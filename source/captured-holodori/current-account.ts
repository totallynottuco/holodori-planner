import {accountCharactersById,boardPointsForMemberLevel,boardPointsSpent} from '../hololive/vendor/shared/account-data';
import {progressionManifest} from '../hololive/vendor/shared/manifest';
import type {AppProfileV2,GameAccountCardSource,GameAccountSnapshot} from '../hololive/vendor/shared/types';
import {optimizerBoards} from './saved-lineups';
import type {SavedBoards} from './saved-boards';

export function observedDreamRank(snapshot?:GameAccountSnapshot){
  if(snapshot?.progress?.dreamRank!==undefined)return snapshot.progress.dreamRank;
  const rank=Number(snapshot?.tables.missions?.find(row=>
    row.missionId==='mission-achievement-common-absolute_player_level'&&row.missionPassId==='__NONE__')?.progress);
  return Number.isSafeInteger(rank)&&rank>0?rank:undefined;
}

export function currentDreamRank(profile?:AppProfileV2){
  const rank=profile?.account.playerLevel??1;
  return rank!==1||profile?.dreamRankManuallySet?rank:observedDreamRank(profile?.gameAccountImport?.snapshot)??rank;
}

export function currentBoards(profile?:AppProfileV2):SavedBoards {
  if(!profile)return {};
  const legacy:SavedBoards={};
  for(const [id,board] of Object.entries(profile.account.boards)){
    if(board.unlockedNodeIds.length||Object.values(board.connectAssignments).some(Boolean))legacy[id]={
      nodes:board.unlockedNodeIds,cards:Object.fromEntries(Object.entries(board.connectAssignments).filter((entry):entry is [string,string]=>!!entry[1])),
    };
  }
  return {...legacy,...optimizerBoards(profile.gameAccountImport?.snapshot.tables.boards),...profile.boardEdits};
}

export function currentMemberRank(profile:AppProfileV2,owner:string){
  const saved=profile.account.boards[owner]?.characterLevel;
  const observed=profile.gameAccountImport?.snapshot.tables.members.find(row=>row.characterId===owner)?.level;
  return saved??observed??1;
}

export function currentBoardPoints(profile:AppProfileV2,owner:string,board=currentBoards(profile)[owner]){
  const rank=currentMemberRank(profile,owner);
  const earned=boardPointsForMemberLevel(owner,rank);
  const spent=boardPointsSpent(owner,board?.nodes??[]);
  const snapshot=profile.gameAccountImport?.snapshot;
  const row=snapshot?.tables.boardPoints?.find(row=>row.skillTreePointId===accountCharactersById.get(owner)?.boardPointId);
  const observedRank=snapshot?.tables.members.find(row=>row.characterId===owner)?.level;
  // Use the live game balance when neither input has been manually changed.
  const available=row&&!Object.hasOwn(profile.boardEdits??{},owner)&&rank===observedRank?Number(row.quantity):earned-spent;
  return {rank,earned,spent,available,reconciled:earned-spent===available};
}

/** An observed Board replaces the current record. An omitted Board keeps its last known layout. */
export function consolidateBoardEdits(previous:AppProfileV2,snapshot:GameAccountSnapshot):SavedBoards{
  const observed=optimizerBoards(snapshot.tables.boards);
  const preserved=Object.fromEntries(Object.entries(currentBoards(previous)).filter(([id])=>!Object.hasOwn(observed,id)));
  const connected=new Set(Object.values(observed).flatMap(board=>Object.values(board.cards)));
  for(const [id,board] of Object.entries(preserved)){
    const cards=Object.fromEntries(Object.entries(board.cards).filter(([,card])=>!connected.has(card)));
    if(Object.keys(cards).length!==Object.keys(board.cards).length)preserved[id]={...board,cards};
  }
  return preserved;
}

export function currentOwnership(profile?:AppProfileV2):Set<string>|null {
  if(!profile||!profile.gameAccountImport&&!Object.keys(profile.cardOwnership??{}).length)return null;
  const ids=new Set(profile.gameAccountImport?.ownedCardIds??[]);
  for(const [id,owned] of Object.entries(profile.cardOwnership??{})){
    if(owned)ids.add(id);else ids.delete(id);
  }
  return ids;
}

export function currentGachaPoints(profile?:AppProfileV2){
  return {...profile?.gameAccountImport?.snapshot.balances.gachaPoints,...profile?.gachaPointEdits};
}

export function currentUpgradeBonus(profile:AppProfileV2|undefined,owned:GameAccountCardSource[]){
  const bonus=profile?.account.upgradeBonusPermyriad;
  const imported=profile?.gameAccountImport?.snapshot;
  if(!imported||bonus!==imported.progress?.upgradeBonusPermyriad)return bonus;
  const rows=new Map(imported.tables.cards.map(card=>[card.cardId,card]));
  return owned.length===rows.size&&owned.every(card=>{
    const source=rows.get(card.cardId);
    return source?.level===card.level&&source.levelLimitBreakCount===card.levelLimitBreakCount&&source.potentialUpgradeCount===card.potentialUpgradeCount;
  })?bonus:undefined;
}

type CurrentGoal={type:string;character?:string;current?:{level?:number;asc?:number};eidolon?:number;sp?:{current?:number}};
export function currentOwnedCards(profile?:AppProfileV2,goals:CurrentGoal[]=[]):GameAccountCardSource[]{
  const ids=currentOwnership(profile);
  if(!ids||!profile)return [];
  const observed=new Map(profile.gameAccountImport?.snapshot.tables.cards.map(card=>[card.cardId,card]));
  const catalog=new Map(progressionManifest.cards.map(card=>[card.id,card]));
  const current=new Map(goals.filter(goal=>goal.type==='character').map(goal=>[goal.character,goal]));
  const training=new Map(goals.filter(goal=>goal.type==='trace').map(goal=>[goal.character,goal.sp?.current??0]));
  return [...ids].flatMap(cardId=>{
    const raw=observed.get(cardId),card=catalog.get(cardId),saved=profile.cards[cardId],goal=current.get(cardId);
    if(!raw&&!card)return [];
    return [{...raw,cardId,exp:raw?.exp??'0',potentialUpgradePointQuantity:raw?.potentialUpgradePointQuantity??0,
      maxLevel:raw?.maxLevel??progressionManifest.rarities[card!.rarity].maxLevel,rarity:raw?.rarity??card!.rarity,
      cardName:raw?.cardName??card?.cardName,memberName:raw?.memberName??card?.memberName,
      level:goal?.current?.level??saved?.level??raw?.level??1,
      levelLimitBreakCount:goal?Math.max(goal.current?.asc??0,training.get(cardId)??0):saved?.trainingStage??raw?.levelLimitBreakCount??0,
      potentialUpgradeCount:goal?.eidolon??saved?.bloomStage??raw?.potentialUpgradeCount??0,
    }];
  });
}
