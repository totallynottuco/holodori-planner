import {accountCharactersById,boardPointsForMemberLevel,boardPointsSpent,resolveBoardConnectEffect} from '../hololive/vendor/shared/account-data';
import {progressionManifest} from '../hololive/vendor/shared/manifest';
import type {AppProfileV2,GameAccountCardSource,GameAccountSnapshot} from '../hololive/vendor/shared/types';
import {optimizerBoards} from './saved-lineups';
import {boardChanges,mergeSavedBoards,validateSavedBoard,type SavedBoard,type SavedBoards} from './saved-boards';
import {observedGameQuantities} from './account-items';

export function observedDreamRank(snapshot?:GameAccountSnapshot){
  if(snapshot?.progress?.dreamRank!==undefined)return snapshot.progress.dreamRank;
  const rank=Number(snapshot?.tables.missions?.find(row=>
    row.missionId==='mission-achievement-common-absolute_player_level'&&row.missionPassId==='__NONE__')?.progress);
  return Number.isSafeInteger(rank)&&rank>0?rank:undefined;
}

export function currentDreamRank(profile?:AppProfileV2){
  const rank=profile?.account.playerLevel??1;
  return profile?.currentDataVersion===1||rank!==1||profile?.dreamRankManuallySet?rank:observedDreamRank(profile?.gameAccountImport?.snapshot)??rank;
}

function observedBoards(profile:AppProfileV2):SavedBoards {
  const legacy:SavedBoards={};
  for(const [id,board] of Object.entries(profile.account.boards)){
    if(board.layoutKnown===true||board.unlockedNodeIds.length||Object.values(board.connectAssignments).some(Boolean))legacy[id]={
      nodes:board.unlockedNodeIds,cards:Object.fromEntries(Object.entries(board.connectAssignments).filter((entry):entry is [string,string]=>!!entry[1])),
    };
  }
  return profile.currentDataVersion===1?legacy:{...legacy,...optimizerBoards(profile.gameAccountImport?.snapshot.tables.boards)};
}

export function currentBoards(profile?:AppProfileV2):SavedBoards {
  if(!profile)return {};
  if(profile.currentDataVersion===1)return observedBoards(profile);
  // Older Save Board actions wrote only savedBoards. Recover those local
  // records once; a later import must not resurrect an older saved layout.
  const edits=profile.boardProgressVersion===1?profile.boardEdits??{}:
    mergeSavedBoards(profile.savedBoards??{},profile.boardEdits??{});
  return mergeSavedBoards(observedBoards(profile),edits);
}

export function hasLocalBoards(profile?:AppProfileV2){
  return !!profile&&(profile.currentDataVersion===1||Object.keys(profile.boardEdits??{}).length>0||
    profile.boardProgressVersion!==1&&Object.keys(profile.savedBoards??{}).length>0);
}

/** Record the latest local layout without changing the import or inventory. */
export function boardProgressPatch(profile:AppProfileV2,updates:SavedBoards){
  const latest=consolidateCurrentProfile(profile);
  const boards={...latest.account.boards};
  for(const [owner,board] of Object.entries(mergeSavedBoards(currentBoards(latest),updates)))boards[owner]={
    ...boards[owner],characterId:owner,characterLevel:boards[owner]?.characterLevel??1,layoutKnown:resolvedBoard(latest,owner,board),
    unlockedNodeIds:board.nodes,connectAssignments:board.cards,
  };
  return {...latest,account:{...latest.account,boards},boardEdits:undefined,boardProgressVersion:1 as const};
}

function resolvedBoard(profile:AppProfileV2,owner:string,board:SavedBoard){
  try{
    validateSavedBoard(owner,board);
    return Object.values(board.cards).every(id=>!!resolveBoardConnectEffect(id,profile.cards[id]?.bloomStage??0));
  }catch{return false;}
}

export function currentMemberRank(profile:AppProfileV2,owner:string){
  const saved=profile.account.boards[owner]?.characterLevel;
  return saved??(profile.currentDataVersion===1?1:profile.gameAccountImport?.snapshot.tables.members.find(row=>row.characterId===owner)?.level??1);
}

/** Previous game observations are evidence for reconciling legacy plans only. */
export function savedPlanBases(profile:AppProfileV2,saved:SavedBoards,starting:SavedBoards,observed:SavedBoards={}):SavedBoards{
  const bases:SavedBoards={};
  let legacy:SavedBoards|undefined;
  for(const owner of Object.keys(saved)){
    let base=observed[owner]??profile.savedBoardBases?.[owner];
    if(!base&&profile.savedBoards?.[owner]){
      legacy??=optimizerBoards(profile.gameAccountImport?.snapshot.tables.boards);
      base=legacy[owner];
      if(!base&&boardChanges(starting[owner],profile.savedBoards[owner]).length)base=starting[owner];
    }else if(!base)base=starting[owner]??{nodes:[],cards:{}};
    if(base)bases[owner]=base;
  }
  return bases;
}

export function currentPointRows(profile:AppProfileV2|undefined,members:readonly {characterId:string}[],boards:SavedBoards){
  if(!profile)return [];
  return members.filter(({characterId})=>accountCharactersById.has(characterId)).map(({characterId})=>({
    skillTreePointId:'skill_tree_point-'+characterId,quantity:String(currentBoardPoints(profile,characterId,boards[characterId]??{nodes:[],cards:{}}).available),
  }));
}

export function currentMembers(profile?:AppProfileV2){
  return (profile?.account.unlockedCharacterIds??[]).map(characterId=>({characterId,
    level:currentMemberRank(profile!,characterId),exp:profile?.account.boards[characterId]?.characterExp??'0'}));
}

export function currentBoardPoints(profile:AppProfileV2,owner:string,board=currentBoards(profile)[owner]){
  const rank=currentMemberRank(profile,owner);
  const earned=boardPointsForMemberLevel(owner,rank);
  const spent=boardPointsSpent(owner,board?.nodes??[]);
  const checkpoint=consolidateCurrentProfile(profile).account.boards[owner]?.pointBalance;
  const available=checkpoint?checkpoint.quantity+earned-boardPointsForMemberLevel(owner,checkpoint.rank)-spent+checkpoint.spent:earned-spent;
  return {rank,earned,spent,available,reconciled:earned-spent===available};
}

export function currentOwnership(profile?:AppProfileV2):Set<string>|null {
  if(!profile||!profile.gameAccountImport&&!Object.keys(profile.cardOwnership??{}).length)return null;
  const ids=new Set(profile.currentDataVersion===1?[]:profile.gameAccountImport?.ownedCardIds??[]);
  for(const [id,owned] of Object.entries(profile.cardOwnership??{})){
    if(owned)ids.add(id);else ids.delete(id);
  }
  return ids;
}

export function currentGachaPoints(profile?:AppProfileV2){
  if(profile?.currentDataVersion===1)return profile.gachaPoints??{};
  return {...profile?.gameAccountImport?.snapshot.balances.gachaPoints,
    ...profile?.gachaPoints,...profile?.gachaPointEdits};
}

export function currentUpgradeBonus(profile:AppProfileV2|undefined,owned:GameAccountCardSource[]){
  if(!profile?.upgradeBonusManual&&owned.some(row=>profile?.cards[row.cardId]?.level!==row.level))return undefined;
  return profile?.account.upgradeBonusPermyriad;
}

export function currentGameInventory(profile?:AppProfileV2){
  return {...(profile?.currentDataVersion===1?{}:observedGameQuantities(profile?.gameAccountImport?.snapshot)),...profile?.gameInventory};
}

export function currentAchievementProgress(profile?:AppProfileV2){
  if(profile?.currentDataVersion===1)return profile.achievementProgress??{};
  const observed=profile?.gameAccountImport?.snapshot.tables.missions??[];
  const rows=Object.fromEntries(observed.filter(row=>row.missionPassId==='__NONE__').map(row=>[row.missionId,
    {progress:row.progress,rewardReceivedThresholds:row.rewardReceivedThresholds}]));
  return {...rows,...profile?.achievementProgress,...profile?.achievementEdits};
}

/** One current record, seeded once from older saves. Captures remain history. */
export function consolidateCurrentProfile(profile:AppProfileV2):AppProfileV2{
  if(profile.currentDataVersion===1)return profile;
  const snapshot=profile.gameAccountImport?.snapshot,boards={...profile.account.boards};
  const layouts=currentBoards(profile);
  for(const row of snapshot?.tables.members??[])if(!boards[row.characterId])boards[row.characterId]={
    characterId:row.characterId,characterLevel:row.level,unlockedNodeIds:[],connectAssignments:{},layoutKnown:false,
  };
  for(const row of snapshot?.tables.members??[])if(boards[row.characterId].characterLevel===row.level)
    boards[row.characterId]={...boards[row.characterId],characterExp:row.exp};
  for(const [owner,board] of Object.entries(boards))boards[owner]={...board,layoutKnown:!!layouts[owner]};
  for(const [owner,board] of Object.entries(layouts))boards[owner]={...boards[owner],characterId:owner,
    characterLevel:currentMemberRank(profile,owner),unlockedNodeIds:board.nodes,connectAssignments:board.cards,layoutKnown:resolvedBoard(profile,owner,board)};
  for(const row of snapshot?.tables.boardPoints??[]){
    const owner=row.skillTreePointId.replace(/^skill_tree_point-/,''),board=boards[owner];
    const source=snapshot?.tables.boards?.find(row=>row.characterId===owner);
    const rank=snapshot?.tables.members.find(row=>row.characterId===owner)?.level,quantity=Number(row.quantity);
    if(!board||!source||!rank||!Number.isSafeInteger(quantity)||quantity<0)continue;
    try{boards[owner]={...board,pointBalance:{quantity,rank,spent:boardPointsSpent(owner,source.releasedSkillTreeNodeGroupIds)}};}catch{/* Unresolved topology stays unknown. */}
  }
  const ownership=currentOwnership(profile);
  const bonus=profile.account.upgradeBonusPermyriad,measured=snapshot?.progress?.upgradeBonusPermyriad;
  const manual=profile.upgradeBonusManual??(bonus!==undefined&&bonus!==measured);
  const changed=!manual&&snapshot?.tables.cards.some(row=>ownership?.has(row.cardId)&&
    profile.cards[row.cardId]&&profile.cards[row.cardId].level!==row.level);
  const memory=profile.account.memoryBonusPermil;
  const memoryManual=profile.memoryBonusManual??(memory!==undefined&&memory!==snapshot?.progress?.memoryBonusPermil);
  return {...profile,currentDataVersion:1,boardProgressVersion:1,boardEdits:undefined,
    upgradeBonusManual:manual,
    memoryBonusManual:memoryManual,
    ...(ownership?{cardOwnership:Object.fromEntries([...ownership].map(id=>[id,true]))}:{}),
    gachaPoints:currentGachaPoints(profile),gachaPointEdits:undefined,
    achievementProgress:currentAchievementProgress(profile),achievementEdits:undefined,
    achievementProgressKnown:profile.achievementProgressKnown??snapshot?.tables.missions!==undefined,
    gameInventory:currentGameInventory(profile),account:{...profile.account,boards,playerLevel:currentDreamRank(profile),
      upgradeBonusPermyriad:changed?undefined:bonus,
      memoryBonusPermil:!memoryManual&&snapshot?.progress?.memoriesCollected!==undefined&&
        profile.account.memoriesCollected!==snapshot.progress.memoriesCollected?undefined:memory,
      ownedCostumeIds:[...new Set([...snapshot?.tables.costumes?.map(row=>row.costumeId)??[],...profile.account.ownedCostumeIds])],
      ownedSongIds:[...new Set([...snapshot?.tables.songs?.map(row=>row.musicId)??[],...profile.account.ownedSongIds??[]])]},
  };
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
    return [{...raw,cardId,exp:raw?.exp??'0',potentialUpgradePointQuantity:saved?.bloomPoints??raw?.potentialUpgradePointQuantity??0,
      maxLevel:raw?.maxLevel??progressionManifest.rarities[card!.rarity].maxLevel,rarity:raw?.rarity??card!.rarity,
      cardName:raw?.cardName??card?.cardName,memberName:raw?.memberName??card?.memberName,
      level:goal?.current?.level??saved?.level??raw?.level??1,
      levelLimitBreakCount:goal?Math.max(goal.current?.asc??0,training.get(cardId)??0):saved?.trainingStage??raw?.levelLimitBreakCount??0,
      potentialUpgradeCount:goal?.eidolon??saved?.bloomStage??raw?.potentialUpgradeCount??0,
    }];
  });
}
