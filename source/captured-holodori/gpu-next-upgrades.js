const byScore=(left,right)=>right.value-left.value||
  (right.tieScore??right.score)-(left.tieScore??left.score);
const pullKey=pulls=>pulls.map(({id,bloom})=>id+':'+bloom).sort().join('|');
const lineupKey=order=>order.map(card=>card.id).sort().join('|');
const distinct=(items,key)=>[...new Map(items.map(item=>[key(item),item])).values()];
const totalStats=({performance,technique,sense})=>performance+technique+sense;

function outfitPotential(outfit,order,stats){
  for(const {type,attr,grouping,count=1} of outfit.triggers){
    if(type==='DECK_CARD_ATTRIBUTE'&&order.filter(card=>card.attribute===attr).length<count)return 0;
    if(type==='DECK_CARD_CHARACTER_GROUPING'&&order.filter(card=>card.groupingIds.includes(grouping)).length<count)return 0;
  }
  let gain=0;
  for(const {type,permil,targetType,targetAttr,targetGrouping,targetCount} of outfit.effects){
    const targets=order.filter(card=>targetType==='ATTRIBUTE'?card.attribute===targetAttr:
      targetType==='CHARACTER_GROUPING'?card.groupingIds.includes(targetGrouping):
        targetType==='SELF'?card.characterId===outfit.characterId:true).map(card=>stats.get(card.id));
    if(!targets.length)continue;
    if(type==='LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP'){
      gain+=order.reduce((sum,card)=>sum+totalStats(stats.get(card.id)),0)*permil*.25;
      continue;
    }
    if(targetCount)targets.sort((a,b)=>totalStats(b)-totalStats(a));
    for(const stat of targets.slice(0,targetCount||targets.length)){
      const amount=type==='PERFORMANCE_UP_PERMIL_UP'?stat.performance:
        type==='TECHNIQUE_UP_PERMIL_UP'?stat.technique:
          type==='SENSE_UP_PERMIL_UP'?stat.sense:totalStats(stat);
      gain+=amount*permil;
    }
  }
  return gain;
}

function arrangements(order){
  const rows=[];
  function append(prefix,remaining){
    if(!remaining.length){rows.push(prefix);return;}
    for(const [index,card] of remaining.entries())
      append([...prefix,card],remaining.filter((_,slot)=>slot!==index));
  }
  append([],order);
  return rows;
}

export async function searchGpuNextUpgrades({data,payload,scorer,rank,plan,findOwnedTeams}){
  const {account,options,extras,boardOpt}=payload;
  const {owned,ranks}=account;
  const optionsOwned={...options,cardPool:'owned'};
  const boardSaves=boardOpt?.ignoreExisting?{}:account.boards;
  const keepBoardBonuses=Object.keys(boardOpt?.keep?.targets??{}).length>0;
  const byId=new Map(data.cards.map(card=>[card.id,card]));
  const locked=new Set(extras.nextDeck??[]);
  const fixed=[...locked].map(id=>byId.get(id));
  if(fixed.length>5||fixed.some(card=>!card||!owned[card.id]?.owned)||
    new Set(fixed.map(card=>card.characterId)).size!==fixed.length)return {results:[],baseline:null};
  const limits=Math.min(29,Math.max(1,Math.trunc(extras.nextCount)||1));
  const cards=data.cards.filter(card=>card.maxLevel>0);
  const entries=new Map(cards.map(card=>[card.id,{
    level:Math.min(card.maxLevel,extras.nextLevel>0?Math.max(1,Math.trunc(extras.nextLevel)):card.maxLevel),
    bloom:Math.min(card.maxBloom,Math.max(0,Math.trunc(extras.nextBloom)||0)),
  }]));
  const outfits=Object.entries(data.costumes).filter(([id,outfit])=>
    (!options.leaderChar||outfit.characterId===options.leaderChar)&&
    (!options.leaderInvitedOnly||options.leaderAllHolomems||Object.hasOwn(ranks,outfit.characterId))&&
    (options.leaderMode==='fixed'?id===options.outfitId:
      options.leaderMode==='holomem'?locked.has(outfit.cardId):true));
  const worn=new Set(account.ownedCostumeIds??[]);
  const hasOutfit=([id,outfit])=>options.leaderMode==='fixed'||outfit.isDefault||worn.has(id)||owned[outfit.cardId]?.owned;
  const ownedOutfits=[];
  const unlockOutfits=new Map();
  for(const outfit of outfits){
    if(hasOutfit(outfit))ownedOutfits.push(outfit);
    else{
      const id=outfit[1].cardId;
      if(!unlockOutfits.has(id))unlockOutfits.set(id,[]);
      unlockOutfits.get(id).push(outfit);
    }
  }
  const rosterPayload=pulls=>{
    const upgrades=Object.fromEntries(pulls.map(({id,level,bloom})=>[id,{...owned[id],owned:true,level,bloom}]));
    return {...payload,options:optionsOwned,account:{...account,owned:{...owned,...upgrades}}};
  };
  const basePayload=rosterPayload([]);
  const baseScoring=scorer(basePayload,boardSaves);
  const power=card=>totalStats(baseScoring.context.stats.get(card.id));
  const rankedByStrength=cards.filter(card=>owned[card.id]?.owned).sort((a,b)=>power(b)-power(a));
  const ownedTeam=[...fixed];
  for(const card of rankedByStrength){
    if(ownedTeam.length===5)break;
    if(!ownedTeam.some(other=>other.characterId===card.characterId))ownedTeam.push(card);
  }
  const lockMembers=new Set(fixed.map(card=>card.characterId));
  const openCandidates=rankedByStrength.filter(card=>!lockMembers.has(card.characterId)).length;
  const current=ownedTeam.length===5&&fixed.length<5&&openCandidates>5-fixed.length?
    await findOwnedTeams({...basePayload,account:{...basePayload.account,boards:boardSaves},boardOpt:null,
      options:{...optionsOwned,goal:locked.size?'holomem':'best',focusCardIds:[...locked],topN:8}}):[];
  const eligibleOutfits=(order,rows)=>options.leaderNoOverlap?
    rows.filter(([,outfit])=>!order.some(card=>card.characterId===outfit.characterId)):rows;
  const initial=[{order:ownedTeam,pulls:[],outfits:ownedOutfits}];
  for(const row of current.slice(0,5)){
    const order=row.order.map(id=>byId.get(id));
    initial.push({order,pulls:[],outfits:ownedOutfits});
  }
  const exact=(candidate,score)=>{
    const rows=[];
    for(const order of candidate.orders)for(const [outfitId,{characterId}] of eligibleOutfits(order,candidate.outfits))
      rows.push(score(order,outfitId,characterId));
    return rows.sort(byScore)[0];
  };
  let base;
  const discoveredOutfits=new Map(current.map(row=>[lineupKey(row.order.map(id=>byId.get(id))),row.outfitId]));
  if(ownedTeam.length===5){
    for(const candidate of distinct(initial,({order})=>lineupKey(order))){
      const valid=eligibleOutfits(candidate.order,candidate.outfits);
      const strongest=valid.length>6?valid
        .map(outfit=>({outfit,row:baseScoring.score(candidate.order,outfit[0],outfit[1].characterId)}))
        .sort((a,b)=>byScore(a.row,b.row)).slice(0,6).map(({outfit})=>outfit):valid;
      const discovered=discoveredOutfits.get(lineupKey(candidate.order));
      const selected=distinct([...strongest,...valid.filter(([id])=>id===discovered)],outfit=>outfit[0]);
      const row=exact({orders:arrangements(candidate.order),outfits:selected},baseScoring.score);
      if(row&&(!base||byScore(row,base)<0))base=row;
    }
  }
  // Preserve the settings on every independent Board plan. A proposed
  // acquisition exists only in that plan's temporary account.
  async function optimizedBoard(row,pulls){
    if(!row||!boardOpt)return row;
    const query=rosterPayload(pulls);
    const {plan:optimized}=await plan({...query,options:{...optionsOwned,leaderMode:'fixed'},
      team:row.order,leaderChar:row.leaderChar,outfitId:row.outfitId});
    return optimized&&(keepBoardBonuses||byScore(optimized.after,row)<0)?
      {...row,...optimized.after,boards:optimized.saves,plan:optimized}:row;
  }
  base=await optimizedBoard(base,[]);
  const priorityOutfits=(candidate,scoring)=>{
    const eligible=eligibleOutfits(candidate.order,candidate.outfits);
    if(eligible.length<=5)return eligible;
    const unlocked=eligible.filter(([,outfit])=>candidate.pulls.some(pull=>pull.new&&pull.id===outfit.cardId));
    const screen=eligible.length<=12?eligible:eligible.map(outfit=>({outfit,
      gain:outfitPotential(outfit[1],candidate.order,scoring.context.stats)}))
      .sort((a,b)=>b.gain-a.gain).slice(0,10).map(({outfit})=>outfit);
    const contenders=distinct([...screen,...eligible.filter(([id])=>id===base?.outfitId)],outfit=>outfit[0]);
    const natural=contenders.map(outfit=>({outfit,row:scoring.score(candidate.order,outfit[0],outfit[1].characterId)}))
      .sort((a,b)=>byScore(a.row,b.row)).slice(0,4).map(({outfit})=>outfit);
    return distinct([...natural,...unlocked],outfit=>outfit[0]);
  };
  const rotate=order=>order.map((_,index)=>[...order.slice(index),...order.slice(0,index)]);
  const resultRows=new Map();
  let pool=distinct(initial,({order})=>lineupKey(order)).slice(0,4);
  let evaluated=0;
  const retain=Math.max(12,Math.min(40,options.topN*2));
  for(let depth=1;depth<=limits&&pool.length;depth++){
    const candidates=new Map();
    function add(order,pulls){
      const key=lineupKey(order)+'/'+pullKey(pulls);
      if(candidates.has(key))return;
      const acquired=pulls.filter(({new:added})=>added).flatMap(({id})=>unlockOutfits.get(id)??[]);
      candidates.set(key,{key,order,pulls,outfits:[...ownedOutfits,...acquired]});
    }
    for(const {order,pulls} of pool){
      const upgrades=new Map(pulls.map(pull=>[pull.id,pull]));
      for(const card of cards){
        const existing=owned[card.id]?.owned?owned[card.id]:null;
        const pull=upgrades.get(card.id);
        const index=order.findIndex(other=>other.id===card.id);
        const canBloom=extras.nextBlooms!==false&&(pull??existing)?.bloom<card.maxBloom;
        if((existing||pull)&&!canBloom)continue;
        if(index<0&&pull)continue;
        if(order.length<5&&index>=0)continue;
        const target=existing||pull?{level:(pull??existing).level,bloom:(pull??existing).bloom+1}:entries.get(card.id);
        const nextPull={id:card.id,new:!existing,copies:(pull?.copies??0)+1,...target};
        const nextPulls=[...pulls.filter(other=>other.id!==card.id),nextPull];
        if(index>=0){add(order,nextPulls);continue;}
        const member=order.findIndex(other=>other.characterId===card.characterId);
        const slots=member>=0?[member]:order.length<5?[order.length]:order.map((_,slot)=>slot);
        for(const slot of slots){
          const replaced=order[slot];
          if(replaced&&(locked.has(replaced.id)||upgrades.has(replaced.id)))continue;
          const lineup=order.slice();
          lineup[slot]=card;
          add(lineup,nextPulls);
        }
      }
    }
    if(!candidates.size)break;
    const complete=[...candidates.values()].filter(candidate=>candidate.order.length===5);
    const partial=[...candidates.values()].filter(candidate=>candidate.order.length<5);
    if(!complete.length){
      const estimatedPower=({order,pulls})=>order.reduce((total,card)=>{
        const entry=pulls.find(pull=>pull.id===card.id)??owned[card.id];
        return total+(card.baseTotals[entry.level-1]??0)*(1+(card.bloomBoosts[entry.bloom]??0)/1000);
      },0);
      pool=partial.map(candidate=>({candidate,power:estimatedPower(candidate)}))
        .sort((a,b)=>b.power-a.power).slice(0,retain).map(({candidate})=>candidate);
      continue;
    }
    const exactCandidates=new Map();
    const prepared=new Map();
    const scoringFor=candidate=>{
      const key=pullKey(candidate.pulls);
      if(!prepared.has(key))prepared.set(key,scorer(rosterPayload(candidate.pulls),boardSaves));
      return prepared.get(key);
    };
    // Rank the bounded expansion on the device. Each trial uses the
    // scenario's actual Bloom, unlocked outfits and chart conditions.
    for(let start=0;start<complete.length;start+=96){
      const batch=complete.slice(start,start+96);
      const proposals=[];
      for(const candidate of batch){
        const scoring=scoringFor(candidate);
        const choices=candidate.outfits=priorityOutfits(candidate,scoring);
        for(const order of rotate(candidate.order))for(const [outfitId,{characterId}] of choices)
          proposals.push({candidate,order,outfitId,characterId,
            trial:scoring.gpuTrial(order,outfitId,characterId)});
      }
      const scores=await rank(payload,proposals.map(({trial})=>trial));
      evaluated+=proposals.length;
      if(scores===null)throw Error('The GPU could not score these upgrade candidates.');
      const ranked=new Map();
      for(const [index,{candidate,order,outfitId,characterId}] of proposals.entries()){
        const proposal={candidate,order,outfitId,characterId,value:scores[index].value,tieScore:scores[index].tie};
        const previous=ranked.get(candidate.key);
        if(!previous||byScore(proposal,previous)<0)ranked.set(candidate.key,proposal);
      }
      const shortlist=[...ranked.values()].sort(byScore).slice(0,retain);
      for(const proposal of shortlist)
        exactCandidates.set(proposal.candidate.key,proposal);
    }
    const finalists=[...exactCandidates.values()].sort(byScore).slice(0,retain);
    const extended=[];
    for(const {candidate,order,outfitId,characterId} of finalists){
      const scoring=scoringFor(candidate);
      const row=exact({orders:arrangements(order),outfits:candidate.outfits},scoring.score)??scoring.score(order,outfitId,characterId);
      const firstNew=candidate.pulls.find(pull=>pull.new);
      const result={...row,pulls:candidate.pulls,...(firstNew?{candidateId:firstNew.id}:{})};
      const key=pullKey(candidate.pulls);
      const previous=resultRows.get(key);
      if(!previous||byScore(result,previous)<0)resultRows.set(key,result);
      extended.push({row:result,pulls:candidate.pulls,order:row.order.map(id=>byId.get(id))});
    }
    pool=distinct(extended.sort((a,b)=>byScore(b.row,a.row)),row=>pullKey(row.pulls))
      .sort((a,b)=>byScore(a.row,b.row)).slice(0,Math.min(retain,depth===1?12:8));
  }
  let best=[...resultRows.values()].sort(byScore).slice(0,Math.max(options.topN*2,8));
  if(boardOpt){
    const leading=await Promise.all(best.slice(0,Math.min(6,best.length)).map(row=>optimizedBoard(row,row.pulls)));
    best=[...leading,...best.slice(leading.length)].sort(byScore);
  }
  if(boardOpt?.ignoreExisting)best=best.map(row=>({...row,boards:row.boards??boardSaves}));
  const baseline=base?.[options.sortBy==='max'?'maxScore':'score']??null;
  return {results:best.filter(row=>!base||byScore(row,base)<0),baseline,evaluated};
}
