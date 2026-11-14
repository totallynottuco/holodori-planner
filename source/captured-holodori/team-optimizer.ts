import {accountCharactersById,accountManifest,availableAccountCostumes,connectedBoardNodeIds,resolveBoardConnectEffect,resolveBoardNodes,resolveCardParameters} from '../hololive/vendor/shared/account-data';
import {resolveChartTimeline} from '../hololive/vendor/shared/chart-timeline';
import {resolveExpectedScoreTrace} from '../hololive/vendor/shared/expected-score-trace';
import {decodeOptimizerChart} from '../hololive/vendor/shared/optimizer-chart-pack';
import {createDefaultCardState,createDefaultProfile} from '../hololive/vendor/shared/profile';
import {cardSkillLevels,type TeamSelection} from '../hololive/vendor/shared/team-parameters';
import type {GameAccountSnapshot} from '../hololive/vendor/shared/types';
import type {ScoringData} from '../hololive/vendor/shared/scoring-data';
import type {loadOptimizerResources} from './team-optimizer-resources';

type Resources=Awaited<ReturnType<typeof loadOptimizerResources>>;
type Tables=GameAccountSnapshot['tables'];
type OptimizerInput={
  chartKey:string;
  cards:Pick<Tables['cards'][number],'cardId'|'level'|'potentialUpgradeCount'>[];
  members:Pick<Tables['members'][number],'characterId'|'level'>[];
  boards?:Tables['boards'];
  memoryCount:number;
  memoryBonusPermil?:number;
  upgradeBonusPermyriad?:number;
  lockedCardIds:string[];
  leaderCharacterId?:string;
  useBoards:boolean;
  resultLimit:number;
};
type Candidate={id:string;member:string;attribute:string;priority:number;special:number};
type Result={cardIds:string[];leaderName:string;outfitName:string;low:number;high:number;power:number};
type Evaluated={result:Result;selection:TeamSelection};
const unique=(ids:readonly string[])=>[...new Set(ids)];
const formationKey=(ids:readonly string[])=>ids.slice().sort().join('|');

function strength(data:ScoringData,kind:'active'|'special',id:string,level:number) {
  const skills=kind==='active'?data.activeSkills:data.specialSkills;
  const definition=skills[id]?.levels.find(row=>row.level===level);
  if(!definition)return 0;
  const scoreUp=Math.max(0,...definition.branches.flatMap(branch=>
    (data.activeEffects[branch.effectGroupId]??[]).filter(effect=>effect.type.includes('SCORE_UP')).map(effect=>effect.value)));
  return kind==='special'?scoreUp:scoreUp*(definition.activationProbabilityPermil??0)/1000*
    (definition.durationMilliseconds??0)/Math.max(definition.cooldownMilliseconds??1,1);
}

function context(input:OptimizerInput,data:ScoringData) {
  const profile=createDefaultProfile(data.metadata.catalogVersion);
  profile.account.memoriesCollected=input.memoryCount;
  const ranks=new Map(input.members.map(member=>[member.characterId,member.level]));
  profile.account.unlockedCharacterIds=[...ranks.keys()].filter(id=>accountCharactersById.has(id));
  const pool:Candidate[]=[];
  let rosterBonus=0,missingRoster=0;
  for(const row of input.cards){
    const id=row.cardId,meta=accountManifest.cardParameterProfiles[id];
    const levelBonus=meta&&data.levelBonuses[meta.levelGroupId]?.[row.level-1];
    if(levelBonus)rosterBonus+=levelBonus.liveDeckPowerPermyriadUp;
    else missingRoster++;
    const card=createDefaultCardState(id,id);
    card.level=row.level;card.bloomStage=row.potentialUpgradeCount as typeof card.bloomStage;
    profile.cards[id]=card;
    const scoring=data.cards[id];
    if(!meta||!scoring||!levelBonus)continue;
    const levels=cardSkillLevels(id,card.bloomStage,data);
    const power=Object.values(resolveCardParameters(id,card.level,card.bloomStage).stats).reduce((total,value)=>total+value,0);
    const special=strength(data,'special',scoring.specialSkillId,levels.special);
    const active=strength(data,'active',scoring.activeSkillId,levels.active);
    // Only the search shortlist uses this priority. Chart scores use the full trace.
    pool.push({id,member:meta.characterId,attribute:meta.attribute,priority:power*(1+(active+special*.04)/1000),special});
  }
  if(missingRoster&&input.upgradeBonusPermyriad===undefined)throw Error('Upgrade Bonus is missing for part of this collection. Refresh Import data to read the full bonus.');
  const observed={memoryPermil:input.memoryBonusPermil,upgradePermyriad:input.upgradeBonusPermyriad??Math.min(5000,rosterBonus)};
  if(input.useBoards){
    if(!input.boards?.length)throw Error('Board data is missing. Refresh Import data or clear Use imported Boards.');
    for(const source of input.boards){
      if(!accountCharactersById.has(source.characterId)){
        if(source.releasedSkillTreeNodeGroupIds.length||source.connectedSkillTreeNodeCardIds.length)throw Error('An imported Board is newer than the scoring catalog. Clear Use imported Boards to score without Board bonuses.');
        continue;
      }
      const nodes=resolveBoardNodes(source.characterId),ids=new Set(nodes.map(node=>node.groupId));
      const unlocked=source.releasedSkillTreeNodeGroupIds;
      const active=connectedBoardNodeIds(nodes,unlocked);
      if(unlocked.some(id=>!ids.has(id)||!active.has(id)))throw Error('An imported Board has unsupported unlocks. Clear Use imported Boards to score without Board bonuses.');
      const assignments:Record<string,string>={};
      source.connectedSkillTreeNodeGroupIds.forEach((slot,index)=>{
        const id=source.connectedSkillTreeNodeCardIds[index],card=profile.cards[id];
        if(!active.has(slot)||!card||!resolveBoardConnectEffect(id,card.bloomStage))
          throw Error('An imported Connect card is newer than the scoring catalog. Clear Use imported Boards to score without Board bonuses.');
        assignments[slot]=id;
      });
      profile.account.boards[source.characterId]={characterId:source.characterId,characterLevel:ranks.get(source.characterId)??1,
        unlockedNodeIds:unlocked,connectAssignments:assignments};
    }
  }
  return {profile,pool:pool.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id)),observed};
}

function shortlist(pool:Candidate[],locked:Candidate[]) {
  const builds=new Map<string,Candidate[]>();
  const complete=(base:Candidate[],candidates:Candidate[])=>{
    const members=new Set(base.map(card=>card.member)),team=base.slice();
    for(const card of candidates){
      if(team.length===5)break;
      if(!members.has(card.member)){team.push(card);members.add(card.member);}
    }
    if(team.length===5)builds.set(formationKey(team.map(card=>card.id)),team);
    return team;
  };
  const base=complete(locked,pool);
  for(const attr of unique(pool.map(card=>card.attribute))){
    complete(locked,[...pool.filter(card=>card.attribute===attr),...pool]);
  }
  // Sample high-priority replacements even if a member already appears in the top team.
  for(const card of pool.filter(card=>!base.includes(card)).slice(0,14)){
    if(locked.some(row=>row.member===card.member)||locked.length===5)continue;
    complete([...locked,card],pool);
  }
  return [...builds.values()];
}

export function searchTeams(resources:Resources,input:OptimizerInput,progress:(evaluated:number,total:number)=>void) {
  const {pack,data,denominators}=resources;
  const chart=decodeOptimizerChart(pack,input.chartKey,'mobile');
  const {profile,pool,observed}=context(input,data);
  if(new Set(pool.map(card=>card.member)).size<5)throw Error('At least five supported cards from different Holomem are needed.');
  const locked=input.lockedCardIds.map(id=>pool.find(card=>card.id===id));
  if(locked.some(card=>!card)||new Set(locked.map(card=>card?.member)).size!==locked.length||locked.length>5)
    throw Error('Choose up to five supported cards from different Holomem.');
  const leaders=new Set(profile.account.unlockedCharacterIds);
  const outfits=availableAccountCostumes(Object.keys(profile.cards),[]).filter(outfit=>
    leaders.has(outfit.characterId)&&(!input.leaderCharacterId||input.leaderCharacterId===outfit.characterId)&&
    (!outfit.leaderSkillId||data.leaderSkills[outfit.leaderSkillId]));
  if(!outfits.length)throw Error('No supported outfit is available for the selected leader.');
  const song=data.songs[chart.music_id];
  const leaderStrength=(outfit:typeof outfits[number])=>{
    const skill=outfit.leaderSkillId?data.leaderSkills[outfit.leaderSkillId]:undefined;
    return skill?.levels[0]?.branches.reduce((total,branch)=>total+
      (data.passiveEffects[branch.effectGroupId]??[]).reduce((sum,effect)=>sum+effect.value,0),0)??0;
  };
  const orderedOutfits=outfits.sort((a,b)=>leaderStrength(b)-leaderStrength(a)||a.id.localeCompare(b.id));
  const lineups=shortlist(pool,locked as Candidate[]);
  const limit=60,tried=new Set<string>(),results=new Map<string,Evaluated>(),reasons=new Set<string>();
  let evaluated=0,unresolved=0;
  const mean=(row:Result)=>(row.low+row.high)/2;
  const ranked=()=>[...results.values()].sort((a,b)=>mean(b.result)-mean(a.result)||b.result.power-a.result.power);
  const evaluate=(selection:TeamSelection)=>{
    const key=selection.outfitId+'|'+selection.memberCardIds.join('|');
    if(tried.has(key)||evaluated>=limit)return;
    tried.add(key);evaluated++;
    if(evaluated%5===1)progress(evaluated,limit);
    const timeline=resolveChartTimeline(profile,selection,chart,data,null,observed);
    const trace=resolveExpectedScoreTrace(timeline,chart,data,denominators,'additive-assumption');
    const expected=trace.expectedScenarioTotal;
    if(!expected||trace.power.status!=='resolved'){
      unresolved++;
      for(const reason of trace.reasons)reasons.add(reason);
      return;
    }
    const value=(fraction:typeof expected.lower)=>{
      const numerator=BigInt(fraction.numerator),denominator=BigInt(fraction.denominator);
      return Number((numerator+denominator/2n)/denominator);
    };
    const result:Result={cardIds:selection.memberCardIds,leaderName:timeline.team.leader.name,outfitName:timeline.team.leader.outfitName,
      low:value(expected.lower),high:value(expected.upper),power:trace.power.value};
    const group=formationKey(result.cardIds),previous=results.get(group);
    if(!previous||mean(result)>mean(previous.result))results.set(group,{result,selection});
  };
  const formation=(team:Candidate[],outfit:typeof outfits[number])=>({
    memberCardIds:team.map(row=>row.id),leaderCharacterId:outfit.characterId,outfitId:outfit.id,songId:song.id,
  });
  for(const team of lineups){
    const order=team.slice().sort((a,b)=>b.special-a.special||b.priority-a.priority);
    const fitting=orderedOutfits.filter(row=>team.some(card=>card.member===row.characterId)||song.characterIds.includes(row.characterId));
    for(const outfit of new Set([orderedOutfits[0],fitting[0]??orderedOutfits[1]??orderedOutfits[0]]))
      evaluate(formation(order,outfit));
  }
  for(const {selection} of ranked().slice(0,3)){
    for(const outfit of orderedOutfits.slice(0,5))
      evaluate({...selection,leaderCharacterId:outfit.characterId,outfitId:outfit.id});
    for(let a=0;a<5;a++)for(let b=a+1;b<5;b++){
      const order=selection.memberCardIds.slice();
      [order[a],order[b]]=[order[b],order[a]];
      evaluate({...selection,memberCardIds:order});
    }
  }
  const notes=['The estimate uses ideal timing and assumes additive stacking when multiple static skill modifiers apply.'];
  if(unresolved)notes.push('Some lineups could not be scored because their effects are unverified.');
  if(!results.size&&reasons.size)notes.push([...reasons].slice(0,3).join(' · '));
  return {results:ranked().slice(0,input.resultLimit).map(row=>row.result),evaluated,unresolved,excluded:input.cards.length-pool.length,notes};
}
