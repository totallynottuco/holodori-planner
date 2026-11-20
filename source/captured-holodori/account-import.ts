import {progressionManifest as manifest} from '../hololive/vendor/shared/manifest';
import {accountCharactersById,accountManifest,connectedBoardNodeIds,resolveAccountCardParametersBatch,resolveBoardNodes,resolveBoardConnectEffect} from '../hololive/vendor/shared/account-data';
import {createDefaultCardState,createDefaultProfile,gameAccountSnapshotSchema,prepareProfile,validateProfileForManifest} from '../hololive/vendor/shared/profile';
import {minimumTrainingStage} from '../hololive/vendor/shared/planner';
import {boostCap,boostRules,defaultBoosts,sampleBoost,type Boosts} from '../hololive/boosts';
import {inventoryEventCurrency,inventoryEventTime,type InventoryEventWindow} from './inventory-events';
import {accountProgressRank,syncImportedMemberRanks} from './account-progress';
import {boardProgressPatch,consolidateCurrentProfile,currentAchievementProgress,currentDreamRank,currentGachaPoints,currentGameInventory,currentMembers,currentOwnership,observedDreamRank} from './current-account';
import {diamondInventoryIds,isGameInventoryId,resourceKeys,type AppProfileV2,type CardCatalogEntry,type GameAccountCardSource,type GameAccountIdentity,type GameAccountImportState,type GameAccountSnapshot,type ResourceKey,type SavedCardState} from '../hololive/vendor/shared/types';
import {ACCOUNT_RESOURCE_ITEM_IDS,observedGameQuantities} from './account-items';
export {ACCOUNT_RESOURCE_ITEM_IDS} from './account-items';

const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

export interface AccountImportWarning {code:string;message:string;cardId?:string;resourceKey?:ResourceKey;characterId?:string}
export interface AccountCardChange {
  cardId:string;cardName:string;memberName:string;status:'new'|'updated'|'unchanged'|'unknown'|'unsupported';
  previous:SavedCardState|null;next:SavedCardState|null;observed:GameAccountCardSource;
}
export interface AccountInventoryChange {
  key:ResourceKey;sourceItemId:string;previous:number;value:number;delta:number;stackCount:number;
  authoritative:boolean;status:'updated'|'unchanged'|'skipped';
}
export interface AccountMemberProgress {characterId:string;expTotal:string;level:number;known:boolean;name:string;previousRank:number|null;plannerRank:number|null}
export interface AccountBoostComparison {
  previous:number|null;previousCap:number;value:number|null;cap:number;nextRecoveryAt:number|null;
  status:'updated'|'unchanged'|'unavailable'|'skipped';
}
export interface AccountStatusPreview {
  identity:GameAccountIdentity|null;linkedIdentity:GameAccountIdentity|null;identityStatus:'new'|'matched'|'unavailable';
  boosts:{minigame:AccountBoostComparison;live:AccountBoostComparison};
  holoPassport:{previous:boolean;active:boolean|null;expiresAtMs:string|null;status:'updated'|'unchanged'|'unavailable'};
}
export interface AccountImportPreview {
  snapshot:GameAccountSnapshot;
  accountStatus:AccountStatusPreview;
  counts:{sourceCards:number;knownCards:number;unknownCards:number;unsupportedCards:number;newCards:number;updatedCards:number;unchangedCards:number;members:number;knownMembers:number;unknownMembers:number;materials:number;materialsChanged:number;materialsSkipped:number;unobservedCardsPreserved:number};
  cardChanges:AccountCardChange[];inventoryChanges:AccountInventoryChange[];members:AccountMemberProgress[];warnings:AccountImportWarning[];nextProfile:AppProfileV2;
}

/** Complete production captures only. Research tags and partial tables cannot
 * become authoritative zero quantities through this entry point. */
export function parseAccountSnapshot(input:unknown):GameAccountSnapshot {
  return gameAccountSnapshotSchema.parse(input) as GameAccountSnapshot;
}

function accountStatusPreview(snapshot:GameAccountSnapshot,previous:AppProfileV2,next:AppProfileV2,warnings:AccountImportWarning[]):AccountStatusPreview {
  const source=snapshot.accountStatus,before=previous.boosts||defaultBoosts(),after=copy(before);
  const identity=source?.identity||null,linkedIdentity=previous.gameAccountImport?.identity||previous.gameAccountImport?.snapshot.accountStatus?.identity||null;
  if(identity&&linkedIdentity&&identity.publicUserId!==linkedIdentity.publicUserId)
    throw Error('This profile is linked to a different game account. Select another profile before importing.');
  if(!identity&&linkedIdentity)warnings.push({code:'unavailable-account-identity',message:'The game account identity was unavailable. This capture could not be matched to the linked account; its existing identity has been kept.'});
  const observedAt=Date.parse(source?.observedAt||snapshot.capturedAt),serverTime=source?Number(source.serverTimeMs):null;
  const passport=source?.holoPassport||null;
  if(passport)after.holoPassport=passport.active;
  const boosts={} as AccountStatusPreview['boosts'];
  for(const kind of ['minigame','live'] as const){
    const previousCap=boostCap(kind,before.holoPassport),cap=boostCap(kind,after.holoPassport),prior=before[kind];
    const current=prior?sampleBoost(prior,previousCap,boostRules[kind].interval,observedAt):null;
    const comparison:AccountBoostComparison={previous:current?.amount??null,previousCap,value:null,cap,nextRecoveryAt:null,status:'unavailable'};
    const raw=source?.boosts[kind];
    if(raw){
      const recoveryTime=Number(raw.lastRecoveryTimeMs);
      const anchor=observedAt+(recoveryTime-(serverTime??0));
      if(!Number.isSafeInteger(raw.amount)||raw.amount<0||raw.amount>cap||serverTime===null||!Number.isSafeInteger(serverTime)||serverTime<=0||!Number.isSafeInteger(recoveryTime)||recoveryTime<=0||recoveryTime>serverTime||!Number.isSafeInteger(anchor)||anchor<0||anchor>observedAt){
        comparison.status='skipped';warnings.push({code:'unsupported-boost-state',message:`${boostRules[kind].name}: the game count or recovery timing cannot be represented by this tracker. Its existing tracker was kept.`});
      }else{
        // The native quantity predates regeneration. Preserve its recovery phase;
        // use the clock offset, not capture time as a replacement anchor.
        const record={amount:raw.amount,at:anchor},sampled=sampleBoost(record,cap,boostRules[kind].interval,observedAt);
        after[kind]=record;comparison.value=sampled.amount;comparison.nextRecoveryAt=sampled.nextAt;
        comparison.status=same(prior,record)?'unchanged':'updated';
      }
    }
    boosts[kind]=comparison;
  }
  next.boosts=after;
  return {identity:identity?copy(identity):null,linkedIdentity:linkedIdentity?copy(linkedIdentity):null,identityStatus:identity?(linkedIdentity?'matched':'new'):'unavailable',boosts,
    holoPassport:{previous:before.holoPassport,active:passport?.active??null,expiresAtMs:passport?.expiresAtMs??null,status:passport?(passport.active===before.holoPassport?'unchanged':'updated'):'unavailable'}};
}

export function cardProgress(source:GameAccountCardSource,before:SavedCardState|undefined,card:CardCatalogEntry):SavedCardState|string {
  const rules=manifest.rarities[String(card.rarity) as '3'|'4'|'5'];
  const stage=source.levelLimitBreakCount as SavedCardState['trainingStage'];
  const expectedCap=stage===0?rules.initialLevelCap:rules.trainingStages[stage-1].levelCap;
  if(source.rarity!==card.rarity || source.maxLevel!==expectedCap || source.level>rules.maxLevel)
    return 'Native card level cap or rarity differs from this catalog; exact source progress was retained.';
  if(source.level>expectedCap)return 'Native SP stage does not permit the observed level; source progress was retained.';
  const total=Number(source.exp),base=manifest.cumulativeExperience[source.level-1];
  const partial=total-base;
  if(!Number.isSafeInteger(base)||partial<0 || (source.level===rules.maxLevel?partial!==0:partial>=manifest.cumulativeExperience[source.level]-base))
    return 'Native level/EXP differs from this catalog; exact total EXP and native level were retained.';
  const result=copy(before || createDefaultCardState(card.id,`${card.memberName} — ${card.cardName}`));
  result.level=source.level;result.expIntoLevel=partial;result.trainingStage=stage;
  result.bloomStage=source.potentialUpgradeCount as SavedCardState['bloomStage'];result.bloomPoints=source.potentialUpgradePointQuantity;
  // Game facts never lower a saved target or invent a new active plan. Completed
  // targets clamp to the observed current state without spending inventory.
  const targetLevel=Math.max(result.goal.targetLevel,result.level);
  const targetStage=Math.max(result.goal.targetTrainingStage,stage,minimumTrainingStage(card,targetLevel,manifest)) as SavedCardState['trainingStage'];
  const targetBloom=result.goal.targetBloomStage===undefined?undefined:
    Math.max(result.goal.targetBloomStage,result.bloomStage) as SavedCardState['bloomStage'];
  result.goal={...result.goal,targetLevel,targetTrainingStage:targetStage,
    ...(targetBloom===undefined?{}:{targetBloomStage:targetBloom}),
    active:result.goal.active&&(targetLevel>result.level||targetStage>stage||(targetBloom??result.bloomStage)>result.bloomStage)};
  return result;
}

/** Calculations are a separate source layer, never a claimed native cache or a
 * mutation of the user's manually planned Boards. Unknown purchased topology
 * or mismatched native master inputs refuse derivation instead of guessing. */
export function importedParameterProfile(snapshot:GameAccountSnapshot):AppProfileV2|null {
  if(!snapshot.tables.boards?.length)return null;
  const temporary=createDefaultProfile(manifest.metadata.catalogVersion),owned=new Map(snapshot.tables.cards.map(card=>[card.cardId,card])),catalog=new Map(manifest.cards.map(card=>[card.id,card]));
  temporary.account.boards={};temporary.cards={};
    const members=new Map(snapshot.tables.members.map(row=>[row.characterId,row]));
    const boards=new Map(snapshot.tables.boards.map(row=>[row.characterId,row]));
    if(boards.size!==snapshot.tables.boards.length||[...members.keys()].some(id=>!boards.has(id)))throw Error('Native Boards do not cover every observed Holomem.');
    for(const source of snapshot.tables.cards){
      const parameters=accountManifest.cardParameterProfiles[source.cardId],master=source.master;
      const catalogCard=catalog.get(source.cardId);
      if(catalogCard&&(source.rarity!==catalogCard.rarity||master&&master.assetId!==catalogCard.assetId))throw Error('Native card rarity or asset identity differs from the installed catalog.');
      if(parameters&&master){
        const expected:Record<string,unknown>={characterId:parameters.characterId,cardLevelGroupId:parameters.levelGroupId,cardPotentialGroupId:parameters.potentialGroupId,performancePermilMultiply:parameters.parameterPermil.performance,techniquePermilMultiply:parameters.parameterPermil.technique,sensePermilMultiply:parameters.parameterPermil.sense,skillTreeConnectEffectId:accountManifest.cardConnectEffectIds[source.cardId]||''};
        if(Object.entries(expected).some(([key,value])=>master[key]!==undefined&&master[key]!==value))throw Error('Native card parameter metadata differs from the installed catalog.');
      }
      const card=createDefaultCardState(source.cardId,source.cardName||source.cardId);card.level=source.level;card.bloomStage=source.potentialUpgradeCount as SavedCardState['bloomStage'];temporary.cards[source.cardId]=card;
    }
    for(const source of snapshot.tables.boards){
      if(!accountCharactersById.has(source.characterId))throw Error('A native Holomem Board is outside the installed catalog.');
      const nodes=resolveBoardNodes(source.characterId),byId=new Map(nodes.map(node=>[node.groupId,node]));
      if(source.releasedSkillTreeNodeGroupIds.some(id=>!byId.has(id)))throw Error('A purchased Board node is outside the installed topology.');
      const active=connectedBoardNodeIds(nodes,source.releasedSkillTreeNodeGroupIds);
      if(source.releasedSkillTreeNodeGroupIds.some(id=>!active.has(id)))throw Error('A purchased Board node is disconnected in the installed topology.');
      const assignments:Record<string,string>={};
      source.connectedSkillTreeNodeGroupIds.forEach((id,index)=>{
        const cardId=source.connectedSkillTreeNodeCardIds[index],card=owned.get(cardId);
        if(byId.get(id)?.type!=='connect'||!active.has(id)||!card||!resolveBoardConnectEffect(cardId,card.potentialUpgradeCount))throw Error('A native Connect assignment cannot be resolved by the installed catalog.');
        assignments[id]=cardId;
      });
      temporary.account.boards[source.characterId]={characterId:source.characterId,characterLevel:members.get(source.characterId)?.level||1,unlockedNodeIds:[...source.releasedSkillTreeNodeGroupIds],connectAssignments:assignments};
    }
  return temporary;
}
function calculateAccountStats(snapshot:GameAccountSnapshot,warnings:AccountImportWarning[]):Pick<GameAccountImportState,'calculatedTotalStats'|'calculationSource'> {
  try{
    const temporary=importedParameterProfile(snapshot);
    if(!temporary)return {};
    // Stage the whole result before publishing any calculated source values.
    const calculated:NonNullable<GameAccountImportState['calculatedTotalStats']>={};
    const known=snapshot.tables.cards.filter(source=>accountManifest.cardParameterProfiles[source.cardId]);
    const results=resolveAccountCardParametersBatch(temporary,known.map(source=>({cardId:source.cardId,level:source.level,bloomStage:source.potentialUpgradeCount})));
    for(let index=0;index<known.length;index++){
      const source=known[index],result=results[index];
      if(result.level!==source.level||result.bloomStage!==source.potentialUpgradeCount||Object.values(result.accountStats).some(value=>!Number.isSafeInteger(value)||value<0)||!Number.isSafeInteger(result.accountTotal))throw Error('Native card progress cannot be represented exactly by the installed parameters.');
      calculated[source.cardId]={performance:String(result.accountStats.performance),technique:String(result.accountStats.technique),sense:String(result.accountStats.sense),totalPower:String(result.accountTotal)};
    }
    return {calculatedTotalStats:calculated,calculationSource:{schemaVersion:1,source:'planner-derived',method:'resolveAccountCardParameters-v1',catalogVersion:manifest.metadata.catalogVersion,accountSourceCommit:accountManifest.metadata.sourceCommit,inputs:'native-owned-card-progress-and-boards',capturedAt:snapshot.capturedAt}};
  }catch(error){warnings.push({code:'calculated-stats-unavailable',message:`Account totals were kept as native data without deriving replacements: ${String(error instanceof Error?error.message:error)}`});return {};}
}

export function previewAccountImport(input:unknown,previous:AppProfileV2,events:readonly InventoryEventWindow[] = [],localTime?:number):AccountImportPreview {
  const source=parseAccountSnapshot(input),next=consolidateCurrentProfile(prepareProfile(previous,manifest).profile);
  const keep=inventoryEventCurrency(events,inventoryEventTime(source,localTime??Date.parse(source.capturedAt)));
  const snapshot={...source,tables:{...source.tables,
    items:source.tables.items.filter(row=>keep(row.itemId)),
    ownedItems:source.tables.ownedItems.filter(row=>keep(row.itemId)),
  }};
  const catalog=new Map(manifest.cards.map(card=>[card.id,card]));
  const warnings:AccountImportWarning[]=[],cardChanges:AccountCardChange[]=[];
  const accountStatus=accountStatusPreview(snapshot,previous,next,warnings);
  if(source.gachaReadStatus&&!snapshot.balances.gachaPoints)warnings.push({code:'gacha-points-unavailable',
    message:'Gacha Points did not refresh. Your current balances will be kept.'});
  if(snapshot.balances.free===null||snapshot.balances.paid===null)warnings.push({code:'unavailable-gem-balance',message:'Some gem balances have not loaded in the game. They are retained as unknown; card progress and materials can still be imported.'});
  const counts={sourceCards:snapshot.tables.cards.length,knownCards:0,unknownCards:0,unsupportedCards:0,newCards:0,updatedCards:0,unchangedCards:0,members:snapshot.tables.members.length,knownMembers:0,unknownMembers:0,materials:resourceKeys.length,materialsChanged:0,materialsSkipped:0,unobservedCardsPreserved:0};
  for(const source of snapshot.tables.cards){
    const card=catalog.get(source.cardId),before=next.cards[source.cardId];
    const change:AccountCardChange={cardId:source.cardId,cardName:source.cardName||card?.cardName||source.cardId,memberName:source.memberName||card?.memberName||'',status:'unknown',previous:before?copy(before):null,next:null,observed:copy(source)};
    if(!card){counts.unknownCards++;warnings.push({code:'unknown-card',cardId:source.cardId,message:`${change.cardName}: not in this catalog. Its complete source record will be saved.`});}
    else{
      counts.knownCards++;
      const progress=cardProgress(source,before,card);
      if(typeof progress==='string'){change.status='unsupported';counts.unsupportedCards++;warnings.push({code:'catalog-progress-mismatch',cardId:source.cardId,message:`${change.cardName}: ${progress}`});}
      else{
        change.next=copy(progress);change.status=!before?'new':same(before,progress)?'unchanged':'updated';
        if(change.status==='new')counts.newCards++;else if(change.status==='updated')counts.updatedCards++;else counts.unchangedCards++;
        next.cards[source.cardId]=progress;
      }
    }
    cardChanges.push(change);
  }
  const owned=new Set(snapshot.tables.cards.map(card=>card.cardId));
  const priorOwnership=currentOwnership(previous);
  if(snapshot.progress?.upgradeBonusPermyriad===undefined&&!next.upgradeBonusManual&&
    snapshot.tables.cards.some(row=>previous.cards[row.cardId]?.level!==next.cards[row.cardId]?.level||!priorOwnership?.has(row.cardId)))
    delete next.account.upgradeBonusPermyriad;
  next.cardOwnership={...next.cardOwnership,...Object.fromEntries([...owned].map(id=>[id,true]))};
  next.gachaPoints={...currentGachaPoints(next),...snapshot.balances.gachaPoints};
  delete next.gachaPointEdits;
  next.achievementProgress={...currentAchievementProgress(next),...Object.fromEntries((snapshot.tables.missions??[])
    .filter(row=>row.missionPassId==='__NONE__').map(row=>[row.missionId,{progress:row.progress,rewardReceivedThresholds:row.rewardReceivedThresholds}]))};
  if(snapshot.tables.missions!==undefined)next.achievementProgressKnown=true;
  delete next.achievementEdits;
  const boards=Object.fromEntries((snapshot.tables.boards??[]).map(row=>[row.characterId,{nodes:row.releasedSkillTreeNodeGroupIds,
    cards:Object.fromEntries(row.connectedSkillTreeNodeGroupIds.map((slot,index)=>[slot,row.connectedSkillTreeNodeCardIds[index]]))}]));
  Object.assign(next,boardProgressPatch(next,boards));
  counts.unobservedCardsPreserved=Object.keys(next.cards).filter(id=>!owned.has(id)).length;
  const rows=new Map<string,GameAccountSnapshot['tables']['items']>();
  for(const item of snapshot.tables.items){const group=rows.get(item.itemId)||[];group.push(item);rows.set(item.itemId,group);}
  next.gameInventory=currentGameInventory(next);
  const knownItems=new Set(snapshot.tables.ownedItems.map(row=>row.itemId));
  for(const id of Object.keys(next.gameInventory)){
    if(!keep(id))delete next.gameInventory[id];
    else if(id.startsWith('item-')&&!rows.has(id)&&!knownItems.has(id))next.gameInventory[id]=0;
  }
  Object.assign(next.gameInventory,observedGameQuantities(snapshot));
  const inventoryChanges:AccountInventoryChange[]=[],materialKeys:ResourceKey[]=[];
  for(const key of resourceKeys){
    const sourceItemId=ACCOUNT_RESOURCE_ITEM_IDS[key],stacks=rows.get(sourceItemId)||[],prior=next.inventory[key];
    // Nonzero expiration is deliberately not interpreted until the native
    // amount getter's expiration policy is verified. Raw stacks are retained.
    const missingQuantity=!stacks.length&&knownItems.has(sourceItemId);
    const authoritative=!missingQuantity&&stacks.every(stack=>stack.expiredTime==='0');
    let value=prior;
    if(authoritative){
      value=0;
      for(const stack of stacks){const amount=Number(stack.quantity);if(value>Number.MAX_SAFE_INTEGER-amount)throw Error(`The ${key} inventory total exceeds the exact integer range.`);value+=amount;}
      next.inventory[key]=value;materialKeys.push(key);
    }else{counts.materialsSkipped++;warnings.push(missingQuantity
      ?{code:'missing-material-quantity',resourceKey:key,message:`${key}: the game listed this item without a quantity. Your current quantity was kept.`}
      :{code:'unverified-material-expiration',resourceKey:key,message:`${key}: expiring stacks were retained, and the planner quantity was kept until their native availability is verified.`});}
    const status=!authoritative?'skipped':value===prior?'unchanged':'updated';
    if(status==='updated')counts.materialsChanged++;
    inventoryChanges.push({key,sourceItemId,previous:prior,value,delta:value-prior,stackCount:stacks.length,authoritative,status});
  }
  const unlocked=new Set(next.account.unlockedCharacterIds);
  const previousRanks=new Map(currentMembers(previous).map(row=>[row.characterId,row.level]));
  next.account=syncImportedMemberRanks(next.account,snapshot.tables.members);
  for(const row of snapshot.tables.members)if(!next.account.boards[row.characterId])next.account.boards[row.characterId]={
    characterId:row.characterId,characterLevel:row.level,unlockedNodeIds:[],connectAssignments:{},layoutKnown:false,
  };
  for(const row of snapshot.tables.members){
    const board=next.account.boards[row.characterId];
    const characterLevel=accountCharactersById.has(row.characterId)?board.characterLevel:row.level;
    next.account.boards[row.characterId]={...board,characterLevel,characterExp:characterLevel===row.level?row.exp:undefined};
  }
  for(const row of snapshot.tables.boardPoints??[]){
    const owner=row.skillTreePointId.replace(/^skill_tree_point-/,''),board=next.account.boards[owner];
    if(!board||!Object.hasOwn(boards,owner))continue;
    const quantity=Number(row.quantity);
    if(Number.isSafeInteger(quantity)&&quantity>=0)try{
      const spent=resolveBoardNodes(owner).filter(node=>board.unlockedNodeIds.includes(node.groupId)).reduce((sum,node)=>sum+node.boardPointCost,0);
      board.pointBalance={quantity,rank:board.characterLevel,spent};
    }catch{/* Keep unresolved Board data without inventing a balance. */}
  }
  if(snapshot.tables.costumes)next.account.ownedCostumeIds=[...new Set([...next.account.ownedCostumeIds,...snapshot.tables.costumes.map(row=>row.costumeId)])];
  if(snapshot.tables.songs)next.account.ownedSongIds=[...new Set([...next.account.ownedSongIds??[],...snapshot.tables.songs.map(row=>row.musicId)])];
  const members=snapshot.tables.members.map(source=>{
    const entry=accountCharactersById.get(source.characterId),known=!!entry;
    unlocked.add(source.characterId);
    if(known){counts.knownMembers++;}else{counts.unknownMembers++;warnings.push({code:'unknown-member',characterId:source.characterId,message:`${source.characterId}: member progress was retained without guessing a catalog match.`});}
    const previousLevel=previousRanks.get(source.characterId);
    const hadRank=previous.account.boards[source.characterId]!==undefined||previousLevel!==undefined;
    return {
      characterId:source.characterId,expTotal:source.exp,level:source.level,known,name:entry?.name||source.characterId,
      previousRank:hadRank?accountProgressRank(previous.account,source.characterId,previousLevel)?.level??null:null,
      plannerRank:accountProgressRank(next.account,source.characterId,source.level)?.level??null,
    };
  });
  next.account.unlockedCharacterIds=[...unlocked];
  const progress=snapshot.progress;
  const dreamRank=observedDreamRank(snapshot);
  next.account.playerLevel=dreamRank??currentDreamRank(previous);
  if(dreamRank!==undefined)delete next.dreamRankManuallySet;
  if(progress){
    if(progress.quest!==undefined)next.account.storyProgress=progress.quest??{chapter:1,episode:0};
    if(progress.memoriesCollected!==undefined){
      if(progress.memoriesCollected!==next.account.memoriesCollected&&progress.memoryBonusPermil===undefined&&!next.memoryBonusManual)delete next.account.memoryBonusPermil;
      next.account.memoriesCollected=progress.memoriesCollected;
    }
    if(progress.memoryBonusPermil!==undefined){next.account.memoryBonusPermil=progress.memoryBonusPermil;delete next.memoryBonusManual;}
    if(progress.upgradeBonusPermyriad!==undefined){next.account.upgradeBonusPermyriad=progress.upgradeBonusPermyriad;delete next.upgradeBonusManual;}
  }
  const calculated=calculateAccountStats(snapshot,warnings);
  const identity=accountStatus.identity||accountStatus.linkedIdentity;
  const savedSnapshot=copy(snapshot);
  if(savedSnapshot.balances.gachaPoints)savedSnapshot.balances.gachaPointsObservedAt=snapshot.capturedAt;
  next.gameAccountImport={schemaVersion:1,snapshot:savedSnapshot,...(identity?{identity:copy(identity)}:{}),ownedCardIds:[...owned],materialKeys,...calculated};
  // Revision, profile ownership, backup and native transaction are the caller's
  // responsibility. This operation is pure and leaves all unobserved state.
  const nextProfile=validateProfileForManifest(next,manifest);
  return {snapshot:copy(snapshot),accountStatus,counts,cardChanges,inventoryChanges,members,warnings,nextProfile};
}

export function applyAccountImport(previous:AppProfileV2,snapshot:unknown,events?:readonly InventoryEventWindow[],localTime?:number):AppProfileV2 {
  return previewAccountImport(snapshot,previous,events,localTime).nextProfile;
}

/** Preserve the captured renderer's actual IDs/extensions and all other fields.
 * Callers atomically store this partial patch with nextProfile. The converted
 * snapshot is produced from that validated nextProfile, not raw game input. */
export function mergeCapturedAccountImport(
  existing:Record<string,unknown>,converted:Record<string,unknown>,ownedCardIds:readonly string[],materialKeys:readonly ResourceKey[],
):{goals:any[];inventory:any[];boosts?:Boosts} {
  if(!Array.isArray(existing.goals)||!Array.isArray(existing.inventory)||!Array.isArray(converted.goals)||!Array.isArray(converted.inventory))throw Error('The captured account fields have an invalid shape.');
  const catalog=new Map(manifest.cards.map(card=>[card.id,card]));
  const isGameQuantity=(entry:any)=>isGameInventoryId(entry?.item)&&entry.type===entry.item&&entry.tier===0;
  const goals=copy(existing.goals),inventory=copy([
    ...existing.inventory.filter(entry=>!isGameQuantity(entry)),
    ...converted.inventory.filter(isGameQuantity),
  ]),incoming=converted.goals as any[];
  let lastId=goals.reduce((max:number,goal:any)=>typeof goal.id==='number'&&Number.isSafeInteger(goal.id)?Math.max(max,goal.id):max,0);
  for(const id of ownedCardIds){
    const source=incoming.find(goal=>goal.type==='character'&&goal.character===id),card=catalog.get(id);
    if(!source||!card)continue;
    let level=goals.find((goal:any)=>goal.type==='character'&&goal.character===id),sp=goals.find((goal:any)=>goal.type==='trace'&&goal.character===id);
    const targetLevel=Math.max(source.current.level,source.goal.level,Number(level?.goal?.level)||1);
    const targetStage=Math.max(source.current.asc,source.goal.asc,Number(level?.goal?.asc)||0,Number(sp?.sp?.goal)||0,minimumTrainingStage(card,targetLevel,manifest));
    if(!level){level={...copy(source),id:++lastId};goals.push(level);}
    level.current={...level.current,...copy(source.current)};
    level.goal={...level.goal,level:targetLevel,asc:targetStage,text:String(targetLevel)};level.eidolon=source.eidolon;
    if(!sp){sp={id:++lastId,type:'trace',character:id,sp:{},bonus:{}};goals.push(sp);}
    sp.sp={...sp.sp,current:source.current.asc,goal:targetStage};
  }
  for(const key of materialKeys){
    if(!resourceKeys.includes(key))throw Error('An imported material is outside the planner resource scope.');
    const source=(converted.inventory as any[]).find(entry=>entry.type===key&&entry.item===key&&(entry.tier??0)===0);
    if(!source)throw Error('An imported material quantity is missing.');
    const matches=inventory.filter((entry:any)=>entry.type===key&&entry.item===key&&(entry.tier??0)===0);
    if(matches.length)for(const entry of matches)entry.value=source.value;
    else inventory.push(copy(source));
  }
  return {goals,inventory,...(converted.boosts!==undefined&&!same(existing.boosts,converted.boosts)?{boosts:copy(converted.boosts as Boosts)}:{})};
}
