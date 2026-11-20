import {formatNumber} from './regional-formats.js';
import {accountCharactersById} from '../hololive/vendor/shared/account-data';
import type {AppProfileV2,GameAccountSnapshot} from '../hololive/vendor/shared/types';
import {achievementProgress,indexAchievementProgress,type AchievementCategory} from './achievements';
import {characters} from './game';
import {currentAchievementProgress,currentPointRows,currentBoards,currentMembers,currentOwnedCards} from './current-account';
import {boardTable} from './saved-boards';

type Boards=NonNullable<GameAccountSnapshot['tables']['boards']>;

export function compareCurrentAccount(profile:AppProfileV2,current:GameAccountSnapshot,categories?:AchievementCategory[]){
  const members=currentMembers(profile);
  const boards=currentBoards(profile);
  const progress=Object.entries(currentAchievementProgress(profile));
  const previous={...current,tables:{...current.tables,cards:currentOwnedCards(profile),members,
    boards:boardTable(boards),boardPoints:currentPointRows(profile,members,boards),
    missions:profile.achievementProgressKnown||progress.length?progress.map(([missionId,row])=>({
      missionId,...row,missionPassId:'__NONE__',lastProgressTime:'0',ttlBaseTime:'0',
    })):undefined}};
  return {...compareAccountImports(previous,current,categories)!,currentProfile:true};
}

function boardChanges(previous:GameAccountSnapshot,current:GameAccountSnapshot) {
  const before=previous.tables.boards,after=current.tables.boards;
  if(!before?.length||!after?.length)return null;
  const oldBoards=new Map(before.map(row=>[row.characterId,row]));
  const newBoards=new Map(after.map(row=>[row.characterId,row]));
  const oldPoints=new Map(previous.tables.boardPoints?.map(row=>[row.skillTreePointId,row.quantity]));
  const newPoints=new Map(current.tables.boardPoints?.map(row=>[row.skillTreePointId,row.quantity]));
  const comparable=new Set(after.filter(row=>oldBoards.has(row.characterId)).map(row=>row.characterId));
  const memberName=(id:string)=>accountCharactersById.get(id)?.name??id;
  const nodes=after.flatMap(row=>{
    const old=oldBoards.get(row.characterId);
    if(!old)return [];
    const oldNodes=new Set(old.releasedSkillTreeNodeGroupIds),newNodes=new Set(row.releasedSkillTreeNodeGroupIds);
    const unlocked=[...newNodes].filter(id=>!oldNodes.has(id)),removed=[...oldNodes].filter(id=>!newNodes.has(id));
    const pointId=accountCharactersById.get(row.characterId)?.boardPointId;
    const from=pointId?oldPoints.get(pointId):undefined,to=pointId?newPoints.get(pointId):undefined;
    const points=from!==undefined&&to!==undefined&&from!==to
      ? [formatNumber(BigInt(from)),formatNumber(BigInt(to))] : null;
    return unlocked.length||removed.length||points?[{member:memberName(row.characterId),unlocked,removed,points}]:[];
  });
  const placements=(boards:Boards)=>new Map(boards.flatMap(row=>row.connectedSkillTreeNodeCardIds.map((id,index)=>[
    id,{member:row.characterId,slot:row.connectedSkillTreeNodeGroupIds[index]},
  ] as const)));
  const oldPlacements=placements(before),newPlacements=placements(after);
  const cards=new Map([...previous.tables.cards,...current.tables.cards].map(card=>[card.cardId,card.cardName]));
  const position=(value:{member:string;slot:string})=>memberName(value.member)+' · '+(value.slot==='S-001'?'Center':value.slot);
  const connections=[...new Set([...oldPlacements.keys(),...newPlacements.keys()])].flatMap(id=>{
    const old=oldPlacements.get(id),next=newPlacements.get(id);
    if(old&&next&&old.member===next.member&&old.slot===next.slot)return [];
    if((old&&!comparable.has(old.member))||(next&&!comparable.has(next.member)))return [];
    return [{card:cards.get(id)||characters[id]?.cardName||id,from:old?position(old):'Unassigned',to:next?position(next):'Unassigned'}];
  });
  return {nodes,connections,incomplete:comparable.size!==oldBoards.size||comparable.size!==newBoards.size};
}

function achievementChanges(previous:GameAccountSnapshot,current:GameAccountSnapshot,categories?:AchievementCategory[]) {
  const before=indexAchievementProgress(previous.tables.missions),after=indexAchievementProgress(current.tables.missions);
  if(!before||!after||!categories)return null;
  const changes:{group:string;title:string;rewards:string;status:'Ready in game'|'Received'}[]=[];
  for(const category of categories)for(const group of category.groups)for(const mission of group.missions){
    if(!before.has(mission.id)&&!after.has(mission.id))continue;
    const old=achievementProgress(mission,before).tiers;
    achievementProgress(mission,after).tiers.forEach((tier,index)=>{
      if((tier.status!=='claimable'&&tier.status!=='received')||tier.status===old[index].status)return;
      // A tier already received is not newly claimable if the next capture lacks its receipt.
      if(tier.status==='claimable'&&old[index].status==='received')return;
      const target=formatNumber(BigInt(tier.target));
      const title=(mission.title||mission.unstartedTitle||mission.description||mission.id).replaceAll('{0}',target).replace(/<[^>]+>/g,'');
      changes.push({
        group:group.memberName||group.name||category.name,title,
        rewards:tier.rewards.map(reward=>formatNumber(BigInt(reward.quantity))+' × '+reward.label).join(' · '),
        status:tier.status==='claimable'?'Ready in game':'Received',
      });
    });
  }
  return changes;
}

export function compareAccountImports(previous:GameAccountSnapshot|undefined,current:GameAccountSnapshot,categories?:AchievementCategory[]) {
  if(!previous)return null;
  return {
    previousAt:previous.capturedAt,
    boards:boardChanges(previous,current),
    achievements:achievementChanges(previous,current,categories),
  };
}
