import {createGpuSearchKernels,eligibleGpuOutfits,shortlistGpuTeams} from './gpu-search-kernels';
import {boardFrontierPaths,boardPointsAtRank,boardReachability,boardResetCuts} from './unit-score-board-search';
import {createReferenceScoreContext,evaluateReferenceTeam,referenceBoardSongMatches,referenceCardStats,referenceChartBatch,referenceChartMatcher} from './reference-rating-math';
import {evaluateUnitScore,referenceUnitScoreInput,unitScoreContext} from './unit-score-search';
import {createGpuObjectiveScorer,createGpuTradeScorer} from './gpu-trade-scoring';
import {refineBoardExchanges} from './gpu-board-exchanges';
import {hasGpuBoardBonusTargets,improveGpuBoardBonuses} from './gpu-board-bonus-targets';
import {searchGpuNextUpgrades} from './gpu-next-upgrades';
import * as cpuBoardKernels from './cpu-board-kernels';
import {restoreUnusedConnects} from './board-connect-retention';
import {boardPlanningBaseline,boardProtection,pinsBoardConnects,preservesBoard,preservesBoardProtection} from './board-protection';
import {isTeamCardEligible} from './team-card-pool';
import {averageChartRows,boardRangeCharts} from './mobile-chart-average';
import {challengeBonusPermil,screenChallengeScore} from './challenge-score';

const float=new Float32Array(1),bits=new Uint32Array(float.buffer);
const scoreBits=value=>{float[0]=Math.max(0,value);return bits[0];};
const cap=value=>Math.min(0xffffffff,Math.max(0,value));
const emptyMove={path:[],points:0,materials:{}};
const priorityWeights={paramGroup:3,param:3,activeChance:100,activeFreq:90,activeEffect:32};
const arrangements=(fixed,remaining)=>remaining.length?remaining.flatMap((card,index)=>
  arrangements([...fixed,card],remaining.filter((_,position)=>position!==index))):[fixed];
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

export const createGpuTeamOptimizer=(data,objective,dispatcher)=>createTeamOptimizer(data,objective,false,dispatcher);
export const createCpuBoardPlanner=(data,objective)=>createTeamOptimizer(data,objective,true);

async function createTeamOptimizer(data,objective,cpu,dispatcher){
  const kernels=cpu?cpuBoardKernels:await createGpuSearchKernels(undefined,dispatcher);
  const scoreTradeTimelines=cpu?null:createGpuTradeScorer(kernels);
  const scoreObjectives=cpu?null:createGpuObjectiveScorer(kernels,scoreTradeTimelines);
  const sweepCache=new Map();
  let cachedTeams=0;
  const lineupKernels={...kernels,async searchTeams(cards,slots,metric){
    if(metric?.retainAll)return kernels.searchTeams(cards,slots,metric);
    const key=JSON.stringify([cards,slots,metric]);
    if(sweepCache.has(key)){
      const result=sweepCache.get(key);
      sweepCache.delete(key);
      sweepCache.set(key,result);
      return result;
    }
    const result=await kernels.searchTeams(cards,slots,metric);
    if(result.teams.length<=12000&&!sweepCache.has(key)){
      sweepCache.set(key,result);
      cachedTeams+=result.teams.length;
      while(cachedTeams>48000||sweepCache.size>32){
        const oldest=sweepCache.keys().next().value;
        cachedTeams-=sweepCache.get(oldest).teams.length;
        sweepCache.delete(oldest);
      }
    }
    return result;
  }};
  const boardCache=new WeakMap();
  const frontierCache=new WeakMap();
  const effectsByLayout=new Map();
  const noBoardEffects=new Map();
  const statCache=new WeakMap();
  const scoringData={...data,boardOwners:Object.keys(data.boards),boardEffects(owner,save,roster,dreamRank,read){
    if(!save){
      if(!noBoardEffects.has(owner))noBoardEffects.set(owner,[read('always'),read('leader'),read('song')]);
      return noBoardEffects.get(owner);
    }
    let contexts=boardCache.get(save);
    if(!contexts){contexts={byRoster:new WeakMap()};boardCache.set(save,contexts);}
    let cached=contexts.byRoster.get(roster);
    if(cached?.owner===owner&&cached.rank===dreamRank)return cached.effects;
    const key=JSON.stringify([owner,dreamRank,save.nodes,Object.entries(save.cards)
      .map(([socket,id])=>[socket,id,roster[id]?.owned?roster[id].bloom:-1])]);
    let effects=effectsByLayout.get(key);
    if(effects)effectsByLayout.delete(key);
    else effects=[read('always'),read('leader'),read('song')];
    effectsByLayout.set(key,effects);
    if(effectsByLayout.size>4096)effectsByLayout.delete(effectsByLayout.keys().next().value);
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
  const nodeMaps=new Map(Object.entries(data.boards).map(([owner,nodes])=>
    [owner,new Map(nodes.map(node=>[node.id,node]))]));
  const socketNodes=new Map(Object.entries(data.boards).map(([owner,nodes])=>[owner,nodes.filter(node=>node.socket)]));
  const unit=objective==='unitScore';
  let examined=0,boardMoves=0;
  const tradeTiming={topology:0,candidates:0,gpu:0,scoring:0,timelineGpu:0};
  let objectiveTrials=0;
  const timings={screen:0,projection:0,lite:0,full:0,seeded:0,exchangeOnly:0,
    purchases:0,connect:0,paths:0,exchanges:0,order:0};
  const referenceContexts=new WeakMap();
  const chartMatchers=new WeakMap();
  const layoutScorers=new WeakMap();
  const timelineOrders=new WeakMap();
  const timelineStates=new Map(), timelineRing=new Array(4096);
  const timelineMemo={forFormation:cachedTimeline};
  let nextTimeline=0;
  const skillIds=new WeakMap();
  let skillId=0;
  let skillHits=0,skillMisses=0;
  const identity=value=>{
    if(!skillIds.has(value))skillIds.set(value,++skillId);
    return skillIds.get(value);
  };
  function cachedTimeline(order,blooms,outfitSupport,effects,chance,frequency,passive,options){
    let lineup=timelineOrders.get(order);
    if(lineup===undefined){
      lineup=order.map(identity).join('|');
      timelineOrders.set(order,lineup);
    }
    const mode=options.pc?(options.scoringMode==='chart'?'pc-chart':'pc-range'):'mobile';
    const key=[mode,outfitSupport,lineup,...blooms,...effects,...chance,...frequency,...passive].join('|');
    return (scenario,capture,compute)=>{
      let state=timelineStates.get(key);
      if(!state)timelineStates.set(key,state=[new Map(),new Map()]);
      const entries=state[Number(capture)];
      const existing=entries.get(scenario);
      if(existing){skillHits++;return existing;}
      skillMisses++;
      const value=compute();
      entries.set(scenario,value);
      const oldest=timelineRing[nextTimeline];
      if(oldest){
        oldest.entries.delete(oldest.scenario);
        if(!oldest.state[0].size&&!oldest.state[1].size)timelineStates.delete(oldest.key);
      }
      timelineRing[nextTimeline]={key,state,entries,scenario};
      nextTimeline=(nextTimeline+1)%timelineRing.length;
      return value;
    };
  }

  function scorer(payload,boards=payload.account.boards,ranks=payload.account.ranks,base){
    let cachedLayouts=layoutScorers.get(payload);
    if(!cachedLayouts){cachedLayouts=new WeakMap();layoutScorers.set(payload,cachedLayouts);}
    const cached=cachedLayouts.get(boards);
    if(cached?.ranks===ranks)return cached.scorer;
    const {account,options}=payload;
    const previous=referenceContexts.get(payload);
    const prepared=base??(previous?.ranks===ranks?previous:undefined);
    const context=unit?unitScoreContext(scoringData,payload,boards,ranks,prepared):
      createReferenceScoreContext(scoringData,account.owned,boards,ranks,options,account.dreamRank,prepared);
    if(!prepared)referenceContexts.set(payload,context);
    const selection=payload.rangeCharts??options.lbCharts;
    let chartContexts;
    if(selection){
      let match=chartMatchers.get(selection);
      if(!match){
        const entries=payload.rangeCharts??selection.map(({songId,difficulty})=>{
          const song=songs.get(songId);
          const chart=song?.difficulties.find(chart=>chart.type===difficulty);
          if(!chart)throw Error('A rating chart is unavailable.');
          return {song,chart};
        });
        chartMatchers.set(selection,match=referenceChartMatcher(scoringData,entries));
      }
      chartContexts=match(context);
    }
    const metric=options.sortBy==='max'?'maxScore':'score';
    const targetCharts=payload.targetCharts;
    const indices=targetCharts??chartContexts?.map((_,index)=>index);
    const batch=chartContexts?.length?referenceChartBatch(chartContexts):null;
    const evaluate=(chart,order,outfit,leader,capture)=>
      evaluateReferenceTeam(chart,order,outfit,leader,false,null,capture,timelineMemo);
    const score=(order,outfit,leader)=>{
      if(unit){
        const row=evaluateUnitScore(context,order,outfit,leader);
        return {...row,value:row.displayUnitScore};
      }
      if(chartContexts?.length){
        const byChart=batch(indices,order,outfit,leader,undefined,timelineMemo);
        if(payload.rangeCharts){
          const row=averageChartRows(byChart,payload.rangeWeights);
          return {...row,value:row[metric],songBonuses:byChart.map(chart=>chart.breakdown.songBonus)};
        }
        const rows=byChart.filter(Boolean).sort((a,b)=>b[metric]-a[metric]);
        const value=rows.slice(0,3).reduce((total,row)=>total+Math.ceil(row[metric]/5000),0);
        return {...rows[0],value,tieScore:rows.slice(0,3).reduce((total,row)=>total+row[metric],0),
          songBonuses:byChart.map(row=>row.breakdown.songBonus),chartScores:byChart.map(row=>row[metric])};
      }
      const base=evaluate(context,order,outfit,leader);
      const row=options.challengeStage?screenChallengeScore(base,options.challengeStage,order):base;
      return {...row,value:row[metric]};
    };
    const timeline=(order,outfit,leader)=>{
      const result=[];
      const capture=(windows,base)=>result.push({...windows,base});
      if(batch)batch(indices,order,outfit,leader,capture,timelineMemo);
      else evaluate(context,order,outfit,leader,capture);
      return result;
    };
    const gpuTrial=(order,outfit,leader)=>{
      if(unit)return referenceUnitScoreInput(context,order,outfit,leader,true);
      if(chartContexts?.length)return {windows:timeline(order,outfit,leader)};
      const windows=[];
      const row=evaluate(context,order,outfit,leader,(skill,base)=>windows.push({...skill,base}));
      return {windows,eventBonus:options.challengeStage?challengeBonusPermil(options.challengeStage,order):row.breakdown.eventBonus,
        epPermil:row.epPermil};
    };
    const result={context,score,timeline,gpuTrial};
    cachedLayouts.set(boards,{ranks,scorer:result});
    return result;
  }

  async function rankObjective(payload,trials){
    objectiveTrials+=trials.length;
    return scoreObjectives(trials,{sortBy:payload.options.sortBy,merged:!!payload.options.lbCharts?.length,rangeWeights:payload.rangeWeights,unit});
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
    if(cpu){
      const ranked=eligible.map(({row,order,scoring})=>({...row,...scoring.score(order,row.outfitId,row.leaderChar)}));
      return ranked.sort((a,b)=>b.value-a.value||(b.tieScore??b.score)-(a.tieScore??a.score));
    }
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

  async function rankFundedTeams(payload,rows,contenders,explorePairs=false,pinnedCards=[]){
    const rotate=team=>team.map((_,i)=>[...team.slice(i),...team.slice(0,i)]);
    const arranged=rows.flatMap((row,index)=>{
      const team=row.order.map(id=>cards.get(id));
      if(team.some(card=>!card))return [];
      const context=scorer(payload,row.plan?.saves??row.boards??payload.account.boards,row.plan?.ranks);
      return rotate(team).map(order=>({index,row,order,context}));
    });
    if(!arranged.length)return {neighbors:[],best:null};
    const anchors=new Map();
    const finalists=new Map();
    const layouts=new Map();
    const composition=({context,row,order})=>{
      if(!layouts.has(context))layouts.set(context,layouts.size);
      return layouts.get(context)+'|'+row.outfitId+'|'+order.map(card=>card.id).sort().join('|');
    };
    let best;
    async function check(candidates,retainLayouts=false){
      if(!candidates.length)return;
      const scored=await rankObjective(payload,candidates.map(({row,order,context})=>
        context.gpuTrial(order,row.outfitId,row.leaderChar)));
      const ranked=scored?.map((rating,index)=>({rating,candidate:candidates[index]}))
        .sort((a,b)=>b.rating.value-a.rating.value||b.rating.tie-a.rating.tie);
      const shortlist=ranked?new Set(ranked.slice(0,16).map(({candidate})=>candidate)):candidates;
      if(explorePairs&&ranked){
        const compositions=new Set();
        for(const {candidate} of ranked){
          const key=composition(candidate);
          if(compositions.has(key))continue;
          compositions.add(key);
          shortlist.add(candidate);
          if(compositions.size===6)break;
        }
      }
      if(retainLayouts&&ranked){
        const seen=new Set();
        for(const {candidate} of ranked){
          if(seen.has(candidate.index))continue;
          seen.add(candidate.index);
          shortlist.add(candidate);
        }
      }
      for(const candidate of shortlist){
        const {row,order,context}=candidate;
        const after=context.score(order,row.outfitId,row.leaderChar);
        const scored={...candidate,after};
        if(!best||byValue(after,best.after)>0)best=scored;
        if(explorePairs){
          const key=composition(candidate),previous=finalists.get(key);
          if(!previous||byValue(after,previous.after)>0)finalists.set(key,scored);
        }
        const {index}=candidate;
        if(retainLayouts&&(!anchors.has(index)||byValue(after,anchors.get(index).after)>0))
          anchors.set(index,scored);
        if(after.outfitId!==rows[index].outfitId||after.order.some(id=>!rows[index].order.includes(id))){
          const key=after.outfitId+'|'+after.order.slice().sort().join('|');
          const previous=neighbors.get(key);
          if(!previous||byValue(after,previous.after)>0)neighbors.set(key,{index:candidate.index,after});
        }
      }
      return ranked;
    }
    const byValue=(a,b)=>a.value-b.value||(a.tieScore??a.score)-(b.tieScore??b.score);
    const neighbors=new Map();
    await check(arranged,true);
    const {options,account}=payload;
    const pool=data.cards.filter(card=>account.owned[card.id]?.owned&&isTeamCardEligible(card,options));
    const locked=new Set([...(options.focusCardIds??[]),...pinnedCards]);
    // Find cards that improve a funded layout even if they screened poorly
    // against the imported Boards. The Board assignments and cost stay fixed.
    const topLayouts=()=>[...anchors.values()].sort((a,b)=>byValue(b.after,a.after)).slice(0,3);
    // Recheck outfits and other complete lineups against retained layouts.
    const outfits=eligibleGpuOutfits(data,payload);
    const lineups=contenders.map(row=>({row,order:row.order.map(id=>cards.get(id))}));
    await check(topLayouts().flatMap(start=>[
      ...outfits.flatMap(([outfitId,{characterId}])=>
        outfitId===start.row.outfitId||options.leaderNoOverlap&&start.order.some(card=>card.characterId===characterId)?[]:
          [{...start,row:{...start.row,outfitId,leaderChar:characterId}}]),
      ...lineups.map(candidate=>({...start,...candidate})),
    ]),true);
    const bases=topLayouts();
    const swaps=bases.flatMap(starter=>starter.order.flatMap((card,slot)=>{
      if(locked.has(card.id))return [];
      const otherMembers=new Set(starter.order.filter((_,i)=>i!==slot).map(card=>card.characterId));
      return pool.filter(candidate=>candidate!==card&&!otherMembers.has(candidate.characterId)&&
        (!options.leaderNoOverlap||candidate.characterId!==starter.row.leaderChar)).map(candidate=>{
        const order=starter.order.slice();
        order[slot]=candidate;
        return {...starter,order,slot};
      });
    }));
    const rankedSwaps=await check(swaps);
    await check(arrangements([],best.order).map(order=>({...best,order})));
    if(explorePairs&&rankedSwaps?.length){
      // A pair can meet an outfit or support threshold that neither
      // replacement reaches alone. Score the full pair on the same Board.
      const replacements=new Map();
      for(const {candidate} of rankedSwaps){
        const {index,slot,order}=candidate;
        if(!replacements.has(index))replacements.set(index,Array.from({length:5},()=>[]));
        const choices=replacements.get(index)[slot],card=order[slot];
        if(choices.length<4||choices.length<7&&!choices.some(option=>option.attribute===card.attribute))
          choices.push(card);
      }
      const pairs=[];
      for(const base of bases){
        const choices=replacements.get(base.index);
        if(!choices)continue;
        for(let left=0;left<5;left++)for(let right=left+1;right<5;right++){
          for(const first of choices[left])for(const second of choices[right]){
            if(first.characterId===second.characterId)continue;
            const order=base.order.slice();
            order[left]=first;
            order[right]=second;
            pairs.push({...base,order});
          }
        }
      }
      const incumbent=best;
      await check(pairs);
      if(best!==incumbent)await check(arrangements([],best.order).map(order=>({...best,order})));
    }
    const winner={index:best.index,after:best.after};
    const lineup=best.after.order.slice().sort().join('|');
    const alternate=[...finalists.values()].filter(row=>row.context!==best.context&&row.after.outfitId===best.after.outfitId&&
      row.after.value>=best.after.value*.99&&row.after.order.slice().sort().join('|')===lineup)
      .sort((a,b)=>byValue(b.after,a.after))[0];
    return {best:winner,alternate:alternate&&{index:alternate.index,after:alternate.after},neighbors:[...neighbors.values()]
      .sort((a,b)=>byValue(b.after,a.after)).slice(0,12)};
  }

  const solveNext=(payload,findOwnedTeams)=>searchGpuNextUpgrades({
    data,payload,scorer,rank:cpu?null:rankObjective,plan,findOwnedTeams,refine:cpu?null:rankFundedTeams,
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
    if(payload.ratingScout){
      const started=performance.now();
      const {teams,examined:scoutExamined}=await shortlistGpuTeams(lineupKernels,data,payload,context,score,
        {limit:8,width:12,rounds:1,activeProjection:false});
      timings.screen+=performance.now()-started;
      examined+=scoutExamined;
      return {results:teams};
    }
    const boardScores=[];
    if(payload.boardOpt&&(payload.options.lbCharts?.length||objective!=='holomemLb')){
      // Build legal representative Board layouts before ranking lineups.
      // These estimates guide selection. Each finalist is planned again
      // after its exact training bill and remaining reset gold are known.
      const start=performance.now();
      const preliminary=await shortlistGpuTeams(lineupKernels,data,payload,context,score,{limit:8,width:12,rounds:0,activeProjection:false});
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
          boardScores.push(scorer(payload,projected.plan.saves,projected.plan.ranks).score);
        }
      }
      timings.projection+=performance.now()-start;
    }
    const start=performance.now();
    const result=await shortlistGpuTeams(lineupKernels,data,payload,context,score,{
      limit:Math.max(32,payload.options.topN*3),width:24,boardScores,rounds:boardScores.length?2:3,
    });
    timings.screen+=performance.now()-start;
    examined+=result.examined;
    if(boardScores.length){
      const candidates=new Map();
      const bestOutfits=new Map();
      for(const row of result.teams){
        const key=row.outfitId+'|'+row.order.slice().sort().join('|');
        const potential=Math.max(row.potential,row.activePotential??0);
        if(!candidates.has(key))candidates.set(key,{row,potential});
        const best=bestOutfits.get(row.outfitId);
        if(!best||potential>best.potential)bestOutfits.set(row.outfitId,{row,potential});
      }
      const ranked=[...candidates.values()].sort((a,b)=>b.potential-a.potential||b.row.value-a.row.value);
      return {results:[...new Set([...ranked.slice(0,3),...bestOutfits.values(),...ranked]
        .map(({row})=>row))].slice(0,Math.max(32,payload.options.topN*3))};
    }
    if(!cpu&&!payload.boardOpt&&!payload.reviewedFinals&&result.teams.length){
      const {best,neighbors}=await rankFundedTeams(payload,result.teams.slice(0,3),result.teams.slice(0,12),true);
      const key=row=>row.outfitId+'|'+row.order.slice().sort().join('|');
      const teams=new Map(result.teams.map(row=>[key(row),row]));
      for(const proposal of [best,...neighbors]){
        if(!proposal)continue;
        const row=proposal.after,id=key(row),previous=teams.get(id);
        if(!previous||row.value>previous.value||row.value===previous.value&&
          (row.tieScore??row.score)>(previous.tieScore??previous.score))teams.set(id,row);
      }
      return {results:[...teams.values()].sort((a,b)=>b.value-a.value||
        (b.tieScore??b.score)-(a.tieScore??a.score)).slice(0,result.teams.length)};
    }
    return {results:result.teams};
  }

  async function plan(payload){
    const start=performance.now();
    if(payload.boardOpt&&!unit&&!payload.options.pc&&payload.options.scoringMode==='generic'&&!payload.options.lbCharts?.length){
      const rangeCharts=boardRangeCharts(data,payload);
      if(rangeCharts.length)payload={...payload,rangeCharts,rangeWeights:rangeCharts.map(chart=>chart.weight)};
    }
    try{return await planBoards(payload);}
    finally{
      const phase=payload.boardOpt?.litePlan?'lite':payload.exchangeOnly?'exchangeOnly':payload.seedBoards?'seeded':'full';
      timings[phase]+=performance.now()-start;
    }
  }

  async function planBoards(payload){
    const {account,boardOpt,team,leaderChar}=payload;
    if(!boardOpt)return {plan:null};
    const maximumOnly=!unit&&payload.options.sortBy==='max';
    const deepen=!!payload.generalist&&!boardOpt.litePlan&&!!payload.seedBoards;
    const refineBranches=payload.seedBoards&&payload.refineBranches?.length?payload.refineBranches:null;
    let order=team.map(id=>cards.get(id));
    if(order.length!==5||!order.every(Boolean))return {plan:null};
    const ranks={...account.ranks},branches=new Set(boardOpt.branches);
    if(boardOpt.allInvited)for(const id of Object.keys(data.boards))ranks[id]??=1;
    if(boardOpt.maxBoardPoints)for(const id of Object.keys(ranks))ranks[id]=data.boardPointLadder.length-1;
    let saves=boardPlanningBaseline(account.boards,boardOpt);
    const originalBoards=saves;
    const canReset=owner=>boardProtection(boardOpt,owner)==='flexible';
    const pinnedSlot=(owner,socket)=>pinsBoardConnects(boardOpt,owner)&&Object.hasOwn(originalBoards[owner]?.cards??{},socket);
    const allCharts=payload.targetCharts?undefined:payload.options.lbCharts;
    const baseScorer=scorer(payload,saves,ranks).score;
    const eligibleOutfits=payload.options.leaderMode==='fixed'&&payload.outfitId?[payload.outfitId]:
      Object.keys(data.costumes).filter(id=>{
        const outfit=data.costumes[id];
        return outfit.characterId===leaderChar&&(outfit.isDefault||account.owned[outfit.cardId]?.owned||account.ownedCostumeIds?.includes(id));
      });
    const bestOutfit=(score,orders=[order])=>{
      let best;
      for(const id of eligibleOutfits)for(const lineup of orders){
        const row=score(lineup,id,leaderChar);
        if(!best||row.value>best.value||row.value===best.value&&(row.tieScore??row.score)>(best.tieScore??best.score))
          best=row;
      }
      return best;
    };
    let before=bestOutfit(baseScorer);
    const outfitId=before?.outfitId;
    if(!outfitId)return {plan:null};
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
    const bought={},refunded={},changes=new Map();
    const materials=Object.keys(data.boardItems);
    const owners=Object.keys(ranks).filter(id=>data.boards[id]&&boardProtection(boardOpt,id)!=='locked');
    const keep=boardOpt.keep?.targets??{};
    const charts=payload.rangeCharts?.map(({song})=>song)??(payload.options.lbCharts??[{songId:payload.options.songId}]).map(({songId})=>
      data.songs.find(song=>song.id===songId));
    const teamMembers=new Set(order.map(card=>card.characterId));
    const canDetachInactiveSocket=(node,owner,save)=>{
      if(!node?.socket||!node.pts||!deepen||teamMembers.has(owner))return false;
      if(pinnedSlot(owner,node.id))return false;
      const id=save.cards[node.id];
      if(!id)return true;
      const connect=data.connects[id];
      const unlocked=new Set(save.nodes);
      return !!connect&&!data.boards[owner].some(other=>unlocked.has(other.id)&&
        (protectedNode(other,keep)||priorityFor(other,owner)>0)&&
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
        const retained=new Set(saves[owner]?.nodes);
        for(const id of saved.nodes)if(!retained.has(id))for(const item of nodes.get(id)?.items??[])
          refunded[item.id]=(refunded[item.id]??0)+item.qty;
      }
    }
    let resetCount=0;
    const reclaimable=[];
    const staticPriorities=new WeakMap();
    let lastSongPriority,songHeadroom;
    let songPriorities=new WeakMap();
    function remainingSongBonuses(){
      if(lastSongPriority!==after){
        lastSongPriority=after;
        songPriorities=new WeakMap();
        const ceiling=data.boardLimits?.songBonus??Infinity;
        const threshold=deepen&&after.chartScores?[...after.chartScores].sort((a,b)=>b-a)[2]??0:0;
        songHeadroom=charts.map((_,index)=>{
          if(payload.targetCharts&&!payload.targetCharts.includes(index)||
            !payload.targetCharts&&threshold&&(after.chartScores[index]??0)*(1+ceiling/1000)<threshold)return 0;
          return Math.max(0,ceiling-(after.songBonuses?.[index]??after.breakdown?.songBonus??0));
        });
      }
      return songHeadroom;
    }
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
        reclaimable.push({owner,next,resets,removedItems});
      }
      const maxResets=boardOpt.maxResets;
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
    const pinnedCards=new Set(Object.entries(originalBoards).flatMap(([owner,board])=>
      pinsBoardConnects(boardOpt,owner)?Object.values(board.cards):[]));
    const connectRoster={...payload.options.boardConnectEntries,...account.owned};
    const rankedConnects=Object.keys(connectRoster).filter(id=>connectRoster[id].owned&&data.connects[id]&&
      (!boardOpt.preserveConnects||!pinnedCards.has(id)))
      .sort((a,b)=>connectValue(b)-connectValue(a));
    const connectPatternsById=new Map(rankedConnects.map(id=>[id,JSON.stringify([data.connects[id].extent,connectPermil(id)])]));
    function connectorEntry(id){
      return connectRoster[id];
    }
    function connectValue(id){
      const card=data.connects[id];
      return card.extent.length*connectPermil(id);
    }
    function connectPermil(id){
      const card=data.connects[id];
      const entry=connectorEntry(id);
      return card.levels[card.level2Bloom&&entry?.owned&&entry.bloom>=card.level2Bloom?1:0]?.permil??0;
    }
    function priorityFor(node,owner){
      if(!node.kind)return 0;
      if(maximumOnly&&node.kind==='activeChance')return 0;
      if(node.charTrigger==='SET_LIVE_LEADER'&&owner!==leaderChar)return 0;
      if(node.songTrigger&&!matchingCharts(node,owner).length)return 0;
      if(node.charTrigger==='WORK')return protectedNode(node,keep)?node.value:0;
      if(node.kind==='songBonus'){
        if(unit)return 0;
        const headroom=remainingSongBonuses();
        if(songPriorities.has(node))return songPriorities.get(node);
        const priority=matchingCharts(node,owner).reduce((gain,index)=>
          gain+(payload.rangeWeights?.[index]??1)*Math.max(0,Math.min(node.value,headroom[index])),0)*150;
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
    const timingBoosts=new WeakMap();
    const affectedPriority=(node,owner,save)=>{
      const priority=priorityFor(node,owner);
      if(!priority||node.kind!=='activeChance'&&node.kind!=='activeFreq')return priority;
      let boosts=timingBoosts.get(save);
      if(!boosts){
        boosts=new Map();
        for(const [id,cardId] of Object.entries(save.cards)){
          const socket=nodeMaps.get(owner).get(id);
          if(!socket||!data.connects[cardId]||!connectorEntry(cardId)?.owned)continue;
          const boost=1+connectPermil(cardId)/1000;
          for(const cell of socketFootprint(socket,cardId))boosts.set(cell,boost);
        }
        timingBoosts.set(save,boosts);
      }
      return priority*(boosts.get(position(node.x,node.y))??1);
    };
    const frontiers=new Map();
    const budgets=new Map(owners.map(owner=>[owner,boardPointsAtRank(data.boardPointLadder,ranks[owner])]));
    const emptyBoard={nodes:[],cards:{}};
    const originalNodes=new Map(owners.map(owner=>[owner,new Set(originalBoards[owner]?.nodes??[])]));
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
    const frontierScope=account.dreamRank+':'+[...branches].sort().join('|');
    const frontierFor=(owner,save)=>{
      if(frontiers.get(owner)?.save!==save){
        const cached=frontierCache.get(save);
        const frontier=cached?.owner===owner&&cached.scope===frontierScope?cached.frontier:
          boardFrontierPaths(data.boards[owner],save,account.dreamRank,branches,8);
        frontierCache.set(save,{owner,scope:frontierScope,frontier});
        frontiers.set(owner,{save,frontier});
      }
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
        const permil=connectPermil(cardId);
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
      const value=(socket,id,weights)=>id&&data.connects[id]&&connectorEntry(id)?.owned?
        socketFootprint(socket,id).reduce((sum,key)=>sum+(weights.get(key)??0),0)*connectPermil(id)/1000:0;
      const proposals=[];
      for(const socket of sockets){
        if(pinnedSlot(owner,socket.id))continue;
        const incumbent=board.cards[socket.id];
        if(incumbent&&(!data.connects[incumbent]||!connectorEntry(incumbent)?.owned))continue;
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
      const slots=[],reserved=new Set(pinnedCards);
      if(!rankedConnects.length)return false;
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
        const potentialCells=new Set(data.boards[owner].filter(node=>field.active.has(node.id)&&
          (priorityFor(node,owner)>0||!unit&&node.kind==='songBonus'&&matchingCharts(node,owner).length))
          .map(node=>position(node.x,node.y)));
        for(const socket of socketNodes.get(owner)){
          if(!socket.socket||!field.active.has(socket.id))continue;
          const incumbent=board.cards[socket.id];
          if(incumbent&&(pinnedSlot(owner,socket.id)||!data.connects[incumbent]||!connectorEntry(incumbent)?.owned)){
            reserved.add(incumbent);
            continue;
          }
          const estimate=rankedConnects.map(id=>{
            // Removing the incumbent can reopen a capped bonus, so the
            // current layout's remaining headroom cannot rule out a card.
            return socketFootprint(socket,id).some(key=>potentialCells.has(key));
          });
          if(incumbent||estimate.some(Boolean))
            slots.push({owner,socket:socket.id,board,incumbent,estimate,spent:field.spent});
        }
        for(const [id,card] of Object.entries(board.cards))if(!field.active.has(id))reserved.add(card);
      }
      if(!slots.length)return false;
      const scoreValue=row=>row.tieScore??row.value;
      const outfit=after.outfitId;
      // Exact marginal weight for each distinct footprint and Bloom tier.
      // Identical effects share a score, but each physical card keeps its
      // own column so no card can be placed in two sockets.
      const baseline=scorer(payload,saves,ranks).context;
      const weights=slots.map(({owner,socket,board,incumbent,estimate})=>{
        const cards={...board.cards};
        delete cards[socket];
        const without={...board,cards};
        const empty=scoreValue(scorer(payload,{...saves,[owner]:without},ranks,baseline).score(order,outfit,leaderChar));
        const socketNode=nodeMaps.get(owner).get(socket);
        const active=connectField(owner,board,after).weights;
        const gains=new Map();
        return rankedConnects.map((id,index)=>{
          if(reserved.has(id))return 0;
          if(!estimate[index]&&id!==incumbent)return 0;
          // Footprint cells outside the active layout cannot change the
          // marginal effect. Reuse the exact score for equivalent coverage.
          const key=connectPermil(id)+':'+socketFootprint(socketNode,id).filter(key=>active.has(key)).sort().join('|');
          if(!gains.has(key)){
            const next={...board,cards:{...board.cards,[socket]:id}};
            const value=scoreValue(scorer(payload,{...saves,[owner]:next},ranks,baseline).score(order,outfit,leaderChar));
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
      const orderAware=!!payload.seedBoards;
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
      const jointGain=changed.length&&evaluate(changed.map(index=>[index,moved[index]]));
      if(changed.length&&(!jointGain||!boardOpt.litePlan)){
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
        if(components.length>1){
          const joint=best;
          best={boards:saves,row:after};
          for(const {indices} of components)
            evaluate(indices.map(index=>[index,moved[index]]));
          if(compare(joint.row,best.row)>0)best=joint;
        }
      }
      if(orderAware){
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
            (!connectorEntry(id)?.owned&&previous.cards[socket]!==id))
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
      const yellow=color==='yellow',red=color==='red',green=color==='green';
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
        const targetedYellow=yellow&&(deepen||refineBranches&&payload.targetCharts);
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
            const weight=id&&data.connects[id]&&connectorEntry(id)?.owned?
              socketFootprint(node,id).reduce((sum,key)=>sum+(target.get(key)??0),0)*connectPermil(id)/1000:0;
            redWeights.set(node.id,weight);
          }
        }
        const canDetach=(node,save)=>!!node?.socket&&!pinnedSlot(owner,node.id)&&
          (canDetachInactiveSocket(node,owner,save)||red&&node.pts&&(!save.cards[node.id]||connectorEntry(save.cards[node.id])?.owned));
        const mustKeep=node=>node.branch&&!branches.has(node.branch)||protectedNode(node,keep)||
          boardOpt.maxResets===0&&originalNodes.get(owner).has(node.id);
        const variants=new Map();
        const sizes=red?[1,.5,1.75,3]:targetedYellow?
          (payload.seedBoards?[1,.5,1.75,6]:[1,.5,1.75]):green?[1,.5,1.75]:[1];
        for(const size of sizes)for(const [chance,frequency,parameters] of red?[[1,1,1],[1,1,2]]:yellow||green?[[1,1,1]]:[
          [1.6,.1,1],[1.8,.7,.6],[1,1.6,1],[1,0,1.6],[1,1,1],[.65,.65,2],[1.3,.5,2.4],
        ]){
          let next=full;
          const bias=node=>{
            if(green)return node.branch===color?size:1;
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
            const cuts=boardResetCuts(all,next,account.dreamRank);
            let bestCut;
            for(const id of next.nodes){
              const node=nodeMaps.get(owner).get(id);
              if(mustKeep(node)||
                Object.hasOwn(next.cards,id)&&!canDetach(node,next))continue;
              const removed=cuts?.get(id)??[];
              if(removed.some(other=>Object.hasOwn(next.cards,other)&&
                !canDetach(nodeMaps.get(owner).get(other),next)||mustKeep(nodeMaps.get(owner).get(other))))continue;
              const removedNodes=removed.map(other=>nodeMaps.get(owner).get(other));
              const points=removedNodes.reduce((sum,node)=>sum+node.pts,0);
              if(!points)continue;
              if(red&&hasProtectedTargets&&removedNodes.some(node=>next.cards[node.id])){
                const trimmed={...next,nodes:next.nodes.filter(other=>other!==id)};
                const kept=reachable(owner,trimmed);
                const cards=Object.fromEntries(Object.entries(next.cards).filter(([socket])=>kept.active.has(socket)));
                if(!preservesCoverage(owner,base,{...trimmed,cards},connected.active,kept.active))continue;
              }
              const loss=removedNodes.reduce((sum,node)=>sum+
                (canDetachInactiveSocket(node,owner,next)?0:value(node)),0);
              const perPoint=loss/Math.min(points,front.spent-budgets.get(owner));
              if(!bestCut||perPoint<bestCut.loss)bestCut={id,loss:perPoint};
            }
            if(!bestCut)break;
            const {active:kept}=reachable(owner,{...next,nodes:next.nodes.filter(id=>id!==bestCut.id)});
            next={nodes:next.nodes.filter(id=>kept.has(id)),
              cards:Object.fromEntries(Object.entries(next.cards).filter(([id])=>kept.has(id)))};
          }
        }
        const baseline=scorer(payload,saves,ranks).context;
        const contextFor=board=>scorer(payload,{...saves,[owner]:board},ranks,baseline);
        const value=row=>row.tieScore??row.value;
        async function scoreCuts(trials,orders){
          if(!trials.length)return;
          const contexts=trials.map(({board})=>contextFor(board));
          const ranked=cpu?null:await batchLayoutScores(contexts,orders);
          if(ranked)for(const {index,tie} of ranked)trials[index].score=tie;
          else for(const [index,context] of contexts.entries())trials[index].score=value(bestOutfit(context.score,orders));
        }
        if(red&&(refineBranches||payload.seedBoards&&deepen&&!payload.options.lbCharts?.length)){
          const starting=value(bestOutfit(contextFor(full).score));
          const visited=new Set(),faces=new Map();
          let beam=[{board:full,score:starting,spent:reachable(owner,full).spent}];
          const available=exactAvailable();
          const maxResets=boardOpt.maxResets<0?Infinity:boardOpt.maxResets-resetCount;
          for(let depth=0;beam.length&&depth<8;depth++){
            const next=[],trials=[];
            for(const {board,score,spent} of beam){
              const overflow=spent-budgets.get(owner);
              const cuts=boardResetCuts(all,board,account.dreamRank);
              for(const id of board.nodes){
                const node=nodeMaps.get(owner).get(id);
                if(mustKeep(node)||board.cards[id]&&!canDetach(node,board))continue;
                const removed=cuts?.get(id)??[];
                if(removed.some(other=>{
                  const node=nodeMaps.get(owner).get(other);
                  return mustKeep(node)||board.cards[other]&&!canDetach(node,board);
                }))continue;
                if(!removed.length)continue;
                const cut=new Set(removed);
                const trimmed={nodes:board.nodes.filter(other=>!cut.has(other)),
                  cards:Object.fromEntries(Object.entries(board.cards).filter(([socket])=>!cut.has(socket)))};
                const key=trimmed.nodes.slice().sort().join('|');
                if(visited.has(key))continue;
                visited.add(key);
                if(hasProtectedTargets&&!preservesCoverage(owner,base,trimmed,connected.active,reachable(owner,trimmed).active))continue;
                const points=spent-removed.reduce((sum,id)=>sum+nodeMaps.get(owner).get(id).pts,0);
                if(points>=spent)continue;
                const {resets,delta}=editTerms(owner,trimmed);
                if(resets>maxResets)continue;
                const short=boardOpt.infiniteMaterials?0:delta.reduce((sum,n,i)=>sum+Math.max(0,n-available[i]),0);
                trials.push({board:trimmed,key,spent:points,short,parent:score,cut:Math.min(Math.max(1,overflow),spent-points)});
              }
            }
            await scoreCuts(trials,[order]);
            for(const trial of trials){
              const {board,key,spent,score,short,parent,cut}=trial;
              if(spent<=budgets.get(owner)&&board.nodes.some(id=>!source.has(id)))faces.set(key,trial);
              if(spent>budgets.get(owner)||short&&faces.size<12)next.push({...trial,
                loss:(parent-score)/cut+short,weighted:score-13000*Math.max(0,spent-budgets.get(owner))-short*150});
            }
            const efficient=next.sort((a,b)=>a.loss-b.loss).slice(0,4);
            const absolute=next.sort((a,b)=>b.weighted-a.weighted).slice(0,4);
            beam=[...new Set([...efficient,...absolute])];
          }
          const ranked=[...faces];
          for(const [key,{board}] of new Set([...ranked.sort((a,b)=>b[1].score-a[1].score).slice(0,6),
            ...ranked.sort((a,b)=>b[1].score-a[1].score+(a[1].short-b[1].short)*150).slice(0,6)]))variants.set(key,board);
        }
        if(color==='blue'&&payload.seedBoards){
          // Trial cuts are scored against the actual chart timing. Keep
          // both the smallest score loss per reclaimed point and the best
          // absolute intermediate shape while trimming a complete branch.
          const fixed=new Set(base.nodes.filter(id=>{
            const node=nodeMaps.get(owner).get(id);
            return Object.hasOwn(base.cards,id)||protectedNode(node,keep)||
              node.branch&&(!branches.has(node.branch)||!['blue','green'].includes(node.branch));
          }));
          const orders=order===screenedOrder?[order]:[order,screenedOrder];
          const rank=board=>value(bestOutfit(contextFor(board).score,orders));
          let beams=[{board:full,score:rank(full),spent:reachable(owner,full).spent}];
          const visited=new Set();
          const finished=[];
          for(let depth=0;beams.length&&depth<14;depth++){
            const next=[];
            for(const {board,score,spent} of beams){
              const overflow=spent-budgets.get(owner);
              if(overflow<=0){
                finished.push({board,score});
                continue;
              }
              const cuts=boardResetCuts(all,board,account.dreamRank);
              for(const id of board.nodes){
                if(fixed.has(id))continue;
                const removed=cuts?.get(id)??[];
                if(!removed.length||removed.some(other=>fixed.has(other)))continue;
                const rejected=new Set(removed);
                const tested={...board,nodes:board.nodes.filter(other=>!rejected.has(other))};
                const key=tested.nodes.slice().sort().join('|');
                if(visited.has(key))continue;
                visited.add(key);
                const used=spent-removed.reduce((sum,other)=>sum+nodeMaps.get(owner).get(other).pts,0);
                if(used>=spent)continue;
                next.push({board:tested,spent:used,previous:score,cut:Math.min(overflow,spent-used)});
              }
            }
            await scoreCuts(next,orders);
            for(const trial of next){
              trial.loss=(trial.previous-trial.score)/trial.cut;
              trial.weighted=trial.score-500*Math.max(0,trial.spent-budgets.get(owner));
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
      const leaderRoutes=new Map();
      if(yellow)for(const layout of layouts){
        const leaderEdit=layout.edits.find(edit=>edit.owner===leaderChar);
        if(!leaderEdit)continue;
        const key=leaderEdit.board.nodes.slice().sort().join('|');
        if(!leaderRoutes.has(key))leaderRoutes.set(key,layout);
      }
      // A yellow route can be weak until its outer socket covers the new
      // nodes. Retain distinct leader routes before choosing their Connect.
      const forConnect=[...new Set([...ranked.slice(0,4),...leaderRoutes.values()])];
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
    async function batchLayoutScores(contexts,orders){
      const trials=contexts.flatMap(({gpuTrial})=>
        eligibleOutfits.flatMap(outfit=>orders.map(lineup=>gpuTrial(lineup,outfit,leaderChar))));
      const started=performance.now();
      const scores=await rankObjective(payload,trials);
      tradeTiming.timelineGpu+=performance.now()-started;
      if(!scores?.length)return null;
      const stride=eligibleOutfits.length*orders.length;
      const winners=[];
      for(let i=0;i<scores.length;i++){
        const index=Math.floor(i/stride),row=scores[i],best=winners[index];
        if(!best||row.value>best.value||row.value===best.value&&row.tie>best.tie)winners[index]={index,...row};
      }
      return winners.sort((a,b)=>b.value-a.value||b.tie-a.tie);
    }
    async function rankLayouts(layouts,orders=[order],limit=8){
      if(layouts.length<=limit)return layouts;
      const baseline=scorer(payload,saves,ranks).context;
      const contexts=layouts.map(({boards})=>scorer(payload,boards,ranks,baseline));
      if(cpu)return contexts.map(({score},index)=>({index,row:bestOutfit(score,orders)}))
        .sort((a,b)=>compare(b.row,a.row)).slice(0,limit).map(({index})=>layouts[index]);
      const rows=await batchLayoutScores(contexts,orders);
      return rows?rows.slice(0,limit).map(({index})=>layouts[index]):layouts;
    }
    async function mixFundedBoards(){
      if(!payload.donorLayouts?.length)return false;
      const stock=exactAvailable(),seen=new Set(),proposals=[];
      for(const layout of payload.donorLayouts)for(const owner of owners){
        const board=layout[owner],current=saves[owner]??emptyBoard;
        if(!board||!preservesBoard(boardOpt,owner,originalBoards[owner],board))continue;
        const key=owner+JSON.stringify([board.nodes.slice().sort(),board.cards]);
        if(seen.has(key)||key===owner+JSON.stringify([current.nodes.slice().sort(),current.cards]))continue;
        const reachable=boardReachability(data.boards[owner],board,account.dreamRank);
        if(!reachable||reachable.spent>budgets.get(owner)||board.nodes.some(id=>!reachable.active.has(id)))continue;
        seen.add(key);
        proposals.push({...editTerms(owner,board),relevant:teamMembers.has(owner)||owner===leaderChar});
      }
      const candidates=proposals.map(edit=>({edits:[edit],delta:edit.delta,resets:edit.resets}));
      for(const edit of proposals.filter(edit=>edit.relevant)){
        const donors=proposals.filter(other=>other.owner!==edit.owner&&edit.delta.some((qty,i)=>qty>stock[i]&&other.delta[i]<0));
        for(const other of donors.slice(0,16)){
          const delta=edit.delta.map((qty,i)=>qty+other.delta[i]);
          if(delta.every((qty,i)=>qty<=stock[i]))candidates.push({edits:[edit,other],delta,resets:edit.resets+other.resets});
        }
      }
      async function findLayouts(candidates){
        const allowed=await kernels.checkTrades(candidates.map(({delta,resets})=>[0,0,Math.max(0,resets),1,
          ...delta.map(n=>Math.max(0,n)),...delta.map(n=>Math.max(0,-n))]),
          [boardOpt.maxResets<0?0xffffffff:boardOpt.maxResets-resetCount,...stock],{unlimited:boardOpt.infiniteMaterials});
        return candidates.flatMap(({edits},index)=>allowed[index]?assemble(edits):[]);
      }
      function assemble(edits){
        const boards={...saves};
        const edited=new Set(edits.map(({owner})=>owner));
        const assigned=new Map();
        for(const [owner,board] of Object.entries(saves))if(!edited.has(owner)){
          for(const [socket,id] of Object.entries(board.cards))assigned.set(id,{owner,socket});
        }
        for(const {owner,board} of edits){
          const cards={...board.cards};
          for(const [socket,id] of Object.entries(cards)){
            const previous=assigned.get(id);
            if(previous){
              if(pinnedSlot(previous.owner,previous.socket)||!budgets.has(previous.owner)){delete cards[socket];continue;}
              const other={...boards[previous.owner].cards};
              delete other[previous.socket];
              boards[previous.owner]={...boards[previous.owner],cards:other};
            }
            assigned.set(id,{owner,socket});
          }
          boards[owner]={...board,cards};
        }
        return preservesBoardProtection(boardOpt,originalBoards,boards)?[{boards,edits}]:[];
      }
      const ranked=await rankLayouts(await findLayouts(candidates));
      const singles=ranked.filter(layout=>layout.edits.length===1).map(layout=>layout.edits[0]);
      const combinations=[];
      for(const [i,left] of singles.entries())for(const right of singles.slice(i+1)){
        if(left.owner===right.owner)continue;
        combinations.push({edits:[left,right],delta:left.delta.map((qty,i)=>qty+right.delta[i]),resets:left.resets+right.resets});
      }
      const pairs=await rankLayouts(await findLayouts(combinations));
      let best={boards:saves,row:after};
      for(const {boards} of [...ranked,...pairs]){
        const row=bestOutfit(scorer(payload,boards,ranks).score);
        if(compare(row,best.row)>0)best={boards,row};
      }
      if(best.boards===saves)return false;
      for(const [owner,board] of Object.entries(best.boards))if(board!==saves[owner])recordTrade(owner,board);
      if(!fitsInventory())throw Error('The combined Board plan exceeds the shared budget.');
      saves=best.boards;
      after=best.row;
      return true;
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
          const cuts=boardResetCuts(board,save,account.dreamRank);
          for(const id of save.nodes){
            const node=byId.get(id);
            if(!node?.pts||protectedNode(node,keep)||
              !canDetachInactiveSocket(node,owner,save)&&(!branches.has(node.branch)||Object.hasOwn(save.cards,id)))continue;
            const removed=cuts?.get(id)??[];
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
        if(!deepen)return entries.slice(0,7);
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
        const timingPaths=deepen?
          paths.filter(move=>move.path.some(node=>node.kind==='activeFreq')).slice(0,4):[];
        for(const move of new Set([...paths.slice(0,12),...timingPaths])){
          addCandidate({...move,owner:donor.owner,save:donor.next,spent:donor.spent,budget:donor.budget},
            [donor],move.priority);
        }
      }
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
        if(deepen&&frequency.length<12&&!frequencyTargets.has(key)&&
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
          (!deepen||frequency.length>=12))break;
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
      for(const {boards} of variants){
        const row=bestOutfit(scorer(payload,boards,ranks).score);
        if(compare(row,best?.row??after)>0)best={boards,row};
      }
      tradeTiming.scoring+=performance.now()-tick;
      if(!best)return false;
      const {boards,row}=best;
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
    }
    const buyStart=performance.now();
    if(await mixFundedBoards())await matchConnects();
    if(deepen&&payload.expandPaths){
      // A preview leaves some of the Board open. Try whole routes before
      // greedy buys fill it, and keep only funded, objective-improving edits.
      for(const branch of branches)if(await rebuildPaths(branch))await matchConnects();
    }
    const purchaseFields=new Map();
    const relevantCharts=new Map(owners.map(owner=>[owner,[...new Set(data.boards[owner]
      .filter(node=>node.kind==='songBonus').flatMap(node=>matchingCharts(node,owner)))]]));
    const moveWords=new WeakMap();
    const unaffordable=new WeakSet();
    let distinctConnects,connectKey;
    async function affordable(moves,stock){
      const pack=move=>[move.spent+move.points,move.budget,0,0,
        ...materials.map(id=>move.materials[id]??0),scoreBits(move.priority)];
      const limits={unlimited:boardOpt.infiniteMaterials};
      if(cpu)return kernels.checkBoards(moves.map(pack),stock,limits);
      const width=stock.length+3;
      const batch=new Uint32Array(moves.length*width);
      for(const [index,move] of moves.entries()){
        let row=moveWords.get(move);
        if(!row){row=Uint32Array.from(pack(move));moveWords.set(move,row);}
        batch.set(row,index*width);
      }
      return kernels.checkBoardBatch(batch,stock,limits);
    }
    for(let step=0;step<(refineBranches||payload.exchangeOnly?0:boardOpt.litePlan?18:payload.seedBoards?40:140);step++){
      const available=[0,0,...exactAvailable()];
      if(!distinctConnects){
        const assigned=new Set(Object.values(saves).flatMap(board=>Object.values(board.cards)));
        const patterns=new Set();
        distinctConnects=rankedConnects.filter(id=>{
          const key=connectPatternsById.get(id);
          if(assigned.has(id)||patterns.has(key))return false;
          patterns.add(key);return true;
        });
        connectKey=distinctConnects.join('|');
      }
      const headroom=remainingSongBonuses();
      const candidates=[];
      const collect=moves=>{
        for(const move of moves)if(!unaffordable.has(move))candidates.push(move);
      };
      for(const owner of owners){
        const save=saves[owner]??emptyBoard;
        const chartKey=unit?'':relevantCharts.get(owner).map(index=>headroom[index]).join('|');
        let field=purchaseFields.get(owner);
        if(field?.save!==save||field.chartKey!==chartKey){
          const frontier=frontierFor(owner,save);
          if(!frontier)continue;
          const budget=budgets.get(owner);
          const paths=[],sockets=[];
          const keepCoverage=protectedCoverage(owner,save,frontier.active);
          const socketPaths=new Map(frontier.sockets.map(socket=>[socket.id,emptyMove]));
          for(const move of frontier.paths){
            if(frontier.spent+move.points>budget)continue;
            const node=move.path.at(-1);
            if(Object.keys(move.materials).some(id=>!materialKnown.has(id)))continue;
            if(node.socket)socketPaths.set(node.id,move);
            if(!node.kind||node.charTrigger==='WORK'||!priorityFor(node,owner))continue;
            const priority=move.path.reduce((total,node)=>total+priorityFor(node,owner),0)/(1+move.points);
            if(!priority)continue;
            paths.push({...move,owner,save,budget,spent:frontier.spent,priority});
          }
          const affected=new Map(data.boards[owner].filter(node=>frontier.active.has(node.id))
            .map(node=>[node.x+','+node.y,priorityFor(node,owner)]));
          for(const socket of socketNodes.get(owner)){
            if(pinnedSlot(owner,socket.id)||!socketPaths.has(socket.id)&&!frontier.active.has(socket.id))continue;
            const path=socketPaths.get(socket.id)??emptyMove;
            const active=keepCoverage.size&&!frontier.active.has(socket.id)?
              new Set([...frontier.active,socket.id]):frontier.active;
            const newNodes=new Map(path.path.map(node=>[node.x+','+node.y,priorityFor(node,owner)]));
            const boost=id=>id&&data.connects[id]&&connectorEntry(id)?.owned?socketFootprint(socket,id).reduce((sum,key)=>
              sum+(newNodes.get(key)??affected.get(key)??0),0)*connectPermil(id)/1000:0;
            const current=boost(save.cards[socket.id]),priorities=new Map(),offers=new Map();
            sockets.push({offer(cardId){
              if(offers.has(cardId))return offers.get(cardId);
              const pattern=connectPatternsById.get(cardId);
              if(!priorities.has(pattern))priorities.set(pattern,(boost(cardId)-current)/(1+path.points));
              const priority=priorities.get(pattern);
              let move;
              if(priority>0){
                const legal=!keepCoverage.size||preservesCoverage(owner,save,
                  {...save,cards:{...save.cards,[socket.id]:cardId}},frontier.active,active);
                if(legal)move={...path,owner,save,budget,spent:frontier.spent,socket:socket.id,cardId,priority};
              }
              offers.set(cardId,move);
              return move;
            }});
          }
          field={save,chartKey,paths,sockets,socketsOnBoard:new Set(Object.values(save.cards))};
          purchaseFields.set(owner,field);
        }
        collect(field.paths);
        if(field.connectKey!==connectKey){
          field.connectKey=connectKey;
          field.connectMoves=[];
          for(const {offer} of field.sockets){
            const moves=[];
            for(const cardId of distinctConnects){
              if(field.socketsOnBoard.has(cardId))continue;
              const move=offer(cardId);
              if(move)moves.push(move);
            }
            field.connectMoves.push(...moves.sort((a,b)=>b.priority-a.priority).slice(0,3));
          }
        }
        collect(field.connectMoves);
      }
      boardMoves+=candidates.length;
      const legal=await affordable(candidates,available);
      const allowed=[],perOwner=new Map();
      const paths=[],sockets=[],parameters=[],skill=[],timing=[];
      const comparePriority=(a,b)=>b.key-a.key||a.index-b.index;
      function keep(pool,entry,limit){
        if(pool.length===limit&&comparePriority(pool.at(-1),entry)<=0)return;
        const at=pool.findIndex(row=>comparePriority(row,entry)>0);
        if(at<0)pool.push(entry);
        else pool.splice(at,0,entry);
        if(pool.length>limit)pool.pop();
      }
      for(let index=0;index<candidates.length;index++){
        const key=legal[index];
        const move=candidates[index];
        // Each buy can only reduce stock. Moves on an edited Board get a
        // new frontier, while unchanged moves keep their Board Point cost.
        if(!key){unaffordable.add(move);continue;}
        const entry={move,key,index};
        allowed.push(entry);
        keep(move.socket?sockets:paths,entry,move.socket?8:10);
        if(move.path.some(node=>node.kind==='param'&&node.targetType==='ALL'))keep(parameters,entry,8);
        const frequency=move.path.some(node=>node.kind==='activeFreq');
        if(frequency||move.path.some(node=>node.kind==='activeChance'))keep(skill,entry,8);
        if(frequency&&deepen)keep(timing,entry,6);
        if((perOwner.get(move.owner)?.key??0)<key)perOwner.set(move.owner,entry);
      }
      const diverse=[...perOwner.values()].sort(comparePriority).slice(0,12);
      const selected=[...new Set([...paths,...sockets,...parameters,...skill,...timing,...diverse])];
      let best,neutral;
      function moveLayout(move){
        const nodes=move.path.filter(node=>node.pts>0).map(node=>node.id);
        const next={nodes:[...move.save.nodes,...nodes],cards:move.socket?
          {...move.save.cards,[move.socket]:move.cardId}:move.save.cards};
        const boards={...saves,[move.owner]:next};
        return {move,nodes,boards};
      }
      function evaluateMove({move,nodes,boards},scoring=scorer(payload,boards,ranks)){
        const row=bestOutfit(scoring.score);
        const reference=best?.row??after;
        const tie=row.tieScore??row.score,referenceTie=reference.tieScore??reference.score;
        const improvement=row.value-after.value,current=best?.improvement??0;
        if(improvement>current||improvement===current&&tie>referenceTie)
          best={move,nodes,boards,row,improvement};
        else if(!neutral&&nodes.length&&row.value===after.value&&tie===(after.tieScore??after.score))
          neutral={move,nodes,boards,row};
      }
      async function evaluateMoves(moves){
        const layouts=moves.map(moveLayout);
        if(cpu||layouts.length<=8){for(const layout of layouts)evaluateMove(layout);return;}
        const baseline=scorer(payload,saves,ranks).context;
        const contexts=layouts.map(({boards})=>scorer(payload,boards,ranks,baseline));
        const ranked=await batchLayoutScores(contexts,[order]);
        if(!ranked){layouts.forEach((layout,index)=>evaluateMove(layout,contexts[index]));return;}
        const near=(a,b)=>Math.abs(a-b)<=Math.max(8,Math.abs(b)*.00005);
        const top=ranked[0],keep=new Set(ranked.slice(0,6).map(row=>row.index));
        for(const row of ranked)if(near(row.tie,top.tie)&&row.value>=top.value-3||
          near(row.tie,after.tieScore??after.value))keep.add(row.index);
        for(const index of [...keep].sort((a,b)=>a-b))evaluateMove(layouts[index],contexts[index]);
      }
      await evaluateMoves(selected.map(({move})=>move));
      if(!best&&!boardOpt.litePlan){
        // A shallow ranking can be saturated by branches that have hit
        // chart or skill caps. Refine unused legal paths before stopping.
        const tested=new Set(selected);
        const refine=allowed.sort(comparePriority).filter(entry=>!tested.has(entry)&&!entry.move.socket);
        await evaluateMoves(refine.slice(0,36).map(({move})=>move));
      }
      if(!best&&!boardOpt.litePlan){
        // Active Frequency changes a discrete cooldown schedule. A pair
        // can cross a timing threshold even when neither single move does.
        const frequency=allowed.filter(({move})=>!move.socket&&move.path.some(node=>node.kind==='activeFreq')).slice(0,10);
        const compound=[];
        for(const {move:first} of frequency){
          const purchased=new Set(first.path.filter(node=>node.pts).map(node=>node.id));
          const board={...first.save,nodes:[...first.save.nodes,...purchased]};
          const frontier=frontierFor(first.owner,board);
          if(!frontier)continue;
          for(const second of frontier.paths){
            if(!second.path.some(node=>node.kind==='activeFreq'&&priorityFor(node,first.owner)>0)||
              first.spent+first.points+second.points>first.budget)continue;
            const costs={...first.materials};
            for(const [id,quantity] of Object.entries(second.materials))costs[id]=(costs[id]??0)+quantity;
            if(Object.keys(costs).some(id=>!materialKnown.has(id)))continue;
            compound.push({...first,path:[...first.path,...second.path],points:first.points+second.points,materials:costs});
          }
        }
        const legalPairs=await affordable(compound,available);
        await evaluateMoves(compound.filter((_,index)=>legalPairs[index]));
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
        distinctConnects=undefined;
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
      for(let step=0;step<(refineBranches||payload.exchangeOnly?0:payload.seedBoards?8:12);step++){
        if(!await rebalance())break;
        traded=true;
      }
      if(traded)await matchConnects();
      if(deepen&&!payload.expandPaths){
        if(await rebuildPaths('red'))await matchConnects();
        if((after.breakdown.songBonus??0)<(data.boardLimits?.songBonus??Infinity)&&await rebuildPaths('yellow'))
          await matchConnects();
        if(payload.qualityRefine&&await rebuildPaths('green'))await matchConnects();
        const refined=bestOutfit(scorer(payload,saves,ranks).score);
        if(compare(refined,after)>0)after=refined;
      }
      if(!refineBranches&&payload.seedBoards&&deepen){
        if(!payload.exchangeOnly&&!payload.expandPaths){
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
        const includeSong=payload.exchangeOnly||deepen&&!payload.options.lbCharts?.length?
          (node,owner)=>matchingCharts(node,owner).some(index=>
            (!payload.targetCharts||payload.targetCharts.includes(index))&&
            (after.songBonuses?.[index]??after.breakdown.songBonus)<(data.boardLimits?.songBonus??Infinity)):undefined;
        const exchange=await refineBoardExchanges({boards:saves,owners,topology:data.boards,
          allowed:branches,dreamRank:account.dreamRank,budgets,order,leader:leaderChar,
          materials,stock:exactAvailable(),maxResets:boardOpt.maxResets,resetCount,original:originalNodes,
          protectedNode:node=>protectedNode(node,keep),canReset,rankLayouts:(rows,_,limit)=>rankLayouts(rows,orders,limit),
          checkTrades:kernels.checkTrades,
          explore:payload.qualityRefine,
          includeSong,rematchSockets:!!includeSong&&!hasProtectedTargets,pinnedSlot,
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
    if(!boardOpt.ignoreExisting){
      let retained;
      saves=restoreUnusedConnects(data,account,saves,(candidate,owner,previous)=>{
        if(!preservesCoverage(owner,previous[owner],candidate[owner],connectField(owner,previous[owner],after).active))return false;
        retained??=bestOutfit(scorer(finalPayload,previous,ranks).score);
        const row=bestOutfit(scorer(finalPayload,candidate,ranks).score);
        if(compare(row,retained)<0)return false;
        retained=row;
        return true;
      });
    }
    if(boardOpt.litePlan){
      for(let left=0;left<order.length;left++)for(let right=left+1;right<order.length;right++){
        const alternative=order.slice();
        [alternative[left],alternative[right]]=[alternative[right],alternative[left]];
        rotations.push(alternative);
      }
      after=bestOutfit(scorer(payload,saves,ranks).score,rotations);
    }else{
      after=bestOutfit(scorer(finalPayload,saves,ranks).score,arrangements([],order));
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
          return evaluateReferenceTeam(context,rewardOrder,row.outfitId,leaderChar,false,null,undefined,timelineMemo)[estimate];
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
    if(!fitsInventory()||!preservesBoardProtection(boardOpt,originalBoards,saves))
      throw Error('The Board plan violates a protection or shared inventory limit.');
    if(after.outfitId!==outfitId)before=baseScorer(screenedOrder,after.outfitId,leaderChar);
    return {plan:{changes:[...changes.values()],bought,refunded,resetCount,saves,ranks,orderExhaustive:!boardOpt.litePlan,
      ...(rewardGains?{rewardGains}:{}),
      ignoredExisting:boardOpt.ignoreExisting,before,after,leaderChar,outfitId:after.outfitId}};
  }

    return {solve,solveNext,plan,rankResults,rankFundedTeams,
    close:kernels.close,metrics:()=>({examined,boardMoves,
    tradeTiming,
    timings,kernelTiming:kernels.timings,timelineCache:{skillHits,skillMisses},objectiveTrials})};
}
