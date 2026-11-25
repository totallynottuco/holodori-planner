import {buildOptimizerWorkspace} from './optimizer-workspace-data';
import {collectBoardFinalists,hasBoardBonusTargets,loadReferenceData,measuredMemoryEffect,mergeReferenceResults,prepareReferenceSearch,referenceEventPointBase,referenceEventPoints,runReferenceJob,unresolvedBoardEntries} from './reference-team-solver';
import {optimizeReferenceBoards} from './reference-board-search';
import {forecastRating,referenceRatingCandidates,searchReferenceRating,shortlistRatingLeaders} from './reference-holomem-rating';
import {createReferenceScoreContext,evaluateReferenceTeam,referenceMobileEffectWarnings,referencePowerUpBonus,referenceRangeCharts,referenceTeamScoreBonus,referenceUnitScore,updateReferenceCardEntry,withReferenceChart} from './reference-rating-math';
import {compareUnitScore,evaluateUnitScore,finalizeUnitScoreOrders,searchUnitScore,unitScoreContext} from './unit-score-search';
import {boardPointsAtRank,boardReachability,improveUnitScoreBoards} from './unit-score-board-search';
import {optimizerPack,verifyOptimizerPack} from './optimizer-catalog-data';
import {applyEventSongBonus,automaticChapter,normalizeOptimizerEvents,overlayGameOptimizerEvents,referenceEventCardBonuses,referenceEventSongBonus} from './optimizer-events';
import {MobileCoverageError,searchReviewedMobile} from './reviewed-mobile-search';
import {finalistOrders,finalistSetups} from './finalist-orders';
import {createFinalistContext,mobileTeam,nextCardEntry,nextPulls} from './finalist-context';
import {mobileChartEvaluator,mobileRangeChartPreview} from './mobile-chart-average';
import {loadChallengeStages} from './challenge-stages';
import {challengeBonusPermil,challengeUnitBonus} from './challenge-score';
import {challengeChartChoices,searchChallengeSong} from './challenge-search';
import {mergeOptimizerReference,overlayGameOptimizerCards} from './game-optimizer-cards';
import {hasGpuBoardBonusTargets} from './gpu-board-bonus-targets';
import {decodeChartGeometry} from './optimizer-chart-hit-events.js';
import {boardPlanningBaseline,hasBoardProtection} from './board-protection';
import {finalLineupBoardPlan} from './final-lineup-board-plan';
import {retainReferenceConnects} from './board-connect-retention';
import {eligibleTeamOutfits,isTeamCardEligible,teamRarityFilter} from './team-card-pool';

let source=null;
let lastReview=null;
let lastPreview=null;
let previewSession=null;
let lastReferenceRating=null;
const gpuSearches=new WeakMap();
const cpuBoardPlanners=new WeakMap();
function cpuPlanner(data,objective){
  let planners=cpuBoardPlanners.get(data);
  if(!planners){planners=new Map();cpuBoardPlanners.set(data,planners);}
  if(!planners.has(objective))planners.set(objective,import('./gpu-team-optimizer').then(module=>module.createCpuBoardPlanner(data,objective)));
  return planners.get(objective);
}
async function runCpuJob(data,operation,payload,onProgress){
  const {account,boardOpt,options}=payload;
  const filtered=operation==='_hd_solve'&&options.goal==='next'&&
    (payload.extras.nextAcquisition||teamRarityFilter(options)||options.boardConnectEntries);
  const locked=new Set(options.goal==='next'?payload.extras?.nextDeck:options.focusCardIds);
  const lockedOwners=new Set(data.cards.filter(card=>locked.has(card.id)).map(card=>card.characterId));
  const expanded=data.cards.filter(card=>isTeamCardEligible(card,options)&&
    (locked.has(card.id)||locked.size<5&&!lockedOwners.has(card.characterId))&&
    (options.goal==='next'||options.cardPool==='allMaxed'||account.owned[card.id]?.owned)&&
    (card.active.levels.some(level=>level.upScoreUp>0&&!level.scoreUp)||card.special.levels.some(level=>level.upScoreUp>0)||
      card.passive.levels.some(level=>level.additionalEffects?.length||level.stat==='activeChance')));
  const ownedCards=data.cards.filter(card=>account.owned[card.id]?.owned&&isTeamCardEligible(card,options));
  const mobileRangePlan=boardOpt&&options.scoringMode==='generic'&&!options.pc&&boardOpt.objective!=='unitScore';
  if(!expanded.length&&!filtered&&!hasBoardProtection(boardOpt)&&!mobileRangePlan){
    const response=await runReferenceJob(data,operation,payload,onProgress);
    return retainReferenceConnects(data,payload,response);
  }
  const objective=boardOpt?.objective??payload.extras?.objective;
  const planner=await cpuPlanner(data,objective);
  if(operation==='_hd_plan')return planner.plan(payload);
  // The native search proposes lineups. Give each card with an extended skill
  // a focused search, then score the resulting orders with all of its branches.
  async function lineupJob(query,progress){
    const focus=query.options.focusCardIds??[];
    const topN=Math.max(24,query.options.topN);
    const options={...query.options,topN};
    const baseline={...query,boardOpt:null,limits:{...query.limits,jointBoards:false},
      account:{...query.account,boards:boardPlanningBaseline(query.account.boards,query.boardOpt)}};
    const searches=[options];
    const members=new Set(data.cards.filter(card=>focus.includes(card.id)).map(card=>card.characterId));
    const poolSize=options.cardPool==='allMaxed'?data.cards.length:Object.values(query.account.owned).filter(entry=>entry.owned).length;
    if(focus.length<5&&poolSize>5)for(const card of expanded){
      if(members.has(card.characterId)||!(query.account.owned[card.id]?.owned||options.cardPool==='allMaxed'))continue;
      searches.push({...options,goal:'holomem',focusCardIds:[...focus,card.id]});
    }
    const candidates=new Map();
    for(const options of searches){
      const response=await runReferenceJob(data,'_hd_solve',{...baseline,options},progress);
      for(const row of response.results??[])candidates.set(JSON.stringify([row.outfitId,row.leaderChar,row.order]),row);
    }
    const rows=[...candidates.values()];
    if(!expanded.length)return {results:rows};
    const ranked=await planner.rankResults(baseline,rows);
    // Preserve the native lineup response shape for score searches.
    return {results:ranked.map(({value,...row})=>row)};
  }
  if(operation==='_hd_solve'&&options.goal!=='next')return lineupJob(payload,onProgress);
  if(operation==='_hd_solve'){
    const next=options.powerUpOverride==null?{...payload,options:{...options,
      powerUpOverride:referencePowerUpBonus(account.owned,data,options.cardPool)}}:payload;
    const result=await planner.solveNext(next,async query=>(await lineupJob(query,onProgress)).results??[]);
    if(filtered||mobileRangePlan||hasBoardProtection(boardOpt))return result;
    // Preserve the native upgrade and roster assumptions for ordinary lineups.
    // Its proposal score is incomplete for cards with an extended skill.
    const native=await runReferenceJob(data,operation,payload,onProgress);
    const affected=new Set(expanded.map(card=>card.id));
    const usesExtended=row=>row.order.some(id=>affected.has(id));
    const ordinary=native.results.filter(row=>!usesExtended(row));
    const extended=result.results.filter(usesExtended).map(({value,...row})=>row);
    if(!extended.length&&ordinary.length===native.results.length)return native;
    return {...native,...mergeReferenceResults([{results:ordinary},{results:extended}],{...options,topN:Math.max(options.topN,native.results.length)}),
      baseline:ownedCards.some(card=>affected.has(card.id))?result.baseline:native.baseline};
  }
  throw Error('Unsupported protected Board search operation.');
}
let shardGpuSearch,shardGpuData;
const sourceKey=selected=>[selected?.id,selected?.mobile?.id,selected?.gameCatalog?.id];
function referenceRatingKey(payload,input){
  return JSON.stringify([sourceKey(source),payload,input.leaderCharacterId,input.ratingSongIds,input.ratingAllSongs,
    input.ratingMaxDifficulty,input.ratingMerge,input.ratingSongCount,input.ratingTeamsPerSong]);
}
const pack=()=>optimizerPack(source).catch(()=>null);
let gameDataKey,gameDataRequest,nextGameSongRelease=Infinity;
const websiteData=new WeakMap();
const pcData=new WeakMap();
function withPcCharts(data){
  if(!pcData.has(data)){
    const songs=data.songs.flatMap(song=>{
      if(!song.difficulties.some(chart=>chart.gameOnly||chart.pcCoefficient!=null))return [song];
      const difficulties=song.difficulties.filter(chart=>!chart.gameOnly||chart.pcCurve).map(chart=>({
        ...chart,coefficient:chart.pcCoefficient??chart.coefficient,...(chart.gameOnly?{curve:chart.pcCurve}:{})}));
      return difficulties.length?[{...song,difficulties}]:[];
    });
    pcData.set(data,{...data,songs});
  }
  return pcData.get(data);
}
function withoutGameOnlyCharts(data){
  if(!websiteData.has(data)){
    const available=data.songs.flatMap(song=>{
      const difficulties=song.difficulties.filter(chart=>!chart.gameOnly);
      return difficulties.length===song.difficulties.length?[song]:difficulties.length?[{...song,difficulties}]:[];
    });
    websiteData.set(data,available.length===data.songs.length&&available.every((song,index)=>song===data.songs[index])?
      data:{...data,songs:available});
  }
  return websiteData.get(data);
}
const selectedChart=(data,options)=>data.songs.find(song=>song.id===options.songId)?.difficulties
  .find(chart=>chart.type===options.difficulty&&chart.seconds>0);
const gameChartCoverageError='Verified Mobile scoring is unavailable for this chart with the selected setup.';
function activeData(){
  const selected=source;
  const key=JSON.stringify(sourceKey(selected));
  const now=Date.now();
  if(gameDataKey!==key||now>=nextGameSongRelease){
    gameDataKey=key;
    nextGameSongRelease=Infinity;
    selectionKey=undefined;
    gameDataRequest=(async()=>{
      const [cached,bundled]=await Promise.all([optimizerPack(selected).catch(()=>null),loadReferenceData()]);
      const base=mergeOptimizerReference(bundled,cached?.data);
      const [{loadOptimizerResources},{overlayGameOptimizerSongs,nextGameOptimizerSongRelease}]=await Promise.all([
        import('./team-optimizer-resources'),import('./game-optimizer-songs'),
      ]);
      const resources=await loadOptimizerResources(selected?.mobile);
      if(gameDataKey===key)nextGameSongRelease=nextGameOptimizerSongRelease(resources,now);
      const data=overlayGameOptimizerCards(base,resources,selected?.gameCatalog);
      return overlayGameOptimizerSongs(data,resources,now);
    })().catch(error=>{if(gameDataKey===key)gameDataKey=undefined;throw error;});
  }
  return gameDataRequest;
}
let eventsRequest;
let songUnlocksRequest;
async function loadSongUnlocks() {
  const updated=await pack();
  songUnlocksRequest??=fetch('/assets/team-optimizer/song-unlocks.json').then(response=>{
    if(!response.ok)throw Error('Unable to load song unlock rules.');
    return response.json();
  }).catch(error=>{songUnlocksRequest=undefined;throw error;});
  return {...await songUnlocksRequest,...updated?.unlocks};
}
async function loadEvents() {
  const updated=await pack();
  eventsRequest??=fetch('/assets/team-optimizer/optimizer-events.json').then(response=>{
    if(!response.ok)throw Error('Unable to load optimizer events.');
    return response.json();
  }).then(value=>value.events);
  const bundled=await eventsRequest;
  const base=normalizeOptimizerEvents([...(updated?.events.events??[]),...bundled]);
  const {loadOptimizerResources}=await import('./team-optimizer-resources');
  return overlayGameOptimizerEvents(base,await loadOptimizerResources(source?.mobile));
}
let selectionKey,selectionData;
async function dataFor({eventId,eventChapter,eventPoints,memoryEffect,websiteSongsOnly,pcGameCharts}) {
  const active=await activeData();
  const data=websiteSongsOnly?withoutGameOnlyCharts(active):pcGameCharts?withPcCharts(active):active;
  if(!eventId&&memoryEffect===undefined)return data;
  const key=JSON.stringify([sourceKey(source),eventId,eventChapter,eventPoints,memoryEffect,websiteSongsOnly,pcGameCharts]);
  if(selectionKey===key)return selectionData;
  const selected={...data};
  if(memoryEffect!==undefined)selected.memoryEffects=[[0,memoryEffect]];
  if(eventId){
    const event=(await loadEvents()).find(row=>row.id===eventId);
    if(!event)throw Error('This event is unavailable in the captured catalog.');
    if(event.metadataOnly)throw Error('This event’s scoring rules are not available yet.');
    const chapters=event.epBonus?.chapters??[];
    const chapter=eventChapter==null?automaticChapter(chapters,Date.now()):chapters.find(row=>row.number===eventChapter);
    if(eventPoints&&!chapter)throw Error('Event point rules are unavailable for this event.');
    selected.eventBonus={event_id:event.id,name:event.name,songs:event.songs};
    if(eventPoints)selected.epBonus={members:chapter.members,holomems:chapter.holomems,blooms:chapter.blooms};
  }
  selectionData=selected;
  selectionKey=key;
  return selected;
}
function notify(type,value) { self.postMessage({type,...value}); }
function logicalShardCount() {
  const cores=Math.min(16,Math.max(1,(navigator.hardwareConcurrency||4)-1));
  const memory=navigator.deviceMemory;
  return memory===undefined?Math.min(8,cores):memory<=2?1:memory<=4?Math.min(2,cores):cores;
}
function sendJob(port,job,onProgress) {
  return new Promise((resolve,reject)=>{
    port.onmessage=({data})=>{
      if(data.type==='shard-progress'){onProgress(data.fraction,data.phase);return;}
      if(data.type==='shard-result')resolve(data.response);
      if(data.type==='error'||data.type==='worker-error'){
        const error=Error(data.message);
        if(data.code==='gpu')error.name='OptimizerGpuError';
        reject(error);
      }
    };
    port.onmessageerror=()=>reject(Error('A solver worker returned an unreadable response. Try again.'));
    port.postMessage({...job,source});
  });
}
async function runJobs(jobs,selection,onProgress,ports,completionOrder=false) {
  const gpuSearch=gpuSearches.get(selection);
  if(gpuSearch){
    if(gpuSearch.shared){
      let done=0;
      return Promise.all(jobs.map(async({operation,payload})=>{
        const response=await (operation==='_hd_solve'?gpuSearch.solve(payload):gpuSearch.plan(payload));
        onProgress(++done,jobs.length,done/jobs.length);
        return response;
      }));
    }
    const results=new Array(jobs.length);
    const lanes=jobs.every(job=>job.operation==='_hd_plan')?ports.slice(0,Math.max(0,jobs.length-1)):[];
    let next=0,done=0;
    async function runLane(port){
      while(next<jobs.length){
        const index=next++;
        const job=jobs[index];
        if(job.operation==='_hd_solve')results[index]=await gpuSearch.solve(job.payload);
        else if(job.operation==='_hd_plan')
          results[index]=port?await sendJob(port,{type:'gpu-board-shard',selection,...job},()=>{}):await gpuSearch.plan(job.payload);
        else throw Error('This optimizer operation has no GPU implementation.');
        onProgress(++done,jobs.length,done/jobs.length);
      }
    }
    await Promise.all([runLane(),...lanes.map(port=>runLane(port))]);
    return results;
  }
  const count=jobs.length,responses=new Array(count),fractions=new Array(count).fill(0);
  const completedResponses=[];
  let next=0,completed=0;
  const data=ports.length?null:await dataFor(selection);
  await Promise.all((ports.length?ports:[null]).map(async port=>{
      while(next<count){
        const index=next++;
        const progress=(fraction,phase)=>{
          fractions[index]=Math.max(fractions[index],Math.min(1,fraction||0));
          onProgress(completed,count,fractions.reduce((sum,value)=>sum+value,0)/count,phase);
        };
        const job=jobs[index];
        responses[index]=port?await sendJob(port,{type:'shard',selection,...job},progress):
          await runCpuJob(data,job.operation,job.payload,(phase,fraction)=>progress(fraction,phase));
        if(completionOrder)completedResponses.push(responses[index]);
        completed++;
        fractions[index]=1;
        onProgress(completed,count,fractions.reduce((sum,value)=>sum+value,0)/count);
      }
  }));
  return completionOrder?completedResponses:responses;
}

async function eachLeader(rows,concurrency,run){
  let next=0,failed=false;
  const lanes=Array.from({length:Math.min(concurrency,rows.length)},async()=>{
    try{
      while(!failed&&next<rows.length){
        const index=next++;
        await run(rows[index],index);
      }
    }catch(error){failed=true;throw error;}
  });
  const failure=(await Promise.allSettled(lanes)).find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
}
function solveShards(payload,selection,onProgress,ports) {
  // Extended-skill upgrades are ranked together against one shared baseline.
  const single=payload.options.goal==='next'||payload.options.cardPool==='owned'&&Object.values(payload.account.owned).filter(entry=>entry.owned).length<=5;
  const count=gpuSearches.has(selection)||single?1:logicalShardCount();
  const jobs=Array.from({length:count},(_,shardIndex)=>({operation:'_hd_solve',payload:{
    ...payload,limits:{...payload.limits,shardIndex,shardCount:count},
  }}));
  return runJobs(jobs,selection,onProgress,ports,payload.limits.jointBoards);
}
async function searchUnitScoreRows(data,payload,selection,progress,ports) {
  const query={...payload,boardOpt:null,limits:{...payload.limits,jointBoards:false},
    account:{...payload.account,boards:boardPlanningBaseline(payload.account.boards,payload.boardOpt)},
    options:{...payload.options,topN:Math.max(24,payload.options.topN*2)}};
  const responses=await solveShards(query,selection,progress,ports);
  const gpuSearch=gpuSearches.get(selection);
  if(gpuSearch)return (await gpuSearch.rankResults(query,responses[0]?.results??[])).sort(compareUnitScore);
  const proposals=mergeReferenceResults(responses,query.options).results;
  return searchUnitScore(data,payload,proposals,{progress});
}
const compareGpuPlans=(a,b)=>(a?.after.value??-Infinity)-(b?.after.value??-Infinity)||
  (a?.after.tieScore??a?.after.score??0)-(b?.after.tieScore??b?.after.score??0);
const gpuTeamKey=row=>row.outfitId+'|'+row.order.slice().sort().join('|');

async function planGpuFrontier(payload,rows,selection,progress,ports,fullCount,liteOnly){
  const gpu=gpuSearches.get(selection),{options,boardOpt}=payload;
  const jobs=(entries,lite)=>entries.map(({row,seed,donors,quality})=>({
    operation:'_hd_plan',payload:{...payload,options:{...options,leaderMode:'fixed'},
      team:row.order,leaderChar:row.leaderChar,outfitId:row.outfitId,
      boardOpt:{...boardOpt,litePlan:lite},...(seed&&{seedBoards:seed.saves,donorLayouts:donors,
        generalist:true,expandPaths:!seed.orderExhaustive,qualityRefine:quality})},
  }));
  const run=(entries,lite)=>runJobs(jobs(entries,lite),selection,progress,ports);
  const keep=hasGpuBoardBonusTargets(boardOpt.keep?.targets??{});
  const candidates=rows.map((row,index)=>({row,index}));
  if(liteOnly||keep)return (await run(candidates,liteOnly)).map(result=>result.plan??null);
  const lite=await run(candidates,true);
  const plans=lite.map(result=>result.plan??null);
  const ranked=candidates.slice().sort((a,b)=>compareGpuPlans(plans[b.index],plans[a.index])||
    (b.row.potential??b.row.value)-(a.row.potential??a.row.value));
  const count=Math.min(ranked.length,fullCount??Math.max(6,options.topN));
  const funded=[],attempted=new Set(),attemptedSeeds=new WeakMap(),outfits=new Set();
  async function complete(entries){
    for(const {row,seed} of entries){
      const key=gpuTeamKey(row);
      if(!seed)attempted.add(key);
      else{
        if(!attemptedSeeds.has(seed))attemptedSeeds.set(seed,new Set());
        attemptedSeeds.get(seed).add(key);
      }
    }
    const results=await run(entries,false);
    for(const [i,{plan}] of results.entries()){
      if(!plan)continue;
      const {index}=entries[i];
      funded.push({...plan.after,index,plan});
      if(compareGpuPlans(plan,plans[index])>=0)plans[index]=plan;
    }
    funded.sort((a,b)=>compareGpuPlans(b.plan,a.plan));
  }
  const initial=ranked.slice(0,Math.min(count,Math.max(3,count-2)));
  for(const {row} of initial)outfits.add(row.outfitId);
  const distinct=ranked.find(({row,index})=>!outfits.has(row.outfitId)&&plans[index]&&
    plans[index].after.value>=(plans[initial[0]?.index]?.after.value??Infinity)*.96);
  if(distinct&&initial.length>2)initial[initial.length-1]=distinct;
  await complete(initial);
  if(!funded.length){
    await complete(ranked.filter(({row})=>!attempted.has(gpuTeamKey(row))).slice(0,count-initial.length));
    return plans;
  }
  // Every funded state can propose a different lineup or outfit. A new
  // finalist inherits the same shared-budget layout and can trade it again.
  let remaining=count-initial.length;
  if(remaining>1&&boardOpt.maxResets!==0){
    const eligible=ranked.filter(({index})=>lite[index]?.plan&&lite[index].plan.after.value>=funded[0].value*.94);
    const candidate=eligible.find(({row})=>!attempted.has(gpuTeamKey(row)))??eligible[0];
    if(candidate){
      const seed=lite[candidate.index].plan;
      await complete([{...candidate,row:seed.after,seed,donors:funded.slice(0,2).map(({plan})=>plan.saves)}]);
      remaining--;
    }
  }
  const indices=new Map(candidates.map(({row,index})=>[gpuTeamKey(row),index]));
  while(remaining>0){
    const unique=new Map();
    for(const row of funded){
      const key=gpuTeamKey(row);
      if(!unique.has(key))unique.set(key,row);
      if(unique.size===3)break;
    }
    const frontier=[...unique.values()];
    const {neighbors}=await gpu.rankFundedTeams(payload,frontier,ranked.slice(0,16).map(({row})=>row));
    const best=neighbors.find(({after,index})=>
      !attemptedSeeds.get(frontier[index].plan)?.has(gpuTeamKey(after))&&after.value>=frontier[index].value*.985);
    const nextKey=best&&gpuTeamKey(best.after);
    const next=ranked.find(({row})=>!attempted.has(gpuTeamKey(row))&&gpuTeamKey(row)!==nextKey);
    const wave=[];
    if(best){
      const {plan:seed,index}=frontier[best.index];
      wave.push({row:best.after,index:indices.get(nextKey)??index,seed,
        donors:frontier.filter(row=>row.plan!==seed).map(row=>row.plan.saves)});
    }
    if(next&&wave.length<remaining)wave.push(next);
    if(!wave.length)break;
    await complete(wave);
    remaining-=wave.length;
  }
  if(selection.objective!=='holomemLb'||options.lbCharts?.length){
    const frontier=funded.slice(0,3);
    const {best,alternate,neighbors}=await gpu.rankFundedTeams(payload,frontier,ranked.slice(0,16).map(({row})=>row),true);
    const leader=frontier[0];
    const finalists=[{row:leader,index:leader.index,seed:leader.plan,quality:true}];
    const rival=[best,...neighbors].find(candidate=>candidate&&candidate.after.value>=leader.value*.97&&
      gpuTeamKey(candidate.after)!==gpuTeamKey(leader));
    for(const pick of [rival,alternate].filter(Boolean)){
      const {plan:seed,index}=frontier[pick.index];
      if(gpuTeamKey(pick.after)===gpuTeamKey(leader)&&seed===leader.plan)continue;
      finalists.push({row:pick.after,index:indices.get(gpuTeamKey(pick.after))??index,seed,quality:true});
    }
    await complete(finalists.map(entry=>({...entry,
      donors:frontier.filter(row=>row.plan!==entry.seed).map(row=>row.plan.saves)})));
  }
  return plans;
}

async function planReferenceRows(payload,rows,selection,onProgress,ports,fullCount,liteOnly=false) {
  if(!rows.length)return [];
  const progress=(done,total,fraction)=>onProgress(done,total,fraction,'Planning Boards');
  if(gpuSearches.has(selection))
    return planGpuFrontier(payload,rows,selection,progress,ports,fullCount,liteOnly);
  const {options,account,boardOpt}=payload;
  const scoreKey=options.sortBy==='max'?'maxScore':'score';
  const jobs=(indices,lite)=>indices.map(index=>fixedBoardJob(payload,rows[index],lite));
  const regularJobs=(indices,lite)=>hasBoardProtection(boardOpt)?jobs(indices,lite):indices.map(index=>({
    operation:'_hd_plan',payload:{account,options,team:rows[index].order,leaderChar:rows[index].leaderChar,
      outfitId:options.leaderMode==='fixed'?options.outfitId:null,boardOpt:{...boardOpt,litePlan:lite}},
  }));
  const indices=rows.map((_,index)=>index);
  if(!liteOnly&&hasBoardBonusTargets(boardOpt))
    return (await runJobs(regularJobs(indices,false),selection,progress,ports)).map(response=>response.plan??null);
  const lite=await runJobs(regularJobs(indices,true),selection,progress,ports);
  const plans=lite.map(response=>response.plan??null);
  if(liteOnly)return plans;
  const score=plan=>plan?.after?.[scoreKey]??-1;
  const refine=indices.filter(index=>score(plans[index])>=0).sort((a,b)=>score(plans[b])-score(plans[a]))
    .slice(0,fullCount??Math.max(12,options.topN));
  const full=await runJobs(regularJobs(refine,false),selection,progress,ports);
  refine.forEach((index,position)=>{
    if(full[position]?.plan&&score(full[position].plan)>=score(plans[index]))plans[index]=full[position].plan;
  });
  return plans;
}

const isPermil=value=>Number.isSafeInteger(value)&&value>=0;
const isRecord=value=>value&&typeof value==='object'&&!Array.isArray(value);

async function reviewedEventScoring(data,payload,input,cards,selection) {
  const {options,account}=payload;
  if(!options.eventBonus&&!options.eventPoints)return null;
  const rules=data.eventBonus?.songs;
  if(!isRecord(rules))throw new MobileCoverageError('Event song rules are unavailable.');
  const entries=Object.hasOwn(rules,options.songId)?rules[options.songId]:[];
  if(!Array.isArray(entries)||entries.some(rule=>!isRecord(rule)||!isPermil(rule.permil)||
    Object.keys(rule).some(key=>!['permil','cardId'].includes(key))||
    (Object.hasOwn(rule,'cardId')&&(typeof rule.cardId!=='string'||!rule.cardId))))
    throw new MobileCoverageError('This event song bonus is outside reviewed coverage.');
  const chapter=data.epBonus;
  let seconds;
  if(options.eventPoints){
    const event=(await loadEvents()).find(row=>row.id===selection.eventId);
    const selected=event?.epBonus?.chapters.find(row=>row.number===selection.eventChapter);
    const chapterFields=['number','characterId','startTime','endTime','members','holomems','blooms'];
    const permils=values=>isRecord(values)&&Object.values(values).every(isPermil);
    if(!selected||Object.keys(selected).some(key=>!chapterFields.includes(key))||
      !chapter||!permils(chapter.members)||!permils(chapter.holomems)||!isRecord(chapter.blooms)||
      Object.values(chapter.blooms).some(values=>!Array.isArray(values)||!values.length||!values.every(isPermil)))
      throw new MobileCoverageError('This chapter bonus is outside reviewed coverage.');
    seconds=await eventSongSeconds(data,options);
    if(!Number.isFinite(seconds)||seconds<=0)throw new MobileCoverageError('The event song length is unavailable.');
  }
  return {
    score(row,modeled,upgradedEntries){
      const eventSongBonus=referenceEventSongBonus(entries,row.order);
      if(row.breakdown?.eventBonus!==eventSongBonus)throw new MobileCoverageError('The event song bonus could not be verified.');
      const score={...modeled,eventSongBonus};
      for(const key of ['low','high','average','maximum'])score[key]=applyEventSongBonus(score[key],eventSongBonus);
      if(!options.eventPoints)return score;
      const lineup=row.order.map(id=>cards.get(id));
      const eventCardBonuses=referenceEventCardBonuses(chapter,lineup,id=>(upgradedEntries?.[id]??account.owned[id])?.bloom);
      const epPermil=eventCardBonuses.reduce((total,bonus)=>total+bonus,0);
      if(row.epPermil!==epPermil)throw new MobileCoverageError('The event chapter bonus could not be verified.');
      const raw={epPermil,score:referenceEventPointBase(score.average,epPermil),maxScore:referenceEventPointBase(score.maximum,epPermil)};
      return {...score,eventPoints:{...referenceEventPoints(raw,seconds,input.liveBoost,input.holoPassport),epPermil,eventCardBonuses}};
    },
    rankScore:options.eventPoints?score=>options.sortBy==='max'?score.eventPoints.rawMaxScore:score.eventPoints.rawScore:undefined,
  };
}

async function reviewedEngine(data,payload,input,charts,missingMessage) {
  let engine;
  try {
    const {prepareReviewedOptimizer}=await import('./reviewed-optimizer');
    engine=await prepareReviewedOptimizer(payload,input.memoryBonusPermil,charts,source?.mobile,data.cards);
  } catch(error) {
    throw new MobileCoverageError(error.message);
  }
  if(!engine)throw new MobileCoverageError(missingMessage);
  return engine;
}

function steamCoverageMessage(error){
  const message=error.message??String(error);
  const matches=[...message.matchAll(/static-modifier-composition:([^:; ]+):([A-Z_]+)/g)];
  if(matches.length){
    const comparison=error.activationComparison??error.cause?.activationComparison;
    const missing=matches.map(([,id,type])=>{
      const label=type.includes('PROBABILITY')?'activation rate':type.includes('COOL_TIME')?'cooldown reduction':'score support';
      const slot=comparison?.rows.findIndex(row=>row.id===id)??-1;
      return (slot>=0?'slot '+(slot+1):id)+' ('+label+')';
    });
    return 'Steam supplies one combined modifier per card. This setup lacks a confirmed value for '+[...new Set(missing)].join(', ')+'.';
  }
  return message.replaceAll('reviewed Mobile','reviewed Steam').replaceAll('Mobile score','Steam score');
}

function steamCoverageError(error){
  const detail=error.activationComparison??error.cause?.activationComparison;
  return Object.assign(Error(steamCoverageMessage(error)),{activationComparison:detail});
}

function mobileCoverageMessage(error){
  const reasons=(error.message??String(error)).split('; ');
  const effects=new Set();
  const other=reasons.filter(reason=>{
    if(!reason.startsWith('static-modifier-composition:'))return true;
    effects.add(reason.includes('PROBABILITY')?'activation rate':reason.includes('COOL_TIME')?'cooldown':'score support');
    return false;
  }).map(reason=>reason==='server-board-song-bonus-composition'?
    'Mobile receives the lineup’s song-specific Board bonus from the server. Its exact value is unverified for this setup.':reason);
  if(effects.size)other.unshift('Mobile has no confirmed rule for the combined '+[...effects].join(' and ')+' bonuses in this setup.');
  return [...new Set(other.map(reason=>/^board:[\w:-]+(?: board:[\w:-]+)*$/.test(reason)
    ? 'Some Board effects use reference estimates.' : reason))].join(' ');
}

function fixedBoardJob({account,options,boardOpt},team,litePlan) {
  return {
    operation:'_hd_plan',payload:{account,options:{...options,leaderMode:'fixed',outfitId:team.outfitId,leaderChar:team.leaderChar},
      team:team.order,leaderChar:team.leaderChar,outfitId:team.outfitId,boardOpt:{...boardOpt,litePlan}},
  };
}

function mobileBoardPlans(payload,selection,progress,ports) {
  return (teams,litePlan)=>runJobs(teams.map(team=>fixedBoardJob(payload,team,litePlan)),selection,
    (done,total,fraction)=>progress(done,total,fraction,'Planning Boards for Mobile'),ports);
}

function mobileRoster(data,account,context,options) {
  return data.cards.filter(card=>account.owned[card.id]?.owned&&isTeamCardEligible(card,options))
    .map(card=>({id:card.id,power:Object.values(context.stats.get(card.id)).reduce((sum,value)=>sum+value,0)}))
    .sort((a,b)=>b.power-a.power).map(card=>card.id);
}

function nextScenarioKey(row) {
  return nextPulls(row).map(({id,new:acquired,copies,level,bloom})=>JSON.stringify([id,acquired,copies,level,bloom]))
    .sort().join('|');
}

function mobileSearchRows(data,payload,cards,baseAccount) {
  const {options}=payload;
  const next=options.goal==='next';
  const context=createReferenceScoreContext(data,baseAccount.owned,baseAccount.boards,baseAccount.ranks,options,baseAccount.dreamRank);
  const evaluate=(row,plan,chartOptions=options)=>{
    const activePlan=plan??row.plan;
    const scores=next||activePlan||row.boards||chartOptions!==options?createFinalistContext(data,payload,row,cards,chartOptions,
      activePlan?.saves??row.boards??baseAccount.boards,activePlan?.ranks??baseAccount.ranks):context;
    return evaluateReferenceTeam(scores,row.order.map(id=>cards.get(id)),row.outfitId,row.leaderChar);
  };
  return {evaluate,roster:next?[]:mobileRoster(data,baseAccount,context,options),
    outfits:next||options.pc?[]:eligibleTeamOutfits(data,{account:baseAccount,options}),scenarioKey:next?nextScenarioKey:undefined};
}

const rangeResources=async()=> (await import('./team-optimizer-resources')).loadOptimizerResources(source?.mobile);

async function requireChallengeStage(id,resources){
  const stage=(await loadChallengeStages(resources)).find(row=>row.id===id);
  if(!stage)throw Error('Choose an available Challenge Live stage.');
  return stage;
}

async function challengeSongJob(data,payload,songId,difficulties,useGpu,onProgress){
  const solver=useGpu?await (await import('./gpu-team-optimizer')).createGpuTeamOptimizer(data,'challengeLive'):
    await cpuPlanner(data,'challengeLive');
  try{
    return await searchChallengeSong(data,payload,songId,difficulties,await rangeResources(),solver,onProgress);
  }finally{if(useGpu)solver.close();}
}

async function runChallengeSearch(data,payload,input,selection,ports,progress){
  if(payload.options.pc||!['best','holomem'].includes(payload.options.goal))throw Error('Challenge Live requires a Mobile lineup search.');
  const resources=await rangeResources(),stage=await requireChallengeStage(input.challengeStageId,resources);
  const choices=challengeChartChoices(data,stage,input.challengeDifficulties,resources);
  if(!choices.length)throw Error('Choose at least one playable Challenge Live difficulty.');
  const query={...payload,options:{...payload.options,challengeStage:stage,eventPoints:false,eventBonus:false}};
  const groups=stage.songIds.map(songId=>({songId,difficulties:choices.filter(row=>row.songId===songId).map(row=>row.difficulty)}))
    .filter(group=>group.difficulties.length);
  const responses=new Array(groups.length),completed=new Array(groups.length).fill(0);
  const useGpu=Boolean(input.useGpu);
  let next=0;
  const phase='Comparing Challenge Live songs';
  progress(0,choices.length,0,phase);
  async function lane(port){
    while(next<groups.length){
      const i=next++,job=groups[i];
      const update=fraction=>{
        completed[i]=fraction*job.difficulties.length;
        const done=completed.reduce((sum,n)=>sum+n,0);
        progress(Math.round(done),choices.length,done/choices.length,phase);
      };
      responses[i]=port?await sendJob(port,{type:'challenge-song',payload:query,selection,useGpu,...job},update):
        await challengeSongJob(data,query,job.songId,job.difficulties,useGpu,(done,total)=>update(done/total));
      update(1);
    }
  }
  notify('search-backend',{backend:useGpu?'gpu':'cpu'});
  await Promise.all([...ports.slice(0,groups.length-1).map(lane),lane(null)]);
  const field=query.options.sortBy==='max'?'maxScore':'score';
  const ranked=responses.flat().sort((a,b)=>b.rows[0][field]-a.rows[0][field]);
  const songs=new Map();
  const challengeCharts=ranked.map(({songId,difficulty,rows})=>{
    // Keep every requested lineup for each song's winning difficulty.
    const bestDifficulty=!songs.has(songId);
    const teams=withDisplayUnitScores(data,query,teamsForUi(data,bestDifficulty?rows:rows.slice(0,1),query));
    const team=teams[0];
    if(bestDifficulty)songs.set(songId,{songId,difficulty,score:team.score,maxScore:team.maxScore,results:teams});
    return {songId,difficulty,score:team.score,maxScore:team.maxScore,bonusPermil:team.challengeBonusPermil,team};
  });
  const challengeSongs=[...songs.values()];
  return {results:challengeSongs[0].results,challengeSongs,challengeCharts,challengeStageId:stage.id,scoringModel:'challenge-mobile',
    compute:{backend:useGpu?'gpu':'cpu'},evaluated:choices.length};
}

function finalizeMobileSetup(data,payload,seed,resources){
  const {options,account}=payload;
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const metric=options.sortBy==='max'?'maxScore':'score';
  const charts=options.scoringMode==='generic'?referenceRangeCharts(data,options):null;
  const context=createFinalistContext(data,payload,seed,cards);
  const evaluate=mobileChartEvaluator(context,charts,resources);
  let best;
  for(const order of finalistOrders(seed.order.map(id=>cards.get(id)))){
    const trial=evaluate(order,seed.outfitId,seed.leaderChar);
    if(!best||trial[metric]>best[metric])best=trial;
  }
  const row={...seed,...best};
  const ordered=best.order.map(id=>cards.get(id));
  row.effectWarnings=referenceMobileEffectWarnings(context,ordered,seed.outfitId,seed.leaderChar);
  if(seed.plan){
    const baseline=createFinalistContext(data,payload,seed,cards,options,boardPlanningBaseline(account.boards,payload.boardOpt),account.ranks);
    const before=mobileChartEvaluator(baseline,charts,resources)(ordered,seed.outfitId,seed.leaderChar);
    row.plan={...seed.plan,orderExhaustive:true,before:{...seed.plan.before,...before},after:{...seed.plan.after,...best}};
  }
  return row;
}

async function finalizeReferenceOrders(data,payload,ranked,progress,ports,selection,perNote){
  const {options}=payload,metric=options.sortBy==='max'?'maxScore':'score';
  const finalists=finalistSetups(ranked.slice().sort((a,b)=>b[metric]-a[metric]),Math.max(6,options.topN),
    options.goal==='next'?nextScenarioKey:undefined);
  const results=new Array(finalists.length),resources=perNote?await rangeResources():null;
  let next=0,done=0;
  async function run(port){
    while(next<finalists.length){
      const i=next++,seed=finalists[i];
      results[i]=port?await sendJob(port,{type:'range-finalist',selection,payload,seed},()=>{}):
        finalizeMobileSetup(data,payload,seed,resources);
      progress(++done,finalists.length,done/finalists.length,'Checking all 120 Mobile slot orders');
      if(!port&&perNote&&ports.length&&next<finalists.length)await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  await Promise.all([...(perNote?ports:[]).slice(0,Math.max(0,finalists.length-1)).map(run),run(null)]);
  return mergeReferenceResults([{results}],options).results;
}

function mobileFinalists(payload,selection,ports,cards,evaluate){
  const gpu=gpuSearches.get(selection);
  if(!gpu)return;
  return async rows=>{
    const next=payload.options.goal==='next';
    return (await Promise.all((next?rows.map(row=>[row]):[rows]).map(async seeds=>{
      if(!seeds.length)return [];
      const entries=next?mobileTeam(seeds[0],payload,cards).entries:null;
      const query=entries?{...payload,options:{...payload.options,cardPool:'owned',focusCardIds:payload.extras.nextDeck},
        account:{...payload.account,owned:{...payload.account.owned,...Object.fromEntries(Object.entries(entries)
          .map(([id,value])=>[id,{...value,owned:true}]))}}}:payload;
      const {best,alternate,neighbors}=await gpu.rankFundedTeams(query,seeds,seeds,true,entries?Object.keys(entries):[]);
      const distinct=new Set();
      const picks=[best,...neighbors];
      if(alternate)picks.splice(4,0,alternate);
      const variants=picks.flatMap(proposal=>{
        if(!proposal)return [];
        const {after,index}=proposal,seed=seeds[index];
        const key=index+'|'+gpuTeamKey(after);
        if(distinct.has(key))return [];
        distinct.add(key);
        const row={...seed,...after};
        if(seed.plan)row.plan={...seed.plan,after,outfitId:after.outfitId,leaderChar:after.leaderChar,
          before:evaluate({...row,plan:undefined,boards:undefined})};
        return [row];
      }).slice(0,alternate?5:4);
      if(!query.boardOpt)return variants;
      const teams=[seeds[0],...variants.filter(row=>gpuTeamKey(row)!==gpuTeamKey(seeds[0])).slice(0,1)];
      const jobs=teams.map(row=>{
        const job=fixedBoardJob(query,row,false);
        if(row.plan)Object.assign(job.payload,{seedBoards:row.plan.saves,generalist:true,qualityRefine:true});
        return job;
      });
      const planned=await runJobs(jobs,selection,()=>{},ports);
      return [...variants,...planned.flatMap(({plan},index)=>plan?[{...teams[index],...plan.after,plan}]:[])];
    }))).flat();
  };
}

async function prepareMobileRating(data,payload,input,charts,selection,ports,onUnverified) {
  const {boardOpt}=payload;
  const account={...payload.account,boards:boardPlanningBaseline(payload.account.boards,boardOpt)};
  if(unresolvedBoardEntries(data,account.boards))throw new MobileCoverageError('Some Board entries are unavailable.');
  const engine=await reviewedEngine(data,{...payload,account,options:{...payload.options,scoringMode:'chart'}},
    input,charts,'Some eligible Holomem Rating charts are outside the reviewed Mobile chart pack.');
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const score=(row,keys,averageOnly)=>{
    try {
      return engine.scoreCharts(mobileTeam(row,payload,cards),keys,averageOnly);
    }catch(error){throw new MobileCoverageError(error.message,{cause:error});}
  };
  return {
    engine,score,team:row=>mobileTeam(row,payload,cards),
    async search(query,progress,keys,{optimize,summarize,compareScores}){
      const {options}=query;
      const next=options.goal==='next';
      const seed={...query,reviewedFinals:true,account:next?query.account:account,boardOpt:next?query.boardOpt:null,limits:{...query.limits,jointBoards:false},
        options:{...options,topN:Math.max(12,options.topN*2)}};
      const responses=await solveShards(seed,selection,progress,ports);
      const gpuSearch=gpuSearches.get(selection);
      if(gpuSearch)responses[0].results=await gpuSearch.rankResults(seed,responses[0].results??[]);
      const {evaluate,roster,outfits,scenarioKey}=mobileSearchRows(data,query,cards,account);
      const result=await searchReviewedMobile(responses,{
        options,roster,outfits,chartCount:keys.length,memberOf:id=>cards.get(id)?.characterId,progress,scenarioKey,onUnverified,
        planRows:optimize&&!next?mobileBoardPlans(query,selection,progress,ports):null,
        deepen:mobileFinalists({...query,boardOpt:optimize||next?query.boardOpt:null},selection,ports,cards,evaluate),
        keepBoardBonuses:hasBoardBonusTargets(query.boardOpt),compareScores,
        score:row=>{
          const scores=score(row,keys);
          return summarize?summarize(scores):{...scores[0],chartKey:keys[0]};
        },
        buildRow:evaluate,
      });
      return (result?.rows??[]).map(row=>{
        if(summarize){
          const {chartKey}=row.reviewedScore;
          const split=chartKey.lastIndexOf('_');
          const strongest={...options,songId:chartKey.slice(0,split),difficulty:chartKey.slice(split+1)};
          const best=evaluate(row,row.plan,strongest);
          row={...row,...best,...(row.plan?{plan:{...row.plan,after:{...row.plan.after,...best}}}:{})};
        }
        return boardOpt?.ignoreExisting&&!row.boards?{...row,boards:account.boards}:row;
      });
    },
  };
}

async function reviewedNextBaseline(data,payload,account,cards,engine,selection,progress,ports,chartCount) {
  const focusCardIds=payload.extras.nextDeck??[];
  const options={...payload.options,goal:focusCardIds.length?'holomem':'best',focusCardIds,topN:1};
  const query={...payload,options};
  const proposal={...query,reviewedFinals:true,account,boardOpt:null,limits:{...payload.limits,jointBoards:false},options:{...options,topN:12}};
  const baselineProgress=(done,total,fraction)=>progress(done,total,fraction,'Scoring current team for Mobile');
  const responses=await solveShards(proposal,selection,baselineProgress,ports);
  const {evaluate,roster,outfits}=mobileSearchRows(data,query,cards,account);
  const result=await searchReviewedMobile(responses,{
    options,roster,outfits,chartCount,memberOf:id=>cards.get(id)?.characterId,progress:baselineProgress,
    score:row=>engine.score(mobileTeam(row,query,cards)),buildRow:evaluate,
    planRows:payload.boardOpt?mobileBoardPlans(query,selection,baselineProgress,ports):null,
    deepen:mobileFinalists(query,selection,ports,cards,evaluate),
    keepBoardBonuses:hasBoardBonusTargets(payload.boardOpt),
  });
  const score=result?.rows[0]?.reviewedScore;
  if(!score)throw new MobileCoverageError('The current team could not be scored with the reviewed Mobile model.');
  return options.sortBy==='max'?score.maximum:score.average;
}

function reviewedResultScores(row){
  const values=part=>part?.reviewedScore?{...part,...part.reviewedScore.eventPoints,
    score:part.reviewedScore.average,maxScore:part.reviewedScore.maximum}:part;
  const result=values(row);
  return row.plan?{...result,plan:{...row.plan,before:values(row.plan.before),after:values(row.plan.after)}}:result;
}

async function runReviewedMobile(data,payload,input,selection,progress,ports,onUnverified) {
  const {options,boardOpt}=payload;
  const account={...payload.account,boards:boardPlanningBaseline(payload.account.boards,boardOpt)};
  if(unresolvedBoardEntries(data,account.boards))throw new MobileCoverageError('Some Board entries are unavailable.');
  const anySong=options.scoringMode==='generic';
  const song=anySong?null:data.songs.find(row=>row.id===options.songId);
  const selected=anySong?referenceRangeCharts(data,options):
    (song?.difficulties??[]).filter(chart=>chart.type===options.difficulty).map(chart=>({song,chart}));
  const charts=selected.map(({song,chart})=>({key:song.id+'_'+chart.type,level:chart.level,notes:chart.notes}));
  const engine=await reviewedEngine(data,{...payload,account},input,charts,anySong?'The full range is outside the reviewed Mobile chart coverage.':
    'This chart is outside the reviewed Mobile chart pack.');
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const event=await reviewedEventScoring(data,payload,input,cards,selection);
  const next=options.goal==='next';
  const query={...payload,reviewedFinals:true,account:next?payload.account:account,boardOpt:next?boardOpt:null,limits:{...payload.limits,jointBoards:false},
    options:{...options,topN:Math.max(24,options.topN*2)}};
  const responses=await solveShards(query,selection,progress,ports);
  const gpuSearch=gpuSearches.get(selection);
  if(gpuSearch)responses[0].results=await gpuSearch.rankResults(query,responses[0].results??[]);
  const {evaluate,roster,outfits,scenarioKey}=mobileSearchRows(data,payload,cards,account);
  const planRows=boardOpt&&!next?mobileBoardPlans(payload,selection,progress,ports):null;
  const result=await searchReviewedMobile(responses,{
    options,roster,outfits,chartCount:charts.length,memberOf:id=>cards.get(id)?.characterId,progress,planRows,
    rankScore:event?.rankScore,scenarioKey,onUnverified,
    deepen:mobileFinalists(payload,selection,ports,cards,evaluate),
    keepBoardBonuses:hasBoardBonusTargets(boardOpt),
    score:row=>{
      const team=mobileTeam(row,payload,cards);
      const modeled=engine.score(team);
      return event?event.score(row,modeled,team.entries):modeled;
    },
    buildRow:evaluate,
  });
  if(!result&&!next)return null;
  let baseline;
  if(next&&input.objective==='score'&&responses.some(response=>Number.isFinite(response.baseline)&&response.baseline>0))
    baseline=await reviewedNextBaseline(data,payload,account,cards,engine,selection,progress,ports,charts.length);
  const rows=(result?.rows??[]).map(row=>({...reviewedResultScores(row),
    ...(boardOpt?.ignoreExisting&&!row.boards?{boards:account.boards}:{})}));
  const teams=teamsForUi(data,rows,payload).map((team,index)=>anySong?team:{...team,reviewIndex:index});
  if(!anySong)lastReview={engine,rows:teams.map(team=>mobileTeam(team,payload,cards))};
  return {results:withDisplayUnitScores(data,payload,teams),baseline,reviewedCount:result?.scored??0,evaluated:responses.length};
}

async function planUnitScoreRows(data,payload,rows,selection,onProgress,ports) {
  if(!payload.boardOpt||!rows.length)return rows;
  if(gpuSearches.has(selection)){
    const plans=await planReferenceRows(payload,rows,selection,onProgress,ports);
    return rows.map((row,index)=>plans[index]?{...row,...plans[index].after,plan:plans[index]}:row).sort(compareUnitScore);
  }
  const {account,options,boardOpt}=payload;
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const makeJobs=(teams,litePlan)=>teams.map(team=>fixedBoardJob(payload,team,litePlan));
  const progress=(done,total,fraction)=>onProgress(done,total,fraction,'Planning Boards');
  const keepBoardBonuses=hasBoardBonusTargets(boardOpt);
  const applyPlan=(before,plan)=>{
    if(!plan?.saves)return before;
    const order=(plan.after?.order??before.order).map(id=>cards.get(id));
    if(order.some(card=>!card))return before;
    const context=unitScoreContext(data,payload,plan.saves,plan.ranks??account.ranks);
    const after=evaluateUnitScore(context,order,before.outfitId,before.leaderChar);
    if(!keepBoardBonuses&&!(after.displayUnitScore>before.displayUnitScore))return before;
    return {...after,plan:{...plan,before,after}};
  };
  // The lite planner can skip the score-loss comparison. Direct Unit Score
  // swaps also bypass the reference solver's keep-only rules.
  if(keepBoardBonuses){
    const plans=await runJobs(makeJobs(rows,false),selection,progress,ports);
    return rows.map((team,index)=>applyPlan(team,plans[index]?.plan)).sort(compareUnitScore);
  }
  const lite=await runJobs(makeJobs(rows,true),selection,progress,ports);
  const ranked=rows.map((team,index)=>({team,best:applyPlan(team,lite[index]?.plan)}))
    .sort((a,b)=>compareUnitScore(a.best,b.best));
  const count=Math.min(ranked.length,Math.max(6,options.topN));
  const full=await runJobs(makeJobs(ranked.slice(0,count).map(row=>row.team),false),selection,progress,ports);
  const directCount=Math.min(ranked.length,Math.max(4,Math.min(8,options.topN)));
  const directTeams=new Set([...rows.slice(0,directCount),...ranked.slice(0,2).map(row=>row.team)]);
  let checked=0;
  return ranked.map(({team,best},index)=>{
    const fullPlan=applyPlan(team,full[index]?.plan);
    if(compareUnitScore(fullPlan,best)<0)best=fullPlan;
    if(directTeams.has(team)&&!hasBoardProtection(boardOpt)){
      onProgress(checked++,directTeams.size,checked/directTeams.size,'Optimizing Boards for Unit Score');
      const direct=improveUnitScoreBoards(data,payload,team);
      if(compareUnitScore(direct,best)<0)best=direct;
    }
    return best;
  }).sort(compareUnitScore);
}

function boardBudgetMessages(data,account,input){
  const members=new Map((input.budgetMembers??[]).map(row=>[row.characterId,row.level]));
  const boards=input.budgetBoards&&new Map(input.budgetBoards.map(row=>
    [row.characterId,{nodes:row.releasedSkillTreeNodeGroupIds}]));
  const names=new Map(data.cards.map(card=>[card.characterId,card.character]));
  const mismatches=[];
  for(const row of input.boardPointBalances??[]){
    const id=row.skillTreePointId.replace(/^skill_tree_point-/,'');
    const rank=members.get(id)??account.ranks[id];
    const board=boards?boards.get(id):account.boards[id],nodes=data.boards[id];
    if(!nodes||!board||!Number.isInteger(rank))continue;
    const byId=new Map(nodes.map(node=>[node.id,node]));
    if(board.nodes.some(node=>!byId.has(node)))continue;
    const spent=[...new Set(board.nodes)].reduce((sum,node)=>sum+byId.get(node).pts,0);
    const name=names.get(id)??id;
    if(boardPointsAtRank(data.boardPointLadder,rank)-spent!==Number(row.quantity))mismatches.push(name);
  }
  return mismatches;
}
let songLengths;
async function eventSongSeconds(data,options) {
  songLengths??=fetch('/assets/team-optimizer/song-lengths.json').then(response=>response.ok?response.json():{}).catch(()=>({}));
  const lengths=(await pack())?.lengths??await songLengths;
  const song=data.songs.find(row=>row.id===options.songId);
  return lengths[options.songId]??song?.difficulties.find(row=>row.type===options.difficulty)?.seconds??0;
}
function teamsForUi(data,rows,payload) {
  const names=new Map(data.cards.map(card=>[card.characterId,card.character]));
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const {account,extras}=payload;
  const finalRows=rows.map(row=>row.plan?{...row,plan:finalLineupBoardPlan(data,payload,row.plan,
    row.order.map(id=>cards.get(id)?.characterId),row.leaderChar)}:row);
  return finalRows.map(row=>({
    ...row,cardIds:row.order,leaderName:names.get(row.leaderChar)??row.leaderChar,
    ...(row.reviewedScore&&!payload.options.pc?{effectWarnings:referenceMobileEffectWarnings(
      createFinalistContext(data,payload,row,cards),row.order.map(id=>cards.get(id)),row.outfitId,row.leaderChar,{reviewed:true})}:{}),
    outfitName:data.costumes[row.outfitId]?.name??row.outfitId,
    outfitDescription:data.costumes[row.outfitId]?.description,
    lineup:row.order.map(id=>{
      const card=cards.get(id);
      const pull=nextPulls(row).find(entry=>entry.id===id);
      if(pull)return nextCardEntry(card,extras,pull,account.owned[id]);
      return account.owned[id]??{level:1,bloom:0};
    }),
    low:row.score,high:row.maxScore,power:row.deckPower,
    upgrades:row.pulls??(row.candidateId?[{id:row.candidateId,new:true,copies:1}]:[]),
    ...(row.plan?{boardCards:Object.fromEntries([...new Set(Object.values(row.plan.saves??{}).flatMap(save=>Object.values(save.cards)))].flatMap(id=>{
      const card=cards.get(id),pull=nextPulls(row).find(entry=>entry.id===id);
      const entry=pull&&card?nextCardEntry(card,extras,pull,account.owned[id]):
        account.owned[id]??payload.options.boardConnectEntries?.[id];
      return entry?[[id,entry.bloom]]:[];
    }))}:{}),
  }));
}

let bundledPreviewGeometry;
async function loadPreviewChartData(key, pc) {
  if(!key)return null;
  const {loadOptimizerResources}=await import('./team-optimizer-resources');
  const {decodeOptimizerChart}=await import('../hololive/vendor/shared/optimizer-chart-pack');
  bundledPreviewGeometry??=fetch('/assets/team-optimizer/optimizer-preview-geometry.json').then(response=>response.json()).catch(()=>({}));
  const [{pack,previewHits,previewGeometry},bundledGeometry]=await Promise.all([loadOptimizerResources(source?.mobile),bundledPreviewGeometry]);
  const row=pack.rowsByKey.get(key);
  if(!row)return null;
  const decoded=decodeOptimizerChart(pack,key,pc?'pc':'mobile');
  const events={times:decoded.eventTimesMicroseconds,types:decoded.eventNoteTypes,officialHash:row[3]};
  const bundled=bundledGeometry[key];
  const profile=previewHits?.[key]??bundled?.profile;
  if(Array.isArray(profile)&&profile[0]===row[3]){
    events.hitProfile=profile.slice(0,3);
    const encoded=profile[3];
    if(typeof encoded==='string'&&encoded.length===4*Math.ceil(row[16]/3)){
      const lanes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
      if(lanes.length===row[16]&&lanes.every(lane=>(lane&15)>0)){
        events.lanes=lanes;
        const geometry=decodeChartGeometry(previewGeometry?.[key]??
          (bundled?.profile[0]===row[3]?bundled.geometry:null),events);
        if(geometry)events.previewGeometry=geometry;
      }
    }
  }
  return {key,pc,events,level:row[2],notes:row[5],seconds:row[4]/1e6,
    slots:row[14].map(time=>time==null?null:time/1e6),countCurve:[],weightCurve:[],active:[],special:[]};
}

async function resultPreview({data,payload,input,previewData},team,chartKey,pc=payload.options.pc,stream=false) {
  const stage=team.challengeStageId?await requireChallengeStage(team.challengeStageId,await rangeResources()):null;
  if(stage){
    const primary=team.scoringCharts[0];
    chartKey||=primary.songId+'_'+primary.difficulty;
    if(pc||!stage.songIds.includes(chartKey.split('_')[0]))throw Error('Choose a Mobile chart from this Challenge Live stage.');
  }
  if(chartKey&&previewData)data=previewData;
  if(pc)data=withPcCharts(data);
  const {account,options}=payload;
  const order=team.cardIds.map(id=>data.cards.find(card=>card.id===id));
  if(order.some(card=>!card))return null;
  const boards=team.plan?.saves??team.boards??boardPlanningBaseline(account.boards,payload.boardOpt);
  const ranks=team.plan?.ranks??account.ranks;
  const owned={...account.owned};
  for(const [id,bloom] of Object.entries(team.boardCards??{}))if(owned[id])owned[id]={...owned[id],bloom};
  order.forEach((card,index)=>{owned[card.id]={owned:true,...team.lineup[index]};});
  const context=createReferenceScoreContext(data,owned,boards,ranks,{...options,pc,cardPool:'owned',
    scoringMode:'unit',eventBonus:false,eventPoints:false},account.dreamRank);
  const outfit=team.outfitId,leader=team.leaderChar;
  const rankFor=(ranks,value)=>ranks?.findLast(rank=>rank.value<=value)??null;
  const summarize=context=>{
    const {breakdown}=evaluateReferenceTeam(context,order,outfit,leader);
    const power=['parameters','board','passive','memory','powerUp','leader'].reduce((sum,key)=>sum+breakdown[key],0);
    const bonuses=referenceTeamScoreBonus(context,order,outfit,leader);
    const unitScore=referenceUnitScore(power,bonuses.total);
    return {breakdown,power,bonuses,unitScore,...(stage?{challengeUnitBonus:challengeUnitBonus(unitScore,challengeBonusPermil(stage,order))}:{}),
      ranks:{power:rankFor(data.deckPowerRanks,power),bonus:rankFor(data.deckRankBonus,bonuses.total),
        unit:rankFor(data.deckRanks,unitScore)}};
  };
  const overall=summarize(context);
  const [songId,difficulty]=chartKey?.split('_')??[];
  const song=data.songs.find(row=>row.id===songId);
  const chart=song?.difficulties.find(row=>row.type===difficulty&&row.seconds>0);
  if(!chart){
    if(!stream)return {overall};
    const gameChart=await loadPreviewChartData(chartKey,pc).catch(()=>null);
    if(gameChart)return {report:{overall,chart:gameChart,chartOnly:true}};
    if(pc)return {report:{overall}};
    const generic=createReferenceScoreContext(data,owned,boards,ranks,{...context.options,pc,scoringMode:'generic',
      songId:null,difficulty:''},account.dreamRank);
    let range=referenceRangeCharts(data,options);
    const effectWarnings=[];
    if(input?.reviewedMobile!==false&&(!input?.preferWebsiteMobile||input.mobileChartRange)){
      try{
        const charts=range.map(({song,chart})=>({key:song.id+'_'+chart.type,level:chart.level,notes:chart.notes}));
        const engine=await reviewedEngine(data,{...payload,options:{...options,pc:false},account:{...account,owned,boards,ranks}},
          input,charts,'The selected range is outside reviewed Mobile coverage.');
        const score=engine.score({...team,order:team.cardIds});
        return {report:{overall,score:score.average,maxScore:score.maximum,backend:'reviewed-mobile',
          effectWarnings:referenceMobileEffectWarnings(generic,order,outfit,leader,{reviewed:true})}};
      }catch(error){
        effectWarnings.push(mobileCoverageMessage(error));
        if(!team.rangeCoverage)range=range.filter(({chart})=>!chart.gameOnly);
      }
    }
    const {score,maxScore,rangeCoverage}=mobileChartEvaluator(generic,range,team.rangeCoverage?await rangeResources():null)(order,outfit,leader);
    effectWarnings.push(...referenceMobileEffectWarnings(generic,order,outfit,leader));
    return {report:{overall,score,maxScore,rangeCoverage,backend:rangeCoverage?.perNote?'mobile-per-note-estimate':'reference',effectWarnings}};
  }
  const chartContext=withReferenceChart({...context,options:{...context.options,scoringMode:'chart',
    eventBonus:options.eventBonus,pc}},song,chart);
  const thisSong=summarize({...chartContext,options:{...chartContext.options,scoringMode:'unit'}});
  const chartInfo={key:chartKey,seconds:chart.seconds,notes:chart.notes,level:chart.level,pc,
    countCurve:chart.countCurve??[],weightCurve:chart.curve??[],slots:chart.slots??[],
    active:[],special:[],outfitSupport:0};
  const gameChart=await loadPreviewChartData(chartKey,pc).catch(()=>null);
  if(gameChart?.level===chart.level&&gameChart.notes===chart.notes)chartInfo.events=gameChart.events;
  let model,coverageMessage,activationComparison;
  if(!stage&&(pc||input?.reviewedMobile!==false&&(!input?.preferWebsiteMobile||chart.gameOnly||input.mobileChartRange||team.rangeCoverage))){
    try{
      const engine=await reviewedEngine(data,{...payload,options:{...options,pc},account:{...account,owned,boards,ranks}},input,
        [{key:chartKey,level:chart.level,notes:chart.notes}],'This chart is outside reviewed Mobile coverage.');
      model=engine.previewSimulation({...team,order:team.cardIds},chartKey);
      if(!model)throw Error('The score distribution is unavailable for this lineup.');
    }catch(error){
      if(pc)throw steamCoverageError(error);
      coverageMessage=mobileCoverageMessage(error);
      activationComparison=error.activationComparison;
    }
  }else if(!stage&&!pc&&input?.reviewedMobile!==false){
    // A whole-search fallback can still have signed formation data for this song.
    const engine=await reviewedEngine(data,{...payload,options:{...options,pc},account:{...account,owned,boards,ranks}},input,
      [{key:chartKey,level:chart.level,notes:chart.notes}],'Chart unavailable').catch(()=>null);
    if(engine)try{activationComparison=engine.activationRates({...team,order:team.cardIds},chartKey);}catch(error){coverageMessage=mobileCoverageMessage(error);}
  }
  let score,maxScore,backend,sampler;
  const projected=!model&&!pc&&team.rangeCoverage&&
    mobileRangeChartPreview(chartContext,song,chart,order,outfit,leader,await rangeResources(),stage?challengeBonusPermil(stage,order):0);
  if(model){
    const scale=value=>applyEventSongBonus(value,thisSong.breakdown.eventBonus);
    score=scale(model.average);
    maxScore=scale(model.maximum);
    backend=pc?'steam':'reviewed-mobile';
    Object.assign(chartInfo,model.windows);
    sampler={minimum:scale(model.minimum),maximum:maxScore,
      sample:(runs,seed)=>model.sample(runs,seed).map(row=>({...row,score:scale(row.score)})),
      timeline:model.timeline.map(point=>({...point,score:scale(point.score)}))};
  }else if(projected){
    ({score,maxScore,sampler}=projected);
    backend='mobile-per-note-estimate';
    const {active,special,outfit,seconds}=projected.windows;
    Object.assign(chartInfo,{active,special,outfitSupport:outfit/1000,seconds,slots:gameChart?.slots??chart.slots});
  }else{
    if(chart.gameOnly){
      const report={overall,chart:gameChart??chartInfo,chartOnly:true,activationComparison,effectWarnings:coverageMessage?[coverageMessage]:[]};
      return stream?{report}:report;
    }
    const reference=evaluateReferenceTeam(chartContext,order,outfit,leader);
    ({score,maxScore}=reference);
    backend='reference';
    evaluateReferenceTeam(chartContext,order,outfit,leader,false,null,windows=>{
      Object.assign(chartInfo,{active:windows.active,special:windows.special,outfitSupport:windows.outfit/1000});
    });
    const evaluate=random=>evaluateReferenceTeam(chartContext,order,outfit,leader,false,random).score;
    sampler={minimum:evaluate(()=>1-Number.EPSILON/2),maximum:evaluate(()=>0),timeline:[],sample:(runs,seed)=>{
      const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
      return Array.from({length:runs},()=>({score:evaluate(random),count:1}));
    }};
  }
  let event;
  if(options.eventPoints&&data.epBonus){
    const eventCardBonuses=referenceEventCardBonuses(data.epBonus,order,id=>owned[id]?.bloom);
    const epPermil=eventCardBonuses.reduce((total,bonus)=>total+bonus,0);
    const seconds=await eventSongSeconds(data,{...options,songId,difficulty}).catch(()=>chart.seconds);
    const points=referenceEventPoints({epPermil,score:referenceEventPointBase(score,epPermil),
      maxScore:referenceEventPointBase(maxScore,epPermil)},seconds,input?.liveBoost,input?.holoPassport);
    event={...points,score,maxScore,epPermil,eventCardBonuses};
  }
  const report={overall,thisSong,chart:{...chartInfo,averageScore:score,maxScore},score,maxScore,backend,
    ...(stage?{challengeBonusPermil:challengeBonusPermil(stage,order),challengeUnitBonus:overall.challengeUnitBonus}:{}),
    activationComparison:model?.activationComparison??activationComparison,
    effectWarnings:pc?[]:[...new Set([coverageMessage,...referenceMobileEffectWarnings(chartContext,order,outfit,leader,{reviewed:!!model})].filter(Boolean))],...event};
  return stream?{report,sampler}:report;
}

const previewBins=80;
const simulationDurations=new Set([5000,10000,30000,60000,120000,300000]);
const initialSimulationDuration=10000;
const newPreviewSamples=()=>({bins:new Uint32Array(previewBins),runs:0,mean:0,m2:0});

function previewBin(score,minimum,width){
  return Math.max(0,Math.min(previewBins-1,Math.floor((score-minimum)/width)));
}

function previewDetails(session){
  const {sampler:{minimum,maximum,timeline},samples:{bins,runs,mean,m2}}=session;
  if(!runs)return {minimum,maximum,average:session.report.score,timeline,runs:0};
  const width=(maximum-minimum)/previewBins||1;
  let peak=0;
  const histogram=Array.from(bins,(count,index)=>{
    if(count>bins[peak])peak=index;
    return {from:Math.min(maximum,minimum+index*width),to:Math.min(maximum,minimum+(index+1)*width),count};
  });
  const percentiles=Object.fromEntries([5,25,50,75,95].map(percent=>{
    const target=percent*runs/100;
    let seen=0;
    const index=bins.findIndex(count=>{seen+=count;return seen>=target;});
    const value=index<0?maximum:minimum+(index+1-(seen-target)/bins[index])*width;
    return ['p'+percent,Math.min(maximum,value)];
  }));
  const stdDev=Math.sqrt(Math.max(0,m2/runs));
  const mode=Math.min(maximum,minimum+(peak+.5)*width);
  const aboveAverage=bins.slice(previewBin(mean,minimum,width)).reduce((sum,count)=>sum+count,0)*100/runs;
  return {minimum,maximum,timeline,histogram,percentiles,runs,mean,average:mean,median:percentiles.p50,mode,stdDev,
    variation:mean?100*stdDev/mean:0,spread:maximum-minimum,aboveAverage};
}

function notifyPreview(session){
  if(session!==previewSession||!session.report)return;
  const {sampler,run,samples}=session;
  notify('review-details',{request:session.request,...session.report,
    ...(sampler?{details:previewDetails(session),simulation:{running:!!run,elapsedMs:run?performance.now()-run.started:0,
      durationMs:run?.durationMs??0,runs:samples.runs,action:run?.action}}:{})});
}

function runPreviewSimulation(session,action,durationMs){
  if(!session.sampler||(action==='continue'&&session.run))return;
  if(action!=='continue')session.samples=newPreviewSamples();
  const {samples,sampler}=session;
  const run={action,durationMs,started:performance.now()};
  session.run=run;
  notifyPreview(session);
  const width=(sampler.maximum-sampler.minimum)/previewBins||1;
  function add(score,count){
    samples.bins[previewBin(score,sampler.minimum,width)]+=count;
    samples.runs+=count;
    const delta=score-samples.mean;
    samples.mean+=delta*count/samples.runs;
    samples.m2+=delta*(score-samples.mean)*count;
  }
  let lastUpdate=run.started;
  function tick(){
    if(session!==previewSession||session.run!==run)return;
    try{
      const deadline=performance.now()+20;
      do{
        // The same batch of 32 runs starts from the same seed after every reset.
        for(const {score,count} of sampler.sample(32,(2718+samples.runs)>>>0))add(score,count);
      }while(performance.now()<deadline);
      const now=performance.now();
      if(now-run.started>=durationMs){session.run=null;notifyPreview(session);}
      else{
        if(now-lastUpdate>=200){notifyPreview(session);lastUpdate=now;}
        setTimeout(tick,0);
      }
    }catch(error){
      session.run=null;
      notify('review-details',{request:session.request,...session.report,error:error.message,activationComparison:error.activationComparison??session.report?.activationComparison});
    }
  }
  setTimeout(tick,0);
}

// The public preview's Unit Score uses the overall power breakdown and its
// team skill bonus. The solver's unitScore is a separate chart base value.
function withDisplayUnitScores(data,payload,teams) {
  const {account}=payload;
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  let baseContext;
  return teams.map(team=>{
    const order=team.order.map(id=>cards.get(id));
    if(order.some(card=>!card))return team;
    const saves=team.plan?.saves??team.boards;
    const ranks=team.plan?.ranks??account.ranks;
    const changed=team.candidateId||team.pulls?.length;
    const owned=changed?{...account.owned}:account.owned;
    if(changed){
      if(team.reviewedScore){
        for(const pull of nextPulls(team))owned[pull.id]={...nextCardEntry(cards.get(pull.id),payload.extras,pull,account.owned[pull.id]),owned:true};
      }
      for(const [index,card] of order.entries()){
        const entry=team.lineup[index];
        if(entry)owned[card.id]={...entry,owned:true};
      }
    }
    const makeContext=()=>unitScoreContext(data,{...payload,account:{...account,owned}},saves??account.boards,ranks);
    const context=saves||changed||ranks!==account.ranks?makeContext():(baseContext??=makeContext());
    // Fixed lineup previews use the actual entries even with a custom pool.
    for(const [index,card] of order.entries()){
      const entry=team.lineup[index];
      if(entry)updateReferenceCardEntry(context,card,entry);
    }
    const {displayUnitScore}=evaluateUnitScore(context,order,team.outfitId,team.leaderChar);
    return Number.isFinite(displayUnitScore)?{...team,displayUnitScore,...(team.challengeStageId?
      {challengeUnitBonus:challengeUnitBonus(displayUnitScore,team.challengeBonusPermil)}:{})}:team;
  });
}

async function prepareFixedLineup(saved,input) {
  const data=await activeData();
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const order=saved.cardIds.map(id=>cards.get(id));
  if(order.some(card=>!card)||!data.cards.some(card=>card.characterId===saved.leaderChar)||
    (saved.outfitId&&!data.costumes[saved.outfitId]))throw Error('A saved card, leader or outfit is unavailable in this catalog.');
  const [first]=saved.charts;
  const assumptions=saved.cardAssumptions;
  const outfitAssumption=saved.outfitAssumption;
  const options={goal:'best',cardPool:assumptions?.cardPool??'owned',scoringMode:first?'chart':'generic',songId:first?.songId??null,
    difficulty:first?.difficulty??'',pc:saved.pc,anyDiffMin:saved.anyDiffMin,anyDiffMax:saved.anyDiffMax,
    anyDiffTypes:saved.anyDiffTypes,eventBonus:saved.objective==='event',eventPoints:saved.objective==='eventPoints',
    ...(outfitAssumption?{leaderMode:'fixed',leaderChar:saved.leaderChar,outfitId:saved.outfitId}:{})};
  if((options.eventBonus||options.eventPoints)&&(!first||!saved.eventId||(options.eventPoints&&!saved.eventChapter)))
    throw Error('The saved lineup is missing its event chart or chapter.');
  const payload=prepareReferenceSearch(data,{...input,...assumptions,
    powerUpPreset:saved.powerUpPreset,plannedCards:saved.plannedCards,outfitAssumption,options});
  const currentBoards=input.boards===undefined?saved.boards:payload.account.boards;
  const boards=saved.boardMode==='none'?{}:saved.boardMode==='saved'&&input.savedBoards?
    {...currentBoards,...input.savedBoards}:currentBoards;
  const account={...payload.account,owned:{...payload.account.owned},boards,
    ranks:input.boards===undefined?saved.boardRanks??payload.account.ranks:payload.account.ranks};
  const current=order.map((card,index)=>{
    const {level,bloom,sp}=payload.account.owned[card.id]??saved.lineup[index];
    return account.owned[card.id]={owned:true,level:Math.min(card.maxLevel,level),bloom:Math.min(card.maxBloom,bloom),
      ...(sp==null?{}:{sp})};
  });
  if(unresolvedBoardEntries(data,account.boards))throw Error('The current catalog is missing entries from the saved Board setup.');
  if(Object.values(account.boards).some(board=>Object.values(board.cards).some(id=>!account.owned[id]&&!payload.options.boardConnectEntries?.[id])))
    throw Error('A card assigned to a Connect slot is missing from your current collection.');
  const selection={eventId:saved.eventId,eventChapter:saved.eventChapter,eventPoints:options.eventPoints,pcGameCharts:saved.pc,
    memoryEffect:measuredMemoryEffect(data,payload.options.memories,input.memoryBonusPermil)};
  const jobData=await dataFor(selection);
  const unitMode=saved.objective==='unitScore',ratingMode=saved.objective==='holomemLb';
  const selected=unitMode?[]:saved.charts.length?saved.charts.map(({songId,difficulty})=>{
    const song=jobData.songs.find(song=>song.id===songId);
    const chart=song?.difficulties.find(chart=>chart.type===difficulty&&chart.seconds>0);
    if(!chart)throw Error('A saved song or difficulty is unavailable in this catalog.');
    return {song,chart};
  }):referenceRangeCharts(jobData,options);
  if(!unitMode&&!selected.length)throw Error('No charts match the saved range.');
  const stage=saved.objective==='challengeLive'?await requireChallengeStage(saved.challengeStageId,await rangeResources()):null;
  if(stage&&(saved.pc||saved.charts.length!==1||!stage.songIds.includes(selected[0].song.id)))
    throw Error('The saved chart is outside this Challenge Live stage.');
  const gameOnly=selected.some(({chart})=>chart.gameOnly);
  const noteResources=!saved.pc&&!saved.charts.length&&saved.objective==='score'&&input.reviewedMobile!==false&&
    !input.preferWebsiteMobile?await rangeResources():null;
  const referenceData=saved.pc||noteResources?jobData:withoutGameOnlyCharts(jobData);
  const referenceCharts=saved.pc||noteResources?selected:selected.filter(({chart})=>!chart.gameOnly);
  const seconds=options.eventPoints?await eventSongSeconds(jobData,options):0;
  const contexts=new Map();
  const ratingContexts=new WeakMap();
  const entriesFor=lineup=>Object.fromEntries(order.map((card,index)=>[card.id,{...lineup[index],owned:true}]));
  const ladderGain=(card,level)=>{
    let value=0;
    for(const [threshold,bonus] of jobData.powerUpLadder[card.cardLevelGroupId??'']??[]){if(level>=threshold)value=bonus;}
    return value;
  };
  const observed=payload.options.powerUpOverride;
  const starting=order.map(card=>ladderGain(card,payload.account.owned[card.id]?.level??0));
  const powerUp=lineup=>{
    if(saved.powerUpPreset!=='search')return observed;
    const gain=order.reduce((sum,card,index)=>sum+ladderGain(card,lineup[index].level)-starting[index],0);
    return Math.min(5000,Math.max(0,observed+gain));
  };
  const contextFor=(lineup,unit=false,website=false)=>{
    const key=unit+':'+website+':'+lineup.map(entry=>entry.bloom).join(',');
    let context=contexts.get(key);
    if(!context){
      const owned={...account.owned,...entriesFor(lineup)};
      context=unit?unitScoreContext(jobData,{...payload,account:{...account,owned}}):
        createReferenceScoreContext(website?referenceData:jobData,owned,account.boards,account.ranks,payload.options,account.dreamRank);
      if(contexts.size>=16)contexts.delete(contexts.keys().next().value);
      contexts.set(key,context);
    }
    for(const [index,card] of order.entries()){
      updateReferenceCardEntry(context,card,lineup[index]);
    }
    context.powerUp=powerUp(lineup);
    return context;
  };
  const evaluate=context=>evaluateReferenceTeam(context,order,saved.outfitId,saved.leaderChar);
  const charts=selected.map(({song,chart})=>({key:song.id+'_'+chart.type,level:chart.level,notes:chart.notes}));
  function ratingResult(scores) {
    const best=scores.map(({average,maximum},index)=>{
      const {song,chart}=selected[index];
      const score=saved.sortBy==='max'?maximum:average;
      return {songId:song.id,title:song.title,difficulty:chart.type,score,rating:Math.ceil(score/5000),average,maximum};
    }).sort((a,b)=>b.score-a.score);
    return {rating:best.slice(0,3).reduce((sum,song)=>sum+song.rating,0),ratingSongs:best,
      score:best[0].average,maxScore:best[0].maximum};
  }
  const unitScore=lineup=>evaluateUnitScore(contextFor(lineup,true),order,saved.outfitId,saved.leaderChar).displayUnitScore;
  function reference(lineup,includeUnit=false){
    const unit=unitMode||includeUnit?{displayUnitScore:unitScore(lineup)}:{};
    if(unitMode)return {...unit,effectWarnings:referenceMobileEffectWarnings(contextFor(lineup,true),order,saved.outfitId,saved.leaderChar)};
    if(saved.charts.length&&gameOnly&&!saved.pc)throw Error(gameChartCoverageError);
    if(!referenceCharts.length)throw Error(gameChartCoverageError);
    const context=contextFor(lineup,false,true);
    const effectWarnings=saved.pc?[]:referenceMobileEffectWarnings(context,order,saved.outfitId,saved.leaderChar);
    if(ratingMode){
      let charts=ratingContexts.get(context);
      if(!charts){
        charts=selected.map(({song,chart})=>withReferenceChart(context,song,chart));
        ratingContexts.set(context,charts);
      }
      const scores=charts.map(chart=>{
        chart.powerUp=context.powerUp;
        const result=evaluate(chart);
        return {average:result.score,maximum:result.maxScore};
      });
      return {...unit,...ratingResult(scores),effectWarnings};
    }
    const row=!saved.pc&&!saved.charts.length?mobileChartEvaluator(context,referenceCharts,noteResources)(order,saved.outfitId,saved.leaderChar):evaluate(context);
    const score=options.eventPoints?referenceEventPoints(row,seconds,input.liveBoost,input.holoPassport):row;
    return {...unit,score:score.score,maxScore:score.maxScore,rangeCoverage:score.rangeCoverage,eventPointsAvg:score.eventPointsAvg,eventPointsMax:score.eventPointsMax,effectWarnings};
  }
  async function reviewed(lineups,includeUnit=false){
    if(stage){
      const resources=await rangeResources(),bonus=challengeBonusPermil(stage,order);
      return lineups.map(lineup=>{
        const context=contextFor(lineup,false);
        const row=mobileChartEvaluator(context,selected,resources,bonus)(order,saved.outfitId,saved.leaderChar);
        if(!row.rangeCoverage?.perNote)throw Error('Mobile note scoring is unavailable for this Challenge Live chart.');
        const ordinary=bonus?mobileChartEvaluator(context,selected,resources)(order,saved.outfitId,saved.leaderChar):row;
        const displayUnitScore=unitScore(lineup);
        return {score:row.score,maxScore:row.maxScore,songScore:ordinary.score,songMaxScore:ordinary.maxScore,
          challengeBonusPermil:bonus,displayUnitScore,challengeUnitBonus:challengeUnitBonus(displayUnitScore,bonus),
          effectWarnings:referenceMobileEffectWarnings(context,order,saved.outfitId,saved.leaderChar)};
      });
    }
    if(unitMode||(!saved.pc&&(input.reviewedMobile===false||input.preferWebsiteMobile&&!gameOnly)))return null;
    try{
      const engine=await reviewedEngine(jobData,{...payload,account},input,charts,'The saved charts are outside reviewed Mobile coverage.');
      const event=await reviewedEventScoring(jobData,{...payload,account},input,cards,selection);
      return lineups.map(lineup=>{
        const context=contextFor(lineup,false);
        const row=evaluate(context);
        const effectWarnings=saved.pc?[]:referenceMobileEffectWarnings(context,order,saved.outfitId,saved.leaderChar,{reviewed:true});
        const entries=entriesFor(lineup);
        const team={...row,lineup,entries,powerUpOverride:powerUp(lineup)};
        const unit=includeUnit?{displayUnitScore:unitScore(lineup)}:{};
        if(ratingMode){
          const scores=engine.scoreCharts(team,charts.map(chart=>chart.key),saved.sortBy!=='max',includeUnit&&charts.length===1);
          return {...unit,...ratingResult(scores),activationComparison:scores.length===1?scores[0].activationComparison:null,effectWarnings};
        }
        const modeled=engine.score(team,includeUnit),score=event?event.score(row,modeled,entries):modeled;
        return {...unit,score:score.average,maxScore:score.maximum,eventPointsAvg:score.eventPoints?.eventPointsAvg,
          eventPointsMax:score.eventPoints?.eventPointsMax,activationComparison:modeled.activationComparison,effectWarnings};
      });
    }catch(error){
      if(saved.pc)throw steamCoverageError(error);
      if(saved.charts.length&&gameOnly)throw Object.assign(Error(gameChartCoverageError+' '+mobileCoverageMessage(error)),
        {activationComparison:error.activationComparison});
      return lineups.map(lineup=>{
        const fallback=reference(lineup,includeUnit);
        return {...fallback,...(includeUnit?{activationComparison:error.activationComparison}:{}),
          effectWarnings:[...new Set([mobileCoverageMessage(error),...fallback.effectWarnings])]};
      });
    }
  }
  return {current,reference,reviewed,powerUp};
}

async function scoreSavedLineup(saved,input) {
  const scorer=await prepareFixedLineup(saved,input);
  const reviewed=await scorer.reviewed([scorer.current],true);
  return reviewed?.[0]??scorer.reference(scorer.current,true);
}

self.addEventListener('message',async({data:message,ports})=>{
  if(message.type==='gpu-rating-device'||message.type==='gpu-rating-lane'){
    try{
      const queue=await import('./gpu-rating-queue');
      if(message.type==='gpu-rating-device')await queue.serveRatingDevice(ports);
      else {
        source=message.source;
        const {createGpuTeamOptimizer}=await import('./gpu-team-optimizer');
        const engine=await createGpuTeamOptimizer(await dataFor(message.selection),message.selection.objective,queue.ratingDeviceClient(ports[0]));
        queue.serveRatingLane(ports[1],engine);
      }
      notify('gpu-ready',{});
    }catch(error){notify('error',{message:error.message});}
    return;
  }
  let gpuSearch;
  try{
    if (message.type === 'review-details') {
      if(message.stream){
        const session={request:message.request,run:null,samples:newPreviewSamples()};
        previewSession=session;
        try{
          if(!message.team||!lastPreview)throw Error('The optimizer result is unavailable.');
          const preview=await resultPreview(lastPreview,message.team,message.chartKey,message.pc,true);
          if(session!==previewSession)return;
          if(!preview)throw Error('Some selected cards are outside the optimizer catalog.');
          Object.assign(session,preview);
          notifyPreview(session);
        }catch(error){
          if(session===previewSession)notify('review-details',{request:message.request,error:error.message,activationComparison:error.activationComparison});
        }
        return;
      }
      try {
        const team = lastReview?.rows[message.index];
        let details = team && lastReview.engine.details(team,team.reviewedScore.chartKey);
        const bonus=team?.reviewedScore.eventSongBonus;
        if(details&&bonus>0){
          const scale=value=>applyEventSongBonus(value,bonus);
          details={...details,minimum:scale(details.minimum),maximum:scale(details.maximum),
            average:scale(details.average),
            timeline:details.timeline.map(point=>({...point,score:scale(point.score)})),
          };
        }
        const preview=message.team&&lastPreview?await resultPreview(lastPreview,message.team,message.chartKey):null;
        notify('review-details', { request: message.request, ...preview, details:details??preview?.details });
      } catch (error) {
        notify('review-details', { request: message.request, error: error.message, activationComparison:error.activationComparison });
      }
      return;
    }
    if(message.type==='review-details-simulate'){
      const session=previewSession;
      if(!session||session.request!==message.request)return;
      if(message.action==='cancel')previewSession=null;
      else if(message.action==='stop'){session.run=null;notifyPreview(session);}
      else if(message.action==='rerun')runPreviewSimulation(session,'rerun',initialSimulationDuration);
      else if(message.action==='continue'&&simulationDurations.has(message.durationMs))
        runPreviewSimulation(session,'continue',message.durationMs);
      return;
    }
    if(message.type==='validate-catalog'){
      await verifyOptimizerPack(message.source);
      notify('validated',{});
      return;
    }
    if(message.type==='validate-mobile-scoring'){
      const {verifyMobileScoringRelease}=await import('./team-optimizer-resources');
      const release=await verifyMobileScoringRelease(message.source,message.previous);
      notify('validated',{revision:release.revision});
      return;
    }
    source=message.source??null;
    if(message.type==='catalog-coverage'){
      const ids=new Set((await activeData()).cards.map(card=>card.id));
      notify('catalog-coverage',{missing:message.cardIds.filter(id=>!ids.has(id)).length});
    }else if(message.type==='score-lineup'){
      try{notify('lineup-score',{score:await scoreSavedLineup(message.lineup,message.input)});}
      catch(error){notify('lineup-score',{error:error.message,activationComparison:error.activationComparison});}
    }else if(message.type==='catalog'){
      const localMetadata=file=>fetch(`/assets/team-optimizer/${file}.json`).then(response=>response.ok?response.json():{}).catch(()=>({}));
      const [updated,bundled]=await Promise.all([pack(),localMetadata('workspace')]);
      if(!bundled.bundledCardIds?.length)throw Error('The bundled optimizer workspace could not open.');
      const [events,unlocks,eventArt,eventTitles,data,resources]=await Promise.all([
        loadEvents(),loadSongUnlocks(),localMetadata('event-art'),localMetadata('event-titles'),activeData(),
        import('./team-optimizer-resources').then(module=>module.loadOptimizerResources(source?.mobile)),
      ]);
      const gameSongs=resources?.songs.map(song=>({...song,startTime:resources.previewSongStarts?.[song.id]}));
      const challengeStages=await loadChallengeStages(resources);
      notify('catalog',{...buildOptimizerWorkspace({data,events,unlocks,bundledCardIds:bundled.bundledCardIds,bundledSongIds:bundled.bundledSongIds,
        eventArt,eventTitles,updated,gameArtwork:source?.gameCatalog?.artwork,gameSongs,
        gameReleaseId:resources?.releaseId,
        nextSongRelease:Number.isFinite(nextGameSongRelease)?nextGameSongRelease:undefined}),challengeStages});
    }else if(message.type==='challenge-song'){
      const rows=await challengeSongJob(await dataFor(message.selection),message.payload,message.songId,message.difficulties,message.useGpu,
        (done,total)=>notify('shard-progress',{fraction:done/total}));
      notify('shard-result',{response:rows});
    }else if(message.type==='range-finalist'){
      const data=await dataFor(message.selection);
      notify('shard-result',{response:finalizeMobileSetup(data,message.payload,message.seed,await rangeResources())});
    }else if(message.type==='gpu-board-shard'){
      const data=await dataFor(message.selection);
      if(shardGpuData!==data){
        shardGpuSearch?.close();
        shardGpuSearch=null;
        shardGpuData=null;
        const {createGpuTeamOptimizer}=await import('./gpu-team-optimizer');
        shardGpuSearch=await createGpuTeamOptimizer(data,message.selection.objective);
        shardGpuData=data;
      }
      notify('shard-result',{response:await shardGpuSearch.plan(message.payload)});
    }else if(message.type==='shard'){
      const data=await dataFor(message.selection);
      let response;
      try{
        response=await runCpuJob(data,message.operation,message.payload,(phase,fraction)=>notify('shard-progress',{phase,fraction}));
      }catch(error){
        if(hasBoardProtection(message.payload.boardOpt))throw error;
        if(message.operation==='_hd_plan')response={plan:null};
        else if(message.operation==='_hd_neighbors')response={results:[]};
        else throw error;
      }
      notify('shard-result',{response});
    }else if(message.type==='search'){
      lastReview=null;
      lastPreview=null;
      previewSession=null;
      const input=message.input;
      const data=await activeData();
      const unitMode=input.objective==='unitScore';
      const payload=prepareReferenceSearch(data,unitMode?{...input,chartKey:'',options:{
        ...input.options,scoringMode:'generic',songId:null,difficulty:'',pc:false,
        anyDiffMin:1,anyDiffMax:999,anyDiffTypes:undefined,eventBonus:false,eventPoints:false,sortBy:'avg',
      }}:input);
      const {options}=payload;
      for(const owner of input.protectedSavedOwners??[]){
        const {account,boardOpt}=payload;
        const board=account.boards[owner],nodes=data.boards[owner];
        const name=data.cards.find(card=>card.characterId===owner)?.character??owner;
        const rank=boardOpt.maxBoardPoints?data.boardPointLadder.length-1:account.ranks[owner]??(boardOpt.allInvited?1:0);
        const state=nodes&&board&&boardReachability(nodes,board,account.dreamRank);
        if(!state||board.nodes.some(id=>!state.active.has(id))||Object.keys(board.cards).some(id=>!state.active.has(id)))
          throw Error(`${name}’s protected saved Board contains unavailable nodes or Connect slots.`);
        if(state.spent>boardPointsAtRank(data.boardPointLadder,rank))
          throw Error(`${name}’s protected saved Board exceeds the current Board Point budget.`);
      }
      const cardIds=new Set(data.cards.map(card=>card.id));
      const excluded=input.cards.filter(card=>!cardIds.has(card.cardId)).length;
      const unresolved=unresolvedBoardEntries(data,payload.account.boards);
      const boardWarnings=unresolved ? [`${unresolved} imported Board entries are missing from the optimizer catalog. Board estimates may be incomplete.`] : [];
      const notes=[],notices=[];
      const searchNotice=message=>{
        if(!notices.includes(message))notices.push(message);
        if(!notes.includes(message))notes.push(message);
      };
      const onUnverified=error=>{
        const message='Some proposed lineups were omitted. '+(options.pc?steamCoverageMessage(error):mobileCoverageMessage(error));
        searchNotice(message);
      };
      if(payload.boardOpt&&!payload.boardOpt.maxBoardPoints&&!payload.boardOpt.ignoreExisting){
        const mismatches=boardBudgetMessages(data,payload.account,input);
        if(mismatches.length)boardWarnings.push(`Board Points do not reconcile for ${mismatches.join(', ')}. Check current ranks and Boards in Progress, and catalog updates in Settings.`);
      }
      let selection={objective:input.objective,eventId:options.eventBonus||options.eventPoints?input.eventId:undefined,
        eventChapter:input.eventChapter,eventPoints:options.eventPoints,
        memoryEffect:measuredMemoryEffect(data,options.memories,input.memoryBonusPermil)};
      if((options.eventBonus||options.eventPoints)&&!selection.eventId)throw Error('Choose an event first.');
      if(options.eventPoints&&selection.eventChapter==null){
        const event=(await loadEvents()).find(row=>row.id===selection.eventId);
        selection.eventChapter=automaticChapter(event?.epBonus?.chapters??[],Date.now())?.number;
      }
      let completion=0,previousPhase;
      const progress=(evaluated,total,fraction,phase)=>{
        completion=Math.max(completion,Math.min(.99,fraction||0));
        previousPhase=phase??previousPhase;
        notify('progress',{evaluated,total,fraction:completion,phase:previousPhase});
      };
      let jobData=await dataFor(selection);
      const previewData=jobData;
      if(input.objective==='challengeLive'){
        const result=await runChallengeSearch(jobData,payload,input,selection,ports,progress);
        lastPreview={data:jobData,payload,input,previewData};
        notify('result',{...result,unresolved,excluded,notes,notices,boardWarnings});
        return;
      }
      if(options.pc){
        selection={...selection,pcGameCharts:true};
        jobData=await dataFor(selection);
      }
      const chart=options.scoringMode==='chart'?selectedChart(jobData,options):null;
      if(options.scoringMode==='chart'&&!chart)throw Error('The selected chart is unavailable in the local optimizer catalog.');
      const gameOnly=chart?.gameOnly===true;
      const websiteMobile=input.preferWebsiteMobile&&!options.pc;
      const mobileRange=websiteMobile&&options.scoringMode==='generic'&&referenceRangeCharts(jobData,options).some(({chart})=>chart.gameOnly);
      const wantsReviewed=input.reviewedMobile===true&&(!websiteMobile||gameOnly||mobileRange)&&['chart','generic'].includes(options.scoringMode)&&
        ['score','event','eventPoints'].includes(input.objective)&&['best','holomem','next'].includes(options.goal);
      const wantsMobileRating=input.reviewedMobile===true&&!options.pc&&input.objective==='holomemLb'&&
        (!websiteMobile||(input.ratingLeaderIds??[options.leaderChar]).some(leader=>
          referenceRatingCandidates(jobData,input,leader).some(({charts})=>charts.some(chart=>chart.gameOnly))))&&
        ['best','holomem','next'].includes(options.goal);
      if(gameOnly&&!options.pc&&!wantsReviewed)throw Error(gameChartCoverageError);
      const pcGameEstimate=options.pc&&(chart?.gameOnly||options.scoringMode==='generic'&&
        referenceRangeCharts(jobData,options).some(({chart})=>chart.gameOnly));
      const createGpu=async()=>{
        if(input.objective==='holomemLb'&&input.ratingLeaderIds?.length>1){
          const {createGpuRatingPool}=await import('./gpu-rating-queue');
          const fastHost=(navigator.hardwareConcurrency||4)>=6&&input.ratingLeaderIds.length>=4;
          const lanes=[1,2,4].includes(input.gpuRatingLanes)?input.gpuRatingLanes:fastHost?4:2;
          return createGpuRatingPool(selection,source,lanes,message.gpuHost?(request,ports)=>
            postMessage({type:'gpu-worker',request},ports):undefined);
        }
        const {createGpuTeamOptimizer}=await import('./gpu-team-optimizer');
        return createGpuTeamOptimizer(jobData,input.objective);
      };
      const websiteOnly=async()=>{
        if(withoutGameOnlyCharts(jobData)===jobData)return;
        if(!options.pc&&input.objective!=='unitScore'){
          const omitted=input.objective==='holomemLb'
            ?new Set((input.ratingLeaderIds??[options.leaderChar]).flatMap(leader=>referenceRatingCandidates(jobData,input,leader)
              .flatMap(({song,charts})=>charts.filter(chart=>chart.gameOnly).map(chart=>song.id+'_'+chart.type)))).size
            :options.scoringMode==='generic'?referenceRangeCharts(jobData,options).filter(({chart})=>chart.gameOnly).length:0;
          if(omitted)searchNotice(`The Mobile reference estimate excludes ${omitted} selected ${omitted===1?'chart':'charts'} outside its catalog.`);
        }
        selection={...selection,websiteSongsOnly:true};
        jobData=await dataFor(selection);
        if(input.useGpu){
          gpuSearch?.close();
          gpuSearch=await createGpu();
          gpuSearches.set(selection,gpuSearch);
        }
      };
      if(!options.pc&&!wantsReviewed&&!wantsMobileRating){
        selection={...selection,websiteSongsOnly:true};
        jobData=await dataFor(selection);
      }
      if(websiteMobile)input.mobileChartRange=!!(mobileRange||wantsMobileRating);
      lastPreview={data:jobData,payload,input,previewData};
      let compute;
      if(input.useGpu){
        progress(0,1,0,'Starting GPU search');
        gpuSearch=await createGpu();
        gpuSearches.set(selection,gpuSearch);
        notify('search-backend',{backend:'gpu'});
        progress(0,1,0,'Finding teams');
      }else{
        notify('search-backend',{backend:'cpu'});
      }
      if(selection.eventId){
        const song=jobData.songs.find(row=>row.id===options.songId);
        if(options.scoringMode!=='chart'||!song||!song.difficulties.some(chart=>chart.type===options.difficulty&&chart.seconds>0))
          throw Error('Choose a playable song and difficulty for this event search.');
        if(options.eventBonus&&!Object.hasOwn(jobData.eventBonus.songs,song.id))
          throw Error('This song is outside the selected event. Choose an event song.');
      }
      if(unitMode){
        const next=options.goal==='next';
        const focusCardIds=payload.extras.nextDeck??[];
        const current=next?{...payload,options:{...options,cardPool:'owned',
          goal:focusCardIds.length?'holomem':'best',focusCardIds}}:payload;
        if(next)progress(0,1,0,'Finding your current best Unit Score');
        const candidates=await searchUnitScoreRows(jobData,current,selection,progress,ports);
        const ordered=finalizeUnitScoreOrders(jobData,current,candidates);
        const planned=await planUnitScoreRows(jobData,current,ordered,selection,progress,ports);
        const ranked=current.boardOpt?finalizeUnitScoreOrders(jobData,current,planned):ordered;
        let result={results:ranked};
        if(next){
          progress(0,1,0,'Finding Unit Score upgrades');
          const currentUnitTeams=ranked.slice(0,5).map(({order,outfitId,displayUnitScore})=>({order,outfitId,displayUnitScore}));
          const upgrades={...payload,currentUnitTeams,currentUnitPlan:ranked[0]?.plan};
          if(gpuSearch)[result]=await solveShards(upgrades,selection,progress,ports);
          else result=await (await cpuPlanner(jobData,'unitScore')).solveNext(upgrades,async()=>ranked);
          result={...result,results:finalizeUnitScoreOrders(jobData,payload,result.results)};
        }
        const rows=result.results.slice(0,options.topN).map(team=>({...team,score:undefined,maxScore:undefined,unitScore:undefined}));
        if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
        notify('result',{results:teamsForUi(data,rows,payload),baseline:result.baseline,excluded,boardWarnings,compute});
        return;
      }
      const runFallback=job=>runCpuJob(jobData,job.operation,job.payload);
      const runBoard=async(responses,query)=>{
        if(hasBoardProtection(query.boardOpt)){
          const candidates=collectBoardFinalists(responses,query.options).slice(0,Math.max(24,query.options.topN));
          const plans=await planReferenceRows(query,candidates,selection,progress,ports);
          const score=query.options.sortBy==='max'?'maxScore':'score';
          return candidates.map((row,index)=>plans[index]?{...row,...plans[index].after,plan:plans[index]}:row)
            .sort((a,b)=>b[score]-a[score]).slice(0,query.options.topN);
        }
        return optimizeReferenceBoards(responses,query,{
        workerCount:ports.length,
        runJob:(slot,job)=>sendJob(ports[slot],{type:'shard',selection,...job},()=>{}),
        runFallback,onProgress:progress,
        });
      };
      if(input.objective==='holomemLb'){
        const driver={
          reusePlans:!!gpuSearch,
          rankFundedTeams:gpuSearch?.rankFundedTeams,
          ...(gpuSearch&&{refine:async jobs=>(await runJobs(jobs.map(({query,row,donorLayouts,quality})=>({
            operation:'_hd_plan',payload:{...query,options:{...query.options,leaderMode:'fixed'},
              team:row.order,outfitId:row.outfitId,leaderChar:row.leaderChar,seedBoards:row.plan.saves,
              donorLayouts,generalist:true,qualityRefine:quality},
          })),selection,()=>{},ports)).map(result=>result.plan)}),
          solve:async(query,ratingProgress=progress,{rawJoint=false}={})=>{
            const responses=await solveShards(query,selection,ratingProgress,ports);
            if(gpuSearch){
              const rows=responses[0]?.results??[];
              return query.boardOpt||query.ratingScout?rows:gpuSearch.rankResults(query,rows);
            }
            if(query.limits.jointBoards)return rawJoint?collectBoardFinalists(responses,query.options):runBoard(responses,query);
            return mergeReferenceResults(responses,query.options);
          },
          plan:(query,rows,ratingProgress=progress,{maxRows=rows.length,fullCount}={})=>
            planReferenceRows(query,rows.slice(0,maxRows),selection,ratingProgress,ports,
              gpuSearch?Math.min(5,fullCount??maxRows):fullCount),
          onProgress:progress,
        };
        const ratingInput={...input,ratingNow:input.ratingNow??Date.now()};
        const displayRating=(rating,query,mobile)=>{
          const displayRows=rows=>withDisplayUnitScores(jobData,query,teamsForUi(data,mobile?rows.map(reviewedResultScores):rows,query)).map(team=>{
            if(!mobile)return team;
            const reviewIndex=lastReview.rows.push(mobile.team(team))-1;
            return {...team,reviewIndex};
          });
          return {...rating,results:displayRows(rating.results),
            ratingGroups:rating.ratingGroups.map(group=>({...group,results:displayRows(group.results)}))};
        };
        if(input.ratingLeaderIds){
          const names=new Map(data.cards.map(card=>[card.characterId,card.character]));
          const leaders=[...new Set(input.ratingLeaderIds)].filter(id=>names.has(id));
          if(!leaders.length)throw Error('No Holomems match the leader filter.');
          const total=leaders.length;
          const requested=Number.isInteger(input.ratingQuickLimit)&&input.ratingQuickLimit>0?input.ratingQuickLimit:0;
          const limit=Math.min(total,requested);
          const batchPayload={...payload,options:{...options,leaderMode:'auto',outfitId:null}};
          const runBatch=async mobile=>{
            lastPreview={data:jobData,payload:batchPayload,input,previewData};
            lastReview=mobile?{engine:mobile.engine,rows:[]}:null;
            const ratingLeaders=[];
            const concurrency=gpuSearch?.leaderConcurrency??1;
            const summary={ratingLeaders,leaderTotal:total,results:[],ratingGroups:[],byMax:options.sortBy==='max',
              excluded,notes,notices,boardWarnings,scoringModel:mobile?(options.pc?'steam':'mobile'):'website'};
            if(limit)summary.quickTop={limit:requested,screened:null};
            notify('rating-batch',summary);
            let finalists=leaders.map(leaderId=>({leaderId,candidateCharts:referenceRatingCandidates(jobData,ratingInput,leaderId)}));
            const queryFor=leaderId=>({...batchPayload,options:{...batchPayload.options,leaderChar:leaderId}});
            if(limit){
              const screened=[];
              const scout={
                solve:query=>driver.solve(query,()=>{}),
                plan:(query,rows)=>planReferenceRows(query,rows,selection,()=>{},ports,undefined,true),mobile,
              };
              let scanned=0;
              progress(0,total,0,'Screening leaders');
              await eachLeader(finalists,concurrency,async(row,index)=>{
                if(row.candidateCharts.length)screened[index]={...row,
                  forecast:await forecastRating(jobData,queryFor(row.leaderId),ratingInput,row.candidateCharts,scout)};
                progress(++scanned,total,.2*scanned/total,`Screening leaders · ${scanned} of ${total}`);
              });
              finalists=shortlistRatingLeaders(screened.filter(Boolean),limit,input.ratingPlacementRows);
              summary.quickTop.screened=total;
              summary.leaderTotal=finalists.length;
              notify('rating-batch',summary);
            }
            let completedWork=0;
            const start=limit ? .2 : 0;
            await eachLeader(finalists,concurrency,async({leaderId,candidateCharts})=>{
              const name=names.get(leaderId);
              let leaderProgress=0,previousStage;
              const update=phase=>progress(ratingLeaders.length,finalists.length,
                start+(1-start)*completedWork/finalists.length,phase);
              const report=(done,jobs,fraction,phase)=>{
                const next=Math.max(leaderProgress,Math.min(.99,fraction||0));
                if(next===leaderProgress&&phase===previousStage)return;
                completedWork+=next-leaderProgress;
                leaderProgress=next;
                previousStage=phase;
                update(`${name}${phase?' · '+phase:''}`);
              };
              update(name);
              const row={leaderId,name};
              if(candidateCharts.length){
                const query=queryFor(leaderId);
                const rating=await searchReferenceRating(jobData,query,{...ratingInput,leaderCharacterId:leaderId},{
                  ...driver,candidateCharts,onProgress:report,prepareMobile:mobile?()=>mobile:undefined,
                });
                if(rating.results.length||rating.ratingGroups.length)Object.assign(row,displayRating(rating,query,mobile));
                else row.status='No matching team';
              }else row.status='No eligible charts';
              ratingLeaders.push(row);
              notify('rating-leader',{leader:row});
              completedWork+=1-leaderProgress;
            });
            if(gpuSearch)summary.compute={backend:'gpu',...gpuSearch.metrics()};
            notify('result',summary);
          };
          if(wantsMobileRating){
            try{
              const charts=new Map();
              for(const leader of leaders)for(const {song,charts:candidates} of referenceRatingCandidates(jobData,ratingInput,leader)){
                for(const chart of candidates){
                  const key=song.id+'_'+chart.type;
                  charts.set(key,{key,level:chart.level,notes:chart.notes});
                }
              }
              if(charts.size){
                const mobile=await prepareMobileRating(jobData,batchPayload,input,[...charts.values()],selection,ports,onUnverified);
                await runBatch(mobile);
                return;
              }
            }catch(error){
              if(!(error instanceof MobileCoverageError))throw error;
              if(options.pc)throw steamCoverageError(error);
              notes.push(mobileCoverageMessage(error));
              completion=0;
              progress(0,total,0,'Searching with score estimates');
            }
          }
          await websiteOnly();
          await runBatch(null);
          return;
        }
        let rating,mobile;
        if(wantsMobileRating){
          try {
            rating=await searchReferenceRating(jobData,payload,ratingInput,{...driver,prepareMobile:async charts=>{
              mobile=await prepareMobileRating(jobData,payload,input,charts,selection,ports,onUnverified);
              return mobile;
            }});
          }catch(error){
            if(!(error instanceof MobileCoverageError))throw error;
            if(options.pc)throw steamCoverageError(error);
            mobile=null;
            notes.push(mobileCoverageMessage(error));
            progress(0,1,0,'Searching with score estimates');
          }
        }
        if(!rating){
          await websiteOnly();
          lastPreview={data:jobData,payload,input,previewData};
          const key=referenceRatingKey(payload,input);
          rating=!gpuSearch&&lastReferenceRating?.key===key?lastReferenceRating.result:
            await searchReferenceRating(jobData,payload,ratingInput,driver);
          if(!gpuSearch)lastReferenceRating={key,result:rating};
        }
        if(mobile)lastReview={engine:mobile.engine,rows:[]};
        if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
        notify('result',{...displayRating(rating,payload,mobile),excluded,notes,notices,boardWarnings,compute,
          scoringModel:mobile?(options.pc?'steam':'mobile'):'website'});
        return;
      }
      if(wantsReviewed){
        try{
          const mobile=await runReviewedMobile(jobData,payload,input,selection,progress,ports,onUnverified);
          if(mobile){
            if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
            notify('result',{...mobile,scoringModel:options.pc?'steam':'mobile',unresolved,excluded,notes,notices,boardWarnings,compute});
            return;
          }
          if(options.pc)throw new MobileCoverageError('No eligible lineup has a verified Steam chart score.');
        }catch(error){
          if(!(error instanceof MobileCoverageError))throw error;
          if(options.pc)throw steamCoverageError(error);
          if(gameOnly&&!options.pc)throw Error(`${gameChartCoverageError} ${mobileCoverageMessage(error)}`);
          notes.push(mobileCoverageMessage(error));
          progress(0,1,0,options.pc?'Searching with PC estimates':'Searching with score estimates');
        }
      }
      if(gameOnly&&!options.pc)throw Error(gameChartCoverageError);
      const perNote=wantsReviewed&&!options.pc&&!websiteMobile&&input.objective==='score'&&options.scoringMode==='generic';
      if(!options.pc&&!perNote)await websiteOnly();
      if(options.scoringMode==='generic'&&(options.pc||jobData!==previewData)&&referenceRangeCharts(jobData,options).length===0)
        throw Error('Verified Mobile scoring is unavailable for this chart range with the selected setup.');
      lastPreview={data:jobData,payload,input:{...input,preferWebsiteMobile:true,mobileChartRange:false},previewData};
      async function referenceFinalists(request){
        const query=options.pc?request:{...request,options:{...request.options,topN:Math.max(6,request.options.topN)}};
        const responses=await solveShards(query,selection,progress,ports);
        const merged=mergeReferenceResults(responses,query.options);
        let seeds;
        if(gpuSearch){
          seeds=await gpuSearch.rankResults(query,responses[0]?.results??[]);
          if(query.boardOpt&&query.options.goal!=='next'){
            seeds=seeds.slice(0,Math.max(8,query.options.topN));
            const plans=await planReferenceRows(query,seeds,selection,progress,ports,Math.min(6,seeds.length));
            seeds=seeds.map((row,index)=>plans[index]?{...row,...plans[index].after,plan:plans[index]}:row);
          }
        }else if(query.limits.jointBoards)seeds=await runBoard(responses,query);
        else seeds=responses.flatMap(response=>response.results??[]);
        const rows=options.pc?mergeReferenceResults([{results:seeds}],request.options).results:
          await finalizeReferenceOrders(jobData,request,seeds,progress,ports,selection,perNote);
        return {rows,baseline:merged.baseline,evaluated:responses.length};
      }
      let {rows,baseline,evaluated}=await referenceFinalists(payload);
      if(!options.pc&&options.goal==='next'&&input.objective==='score'&&baseline>0){
        const focusCardIds=payload.extras.nextDeck??[];
        const current=await referenceFinalists({...payload,limits:{...payload.limits,jointBoards:!!payload.boardOpt},
          options:{...options,cardPool:'owned',goal:focusCardIds.length?'holomem':'best',focusCardIds,topN:1}});
        baseline=current.rows[0]?.[options.sortBy==='max'?'maxScore':'score']??null;
      }
      if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
      if(options.eventPoints){
        const seconds=await eventSongSeconds(data,options);
        const cards=new Map(data.cards.map(card=>[card.id,card]));
        rows=rows.map(row=>{
          const perCard=referenceEventCardBonuses(jobData.epBonus,row.order.map(id=>cards.get(id)),
            id=>row.pulls?.find(pull=>pull.id===id)?.bloom??payload.account.owned[id]?.bloom??0);
          const plan=row.plan;
          const displayPlan=plan&&[plan.before,plan.after].every(side=>Number.isFinite(side?.epPermil))?
            {...plan,presentationBefore:referenceEventPoints(plan.before,seconds,input.liveBoost,input.holoPassport),
              presentationAfter:referenceEventPoints(plan.after,seconds,input.liveBoost,input.holoPassport)}:plan;
          return {...row,...referenceEventPoints(row,seconds,input.liveBoost,input.holoPassport),
            ...(displayPlan?{plan:displayPlan}:{}),eventCardBonuses:perCard.reduce((sum,value)=>sum+value,0)===row.epPermil?perCard:null};
        });
      }
      const results=withDisplayUnitScores(jobData,payload,teamsForUi(data,rows.slice(0,options.topN),payload));
      notify('result',{results,baseline,reviewedCount:0,scoringModel:results[0]?.rangeCoverage?.perNote?'mobile-per-note-estimate':
        pcGameEstimate?'game-pc-estimate':'website',
        evaluated,unresolved,excluded,notes,notices,boardWarnings,compute});
    }
  }catch(error){notify('error',{message:error instanceof Error?error.message:String(error),activationComparison:error?.activationComparison,
    ...(error?.name==='OptimizerGpuError'?{code:'gpu'}:{})});}
  finally{
    gpuSearch?.close();
    for(const port of ports)port.close();
  }
});
