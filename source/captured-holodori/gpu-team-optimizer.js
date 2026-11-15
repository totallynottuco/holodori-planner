import {createGpuSearchKernels,shortlistGpuTeams} from './gpu-search-kernels';
import {boardFrontierPaths,boardPointsAtRank,boardReachability} from './unit-score-board-search';
import {createReferenceScoreContext,evaluateReferenceTeam,referenceBoardSongMatches,referenceCardStats,withReferenceChart} from './reference-rating-math';
import {evaluateUnitScore,referenceUnitScoreInput,unitScoreContext} from './unit-score-search';
import {createGpuObjectiveScorer,createGpuTradeScorer} from './gpu-trade-scoring';
import {refineBoardExchanges} from './gpu-board-exchanges';
import {hasGpuBoardBonusTargets,improveGpuBoardBonuses} from './gpu-board-bonus-targets';
import {searchGpuNextUpgrades} from './gpu-next-upgrades';
import * as cpuBoardKernels from './cpu-board-kernels';
import {boardPlanningBaseline,boardProtection,hasBoardProtection,preservesBoard,preservesBoardProtection} from './board-protection';

const float=new Float32Array(1),bits=new Uint32Array(float.buffer);
const scoreBits=value=>{float[0]=Math.max(0,value);return bits[0];};
const cap=value=>Math.min(0xffffffff,Math.max(0,value));
const emptyMove={path:[],points:0,materials:{}};
const priorityWeights={paramGroup:3,param:3,activeChance:100,activeFreq:90,activeEffect:32};
const nonScoringKinds=new Set(['workReward','miniGameReward','rewardExp','rewardQty','life','leaderActiveAdd','leaderActiveLevel']);
const keepPrefixes={workReward:'holowork',leaderActiveAdd:'holomemSkill',leaderActiveLevel:'holomemSkillUp',
  miniGameReward:'minigame'};
const protectedNode=(node,targets)=>{
  const leader=node.charTrigger==='SET_LIVE_LEADER';
  const prefix=node.kind==='rewardQty'?(leader?'leaderGold':'memberGold'):
    node.kind==='rewardExp'?(leader?'leaderExp':'memberExp'):keepPrefixes[node.kind];
  return Object.hasOwn(targets,node.kind)||!!prefix&&
    (Object.hasOwn(targets,prefix)||Object.hasOwn(targets,prefix+':'+node.variant));
};

export const createGpuTeamOptimizer=(data,objective)=>createTeamOptimizer(data,objective,false);
export const createCpuBoardPlanner=(data,objective)=>createTeamOptimizer(data,objective,true);

async function createTeamOptimizer(data,objective,cpu){
  const kernels=cpu?cpuBoardKernels:await createGpuSearchKernels();
  const scoreTradeTimelines=cpu?null:createGpuTradeScorer(kernels);
  const scoreObjectives=cpu?null:createGpuObjectiveScorer(kernels,scoreTradeTimelines);
  const boardCache=new WeakMap();
  const noBoardEffects=new Map();
  const statCache=new WeakMap();
  const scoringData={...data,boardEffects(owner,save,roster,dreamRank,read){
    if(!save){
      if(!noBoardEffects.has(owner))noBoardEffects.set(owner,[read('always'),read('leader'),read('song')]);
      return noBoardEffects.get(owner);
    }
    let contexts=boardCache.get(save);
    if(!contexts){contexts={states:new Map(),byRoster:new WeakMap()};boardCache.set(save,contexts);}
    let cached=contexts.byRoster.get(roster);
    if(cached?.owner===owner&&cached.rank===dreamRank)return cached.effects;
    const key=JSON.stringify([owner,dreamRank,Object.values(save.cards).map(id=>roster[id]?.bloom??-1)]);
    if(!contexts.states.has(key))contexts.states.set(key,[read('always'),read('leader'),read('song')]);
    const effects=contexts.states.get(key);
    contexts.byRoster.set(roster,{owner,rank:dreamRank,effects});
    return effects;
  },cardStats(card,level,bloom){
    let stats=statCache.get(card);
    if(!stats)statCache.set(card,stats=new Map());
    const key=level+':'+bloom;
    if(!stats.has(key))stats.set(key,(data.cardStats??referenceCardStats)(card,level,bloom));
    return stats.get(key);
  }};
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const songs=new Map(data.songs.map(song=>[song.id,song]));
  const unit=objective==='unitScore';
  let examined=0,boardMoves=0,projectedBest=0,plannedBest=0,boardProjections=0,connectMatches=0,frequencyPairs=0;
  let sameBoardTrades=0,crossBoardTrades=0,tradeCandidates=0;
  const tradeTiming={topology:0,candidates:0,gpu:0,scoring:0,timelineGpu:0};
  let tradeTimelines=0;
  let objectiveTrials=0;
  const shortlistPlans=[];
  const timings={screen:0,projection:0,lite:0,full:0,seeded:0,exchangeOnly:0,
    purchases:0,connect:0,paths:0,exchanges:0,order:0};
  const referenceContexts=new WeakMap();
  const timelineScenarios=new WeakMap();
  const timelineOrders=new WeakMap();
  const skillCache=new Map();
  const skillIds=new WeakMap();
  let skillId=0;
  let skillHits=0,skillMisses=0;
  let shortlistTiming={};
  const identity=value=>{
    if(!skillIds.has(value))skillIds.set(value,++skillId);
    return skillIds.get(value);
  };
  function cachedTimeline(scenario,order,blooms,outfit,effects,chance,frequency,passive,capture,compute){
    let chart=timelineScenarios.get(scenario);
    if(chart===undefined){
      chart=[identity(scenario.curve),scenario.seconds,scenario.slots.length,...scenario.slots,
        identity(scenario.countCurve),scenario.notes].join('|');
      timelineScenarios.set(scenario,chart);
    }
    let lineup=timelineOrders.get(order);
    if(lineup===undefined){
      lineup=order.map(identity).join('|');
      timelineOrders.set(order,lineup);
    }
    const key=[chart,outfit,lineup,...blooms,...effects,...chance,...frequency,...passive,Number(capture)].join('|');
    const existing=skillCache.get(key);
    if(existing){skillHits++;return existing;}
    skillMisses++;
    const value=compute();
    skillCache.set(key,value);
    if(skillCache.size>4096)skillCache.delete(skillCache.keys().next().value);
    return value;
  }

  function scorer(payload,boards=payload.account.boards,ranks=payload.account.ranks){
    const {account,options}=payload;
    const previous=referenceContexts.get(payload);
    const prepared=previous?.ranks===ranks?previous:undefined;
    const context=unit?unitScoreContext(scoringData,payload,boards,ranks,prepared):
      createReferenceScoreContext(scoringData,account.owned,boards,ranks,options,account.dreamRank,prepared);
    if(!prepared)referenceContexts.set(payload,context);
    const chartContexts=options.lbCharts?.map(({songId,difficulty})=>{
      const song=songs.get(songId);
      const chart=song?.difficulties.find(chart=>chart.type===difficulty);
      if(!chart)throw Error('A rating chart is unavailable.');
      return withReferenceChart(context,song,chart);
    });
    const metric=options.sortBy==='max'?'maxScore':'score';
    const targetCharts=payload.targetCharts;
    const indices=targetCharts??chartContexts?.map((_,index)=>index);
    const evaluate=(chart,order,outfit,leader,capture)=>
      evaluateReferenceTeam(chart,order,outfit,leader,false,null,capture,cachedTimeline);
    const score=(order,outfit,leader)=>{
      if(unit){
        const row=evaluateUnitScore(context,order,outfit,leader);
        return {...row,value:row.displayUnitScore};
      }
      if(chartContexts?.length){
        const byChart=[];
        for(const index of indices)byChart[index]=evaluate(chartContexts[index],order,outfit,leader);
        const rows=byChart.filter(Boolean).sort((a,b)=>b[metric]-a[metric]);
        const value=rows.slice(0,3).reduce((total,row)=>total+Math.ceil(row[metric]/5000),0);
        return {...rows[0],value,tieScore:rows.slice(0,3).reduce((total,row)=>total+row[metric],0),
          songBonuses:byChart.map(row=>row.breakdown.songBonus),chartScores:byChart.map(row=>row[metric])};
      }
      const row=evaluate(context,order,outfit,leader);
      return {...row,value:row[metric]};
    };
    const timeline=(order,outfit,leader)=>{
      const result=[];
      for(const chart of targetCharts?targetCharts.map(index=>chartContexts[index]):chartContexts??[context]){
        evaluate(chart,order,outfit,leader,(windows,base)=>result.push({...windows,base}));
      }
      return result;
    };
    const gpuTrial=(order,outfit,leader)=>{
      if(unit)return referenceUnitScoreInput(context,order,outfit,leader,true);
      if(chartContexts?.length)return {windows:timeline(order,outfit,leader)};
      const windows=[];
      const row=evaluate(context,order,outfit,leader,(skill,base)=>windows.push({...skill,base}));
      return {windows,eventBonus:row.breakdown.eventBonus,epPermil:row.epPermil};
    };
    return {context,score,timeline,gpuTrial};
  }

  async function rankObjective(payload,trials){
    objectiveTrials+=trials.length;
    return scoreObjectives(trials,{sortBy:payload.options.sortBy,merged:!!payload.options.lbCharts?.length,unit});
  }

  async function rankResults(payload,rows){
    if(!rows.length)return rows;
    const base=boardPlanningBaseline(payload.account.boards,payload.boardOpt);
    const scoredByBoard=new WeakMap();
    const dataFor=row=>{
      const pulls=row.pulls??[];
      const boards=row.plan?.saves??row.boards??base;
      const ranks=row.plan?.ranks??payload.account.ranks;
      if(!pulls.length){
        if(!scoredByBoard.has(boards))scoredByBoard.set(boards,new Map());
        const contexts=scoredByBoard.get(boards);
        if(!contexts.has(ranks))contexts.set(ranks,scorer(payload,boards,ranks));
        return contexts.get(ranks);
      }
      const owned={...payload.account.owned};
      for(const pull of pulls)owned[pull.id]={owned:true,level:pull.level,bloom:pull.bloom};
      return scorer({...payload,account:{...payload.account,owned}},boards,ranks);
    };
    const eligible=rows.flatMap(row=>{
      const order=row.order.map(id=>cards.get(id));
      if(!order.every(Boolean)||(row.pulls??[]).some(pull=>pull.level<1))return [];
      return [{row,order,scoring:dataFor(row)}];
    });
    if(eligible.length!==rows.length)return rows;
    const gpu=await rankObjective(payload,eligible.map(({row,order,scoring})=>scoring.gpuTrial(order,row.outfitId,row.leaderChar)));
    if(!gpu?.length)return rows;
    // Use the accelerated ranking to retain the best candidates, then use
    // exact arithmetic to distinguish results near an integer boundary.
    return eligible.map(({row},index)=>({row,gpu:gpu[index]}))
      .sort((a,b)=>b.gpu.value-a.gpu.value||b.gpu.tie-a.gpu.tie)
      .slice(0,Math.min(rows.length,Math.max(payload.options.topN*2,12)))
      .map(({row})=>row).sort((a,b)=>(b.value??b.score)-(a.value??a.score)||
        (b.tieScore??b.score)-(a.tieScore??a.score));
  }

  const solveNext=(payload,findOwnedTeams)=>searchGpuNextUpgrades({
    data,payload,scorer,rank:cpu?null:rankObjective,plan,findOwnedTeams,
  });

  async function solve(payload){
    if(payload.options.goal==='next'){
      const start=performance.now();
      const result=await solveNext(payload,async query=>(await solve(query)).results);
      timings.screen+=performance.now()-start;
      examined+=result.evaluated??0;
      return result;
    }
    const boards=boardPlanningBaseline(payload.account.boards,payload.boardOpt);
    const {context,score}=scorer(payload,boards);
    const boardScores=[];
    if(payload.boardOpt&&(payload.options.lbCharts?.length||objective!=='holomemLb')){
      // Build legal representative Board layouts before ranking lineups.
      // These estimates guide selection. Each finalist is planned again
      // after its exact training bill and remaining reset gold are known.
      const start=performance.now();
      const preliminary=await shortlistGpuTeams(kernels,data,payload,context,score,{limit:8,width:12,rounds:0,activeProjection:false});
      examined+=preliminary.examined;
      const representatives=[];
      const chosenOutfits=new Set();
      for(const row of preliminary.teams){
        if(chosenOutfits.has(row.outfitId))continue;
        representatives.push(row);
        chosenOutfits.add(row.outfitId);
        if(representatives.length===2)break;
      }
      const projections=await Promise.all(representatives.map(row=>
        plan({...payload,options:{...payload.options,leaderMode:'fixed'},
          team:row.order,leaderChar:row.leaderChar,outfitId:row.outfitId,
          boardOpt:{...payload.boardOpt,litePlan:true}})));
      for(const projected of projections){
        if(projected.plan?.changes.length){
          boardProjections++;
          boardScores.push(scorer(payload,projected.plan.saves,projected.plan.ranks).score);
        }
      }
      timings.projection+=performance.now()-start;
    }
    const start=performance.now();
    const result=await shortlistGpuTeams(kernels,data,payload,context,score,{
      limit:Math.max(32,payload.options.topN*3),width:24,boardScores,rounds:boardScores.length?2:3,
    });
    shortlistTiming=result.timing;
    timings.screen+=performance.now()-start;
    examined+=result.examined;
    if(payload.options.lbCharts?.length)projectedBest=Math.max(projectedBest,...result.teams.map(row=>row.value));
    // Reserve finalists for both current score and reachable Board upside.
    if(boardScores.length){
      const byOutfit=new Map();
      for(const row of result.teams){
        const current=byOutfit.get(row.outfitId);
        if(!current||row.potential>current.potential)byOutfit.set(row.outfitId,row);
      }
      const priority=[...byOutfit.values()].sort((a,b)=>b.potential-a.potential);
      const active=result.teams.filter(row=>row.activePotential!==undefined)
        .sort((a,b)=>b.activePotential-a.activePotential||b.activeTieScore-a.activeTieScore);
      const ranked=[...result.teams].sort((a,b)=>b.potential-a.potential||b.value-a.value);
      const growth=active.filter(row=>row.activePotential>=active[0].activePotential*.94)
        .sort((a,b)=>(b.activePotential-b.value)-(a.activePotential-a.value)||
        b.activeTieScore-a.activeTieScore);
      const synergy=[...active].sort((a,b)=>(b.activePotential-a.activePotential)+
        (b.activeSynergy-a.activeSynergy)/25);
      const boardGain=active.filter(row=>row.activeBoardGain>0).sort((a,b)=>(b.activePotential-a.activePotential)+
        (b.activeBoardGain-a.activeBoardGain)/8);
      const seenLineups=new Set();
      const specialists=[...boardGain.slice(0,1),...active.slice(0,1),...synergy.slice(0,1),...growth.slice(0,1)];
      const specialistKeys=new Set(specialists.map(row=>row.order.slice().sort().join(',')));
      const unique=[...ranked.slice(0,3),...specialists,...priority,...ranked].flatMap(row=>{
        const key=row.order.slice().sort().join(',');
        if(seenLineups.has(key))return [];
        seenLineups.add(key);
        return [specialistKeys.has(key)?{...row,activeSpecialist:true}:row];
      });
      return {results:unique};
    }
    return {results:result.teams};
  }

  async function plan(payload){
    const start=performance.now();
    try{return await planBoards(payload);}
    finally{
      const phase=payload.boardOpt?.litePlan?'lite':payload.exchangeOnly?'exchangeOnly':payload.seedBoards?'seeded':'full';
      timings[phase]+=performance.now()-start;
    }
  }

  async function planBoards(payload){
    const {account,boardOpt,team,leaderChar}=payload;
    if(!boardOpt)return {plan:null};
    const refineBranches=payload.seedBoards&&payload.refineBranches?.length?payload.refineBranches:null;
    let order=team.map(id=>cards.get(id));
    if(order.length!==5||!order.every(Boolean))return {plan:null};
    const ranks={...account.ranks},branches=new Set(boardOpt.branches);
    if(boardOpt.allInvited)for(const id of Object.keys(data.boards))ranks[id]??=1;
    if(boardOpt.maxBoardPoints)for(const id of Object.keys(ranks))ranks[id]=data.boardPointLadder.length-1;
    const outfits=Object.entries(data.costumes).filter(([id,outfit])=>outfit.characterId===leaderChar&&
      (outfit.isDefault||account.owned[outfit.cardId]?.owned||account.ownedCostumeIds?.includes(id)));
    let saves=boardPlanningBaseline(account.boards,boardOpt);
    const originalBoards=saves;
    const canReset=owner=>boardProtection(boardOpt,owner)==='flexible';
    const pinnedSlot=(owner,socket)=>!canReset(owner)&&Object.hasOwn(originalBoards[owner]?.cards??{},socket);
    const allCharts=payload.targetCharts?undefined:payload.options.lbCharts;
    const baseScorer=scorer(payload,saves,ranks).score;
    const eligibleOutfits=payload.options.leaderMode==='fixed'&&payload.outfitId?[payload.outfitId]:outfits.map(([id])=>id);
    const bestOutfit=(score,orders=[order])=>eligibleOutfits.flatMap(id=>orders.map(lineup=>score(lineup,id,leaderChar)))
      .sort((a,b)=>b.value-a.value||(b.tieScore??b.score)-(a.tieScore??a.score))[0];
    const outfitId=bestOutfit(baseScorer)?.outfitId;
    if(!outfitId)return {plan:null};
    const before=baseScorer(order,outfitId,leaderChar);
    if(!before)return {plan:null};
    if(payload.trio&&allCharts?.length>3&&before.chartScores){
      const chartScores=payload.trio==='current'&&payload.seedBoards?
        scorer(payload,payload.seedBoards,ranks).score(order,outfitId,leaderChar).chartScores:before.chartScores;
      const targetCharts=chartScores.map((score,index)=>({score,index})).sort((a,b)=>b.score-a.score)
        .slice(0,3).map(chart=>chart.index);
      payload={...payload,targetCharts};
    }
    const score=payload.targetCharts?scorer(payload,saves,ranks).score:baseScorer;
    let after=score(order,outfitId,leaderChar);
    const screenedOrder=order;
    if(payload.activeSpecialist&&!boardOpt.litePlan&&!payload.seedBoards){
      const trialOrders=[order];
      for(let i=0;i<order.length;i++)for(let j=i+1;j<order.length;j++){
        const swap=order.slice();
        [swap[i],swap[j]]=[swap[j],swap[i]];
        trialOrders.push(swap);
      }
      after=bestOutfit(score,trialOrders);
      order=after.order.map(id=>cards.get(id));
    }
    const bought={},refunded={},changes=new Map();
    const materials=Object.keys(data.boardItems);
    const owners=Object.keys(ranks).filter(id=>data.boards[id]&&boardProtection(boardOpt,id)!=='locked');
    const keep=boardOpt.keep?.targets??{};
    const charts=(payload.options.lbCharts??[{songId:payload.options.songId}]).map(({songId})=>
      data.songs.find(song=>song.id===songId));
    const teamMembers=new Set(order.map(card=>card.characterId));
    const blueDonorPriority=payload.activeSpecialist&&branches.has('blue');
    const canDetachInactiveSocket=(node,owner,save)=>{
      if(!node?.socket||!node.pts||!payload.activeSpecialist||teamMembers.has(owner))return false;
      if(!payload.rebuildBlue&&(node.x>=0||!branches.has('blue')))return false;
      const id=save.cards[node.id];
      if(!id)return true;
      const connect=data.connects[id];
      const unlocked=new Set(save.nodes);
      return !!connect&&!data.boards[owner].some(other=>unlocked.has(other.id)&&
        (protectedNode(other,keep)||payload.rebuildBlue&&priorityFor(other,owner)>0)&&
        connect.extent.some(([x,y])=>node.x+x===other.x&&node.y+y===other.y));
    };
    const chartMatches=new WeakMap();
    const matchingCharts=(node,owner)=>{
      if(!chartMatches.has(node))chartMatches.set(node,charts.flatMap((song,index)=>song&&
        referenceBoardSongMatches(node.songTrigger,owner,{song,data})?[index]:[]));
      return chartMatches.get(node);
    };
    const exactAvailable=()=>materials.map(id=>cap((boardOpt.materials[id]??0)+(refunded[id]??0)-(bought[id]??0)));
    const materialKnown=new Set(materials);
    if(boardOpt.ignoreExisting&&!boardOpt.noRefund){
      for(const [owner,saved] of Object.entries(account.boards)){
        if(!canReset(owner))continue;
        const nodes=new Map((data.boards[owner]??[]).map(node=>[node.id,node]));
        for(const id of saved.nodes)for(const item of nodes.get(id)?.items??[])
          refunded[item.id]=(refunded[item.id]??0)+item.qty;
      }
    }
    let resetCount=0;
    const reclaimable=[];
    const staticPriorities=new WeakMap();
    let lastSongPriority;
    let songPriorities=new WeakMap();
    // Reserve refunds from connected removable branches for candidate moves.
    if(!boardOpt.ignoreExisting&&boardOpt.maxResets!==0&&!payload.seedBoards){
      const sourceSaves=saves;
      for(const owner of owners){
        if(!canReset(owner))continue;
        const saved=sourceSaves[owner];
        if(!saved?.nodes.length)continue;
        const nodes=data.boards[owner],byId=new Map(nodes.map(node=>[node.id,node]));
        const preserve=new Set(saved.nodes.filter(id=>{
          const node=byId.get(id);
          const disposableSocket=canDetachInactiveSocket(node,owner,saved);
          return !node||protectedNode(node,keep)||node.songTrigger&&matchingCharts(node,owner)
            .some(index=>!payload.targetCharts||payload.targetCharts.includes(index))||priorityFor(node,owner)>0||
            !disposableSocket&&(Object.hasOwn(saved.cards,id)||!branches.has(node.branch));
        }));
        const origin=nodes.find(node=>node.x===0&&node.y===0);
        if(!origin)continue;
        const positions=new Map(nodes.map(node=>[node.x+','+node.y,node]));
        const pending=[origin],parents=new Map([[origin.id,null]]);
        const unlocked=new Set(saved.nodes);
        for(const node of pending)for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const next=positions.get((node.x+x)+','+(node.y+y));
          if(next&&!parents.has(next.id)&&(!next.pts||unlocked.has(next.id))){
            parents.set(next.id,node.id);pending.push(next);
          }
        }
        for(const id of [...preserve])for(let previous=parents.get(id);previous;previous=parents.get(previous))preserve.add(previous);
        const resets=saved.nodes.filter(id=>!preserve.has(id)&&byId.get(id)?.pts);
        if(!resets.length)continue;
        const removed=new Set(resets),next={nodes:saved.nodes.filter(id=>!removed.has(id)),
          cards:Object.fromEntries(Object.entries(saved.cards).filter(([id])=>!removed.has(id)))};
        const connected=boardReachability(nodes,next,account.dreamRank);
        if(!connected||next.nodes.some(id=>!connected.active.has(id)))continue;
        const removedItems={};
        for(const id of resets)for(const item of byId.get(id).items)
          removedItems[item.id]=(removedItems[item.id]??0)+item.qty;
        const blueRefund=blueDonorPriority?resets.reduce((sum,id)=>{
          const node=byId.get(id);
          return node.branch==='blue'?sum+node.items.reduce((count,item)=>count+item.qty,0):sum;
        },0):0;
        reclaimable.push({owner,next,resets,removedItems,blueRefund});
      }
      const maxResets=boardOpt.maxResets;
      if(blueDonorPriority&&maxResets>=0)
        reclaimable.sort((a,b)=>b.blueRefund/b.resets.length-a.blueRefund/a.resets.length);
      for(const {owner,next,resets,removedItems} of reclaimable){
        if(maxResets>=0&&resetCount+resets.length>maxResets)continue;
        saves={...saves,[owner]:next};
        resetCount+=resets.length;
        for(const [id,quantity] of Object.entries(removedItems))refunded[id]=(refunded[id]??0)+quantity;
        const connects=Object.keys(account.boards[owner].cards).filter(socket=>!Object.hasOwn(next.cards,socket))
          .map(socket=>({socket,cardId:null}));
        changes.set(owner,{owner,buys:[],resets,connects,ptsBudget:boardPointsAtRank(data.boardPointLadder,ranks[owner])});
      }
      after=bestOutfit(scorer(payload,saves,ranks).score);
    }
    const rankedConnects=Object.keys(account.owned).filter(id=>account.owned[id].owned&&data.connects[id])
      .sort((a,b)=>connectValue(b)-connectValue(a));
    const connectPatternsById=new Map(rankedConnects.map(id=>[id,JSON.stringify([data.connects[id].extent,connectPermil(id)])]));
    function connectValue(id){
      const card=data.connects[id];
      return card.extent.length*connectPermil(id);
    }
    function connectPermil(id){
      const card=data.connects[id];
      return card.levels[card.level2Bloom&&account.owned[id].bloom>=card.level2Bloom?1:0]?.permil??0;
    }
    function priorityFor(node,owner){
      if(!node.kind)return 0;
      if(node.charTrigger==='SET_LIVE_LEADER'&&owner!==leaderChar)return 0;
      if(node.songTrigger&&!matchingCharts(node,owner).length)return 0;
      if(node.charTrigger==='WORK')return protectedNode(node,keep)?node.value:0;
      if(node.kind==='songBonus'){
        if(unit)return 0;
        if(lastSongPriority!==after){lastSongPriority=after;songPriorities=new WeakMap();}
        if(songPriorities.has(node))return songPriorities.get(node);
        const ceiling=data.boardLimits?.songBonus??Infinity;
        const threshold=payload.activeSpecialist&&after.chartScores?[...after.chartScores].sort((a,b)=>b-a)[2]??0:0;
        const priority=matchingCharts(node,owner).reduce((gain,index)=>{
          if(payload.targetCharts&&!payload.targetCharts.includes(index))return gain;
          const bonus=Math.max(0,Math.min(node.value,ceiling-(after.songBonuses?.[index]??after.breakdown?.songBonus??0)));
          if(!payload.targetCharts&&threshold&&(after.chartScores[index]??0)*(1+ceiling/1000)<threshold)return gain;
          return gain+bonus;
        },0)*150;
        songPriorities.set(node,priority);
        return priority;
      }
      if(staticPriorities.has(node))return staticPriorities.get(node);
      const targets=order.filter(card=>{
        switch(node.targetType){
          case 'ALL':return true;
          case 'CHARACTER_GROUPING':return card.groupingIds.includes(node.targetGrouping);
          case 'ATTRIBUTE':return card.attribute===node.targetAttr;
          case 'CHARACTER':return card.characterId===node.targetCharacter;
          default:return card.characterId===owner;
        }
      });
      const scale=nonScoringKinds.has(node.kind)?0:node.kind.endsWith('Permil')?24:priorityWeights[node.kind]??1;
      const value=node.value*scale*targets.length;
      staticPriorities.set(node,value);
      return value;
    }
    const affectedPriority=(node,owner,save)=>{
      let priority=priorityFor(node,owner);
      if(!priority||node.kind!=='activeChance'&&node.kind!=='activeFreq')return priority;
      const topology=data.boards[owner];
      const base=priority;
      for(const [id,cardId] of Object.entries(save.cards)){
        const card=data.connects[cardId];
        const socket=topology.find(candidate=>candidate.id===id);
        if(socket&&card&&account.owned[cardId]?.owned&&card.extent.some(([x,y])=>socket.x+x===node.x&&socket.y+y===node.y))
          priority=base*(1+connectPermil(cardId)/1000);
      }
      return priority;
    };
    const frontiers=new Map();
    const budgets=new Map(owners.map(owner=>[owner,boardPointsAtRank(data.boardPointLadder,ranks[owner])]));
    const emptyBoard={nodes:[],cards:{}};
    const originalNodes=new Map(owners.map(owner=>[owner,new Set(originalBoards[owner]?.nodes??[])]));
    const nodeMaps=new Map(owners.map(owner=>[owner,new Map(data.boards[owner].map(node=>[node.id,node]))]));
    const compare=(a,b)=>a.value-b.value||(a.tieScore??a.score)-(b.tieScore??b.score);
    const donorTopology=new WeakMap();
    const recipientBoards=new WeakMap();
    function tradeBoards(move,donors,next){
      if(donors.length!==1||donors[0].owner===move.owner)return next;
      // Reuse the recipient Board object across donors so its decoded
      // Board effects are computed once per replacement path.
      let paths=recipientBoards.get(move.save);
      if(!paths)recipientBoards.set(move.save,paths=new Map());
      const path=move.path.map(node=>node.id).join('|');
      if(!paths.has(path))paths.set(path,next[move.owner]);
      return {...next,[move.owner]:paths.get(path)};
    }
    const frontierFor=(owner,save)=>{
      if(frontiers.get(owner)?.save!==save)frontiers.set(owner,{save,
        frontier:boardFrontierPaths(data.boards[owner],save,account.dreamRank,branches,8)});
      return frontiers.get(owner).frontier;
    };
    const position=(x,y)=>x+','+y;
    const footprintCache=new Map();
    const socketFootprint=(socket,card)=>{
      const pattern=connectPatternsById.get(card);
      if(!pattern)return data.connects[card]?.extent.map(([x,y])=>position(socket.x+x,socket.y+y))??[];
      const key=[socket.x,socket.y,pattern].join('|');
      if(!footprintCache.has(key))footprintCache.set(key,data.connects[card].extent.map(([x,y])=>
        position(socket.x+x,socket.y+y)));
      return footprintCache.get(key);
    };
    const hasProtectedTargets=Object.keys(keep).length>0;
    const protectedCoverage=(owner,board,active)=>{
      const minimum=new Map();
      if(!hasProtectedTargets)return minimum;
      const nodes=nodeMaps.get(owner);
      for(const id of (originalBoards[owner]?.nodes??[])){
        const node=nodes.get(id);
        if(node&&active.has(id)&&protectedNode(node,keep))minimum.set(position(node.x,node.y),0);
      }
      if(!minimum.size)return minimum;
      for(const [socket,cardId] of Object.entries(board.cards)){
        if(!active.has(socket)||!data.connects[cardId])continue;
        const card=data.connects[cardId],entry=account.owned[cardId];
        const permil=card.levels[card.level2Bloom&&entry?.owned&&entry.bloom>=card.level2Bloom?1:0]?.permil??0;
        for(const key of socketFootprint(nodes.get(socket),cardId))if(minimum.has(key))minimum.set(key,permil);
      }
      return minimum;
    };
    const preservesCoverage=(owner,board,next,active,nextActive=active)=>{
      if(!preservesBoard(boardOpt,owner,originalBoards[owner],next))return false;
      if(!hasProtectedTargets)return true;
      const old=protectedCoverage(owner,board,active);
      if(!old.size)return true;
      const coverage=protectedCoverage(owner,next,nextActive);
      return [...old].every(([key,minimum])=>(coverage.get(key)??0)>=minimum);
    };
    const connectFields=new WeakMap();
    function connectField(owner,save,state){
      let record=connectFields.get(save);
      if(!record||state!==record.state){
        record={state,owners:new Map()};
        connectFields.set(save,record);
      }
      const fields=record.owners;
      if(!fields.has(owner)){
        const frontier=boardReachability(data.boards[owner],save,account.dreamRank);
        fields.set(owner,frontier?{
          active:frontier.active,
          spent:frontier.spent,
          weights:new Map(data.boards[owner].filter(node=>frontier.active.has(node.id))
            .map(node=>[position(node.x,node.y),priorityFor(node,owner)])),
        }:null);
      }
      return fields.get(owner);
    }
    // A route and its useful socket assignment must compete together. Existing
    // cards may move or swap if doing so leaves the source assignment legal.
    function connectTrials(layout,owner,path,limit=3){
      if(!Array.isArray(path))path=[path];
      path=path.filter(Boolean);
      const board=layout[owner];
      if(!board||!path.length)return [];
      const target=connectField(owner,board,after);
      if(!target)return [];
      const changed=new Set(path.map(node=>position(node.x,node.y)));
      const changedSockets=new Set(path.filter(node=>node.socket).map(node=>node.id));
      const sockets=data.boards[owner].filter(node=>node.socket&&target.active.has(node.id));
      const placed=new Map();
      for(const [member,save] of Object.entries(layout))for(const [socket,id] of Object.entries(save.cards))
        placed.set(id,{member,socket,save});
      const value=(socket,id,weights)=>id&&data.connects[id]&&account.owned[id]?.owned?
        socketFootprint(socket,id).reduce((sum,key)=>sum+(weights.get(key)??0),0)*connectPermil(id)/1000:0;
      const proposals=[];
      for(const socket of sockets){
        if(pinnedSlot(owner,socket.id))continue;
        const incumbent=board.cards[socket.id];
        if(incumbent&&(!data.connects[incumbent]||!account.owned[incumbent]?.owned))continue;
        const before=value(socket,incumbent,target.weights);
        for(const cardId of rankedConnects){
          if(cardId===incumbent||!changedSockets.has(socket.id)&&
            !socketFootprint(socket,cardId).some(key=>changed.has(key)))continue;
          const gain=value(socket,cardId,target.weights)-before;
          if(gain<=0)continue;
          const prior=placed.get(cardId);
          if(!prior){proposals.push({socket,cardId,gain,net:gain});continue;}
          if(pinnedSlot(prior.member,prior.socket))continue;
          const source=budgets.has(prior.member)&&connectField(prior.member,prior.save,after);
          if(!source||!source.active.has(prior.socket))continue;
          const priorNode=nodeMaps.get(prior.member).get(prior.socket);
          const previousGain=value(priorNode,cardId,source.weights);
          const swapGain=incumbent?value(priorNode,incumbent,source.weights):0;
          proposals.push({socket,cardId,prior,swap:swapGain>0,gain,net:gain-previousGain+swapGain});
        }
      }
      const distinct=new Set();
      const byNet=proposals.sort((a,b)=>b.net-a.net||b.gain-a.gain);
      const highestRaw=proposals.reduce((best,next)=>!best||next.gain>best.gain||
        next.gain===best.gain&&next.net>best.net?next:best,null);
      // Protect the strongest target footprint even when the source model
      // predicts a loss. Exact scoring will account for coverage caps and
      // crossed Active windows that the linear estimate cannot explain.
      const portfolio=limit>1&&highestRaw?[byNet[0],highestRaw,...byNet.slice(1)]:byNet;
      return portfolio.flatMap(({socket,cardId,prior,swap})=>{
        const key=[socket.id,connectPatternsById.get(cardId),prior?.member,prior?.socket].join('|');
        if(distinct.size>=limit||distinct.has(key))return [];
        const cards={...board.cards,[socket.id]:cardId};
        const boards={...layout,[owner]:{...board,cards}};
        if(prior){
          const sourceCards=prior.member===owner?cards:{...prior.save.cards};
          if(swap)sourceCards[prior.socket]=board.cards[socket.id];
          else delete sourceCards[prior.socket];
          boards[prior.member]={...prior.save,cards:sourceCards};
        }
        if(!preservesCoverage(owner,board,boards[owner],target.active)||prior&&prior.member!==owner&&
          !preservesCoverage(prior.member,prior.save,boards[prior.member],connectField(prior.member,prior.save,after).active))
          return [];
        distinct.add(key);
        return [{boards,socket:socket.id,cardId}];
      });
    }
    async function matchConnects(){
      const start=performance.now();
      try{return await assignConnects();}
      finally{timings.connect+=performance.now()-start;}
    }
    async function assignConnects(){
      const slots=[],reserved=new Set();
      for(const [owner,board] of Object.entries(saves)){
        if(!budgets.has(owner))for(const id of Object.values(board.cards))reserved.add(id);
      }
      for(const owner of owners){
        const board=saves[owner]??emptyBoard;
        const field=connectField(owner,board,after);
        if(!field) {
          for(const id of Object.values(board.cards))reserved.add(id);
          continue;
        }
        for(const socket of data.boards[owner]){
          if(!socket.socket||!field.active.has(socket.id))continue;
          const incumbent=board.cards[socket.id];
          if(incumbent&&(pinnedSlot(owner,socket.id)||!data.connects[incumbent]||!account.owned[incumbent]?.owned)){
            reserved.add(incumbent);
            continue;
          }
          const estimate=rankedConnects.map(id=>{
            const weight=socketFootprint(socket,id).reduce((sum,key)=>sum+(field.weights.get(key)??0),0);
            return Math.round(weight*connectPermil(id)/1000);
          });
          if(incumbent||estimate.some(Boolean))
            slots.push({owner,socket:socket.id,board,incumbent,estimate,spent:field.spent});
        }
        for(const [id,card] of Object.entries(board.cards))if(!field.active.has(id))reserved.add(card);
      }
      if(!slots.length||slots.length>160||slots.length+rankedConnects.length>768)return false;
      const scoreValue=row=>row.tieScore??row.value;
      const outfit=after.outfitId;
      // Exact marginal weight for each distinct footprint and Bloom tier.
      // Identical effects share a score, but each physical card keeps its
      // own column so no card can be placed in two sockets.
      const weights=slots.map(({owner,socket,board,incumbent,estimate})=>{
        const cards={...board.cards};
        delete cards[socket];
        const without={...board,cards};
        const empty=scoreValue(scorer(payload,{...saves,[owner]:without},ranks).score(order,outfit,leaderChar));
        const gains=new Map();
        return rankedConnects.map((id,index)=>{
          if(reserved.has(id))return 0;
          if(!estimate[index]&&id!==incumbent)return 0;
          const key=connectPatternsById.get(id);
          if(!gains.has(key)){
            const next={...board,cards:{...cards,[socket]:id}};
            const value=scoreValue(scorer(payload,{...saves,[owner]:next},ranks).score(order,outfit,leaderChar));
            gains.set(key,Math.max(0,Math.min(9999999,Math.round(value-empty))));
          }
          return gains.get(key)+(id===incumbent?1:0);
        });
      });
      const match=await kernels.matchConnects(weights,rankedConnects.map(id=>Number(reserved.has(id))));
      const moved=Array.from(match,card=>rankedConnects[card-1]??null);
      const changed=slots.flatMap((slot,index)=>moved[index]!==(slot.incumbent??null)?[index]:[]);
      const places=new Map(slots.flatMap((slot,index)=>slot.incumbent?[[slot.incumbent,index]]:[]));
      const destinations=new Map(moved.flatMap((id,index)=>id?[[id,index]]:[]));
      const columnByCard=new Map(rankedConnects.map((id,index)=>[id,index]));
      const marginal=(index,id)=>id?(weights[index][columnByCard.get(id)]??0):0;
      const orderAware=!!(payload.options.lbCharts?.length&&(payload.seedBoards||payload.rebuildBlue));
      const orderTrials=[];
      let best={boards:saves,row:after};
      function evaluate(edits,base=best.boards){
        const boards={...base};
        const changedOwners=new Set();
        for(const [index,id] of edits){
          const {owner,socket,board}=slots[index];
          const next=boards[owner]===base[owner]?{...board,cards:{...boards[owner]?.cards}}:boards[owner];
          if(id)next.cards[socket]=id;
          else delete next.cards[socket];
          boards[owner]=next;
          changedOwners.add(owner);
        }
        for(const owner of changedOwners){
          const previous=base[owner]??emptyBoard;
          if(!preservesCoverage(owner,previous,boards[owner],connectField(owner,previous,after).active))return false;
        }
        const row=bestOutfit(scorer(payload,boards,ranks).score);
        if(compare(row,best.row)<=0){
          if(orderAware&&edits.length)orderTrials.push({boards,row});
          return false;
        }
        best={boards,row};
        return true;
      }
      if(changed.length&&!evaluate(changed.map(index=>[index,moved[index]]))){
        // Additive socket weights can overestimate a complete assignment.
        // Split it into independent paths and cycles before exact scoring;
        // moving one card without the rest of its cycle would duplicate it.
        const pending=new Set(changed);
        const components=[];
        for(const start of pending){
          const indices=[start];
          pending.delete(start);
          for(const index of indices){
            for(const adjacent of [places.get(moved[index]),destinations.get(slots[index].incumbent)]){
              if(pending.delete(adjacent))indices.push(adjacent);
            }
          }
          const gain=indices.reduce((sum,index)=>sum+marginal(index,moved[index])-
            marginal(index,slots[index].incumbent),0);
          components.push({indices,gain});
        }
        components.sort((a,b)=>b.gain-a.gain);
        for(const {indices} of components.slice(0,24))
          evaluate(indices.map(index=>[index,moved[index]]));
      }
      if(payload.activeSpecialist||orderAware){
        // Covered windows overlap, and the winning global match can hide a
        // better direct swap. Refine high-impact alternatives against the
        // actual current assignment, preserving uniqueness at both ends.
        const base=best.boards;
        const assigned=new Map(slots.flatMap(({owner,socket},index)=>{
          const card=base[owner]?.cards[socket];
          return card?[[card,index]]:[];
        }));
        const songSocket=({owner,socket})=>{
          const position=nodeMaps.get(owner).get(socket);
          return data.boards[owner].some(node=>node.kind==='songBonus'&&
            Math.abs(node.x-position.x)+Math.abs(node.y-position.y)<=3);
        };
        const candidates=slots.flatMap(({owner,socket},index)=>{
          const incumbent=base[owner]?.cards[socket];
          const previous=marginal(index,incumbent);
          const valid=weights[index].flatMap((weight,column)=>{
            const id=rankedConnects[column];
            if(!weight||reserved.has(id)||id===incumbent)return [];
            const prior=assigned.get(id);
            const swap=prior!==undefined?marginal(prior,incumbent):0;
            const loss=prior!==undefined?weights[prior][column]:0;
            return [{index,id,incumbent,prior,swap,weight,gain:weight-previous+swap-loss}];
          }).sort((a,b)=>b.gain-a.gain);
          const acrossSongs=orderAware&&songSocket({owner,socket})?
            valid.filter(({prior,swap})=>swap&&slots[prior].owner!==owner&&
              songSocket(slots[prior]))
              .sort((a,b)=>b.weight-a.weight).slice(0,1):[];
          return [...new Set([...valid.slice(0,2),...acrossSongs])];
        }).sort((a,b)=>b.gain-a.gain);
        const shiftedSongs=orderAware?candidates.filter(({index,prior,swap})=>{
          if(!swap||slots[index].owner===slots[prior].owner)return false;
          return [slots[index],slots[prior]].every(songSocket);
        }).sort((a,b)=>b.weight-a.weight).slice(0,4):[];
        for(const {index,id,incumbent,prior,swap} of new Set([...candidates.slice(0,16),...shiftedSongs])){
          const edits=[[index,id]];
          if(prior!==undefined)edits.push([prior,swap?incumbent:null]);
          evaluate(edits,base);
        }
      }
      if(best.boards===saves&&orderAware&&orderTrials.length){
        // Rating chooses where Support windows land via slot order. Try a
        // strong alternate order before rejecting a promising assignment.
        const scoring=scorer(payload,saves,ranks).score;
        const adjacent=order.slice(1).map((_,index)=>{
          const swap=order.slice();
          [swap[index],swap[index+1]]=[swap[index+1],swap[index]];
          return {swap,row:bestOutfit(scoring,[swap])};
        });
        adjacent.sort((a,b)=>compare(b.row,a.row));
        const orders=adjacent.slice(0,2).map(({swap})=>swap);
        orderTrials.sort((a,b)=>compare(b.row,a.row));
        let baseline=bestOutfit(scoring,[order,...orders]);
        for(const {boards} of orderTrials.slice(0,3)){
          const row=bestOutfit(scorer(payload,boards,ranks).score,orders);
          if(compare(row,baseline)<=0)continue;
          best={boards,row};
          baseline=row;
        }
        if(best.boards!==saves)order=best.row.order.map(id=>cards.get(id));
      }
      if(best.boards===saves)return false;
      connectMatches++;
      const originalSaves=saves;
      saves=best.boards;
      after=best.row;
      for(const {owner,socket,spent} of slots){
        const id=saves[owner]?.cards[socket]??null;
        if(id===(originalSaves[owner]?.cards[socket]??null))continue;
        const change=changes.get(owner)??{owner,buys:[],resets:[],connects:[],ptsBudget:budgets.get(owner),ptsSpent:spent};
        change.connects=change.connects.filter(connection=>connection.socket!==socket);
        change.connects.push({socket,cardId:id});
        changes.set(owner,change);
      }
      return true;
    }
    function recordTrade(owner,next){
      const original=originalNodes.get(owner);
      const current=new Set((saves[owner]??emptyBoard).nodes);
      const remaining=new Set(next.nodes);
      const nodes=nodeMaps.get(owner);
      for(const id of current)if(!remaining.has(id)){
        const wasOwned=original.has(id);
        if(wasOwned)resetCount++;
        const ledger=wasOwned?refunded:bought;
        const sign=wasOwned?1:-1;
        for(const {id:item,qty} of nodes.get(id).items)ledger[item]=(ledger[item]??0)+sign*qty;
      }
      for(const id of remaining)if(!current.has(id)){
        const wasOwned=original.has(id);
        if(wasOwned)resetCount--;
        const ledger=wasOwned?refunded:bought;
        const sign=wasOwned?-1:1;
        for(const {id:item,qty} of nodes.get(id).items)ledger[item]=(ledger[item]??0)+sign*qty;
      }
      const originalCards=originalBoards[owner]?.cards??{};
      const connects=[...new Set([...Object.keys(originalCards),...Object.keys(next.cards)])]
        .filter(socket=>originalCards[socket]!==next.cards[socket])
        .map(socket=>({socket,cardId:next.cards[socket]??null}));
      changes.set(owner,{owner,buys:next.nodes.filter(id=>!original.has(id)),
        resets:[...original].filter(id=>!remaining.has(id)),connects,
        ptsBudget:budgets.get(owner),ptsSpent:next.nodes.reduce((sum,id)=>sum+nodes.get(id).pts,0)});
    }
    const fitsInventory=()=> (boardOpt.maxResets<0||resetCount<=boardOpt.maxResets)&&
      (boardOpt.infiniteMaterials||materials.every(id=>(bought[id]??0)<=(boardOpt.materials[id]??0)+(refunded[id]??0)));
    if(payload.seedBoards){
      if(!preservesBoardProtection(boardOpt,originalBoards,payload.seedBoards))return {plan:null};
      const used=new Set();
      for(const [owner,next] of Object.entries(payload.seedBoards)){
        const previous=saves[owner]??emptyBoard;
        if(next===previous||boardProtection(boardOpt,owner)==='locked'){
          for(const id of Object.values(next.cards)){
            if(used.has(id))return {plan:null};
            used.add(id);
          }
          continue;
        }
        if(!budgets.has(owner)){
          return {plan:null};
        }
        const reachable=boardReachability(data.boards[owner],next,account.dreamRank);
        if(!reachable||reachable.spent>budgets.get(owner)||next.nodes.some(id=>!reachable.active.has(id)))
          return {plan:null};
        for(const [socket,id] of Object.entries(next.cards)){
          if(used.has(id)||!nodeMaps.get(owner).get(socket)?.socket||!reachable.active.has(socket)||
            (!account.owned[id]?.owned&&previous.cards[socket]!==id))
            return {plan:null};
          used.add(id);
        }
        if(next!==previous)recordTrade(owner,next);
      }
      if(!fitsInventory())return {plan:null};
      saves=payload.seedBoards;
      after=bestOutfit(scorer(payload,saves,ranks).score);
      const alternatives=[order,...order.map((_,i)=>[...order.slice(i),...order.slice(0,i)])];
      for(let left=0;left<order.length;left++)for(let right=left+1;right<order.length;right++){
        const neighbor=order.slice();
        [neighbor[left],neighbor[right]]=[neighbor[right],neighbor[left]];
        alternatives.push(neighbor);
      }
      after=bestOutfit(scorer(payload,saves,ranks).score,alternatives);
      order=after.order.map(id=>cards.get(id));
    }
    async function rebuildPaths(color){
      const start=performance.now();
      try{return await rebuildBranch(color);}
      finally{timings.paths+=performance.now()-start;}
    }
    async function rebuildBranch(color){
      const yellow=color==='yellow',red=color==='red';
      const scoringOwners=red?[leaderChar]:yellow?owners.filter(owner=>
        data.boards[owner].some(node=>node.branch===color&&node.kind==='songBonus'&&
          matchingCharts(node,owner).some(index=>!payload.targetCharts||payload.targetCharts.includes(index)))):teamMembers;
      if(!branches.has(color)||boardOpt.maxResets===0&&!refineBranches)return false;
      const reachable=(owner,board)=>boardReachability(data.boards[owner],board,account.dreamRank);
      const proposals=new Map();
      for(const owner of scoringOwners){
        if(!budgets.has(owner)||!canReset(owner))continue;
        const base=saves[owner]??emptyBoard;
        const all=data.boards[owner];
        if(!all||!budgets.has(owner))continue;
        const targetedYellow=yellow&&refineBranches&&payload.targetCharts;
        const matching=node=>matchingCharts(node,owner).filter(index=>!payload.targetCharts||payload.targetCharts.includes(index));
        const routes=targetedYellow?boardFrontierPaths(all,base,account.dreamRank,new Set(['yellow']),12)?.paths:undefined;
        const focusedRoute=routes&&new Set(routes.filter(move=>move.path.at(-1).kind==='songBonus'&&
          matching(move.path.at(-1)).length).flatMap(move=>move.path.map(node=>node.id)));
        const missing=all.filter(node=>node.branch===color&&node.pts>0&&!base.nodes.includes(node.id)&&
          (!focusedRoute||focusedRoute.has(node.id))&&
          (node.lock==null||node.lock<=account.dreamRank)&&(node.hide==null||node.hide<=account.dreamRank));
        if(!missing.length)continue;
        const sockets=all.filter(node=>node.socket&&missing.some(other=>
          Math.abs(node.x-other.x)+Math.abs(node.y-other.y)===1)&&
          !base.nodes.includes(node.id)&&(node.lock==null||node.lock<=account.dreamRank)&&
          (node.hide==null||node.hide<=account.dreamRank));
        const full={...base,nodes:[...base.nodes,...missing.map(node=>node.id),...sockets.map(node=>node.id)]};
        const connected=reachable(owner,full);
        if(!connected)continue;
        full.nodes=full.nodes.filter(id=>connected.active.has(id));
        const source=new Set(base.nodes);
        const redWeights=new Map();
        if(red){
          const target=new Map(all.filter(node=>connected.active.has(node.id))
            .map(node=>[position(node.x,node.y),priorityFor(node,owner)]));
          for(const node of all.filter(node=>node.socket&&node.pts)){
            const id=base.cards[node.id];
            const weight=id&&data.connects[id]&&account.owned[id]?.owned?
              socketFootprint(node,id).reduce((sum,key)=>sum+(target.get(key)??0),0)*connectPermil(id)/1000:0;
            redWeights.set(node.id,weight);
          }
        }
        const canDetach=(node,save)=>canDetachInactiveSocket(node,owner,save)||red&&
          node?.socket&&node.pts&&(!save.cards[node.id]||account.owned[save.cards[node.id]]?.owned);
        const mustKeep=node=>node.branch&&!branches.has(node.branch)||protectedNode(node,keep)||
          boardOpt.maxResets===0&&originalNodes.get(owner).has(node.id);
        const variants=new Map();
        const sizes=red?[1,.5,1.75,3]:targetedYellow?[1,.5,1.75]:[1];
        for(const size of sizes)for(const [chance,frequency,parameters] of red?[[1,1,1],[1,1,2]]:yellow?[[1,1,1]]:[
          [1.6,.1,1],[1.8,.7,.6],[1,1.6,1],[1,0,1.6],[1,1,1],[.65,.65,2],[1.3,.5,2.4],
        ]){
          let next=full;
          const bias=node=>{
            if(red){
              if(node.branch!=='red')return 1;
              if(node.kind==='activeEffect')return parameters*size;
              return size;
            }
            if(node.kind==='activeChance')return chance;
            if(node.kind==='activeFreq')return frequency;
            return node.branch==='blue'?parameters:1;
          };
          const value=node=>{
            if(node.socket)return red?(redWeights.get(node.id)??0):12000;
            if(targetedYellow&&node.kind==='songBonus')return matching(node).length*node.value*150*size;
            return priorityFor(node,owner)*bias(node);
          };
          for(;;){
            const front=reachable(owner,next);
            if(!front)break;
            if(front.spent<=budgets.get(owner)){
              const key=next.nodes.slice().sort().join('|');
              if(!variants.has(key)&&next.nodes.some(id=>!source.has(id)))variants.set(key,next);
              break;
            }
            const cuts=[];
            for(const id of next.nodes){
              const node=nodeMaps.get(owner).get(id);
              if(mustKeep(node)||
                Object.hasOwn(next.cards,id)&&!canDetach(node,next))continue;
              const trimmed={...next,nodes:next.nodes.filter(other=>other!==id)};
              const kept=reachable(owner,trimmed);
              if(!kept)continue;
              const removed=next.nodes.filter(other=>!kept.active.has(other));
              if(removed.some(other=>Object.hasOwn(next.cards,other)&&
                !canDetach(nodeMaps.get(owner).get(other),next)||mustKeep(nodeMaps.get(owner).get(other))))continue;
              const removedNodes=removed.map(other=>nodeMaps.get(owner).get(other));
              const points=removedNodes.reduce((sum,node)=>sum+node.pts,0);
              if(!points)continue;
              if(red&&hasProtectedTargets&&removedNodes.some(node=>next.cards[node.id])){
                const cards=Object.fromEntries(Object.entries(next.cards).filter(([socket])=>kept.active.has(socket)));
                if(!preservesCoverage(owner,base,{...trimmed,cards},connected.active,kept.active))continue;
              }
              const loss=removedNodes.reduce((sum,node)=>sum+
                (canDetachInactiveSocket(node,owner,next)?0:value(node)),0);
              cuts.push({loss:loss/Math.min(points,front.spent-budgets.get(owner)),kept:kept.active});
            }
            cuts.sort((a,b)=>a.loss-b.loss);
            if(!cuts.length)break;
            const {kept}=cuts[0];
            next={nodes:next.nodes.filter(id=>kept.has(id)),
              cards:Object.fromEntries(Object.entries(next.cards).filter(([id])=>kept.has(id)))};
          }
        }
        if(red&&refineBranches){
          const fullScore=bestOutfit(scorer(payload,{...saves,[owner]:full},ranks).score);
          const starting=fullScore.tieScore??fullScore.score;
          const visited=new Set(),faces=new Map();
          let beam=[{board:full,score:starting,spent:reachable(owner,full).spent}];
          const available=exactAvailable();
          const originals=originalNodes.get(owner);
          const costBase=new Set(base.nodes);
          const materialIndices=new Map(materials.map((id,index)=>[id,index]));
          const maxResets=boardOpt.maxResets<0?Infinity:boardOpt.maxResets-resetCount;
          const weightPath=board=>{
            const delta=materials.map(()=>0);
            const added=new Set(board.nodes);
            let resets=0;
            for(const [ids,other,sign] of [[added,costBase,1],[costBase,added,-1]])for(const id of ids){
              if(other.has(id))continue;
              if(originals.has(id))resets-=sign;
              for(const item of nodeMaps.get(owner).get(id).items){
                const index=materialIndices.get(item.id);
                if(index!==undefined)delta[index]+=item.qty*sign;
              }
            }
            return {resets,short:boardOpt.infiniteMaterials?0:delta.reduce((sum,n,i)=>sum+Math.max(0,n-available[i]),0)};
          };
          for(let depth=0;beam.length&&depth<8;depth++){
            const next=[];
            for(const {board,score,spent} of beam){
              const overflow=spent-budgets.get(owner);
              for(const id of board.nodes){
                const node=nodeMaps.get(owner).get(id);
                if(mustKeep(node)||board.cards[id]&&!canDetach(node,board))continue;
                const trimmed={...board,nodes:board.nodes.filter(other=>other!==id)};
                const state=reachable(owner,trimmed);
                if(!state)continue;
                const removed=board.nodes.filter(other=>!state.active.has(other));
                if(removed.some(other=>{
                  const node=nodeMaps.get(owner).get(other);
                  return mustKeep(node)||board.cards[other]&&!canDetach(node,board);
                }))continue;
                trimmed.nodes=trimmed.nodes.filter(other=>state.active.has(other));
                trimmed.cards=Object.fromEntries(Object.entries(board.cards).filter(([socket])=>state.active.has(socket)));
                const key=trimmed.nodes.slice().sort().join('|');
                if(visited.has(key))continue;
                visited.add(key);
                if(hasProtectedTargets&&!preservesCoverage(owner,base,trimmed,connected.active,state.active))continue;
                const points=spent-removed.reduce((sum,id)=>sum+nodeMaps.get(owner).get(id).pts,0);
                if(points>=spent)continue;
                const {resets,short}=weightPath(trimmed);
                if(resets>maxResets)continue;
                const trial=bestOutfit(scorer(payload,{...saves,[owner]:trimmed},ranks).score);
                const exact=trial.tieScore??trial.score;
                const loss=(score-exact)/Math.min(Math.max(1,overflow),spent-points);
                if(points<=budgets.get(owner)&&trimmed.nodes.some(id=>!source.has(id)))
                  faces.set(key,{board:trimmed,score:exact,short});
                if(points>budgets.get(owner)||short&&faces.size<12)next.push({board:trimmed,score:exact,spent:points,
                  loss:loss+short,weighted:exact-13000*Math.max(0,points-budgets.get(owner))-short*150});
              }
            }
            const efficient=next.sort((a,b)=>a.loss-b.loss).slice(0,4);
            const absolute=next.sort((a,b)=>b.weighted-a.weighted).slice(0,4);
            beam=[...new Set([...efficient,...absolute])];
          }
          const ranked=[...faces];
          for(const [key,{board}] of new Set([...ranked.sort((a,b)=>b[1].score-a[1].score).slice(0,6),
            ...ranked.sort((a,b)=>b[1].score-a[1].score+(a[1].short-b[1].short)*150).slice(0,6)]))variants.set(key,board);
        }
        if(!yellow&&!red&&payload.seedBoards){
          // Trial cuts are scored against the actual chart timing. Keep
          // both the smallest score loss per reclaimed point and the best
          // absolute intermediate shape while trimming a complete branch.
          const fixed=new Set(base.nodes.filter(id=>{
            const node=nodeMaps.get(owner).get(id);
            return Object.hasOwn(base.cards,id)||protectedNode(node,keep)||
              node.branch&&(!branches.has(node.branch)||!['blue','green'].includes(node.branch));
          }));
          const rank=board=>bestOutfit(scorer(payload,{...saves,[owner]:board},ranks).score,
            order===screenedOrder?[order]:[order,screenedOrder]).tieScore;
          let beams=[{board:full,score:rank(full)}];
          const visited=new Set();
          const finished=[];
          for(let depth=0;beams.length&&depth<14;depth++){
            const next=[];
            for(const {board,score} of beams){
              const spent=reachable(owner,board).spent;
              const overflow=spent-budgets.get(owner);
              if(overflow<=0){
                finished.push({board,score});
                continue;
              }
              for(const id of board.nodes){
                if(fixed.has(id))continue;
                const tested={...board,nodes:board.nodes.filter(other=>other!==id)};
                const state=reachable(owner,tested);
                if(!state||[...fixed].some(other=>!state.active.has(other)))continue;
                tested.nodes=tested.nodes.filter(other=>state.active.has(other));
                const key=tested.nodes.slice().sort().join('|');
                if(visited.has(key))continue;
                visited.add(key);
                const used=tested.nodes.reduce((sum,other)=>sum+nodeMaps.get(owner).get(other).pts,0);
                if(used>=spent)continue;
                const value=rank(tested);
                next.push({board:tested,score:value,
                  loss:(score-value)/Math.min(overflow,spent-used),
                  weighted:value-500*Math.max(0,used-budgets.get(owner))});
              }
            }
            const byLoss=next.sort((a,b)=>a.loss-b.loss).slice(0,5);
            const byScore=next.sort((a,b)=>b.weighted-a.weighted).slice(0,5);
            beams=[...new Set([...byLoss,...byScore])];
          }
          const mostBlue=board=>board.nodes.filter(id=>nodeMaps.get(owner).get(id).branch==='blue').length;
          const best=finished.sort((a,b)=>b.score-a.score).slice(0,10);
          for(const {board} of new Set([...best,...finished.sort((a,b)=>mostBlue(b.board)-mostBlue(a.board)).slice(0,4)]))
            variants.set(board.nodes.slice().sort().join('|'),board);
        }
        if(variants.size)proposals.set(owner,[...variants.values()]);
      }
      if(!proposals.size)return false;
      const stock=exactAvailable();
      const donorCuts=[];
      const timingCuts=[];
      if(!boardOpt.infiniteMaterials){
        for(const owner of owners){
          if(!canReset(owner))continue;
          if(proposals.has(owner))continue;
          const board=saves[owner]??emptyBoard;
          if(!board.nodes.length)continue;
          const donorPath=board.nodes.map(id=>nodeMaps.get(owner).get(id)).filter(node=>
            node.branch===color&&!protectedNode(node,keep)&&(!priorityFor(node,owner)||!yellow&&node.kind==='activeFreq')&&
            (!node.songTrigger||!matchingCharts(node,owner).some(index=>payload.targetCharts?.includes(index))));
          if(!donorPath.length)continue;
          const eligible=new Set(donorPath.map(node=>node.id));
          const cuts=[];
          for(const node of donorPath){
            const trial={...board,nodes:board.nodes.filter(id=>id!==node.id)};
            const result=reachable(owner,trial);
            if(!result)continue;
            const removed=board.nodes.filter(id=>!result.active.has(id));
            if(removed.some(id=>!eligible.has(id)&&!canDetachInactiveSocket(nodeMaps.get(owner).get(id),owner,board)))continue;
            const refund=removed.reduce((sum,id)=>sum+
              nodeMaps.get(owner).get(id).items.reduce((qty,item)=>qty+item.qty,0),0);
            if(refund)cuts.push({active:result.active,refund});
          }
          cuts.sort((a,b)=>b.refund-a.refund);
          if(cuts.length){
            const keep=new Set(board.nodes.filter(id=>cuts[0].active.has(id)));
            donorCuts.push({owner,board:{nodes:[...keep],
              cards:Object.fromEntries(Object.entries(board.cards).filter(([id])=>keep.has(id)||!nodeMaps.get(owner).get(id).pts))}});
          }
          const removable=board.nodes.filter(id=>!eligible.has(id));
          const result=reachable(owner,{...board,nodes:removable});
          if(result&&removable.every(id=>result.active.has(id))){
            const cards=Object.fromEntries(Object.entries(board.cards).filter(([id])=>result.active.has(id)));
            donorCuts.push({owner,board:{nodes:removable,cards}});
          }
          if(!yellow&&!red&&teamMembers.has(owner)){
            const frequency=donorPath.filter(node=>node.kind==='activeFreq').slice(0,4);
            for(let mask=1;mask<1<<frequency.length;mask++){
              const selected=new Set(frequency.flatMap((node,i)=>mask&(1<<i)?[node.id]:[]));
              const next={...board,nodes:board.nodes.filter(id=>!selected.has(id))};
              const active=reachable(owner,next)?.active;
              if(active&&next.nodes.every(id=>active.has(id))&&Object.keys(next.cards).every(id=>active.has(id)))
                timingCuts.push({owner,board:next});
            }
          }
        }
      }
      const editTerms=(owner,next)=>{
        const original=originalNodes.get(owner);
        const current=new Set((saves[owner]??emptyBoard).nodes),future=new Set(next.nodes);
        const delta=materials.map(()=>0);
        let resets=0;
        const add=(id,sign)=>{
          if(original.has(id))resets-=sign;
          for(const {id:item,qty} of nodeMaps.get(owner).get(id).items){
            const idx=materials.indexOf(item);
            if(idx>=0)delta[idx]+=sign*qty;
          }
        };
        for(const id of current)if(!future.has(id))add(id,-1);
        for(const id of future)if(!current.has(id))add(id,1);
        return {owner,board:next,delta,resets};
      };
      const activeDonors=donorCuts.map(({owner,board})=>editTerms(owner,board))
        .sort((a,b)=>a.delta.reduce((sum,n)=>sum+n,0)/Math.max(1,a.resets)-
          b.delta.reduce((sum,n)=>sum+n,0)/Math.max(1,b.resets));
      const candidates=[];
      const rows=[...proposals].map(([owner,boards])=>boards.map(board=>editTerms(owner,board)));
      const timing=timingCuts.map(({owner,board})=>editTerms(owner,board));
      function consider(edits){
        const delta=materials.map((_,i)=>edits.reduce((sum,edit)=>sum+edit.delta[i],0));
        const combined=[...edits];
        const edited=new Set(edits.map(edit=>edit.owner));
        let resets=edits.reduce((sum,edit)=>sum+edit.resets,0);
        if(!boardOpt.infiniteMaterials)for(const donor of activeDonors){
          if(delta.every((need,i)=>need<=stock[i]))break;
          if(edited.has(donor.owner))continue;
          if(!delta.some((need,i)=>need>stock[i]&&donor.delta[i]<0))continue;
          if(boardOpt.maxResets>=0&&resetCount+resets+donor.resets>boardOpt.maxResets)continue;
          resets+=donor.resets;
          for(const [i,value] of donor.delta.entries())delta[i]+=value;
          combined.push(donor);
          edited.add(donor.owner);
        }
        candidates.push({edits:combined,delta,resets});
      }
      for(const batch of rows)for(const variant of batch)consider([variant]);
      for(let a=0;a<rows.length;a++)for(let b=a+1;b<rows.length;b++)
        for(const first of rows[a])for(const second of rows[b])consider([first,second]);
      for(const donor of timing)consider([donor]);
      const joint=candidates.slice().filter(({edits,delta})=>edits.some(edit=>proposals.has(edit.owner))&&
        delta.every((qty,i)=>qty<=stock[i]));
      if(timing.length&&joint.length){
        const ranked=await rankLayouts(joint.map(({edits})=>({
          boards:{...saves,...Object.fromEntries(edits.map(({owner,board})=>[owner,board]))},edits,
        })));
        for(const {edits} of ranked)for(const donor of timing)
          if(edits.every(edit=>edit.owner!==donor.owner))consider([...edits,donor]);
      }
      const legal=await kernels.checkTrades(candidates.map(({delta,resets})=>[0,0,Math.max(0,resets),1,
        ...delta.map(n=>Math.max(0,n)),...delta.map(n=>Math.max(0,-n))]),
        [boardOpt.maxResets<0?0xffffffff:boardOpt.maxResets-resetCount,...stock],{unlimited:boardOpt.infiniteMaterials});
      const layouts=candidates.flatMap(({edits},i)=>legal[i]?[{boards:{...saves,
        ...Object.fromEntries(edits.map(({owner,board})=>[owner,board]))},edits}]:[]);
      const getOrder=board=>bestOutfit(scorer(payload,board,ranks).score,
        order.map((_,i)=>[...order.slice(i),...order.slice(0,i)]));
      const alternativeOrder=getOrder(saves).order.map(id=>cards.get(id));
      const orders=order.every((card,i)=>card===alternativeOrder[i])?
        (order===screenedOrder?[order]:[order,screenedOrder]):[order,alternativeOrder,screenedOrder];
      const ranked=await rankLayouts(layouts,orders);
      const forConnect=yellow?[...new Set([...ranked.slice(0,4),
        ...layouts.filter(({edits})=>edits.some(edit=>edit.owner===leaderChar)).slice(0,2)])]:ranked.slice(0,4);
      for(const {boards,edits} of forConnect){
        for(const {owner,board} of edits){
          if(!proposals.has(owner))continue;
          const current=new Set((saves[owner]??emptyBoard).nodes);
          const route=board.nodes.filter(id=>!current.has(id)).map(id=>nodeMaps.get(owner).get(id));
          for(const {boards:connected} of connectTrials(boards,owner,route,2))ranked.push({boards:connected,edits});
        }
      }
      let best;
      for(const {boards,edits} of ranked){
        const row=bestOutfit(scorer(payload,boards,ranks).score,orders);
        if(compare(row,best?.row??after)>0)best={boards,edits,row};
      }
      if(!best)return false;
      for(const [owner,board] of Object.entries(best.boards))if(board!==saves[owner])recordTrade(owner,board);
      if(!fitsInventory())throw Error('GPU Board paths exceed the shared budget.');
      saves=best.boards;
      after=best.row;
      order=after.order.map(id=>cards.get(id));
      return true;
    }
    async function rankLayouts(layouts,orders=[order],limit=8){
      if(layouts.length<=limit)return layouts;
      if(cpu)return layouts.map(layout=>({layout,row:bestOutfit(scorer(payload,layout.boards,ranks).score,orders)}))
        .sort((a,b)=>compare(b.row,a.row)).slice(0,limit).map(({layout})=>layout);
      if(unit||payload.options.eventBonus||payload.options.eventPoints||!payload.options.lbCharts?.length){
        const trials=layouts.flatMap(({boards},index)=>{
          const {gpuTrial}=scorer(payload,boards,ranks);
          return eligibleOutfits.flatMap(outfit=>orders.map(lineup=>({index,trial:gpuTrial(lineup,outfit,leaderChar)})));
        });
        const scores=await rankObjective(payload,trials.map(({trial})=>trial));
        if(!scores?.length)return layouts;
        const chosen=new Set();
        for(const {index} of trials.map((trial,i)=>({...trial,...scores[i]}))
          .sort((a,b)=>b.value-a.value||b.tie-a.tie)){
          chosen.add(index);
          if(chosen.size>=limit)break;
        }
        return [...chosen].map(index=>layouts[index]);
      }
      const trials=layouts.flatMap(({boards},index)=>{
        const {timeline}=scorer(payload,boards,ranks);
        return eligibleOutfits.flatMap(outfit=>orders.map(lineup=>({index,windows:timeline(lineup,outfit,leaderChar)})));
      });
      const started=performance.now();
      const scores=await scoreTradeTimelines(trials.map(trial=>trial.windows));
      tradeTiming.timelineGpu+=performance.now()-started;
      if(scores?.length){
        tradeTimelines+=scores.length;
        const field=payload.options.sortBy==='max'?1:0;
        const bestByLayout=new Map();
        for(const [index,row] of scores.entries()){
          const {index:layout}=trials[index];
          const scores=row.map(values=>values[field]).sort((a,b)=>b-a);
          const value=payload.options.lbCharts?.length?scores.slice(0,3).reduce((sum,score)=>sum+Math.ceil(score/5000),0):
            scores.reduce((sum,score)=>sum+score,0);
          const tie=scores.slice(0,3).reduce((sum,score)=>sum+score,0);
          const previous=bestByLayout.get(layout);
          if(!previous||value>previous.value||value===previous.value&&tie>previous.tie)bestByLayout.set(layout,{layout,value,tie});
        }
        return [...bestByLayout.values()].sort((a,b)=>b.value-a.value||b.tie-a.tie).slice(0,limit)
          .map(({layout})=>layouts[layout]);
      }
      return layouts;
    }
    async function rebalance(){
      let tick=performance.now();
      const stock=exactAvailable();
      const resetsLeft=boardOpt.maxResets<0?0xffffffff:Math.max(0,boardOpt.maxResets-resetCount);
      const donors=[],receivers=[];
      for(const owner of owners){
        const save=saves[owner]??emptyBoard;
        const board=data.boards[owner],byId=nodeMaps.get(owner),original=originalNodes.get(owner);
        const frontier=frontierFor(owner,save);
        if(!frontier||save.nodes.some(id=>!frontier.active.has(id)))continue;
        const budget=budgets.get(owner);
        const targets=paths=>paths.flatMap(move=>{
          if(Object.keys(move.materials).some(id=>!materialKnown.has(id)))return [];
          const priority=move.path.reduce((sum,node)=>sum+affectedPriority(node,owner,save),0);
          return priority>0?[{...move,owner,priority}]:[];
        });
        const paths=targets(frontier.paths).filter(move=>frontier.spent+move.points<=budget)
          .sort((a,b)=>b.priority/(1+b.points)-a.priority/(1+a.points));
        const skillPaths=paths.filter(move=>move.path.some(node=>node.kind==='activeChance'||node.kind==='activeFreq'));
        const shortlisted=new Set([...paths.slice(0,10),...skillPaths.slice(0,8)]);
        for(const move of shortlisted)receivers.push({...move,save,spent:frontier.spent,budget});
        if(!canReset(owner))continue;
        let removable=donorTopology.get(save);
        if(!removable){
          removable=[];
          const known=new Set();
          for(const id of save.nodes){
            const node=byId.get(id);
            if(!node?.pts||protectedNode(node,keep)||
              !canDetachInactiveSocket(node,owner,save)&&(!branches.has(node.branch)||Object.hasOwn(save.cards,id)))continue;
            const without={...save,nodes:save.nodes.filter(other=>other!==id)};
            const reachable=boardReachability(board,without,account.dreamRank);
            if(!reachable)continue;
            const removed=save.nodes.filter(other=>!reachable.active.has(other));
            if(!removed.length||removed.some(other=>{
              const node=byId.get(other);
              return !canDetachInactiveSocket(node,owner,save)&&(Object.hasOwn(save.cards,other)||
                !branches.has(node.branch)||protectedNode(node,keep));
            }))continue;
            const key=removed.slice().sort().join('|');
            if(known.has(key))continue;
            known.add(key);
            const refund={},nodes=removed.map(other=>byId.get(other));
            for(const candidate of nodes)for(const {id,qty} of candidate.items)refund[id]=(refund[id]??0)+qty;
            const next={nodes:save.nodes.filter(other=>!removed.includes(other)),
              cards:Object.fromEntries(Object.entries(save.cards).filter(([socket])=>!removed.includes(socket)))};
            const spent=frontier.spent-nodes.reduce((sum,candidate)=>sum+candidate.pts,0);
            removable.push({owner,next,spent,refund,nodes,removed:new Set(removed),budget,
              resetCost:removed.filter(other=>original.has(other)).length,
            });
          }
          if(save!==emptyBoard)donorTopology.set(save,removable);
        }
        for(const donor of removable){
          const loss=donor.nodes.reduce((sum,node)=>sum+priorityFor(node,owner),0);
          donors.push({donor,loss});
        }
      }
      tradeTiming.topology+=performance.now()-tick;
      tick=performance.now();
      const candidates=[];
      const byMaterial=new Map(materials.map(id=>[id,donors.filter(({donor})=>donor.refund[id])
        .sort((a,b)=>a.loss/a.donor.refund[id]-b.loss/b.donor.refund[id]||
          b.donor.refund[id]-a.donor.refund[id]||a.donor.resetCost-b.donor.resetCost).slice(0,16)]));
      const addCandidate=(move,donors,priority)=>{
        const refund={};
        let resetCost=0;
        for(const donor of donors){
          resetCost+=donor.resetCost;
          for(const [id,qty] of Object.entries(donor.refund))refund[id]=(refund[id]??0)+qty;
        }
        candidates.push({move,donors,refund,resetCost,priority});
      };
      for(const move of receivers){
        if(move.spent+move.points>move.budget)continue;
        const blocked=materials.flatMap((id,index)=>(move.materials[id]??0)>stock[index]?
          [{id,shortfall:move.materials[id]-stock[index]}]:[]);
        if(!blocked.length||boardOpt.infiniteMaterials){
          addCandidate(move,[],move.priority/(1+move.points));
          continue;
        }
        const possible=(byMaterial.get(blocked[0].id)??[]).filter(({donor})=>donor.owner!==move.owner);
        for(const {donor,loss} of possible){
          addCandidate(move,[donor],(move.priority-loss)/(1+move.points));
        }
        // Expensive paths often need refunds from more than one member.
        // Gather one connected group per donor Board into the same trade.
        for(const {donor:first,loss:firstLoss} of possible.slice(0,3)){
          const group=[first],used=new Set([move.owner,first.owner]),refund={...first.refund};
          let loss=firstLoss;
          for(let count=0;count<6;count++){
            const missing=blocked.find(({id,shortfall})=>shortfall>(refund[id]??0));
            if(!missing)break;
            const selected=byMaterial.get(missing.id)?.find(({donor})=>!used.has(donor.owner));
            if(!selected)break;
            const next=selected.donor;
            loss+=selected.loss;
            used.add(next.owner);
            group.push(next);
            for(const [id,qty] of Object.entries(next.refund))refund[id]=(refund[id]??0)+qty;
          }
          if(group.length>1)addCandidate(move,group,(move.priority-loss)/(1+move.points));
        }
      }
      const localDonors=new Map();
      for(const row of donors){
        const {owner}=row.donor;
        if(!localDonors.has(owner))localDonors.set(owner,[]);
        localDonors.get(owner).push(row);
      }
      const localCuts=[...localDonors.values()].flatMap(entries=>{
        entries.sort((a,b)=>a.loss-b.loss||b.donor.spent-a.donor.spent);
        if(!payload.activeSpecialist)return entries.slice(0,7);
        const cuts=new Set(entries.slice(0,5));
        // A cheap cut can free too few Board Points for a timing node.
        // Keep the cheapest cuts that reach a range of route lengths.
        for(const points of [5,10,15,20,30]){
          const cut=entries.find(({donor})=>donor.budget-donor.spent>=points);
          if(cut)cuts.add(cut);
        }
        return [...cuts];
      });
      for(const {donor,loss} of localCuts){
        donor.paths??=boardFrontierPaths(data.boards[donor.owner],donor.next,account.dreamRank,branches,8)?.paths??[];
        const paths=[];
        for(const move of donor.paths){
          const end=move.path.at(-1);
          if(donor.spent+move.points>donor.budget||donor.removed.has(end.id)||
            Object.keys(move.materials).some(id=>!materialKnown.has(id)))continue;
          const priority=move.path.reduce((sum,node)=>sum+affectedPriority(node,donor.owner,donor.next),0);
          if(priority<=0)continue;
          paths.push({...move,priority:(priority-loss)/(1+move.points)});
        }
        paths.sort((a,b)=>b.priority-a.priority);
        const timingPaths=payload.activeSpecialist?
          paths.filter(move=>move.path.some(node=>node.kind==='activeFreq')).slice(0,4):[];
        for(const move of new Set([...paths.slice(0,12),...timingPaths])){
          addCandidate({...move,owner:donor.owner,save:donor.next,spent:donor.spent,budget:donor.budget},
            [donor],move.priority);
        }
      }
      tradeCandidates+=candidates.length;
      const resetsFor=({resetCost,move})=>resetCost-
        move.path.filter(node=>originalNodes.get(move.owner).has(node.id)).length;
      const packed=candidates.map(candidate=>{
        const {move,refund,priority}=candidate;
        return [move.spent+move.points,move.budget,Math.max(0,resetsFor(candidate)),scoreBits(Math.max(1,priority+1000000)),
          ...materials.map(id=>move.materials[id]??0),...materials.map(id=>refund[id]??0)];
      });
      tradeTiming.candidates+=performance.now()-tick;
      tick=performance.now();
      const legal=await kernels.checkTrades(packed,[resetsLeft,...stock],{unlimited:boardOpt.infiniteMaterials});
      tradeTiming.gpu+=performance.now()-tick;
      tick=performance.now();
      const ranked=[];
      for(const [index,candidate] of candidates.entries())if(legal[index])ranked.push(candidate);
      ranked.sort((a,b)=>b.priority-a.priority);
      const seen=new Map(),selected=[],skill=[],frequency=[];
      const skillTargets=new Set(),frequencyTargets=new Set();
      let same=0,cross=0,buys=0;
      for(const candidate of ranked){
        const {move,donors}=candidate;
        const local=move.owner===donors[0]?.owner;
        const key=[!donors.length?'buy':local?'same':'cross',move.owner,move.path.at(-1).id].join('|');
        const count=seen.get(key)??0;
        if(count>=2)continue;
        if(!skillTargets.has(key)&&skill.length<24&&move.path.some(node=>node.kind==='activeChance'||node.kind==='activeFreq')){
          skillTargets.add(key);
          skill.push(candidate);
        }
        if(payload.activeSpecialist&&frequency.length<12&&!frequencyTargets.has(key)&&
          move.path.some(node=>node.kind==='activeFreq')){
          frequencyTargets.add(key);
          frequency.push(candidate);
        }
        if(!donors.length?buys>=16:local?same>=24:cross>=28)continue;
        seen.set(key,count+1);
        selected.push(candidate);
        if(!donors.length)buys++;
        else if(local)same++;
        else cross++;
        if(same>=24&&cross>=28&&buys>=16&&skill.length>=24&&
          (!payload.activeSpecialist||frequency.length>=12))break;
      }
      const layouts=[];
      for(const {move,donors} of new Set([...selected,...skill,...frequency])){
        const next={...move.save,nodes:[...move.save.nodes,...move.path.filter(node=>node.pts).map(node=>node.id)]};
        const boards={...saves,...Object.fromEntries(donors.map(donor=>[donor.owner,donor.next])),[move.owner]:next};
        layouts.push({move,donors,boards:tradeBoards(move,donors,boards)});
      }
      const exact=await rankLayouts(layouts);
      const variants=exact.slice();
      if(payload.trio)for(const layout of exact.slice(0,4)){
        for(const {boards} of connectTrials(layout.boards,layout.move.owner,layout.move.path,2))
          variants.push({...layout,boards});
      }
      let best;
      for(const {move,donors,boards} of variants){
        const row=bestOutfit(scorer(payload,boards,ranks).score);
        if(compare(row,best?.row??after)>0)best={move,donors,boards,row};
      }
      tradeTiming.scoring+=performance.now()-tick;
      if(!best)return false;
      const {move,donors:used,boards,row}=best;
      if(used.length&&move.owner!==used[0].owner)crossBoardTrades++;
      else if(used.length)sameBoardTrades++;
      for(const [owner,board] of Object.entries(boards))if(board!==saves[owner])recordTrade(owner,board);
      saves=boards;
      after=row;
      if(boardOpt.maxResets>=0&&resetCount>boardOpt.maxResets||!boardOpt.infiniteMaterials&&
        materials.some(id=>(bought[id]??0)>(boardOpt.materials[id]??0)+(refunded[id]??0)))
        throw Error('GPU Board trade exceeds the shared budget.');
      return true;
    }
    if(refineBranches&&!boardOpt.litePlan){
      for(const branch of refineBranches)await rebuildPaths(branch);
    }else if(payload.rebuildBlue&&!boardOpt.litePlan&&!payload.exchangeOnly){
      if(payload.seedBoards&&payload.targetCharts)await rebuildPaths('yellow');
      await rebuildPaths('blue');
    }
    const buyStart=performance.now();
    const purchaseFields=new WeakMap();
    const socketNodes=new Map(owners.map(owner=>[owner,data.boards[owner].filter(node=>node.socket)]));
    for(let step=0;step<(refineBranches||payload.exchangeOnly?0:boardOpt.litePlan?18:payload.seedBoards?40:140);step++){
      const available=[0,0,...exactAvailable()];
      const assigned=new Set(Object.values(saves).flatMap(board=>Object.values(board.cards)));
      const connects=rankedConnects.filter(id=>!assigned.has(id));
      const connectPatterns=new Set();
      const distinctConnects=connects.filter(id=>{
        const key=connectPatternsById.get(id);
        if(connectPatterns.has(key))return false;
        connectPatterns.add(key);return true;
      });
      const chartKey=JSON.stringify(payload.activeSpecialist?[after.songBonuses,after.chartScores]:after.songBonuses);
      const connectKey=distinctConnects.join('|');
      const candidates=[];
      for(const owner of owners){
        const save=saves[owner]??emptyBoard;
        const frontier=frontierFor(owner,save);
        if(!frontier)continue;
        const budget=budgets.get(owner);
        const cacheable=save!==emptyBoard;
        const cached=cacheable?purchaseFields.get(save):undefined;
        if(cached&&cached.chartKey===chartKey&&cached.connectKey===connectKey){
          candidates.push(...cached.moves);
          continue;
        }
        const boardMoves=[];
        const keepCoverage=protectedCoverage(owner,save,frontier.active);
        const socketPaths=new Map(frontier.sockets.map(socket=>[socket.id,emptyMove]));
        for(const move of frontier.paths){
          const node=move.path.at(-1);
          if(Object.keys(move.materials).some(id=>!materialKnown.has(id)))continue;
          if(node.socket&&move.points<=budget-frontier.spent)socketPaths.set(node.id,move);
          if(!node.kind||node.charTrigger==='WORK')continue;
          const priority=move.path.reduce((total,node)=>total+priorityFor(node,owner),0)/(1+move.points);
          if(!priority)continue;
          boardMoves.push({...move,owner,save,budget,spent:frontier.spent,priority});
        }
        const affected=new Map(data.boards[owner].filter(node=>frontier.active.has(node.id))
          .map(node=>[node.x+','+node.y,priorityFor(node,owner)]));
        const socketsOnBoard=new Set(Object.values(save.cards));
        for(const socket of socketNodes.get(owner).filter(node=>
          (socketPaths.has(node.id)||frontier.active.has(node.id)))){
          if(pinnedSlot(owner,socket.id))continue;
          const path=socketPaths.get(socket.id)??emptyMove;
          const active=keepCoverage.size&&!frontier.active.has(socket.id)?
            new Set([...frontier.active,socket.id]):frontier.active;
          const newNodes=new Map(path.path.map(node=>[node.x+','+node.y,priorityFor(node,owner)]));
          const incumbent=save.cards[socket.id];
          const moves=[];
          const boost=id=>id&&data.connects[id]&&account.owned[id]?socketFootprint(socket,id).reduce((sum,key)=>
            sum+(newNodes.get(key)??affected.get(key)??0),0)*connectPermil(id)/1000:0;
          const current=boost(incumbent);
          for(const cardId of distinctConnects){
            if(socketsOnBoard.has(cardId))continue;
            const priority=(boost(cardId)-current)/(1+path.points);
            if(priority>0&&keepCoverage.size){
              const next={...save,cards:{...save.cards,[socket.id]:cardId}};
              if(!preservesCoverage(owner,save,next,frontier.active,active))continue;
            }
            if(priority>0)moves.push({...path,owner,save,budget,spent:frontier.spent,
              socket:socket.id,cardId,priority});
          }
          boardMoves.push(...moves.sort((a,b)=>b.priority-a.priority).slice(0,3));
        }
        if(cacheable)purchaseFields.set(save,{chartKey,connectKey,moves:boardMoves});
        candidates.push(...boardMoves);
      }
      boardMoves+=candidates.length;
      const legal=await kernels.checkBoards(candidates.map(move=>[
        move.spent+move.points,move.budget,0,0,...materials.map(id=>move.materials[id]??0),scoreBits(move.priority),
      ]),available,{unlimited:boardOpt.infiniteMaterials});
      const ordered=candidates.flatMap((move,index)=>legal[index]?[{move,key:legal[index]}]:[])
        .sort((a,b)=>b.key-a.key);
      const seenOwners=new Set();
      const diverse=ordered.filter(({move})=>{
        if(seenOwners.has(move.owner))return false;
        seenOwners.add(move.owner);
        return true;
      });
      const selected=[...new Set([...ordered.filter(({move})=>!move.socket).slice(0,10),
        ...ordered.filter(({move})=>move.socket).slice(0,8),
        ...ordered.filter(({move})=>move.path.some(node=>node.kind==='param'&&node.targetType==='ALL')).slice(0,8),
        ...ordered.filter(({move})=>move.path.some(node=>node.kind==='activeChance'||node.kind==='activeFreq')).slice(0,8),
        ...(payload.activeSpecialist?ordered.filter(({move})=>move.path.some(node=>node.kind==='activeFreq')).slice(0,6):[]),
        ...diverse.slice(0,12)])];
      let best,neutral,blueOpening;
      const openingKind=payload.activeSpecialist&&step<(payload.rebuildBlue?8:16)?
        (step<8?'activeChance':'activeFreq'):null;
      function moveLayout(move){
        const nodes=move.path.filter(node=>node.pts>0).map(node=>node.id);
        const next={nodes:[...move.save.nodes,...nodes],cards:move.socket?
          {...move.save.cards,[move.socket]:move.cardId}:move.save.cards};
        const boards={...saves,[move.owner]:next};
        return {move,nodes,boards};
      }
      function evaluateMove({move,nodes,boards}){
        const row=bestOutfit(scorer(payload,boards,ranks).score);
        const reference=best?.row??after;
        const tie=row.tieScore??row.score,referenceTie=reference.tieScore??reference.score;
        if(row.value>reference.value||row.value===reference.value&&tie>referenceTie)
          best={move,nodes,boards,row};
        else if(!neutral&&nodes.length&&row.value===after.value&&tie===(after.tieScore??after.score))
          neutral={move,nodes,boards,row};
        if(openingKind&&move.path.some(node=>node.kind===openingKind)&&
          compare(row,after)>0&&(!blueOpening||compare(row,blueOpening.row)>0))
          blueOpening={move,nodes,boards,row};
      }
      for(const {move} of selected)evaluateMove(moveLayout(move));
      if(blueOpening)best=blueOpening;
      if(!best&&!boardOpt.litePlan){
        // A shallow ranking can be saturated by branches that have hit
        // chart or skill caps. Refine unused legal paths before stopping.
        const tested=new Set(selected);
        const refine=ordered.filter(entry=>!tested.has(entry)&&!entry.move.socket);
        for(const {move} of refine.slice(0,36))evaluateMove(moveLayout(move));
      }
      if(!best&&!boardOpt.litePlan){
        // Active Frequency changes a discrete cooldown schedule. A pair
        // can cross a timing threshold even when neither single move does.
        const frequency=ordered.filter(({move})=>!move.socket&&move.path.some(node=>node.kind==='activeFreq')).slice(0,10);
        const compound=[];
        for(const {move:first} of frequency){
          const purchased=new Set(first.path.filter(node=>node.pts).map(node=>node.id));
          const board={...first.save,nodes:[...first.save.nodes,...purchased]};
          const frontier=frontierFor(first.owner,board);
          if(!frontier)continue;
          for(const second of frontier.paths){
            if(!second.path.some(node=>node.kind==='activeFreq')||
              first.spent+first.points+second.points>first.budget)continue;
            const costs={...first.materials};
            for(const [id,quantity] of Object.entries(second.materials))costs[id]=(costs[id]??0)+quantity;
            if(Object.keys(costs).some(id=>!materialKnown.has(id)))continue;
            compound.push({...first,path:[...first.path,...second.path],points:first.points+second.points,materials:costs});
          }
        }
        const legalPairs=await kernels.checkBoards(compound.map(move=>[
          move.spent+move.points,move.budget,0,0,...materials.map(id=>move.materials[id]??0),scoreBits(move.priority),
        ]),available,{unlimited:boardOpt.infiniteMaterials});
        for(const [index,move] of compound.entries())if(legalPairs[index])evaluateMove(moveLayout(move));
        if(best)frequencyPairs++;
      }
      if(!best){
        if(neutral&&step<32)best=neutral;
        else break;
      }
      const {move,nodes,boards,row}=best;
      if(!boardOpt.infiniteMaterials&&Object.entries(move.materials).some(([id,quantity])=>
        quantity+(bought[id]??0)>(boardOpt.materials[id]??0)+(refunded[id]??0)))
        throw Error('GPU Board move exceeds the available materials.');
      saves=boards;
      after=row;
      for(const [id,quantity] of Object.entries(move.materials))bought[id]=(bought[id]??0)+quantity;
      const change=changes.get(move.owner)??{owner:move.owner,buys:[],resets:[],connects:[]};
      change.buys.push(...nodes);
      if(move.socket){
        change.connects=change.connects.filter(connection=>connection.socket!==move.socket);
        change.connects.push({socket:move.socket,cardId:move.cardId});
      }
      changes.set(move.owner,{...change,ptsBudget:move.budget,ptsSpent:move.spent+move.points});
    }
    timings.purchases+=performance.now()-buyStart;
    if(!boardOpt.litePlan)await matchConnects();
    // Restore connected groups first, then individual affordable nodes.
    for(const {owner,resets} of reclaimable.reverse()){
      const change=changes.get(owner);
      if(!change?.resets.length)continue;
      const board=saves[owner];
      const nodeById=new Map(data.boards[owner].map(node=>[node.id,node]));
      const repurchased=resets.filter(id=>change.buys.includes(id));
      const candidates=[resets,repurchased,...resets.map(id=>[id])];
      const nodes=new Set(board.nodes);
      for(const ids of candidates){
        const undo=ids.filter(id=>change.resets.includes(id));
        if(!undo.length)continue;
        const remaining=new Set(undo),cost={};
        for(const id of undo)if(!change.buys.includes(id)){
          for(const item of nodeById.get(id).items)cost[item.id]=(cost[item.id]??0)+item.qty;
        }
        if(!boardOpt.infiniteMaterials&&Object.entries(cost).some(([id,quantity])=>
          (bought[id]??0)+quantity>(boardOpt.materials[id]??0)+(refunded[id]??0)))continue;
        const restored=[...new Set([...nodes,...undo])];
        const points=restored.reduce((total,id)=>total+nodeById.get(id).pts,0);
        if(points>change.ptsBudget)continue;
        const assigned=new Set(Object.values(saves).flatMap(save=>Object.values(save.cards)));
        const restoreCards=undo.flatMap(socket=>{
          const cardId=account.boards[owner]?.cards[socket];
          return cardId&&!assigned.has(cardId)&&!saves[owner].cards[socket]?[[socket,cardId]]:[];
        });
        const next={nodes:restored,cards:{...saves[owner].cards,...Object.fromEntries(restoreCards)}};
        const reachable=boardReachability(data.boards[owner],next,account.dreamRank);
        if(!reachable||restored.some(id=>!reachable.active.has(id)))continue;
        const boards={...saves,[owner]:next};
        const row=bestOutfit(scorer(payload,boards,ranks).score);
        if(row.value<after.value||row.value===after.value&&(row.tieScore??row.score)<(after.tieScore??after.score))continue;
        saves=boards;
        after=row;
        for(const id of undo){
          nodes.add(id);
          for(const item of nodeById.get(id).items){
            refunded[item.id]-=item.qty;
            if(change.buys.includes(id))bought[item.id]-=item.qty;
          }
        }
        resetCount-=undo.length;
        change.resets=change.resets.filter(id=>!remaining.has(id));
        change.buys=change.buys.filter(id=>!remaining.has(id));
        if(restoreCards.length){
          const sockets=new Set(restoreCards.map(([socket])=>socket));
          change.connects=change.connects.filter(({socket})=>!sockets.has(socket));
        }
      }
      change.ptsSpent=[...nodes].reduce((total,id)=>total+nodeById.get(id).pts,0);
      if(!change.resets.length&&!change.buys.length&&!change.connects.length)changes.delete(owner);
    }
    if(!boardOpt.litePlan){
      // Normalize the construction ledger to the actual diff before trading
      // so that canceling a proposed buy cannot produce an in-game refund.
      for(const [owner,change] of changes){
        const original=originalNodes.get(owner);
        const rebuilt=change.buys.filter(id=>original.has(id)&&change.resets.includes(id));
        if(!rebuilt.length)continue;
        const nodes=nodeMaps.get(owner);
        const duplicate=new Set(rebuilt);
        change.buys=change.buys.filter(id=>!duplicate.has(id));
        change.resets=change.resets.filter(id=>!duplicate.has(id));
        resetCount-=rebuilt.length;
        for(const id of rebuilt)for(const {id:item,qty} of nodes.get(id).items){
          bought[item]-=qty;
          refunded[item]-=qty;
        }
      }
      let traded=false;
      for(let step=0;step<(refineBranches||payload.exchangeOnly?0:payload.seedBoards?8:payload.activeSpecialist?18:12);step++){
        if(!await rebalance())break;
        traded=true;
      }
      if(traded)await matchConnects();
      if(!refineBranches&&payload.seedBoards&&payload.rebuildBlue){
        if(!payload.exchangeOnly){
          if(await rebuildPaths('blue'))await matchConnects();
          if(payload.targetCharts&&await rebuildPaths('yellow'))await matchConnects();
        }
        const scoring=scorer(payload,saves,ranks).score;
        const swaps=order.flatMap((_,left)=>order.slice(left+1).map((_,offset)=>{
          const right=left+offset+1;
          const next=order.slice();
          [next[left],next[right]]=[next[right],next[left]];
          return next;
        }));
        const rotations=order.map((_,i)=>[...order.slice(i),...order.slice(0,i)]);
        const candidates=[order,screenedOrder,...swaps,...rotations].map(cards=>({
          cards,row:bestOutfit(scoring,[cards]),
        })).sort((a,b)=>compare(b.row,a.row));
        const seen=new Set();
        const orders=candidates.flatMap(({cards,row})=>{
          const key=row.order.join('|');
          if(seen.has(key))return [];
          seen.add(key);
          return [cards];
        }).slice(0,3);
        const baseline=saves;
        const exchangeStart=performance.now();
        const exchange=await refineBoardExchanges({boards:saves,owners,topology:data.boards,
          allowed:branches,dreamRank:account.dreamRank,budgets,order,leader:leaderChar,
          materials,stock:exactAvailable(),maxResets:boardOpt.maxResets,resetCount,original:originalNodes,
          protectedNode:node=>protectedNode(node,keep),canReset,rankLayouts:(rows,_,limit)=>rankLayouts(rows,orders,limit),
          checkTrades:kernels.checkTrades,
          includeSong:payload.exchangeOnly?(node,owner)=>matchingCharts(node,owner).some(index=>
            (!payload.targetCharts||payload.targetCharts.includes(index))&&
            (after.songBonuses[index]??0)<(data.boardLimits?.songBonus??Infinity)):undefined,
          score:boards=>bestOutfit(scorer(payload,boards,ranks).score,orders),infinite:boardOpt.infiniteMaterials,
        });
        timings.exchanges+=performance.now()-exchangeStart;
        if(exchange){
          for(const [owner,board] of Object.entries(exchange.boards))if(board!==saves[owner])recordTrade(owner,board);
          if(!fitsInventory())throw Error('GPU Board exchanges exceed the shared budget.');
          saves=exchange.boards;
          after=exchange.row;
          order=after.order.map(id=>cards.get(id));
          await matchConnects();
        }
        if(saves!==baseline){
          const evaluated=scorer(payload,saves,ranks).score;
          const next=bestOutfit(evaluated,orders);
          order=next.order.map(id=>cards.get(id));
          after=next;
        }
      }
    }
    const orderStart=performance.now();
    const rotations=order.map((_,index)=>[...order.slice(index),...order.slice(0,index)]);
    const finalPayload=payload.trio?{...payload,targetCharts:undefined}:payload;
    if(boardOpt.litePlan){
      for(let left=0;left<order.length;left++)for(let right=left+1;right<order.length;right++){
        const alternative=order.slice();
        [alternative[left],alternative[right]]=[alternative[right],alternative[left]];
        rotations.push(alternative);
      }
      after=bestOutfit(scorer(payload,saves,ranks).score,rotations);
    }else{
      const permute=(fixed,remaining)=>remaining.length?remaining.flatMap((card,index)=>
        permute([...fixed,card],remaining.filter((_,position)=>position!==index))):[fixed];
      after=bestOutfit(scorer(finalPayload,saves,ranks).score,permute([],order));
    }
    timings.order+=performance.now()-orderStart;
    if(after.value<before.value||after.value===before.value&&
      (after.tieScore??after.score)<(before.tieScore??before.score))return {plan:null};
    let rewardGains;
    if(!boardOpt.litePlan&&hasGpuBoardBonusTargets(keep)){
      const rewardOrder=after.order.map(id=>cards.get(id));
      const estimate=finalPayload.options.sortBy==='max'?'maxScore':'score';
      // The loss limit is denominated in song score, even for Event Points or Unit Score.
      const songScorePayload=unit?{...finalPayload,options:{...finalPayload.options,scoringMode:'generic'}}:null;
      const songScoreFor=(boards,row)=>{
        if(songScorePayload){
          const context=createReferenceScoreContext(scoringData,account.owned,boards,ranks,
            songScorePayload.options,account.dreamRank);
          return evaluateReferenceTeam(context,rewardOrder,row.outfitId,leaderChar,false,null,undefined,cachedTimeline)[estimate];
        }
        return row.epPermil===undefined?row[estimate]:(row[estimate]/(1+row.epPermil/1000)-120)*15000;
      };
      const rewards=await improveGpuBoardBonuses({owners,topology:data.boards,nodeMaps,budgets,originalNodes,
        targets:keep,branches,dreamRank:account.dreamRank,emptyBoard,materials,infinite:boardOpt.infiniteMaterials,
        available:exactAvailable,resetsLeft:()=>boardOpt.maxResets<0?0xffffffff:Math.max(0,boardOpt.maxResets-resetCount),
        protectedNode:node=>protectedNode(node,keep),canReset,priority:priorityFor,checkTrades:kernels.checkTrades,
        score:boards=>{const row=bestOutfit(scorer(finalPayload,boards,ranks).score,[rewardOrder]);
          return {...row,rewardSongScore:songScoreFor(boards,row)};},
        scoreValue:row=>row.rewardSongScore,initial:{...after,rewardSongScore:songScoreFor(saves,after)},boards:saves,
        commit:boards=>{
          for(const [owner,board] of Object.entries(boards))if(board!==saves[owner])recordTrade(owner,board);
          if(!fitsInventory())throw Error('GPU Board bonus targets exceed the shared budget.');
          saves=boards;
        },
      });
      after=rewards.row;
      rewardGains=rewards.gains;
    }
    for(const [owner,change] of changes){
      const original=originalBoards[owner]?.cards??{};
      const final=saves[owner]?.cards??{};
      change.connects=[...new Set([...Object.keys(original),...Object.keys(final)])]
        .filter(socket=>(original[socket]??null)!==(final[socket]??null))
        .map(socket=>({socket,cardId:final[socket]??null}));
      if(!change.buys.length&&!change.resets.length&&!change.connects.length)changes.delete(owner);
    }
    if(payload.options.lbCharts?.length){
      plannedBest=Math.max(plannedBest,after.value);
      if(!boardOpt.litePlan){
        const boughtChance=[...changes.values()].reduce((sum,{owner,buys})=>
          sum+buys.filter(id=>nodeMaps.get(owner).get(id)?.kind==='activeChance').length,0);
        if(shortlistPlans.length<32)shortlistPlans.push({before:before.value,after:after.value,boughtChance,
          specialist:!!payload.activeSpecialist,...(payload.seedBoards?{seeded:true}:{}),
          ...(payload.targetCharts?{targetCharts:payload.targetCharts}:{}),
          ...(payload.options.debugGpuPlans?{order:after.order}:{}),
        });
      }
    }
    if(hasBoardProtection(boardOpt)&&(!preservesBoardProtection(boardOpt,originalBoards,saves)||!fitsInventory()))
      throw Error('The Board plan violates a protection or shared inventory limit.');
    return {plan:{changes:[...changes.values()],bought,refunded,resetCount,saves,ranks,orderExhaustive:!boardOpt.litePlan,
      ...(rewardGains?{rewardGains}:{}),
      ignoredExisting:boardOpt.ignoreExisting,before,after,leaderChar,outfitId:after.outfitId}};
  }

    return {solve,solveNext,plan,rankResults,
    close:kernels.close,metrics:()=>({examined,boardMoves,projectedBest,plannedBest,boardProjections,
    connectMatches,frequencyPairs,sameBoardTrades,crossBoardTrades,tradeCandidates,tradeTimelines,tradeTiming,
    shortlistPlans,timings,shortlistTiming,kernelTiming:kernels.timings,timelineCache:{skillHits,skillMisses},objectiveTrials})};
}
