import {createReferenceScoreContext,evaluateReferenceTeam,referenceTeamScoreBonus,referenceUnitScore,
  referenceUnitSkillInputs} from './reference-rating-math';
import {boardPlanningBaseline} from './board-protection';
import {isTeamCardEligible} from './team-card-pool';

const powerComponents=['parameters','board','passive','memory','powerUp','leader'];
const lineupKey=order=>order.map(card=>card.id).sort().join('|');
const cachedUnitLineup=(...args)=>args.at(-1)();

export function referenceUnitScoreInput(context,order,outfitId,leaderChar,prepareGpu=false) {
  const team=evaluateReferenceTeam(context,order,outfitId,leaderChar,false,null,undefined,
    context.options.scoringMode==='unit'?cachedUnitLineup:undefined);
  const power=powerComponents.reduce((total,key)=>total+team.breakdown[key],0);
  if(prepareGpu){
    const {members,eOutfit}=referenceUnitSkillInputs(context,order,outfitId,leaderChar);
    return {team,power,members,outfitBonus:eOutfit};
  }
  const bonus=referenceTeamScoreBonus(context,order,outfitId,leaderChar);
  return {team,power,bonus:bonus.total};
}

export function evaluateUnitScore(context,order,outfitId,leaderChar) {
  const {team,power,bonus}=referenceUnitScoreInput(context,order,outfitId,leaderChar);
  return {...team,displayUnitScore:referenceUnitScore(power,bonus)};
}

export function unitScoreContext(data,payload,boards=payload.account.boards,ranks=payload.account.ranks,prepared) {
  const {account}=payload;
  const options={...payload.options,scoringMode:'unit',songId:null,eventBonus:false,eventPoints:false};
  return createReferenceScoreContext(data,account.owned,boards,ranks,options,account.dreamRank,prepared);
}

export function compareUnitScore(a,b) {
  return b.displayUnitScore-a.displayUnitScore || a.order.join('|').localeCompare(b.order.join('|')) ||
    a.outfitId.localeCompare(b.outfitId);
}

export function searchUnitScore(data,payload,seeds,{progress=()=>{}}={}) {
  const {options,account,boardOpt}=payload;
  const context=unitScoreContext(data,payload,boardPlanningBaseline(account.boards,boardOpt));
  const available=data.cards.filter(card=>account.owned[card.id]?.owned&&isTeamCardEligible(card,options));
  const cards=new Map(available.map(card=>[card.id,card]));
  const locked=new Set(options.focusCardIds);
  const lockedCards=[...locked].map(id=>cards.get(id));
  const lockedMembers=new Set(lockedCards.map(card=>card?.characterId));
  if(lockedCards.some(card=>!card)||lockedMembers.size!==locked.size||locked.size>5)return [];

  const outfits=Object.entries(data.costumes).filter(([id,outfit])=>{
    if(options.leaderChar&&options.leaderChar!==outfit.characterId)return false;
    if(options.leaderInvitedOnly&&!options.leaderAllHolomems&&!Object.hasOwn(account.ranks,outfit.characterId))return false;
    if(options.leaderMode==='fixed')return id===options.outfitId;
    if(options.leaderMode==='holomem')return locked.has(outfit.cardId);
    return outfit.isDefault||account.owned[outfit.cardId]?.owned||account.ownedCostumeIds?.includes(id);
  });
  const outfitMap=new Map(outfits);
  if(!outfits.length)return [];
  const eligible=(order,outfit)=>!options.leaderNoOverlap||!order.some(card=>card.characterId===outfit.characterId);
  const bestByLineup=new Map(),tested=new Set();
  function inspect(order,id,outfit) {
    if(order.length!==5||!eligible(order,outfit))return;
    const key=lineupKey(order);
    const evaluation=order.map(card=>card.id).join('|')+'#'+id;
    if(tested.has(evaluation))return;
    tested.add(evaluation);
    const team=evaluateUnitScore(context,order,id,outfit.characterId);
    const best=bestByLineup.get(key);
    if(Number.isFinite(team.displayUnitScore)&&(!best||compareUnitScore(team,best)<0))bestByLineup.set(key,team);
  }
  const bestTeams=()=>[...bestByLineup.values()].sort(compareUnitScore);
  function refineOutfits(teams) {
    for(const team of teams){
      const order=team.order.map(id=>cards.get(id));
      for(const [id,outfit] of outfits)inspect(order,id,outfit);
    }
  }

  function smallLineupPool() {
    const groups=new Map();
    for(const card of available){
      if(lockedMembers.has(card.characterId))continue;
      if(!groups.has(card.characterId))groups.set(card.characterId,[]);
      groups.get(card.characterId).push(card);
    }
    const choices=[...groups.values()],lineups=[];
    const limit=Math.floor(4200/outfits.length);
    function choose(first,order) {
      if(order.length===5){lineups.push(order);return lineups.length<=limit;}
      const last=choices.length-(5-order.length);
      for(let index=first;index<=last;index++)for(const card of choices[index]){
        if(!choose(index+1,[...order,card]))return false;
      }
      return true;
    }
    return choose(0,lockedCards)?lineups:null;
  }
  const finalists=Math.max(12,options.topN);

  // Start from the generic solver's teams and an independent power-based
  // lineup for each eligible leader. Rank every evaluated lineup by Unit Score.
  for(const seed of seeds){
    const order=seed.order.map(id=>cards.get(id));
    const outfit=outfitMap.get(seed.outfitId);
    if(outfit&&order.every(Boolean)&&[...locked].every(id=>seed.order.includes(id)))inspect(order,seed.outfitId,outfit);
  }
  const smallPool=smallLineupPool();
  if(smallPool){
    progress(0,1,0,'Checking every eligible lineup');
    for(const order of smallPool)for(const [id,outfit] of outfits)inspect(order,id,outfit);
    progress(1,1,1,'Checking every eligible lineup');
    return bestTeams().slice(0,finalists);
  }
  const power=new Map(available.map(card=>[card.id,Object.values(context.stats.get(card.id)).reduce((sum,value)=>sum+value,0)]));
  const byPower=[...available].sort((a,b)=>power.get(b.id)-power.get(a.id));
  const startingLineups=new Map();
  const attributes=[null,...new Set(available.map(card=>card.attribute))];
  for(const [id,outfit] of outfits){
    for(const attribute of attributes){
      const leader=options.leaderNoOverlap?outfit.characterId:'';
      const key=leader+'#'+(attribute??'');
      if(!startingLineups.has(key)){
        const order=[...lockedCards],members=new Set(lockedMembers);
        const ranked=attribute?byPower.filter(card=>card.attribute===attribute):byPower;
        for(const card of ranked){
          if(order.length===5)break;
          if(members.has(card.characterId)||card.characterId===leader)continue;
          members.add(card.characterId);
          order.push(card);
        }
        startingLineups.set(key,order);
      }
      inspect(startingLineups.get(key),id,outfit);
    }
  }

  // Explore card substitutions with the actual objective, then compare
  // every eligible outfit for the strongest lineups in each pass.
  const beamWidth=Math.min(8,Math.max(4,options.topN));
  const expanded=new Set();
  function beam() {
    const ordered=bestTeams(),selected=[];
    for(const team of ordered){
      if(selected.every(other=>team.order.filter(id=>other.order.includes(id)).length<4))selected.push(team);
      if(selected.length===beamWidth)break;
    }
    return [...new Set([...selected,...ordered])].slice(0,beamWidth);
  }
  for(let pass=0;pass<2;pass++){
    progress(pass,2,pass/2,'Optimizing Unit Score');
    refineOutfits(bestTeams().slice(0,beamWidth));
    for(const team of beam()){
      const order=team.order.map(id=>cards.get(id));
      const key=lineupKey(order)+'#'+team.outfitId;
      if(expanded.has(key))continue;
      expanded.add(key);
      const outfit=outfitMap.get(team.outfitId);
      for(const [index,current] of order.entries()){
        if(locked.has(current.id))continue;
        const others=new Set(order.filter((_,position)=>index!==position).map(card=>card.characterId));
        for(const card of available){
          if(card.id===current.id||others.has(card.characterId))continue;
          const neighbor=order.slice();
          neighbor[index]=card;
          inspect(neighbor,team.outfitId,outfit);
        }
      }
    }
  }
  refineOutfits(bestTeams().slice(0,finalists*2));
  progress(2,2,1,'Optimizing Unit Score');
  return bestTeams().slice(0,finalists);
}
