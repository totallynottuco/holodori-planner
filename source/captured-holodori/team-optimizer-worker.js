import {buildOptimizerWorkspace} from './optimizer-workspace-data';
import {collectBoardFinalists,hasBoardBonusTargets,loadReferenceData,measuredMemoryEffect,mergeReferenceResults,prepareReferenceSearch,referenceEventPointBase,referenceEventPoints,runReferenceJob,unresolvedBoardEntries} from './reference-team-solver';
import {optimizeReferenceBoards} from './reference-board-search';
import {searchReferenceRating} from './reference-holomem-rating';
import {createReferenceScoreContext,evaluateReferenceTeam,referenceCardStats,referenceRangeCharts,referenceTeamScoreBonus,referenceUnitScore,withReferenceChart} from './reference-rating-math';
import {compareUnitScore,evaluateUnitScore,searchUnitScore,unitScoreContext} from './unit-score-search';
import {boardPointsAtRank,boardReachability,improveUnitScoreBoards} from './unit-score-board-search';
import {optimizerPack,verifyOptimizerPack} from './optimizer-catalog-data';
import {applyEventSongBonus,automaticChapter,normalizeOptimizerEvents,overlayGameOptimizerEvents,referenceEventCardBonuses,referenceEventSongBonus} from './optimizer-events';
import {MobileCoverageError,searchReviewedMobile} from './reviewed-mobile-search';
import {overlayGameOptimizerCards} from './game-optimizer-cards';
import {hasGpuBoardBonusTargets} from './gpu-board-bonus-targets';
import {decodeChartGeometry} from './optimizer-chart-hit-events.js';
import {boardPlanningBaseline,hasBoardProtection} from './board-protection';
import bundledChartGeometry from '../hololive/scoring-reviewed/optimizer-preview-geometry.json';

let source=null;
let lastReview=null;
let lastPreview=null;
let previewSession=null;
let lastReferenceRating=null;
const gpuSearches=new WeakMap();
const cpuBoardPlanners=new WeakMap();
async function runCpuJob(data,operation,payload,onProgress){
  const {account,boardOpt,options}=payload;
  const filtered=operation==='_hd_solve'&&options.goal==='next'&&payload.extras.nextAcquisition;
  if(!filtered&&!hasBoardProtection(boardOpt))return runReferenceJob(data,operation,payload,onProgress);
  const lineupJob=(query,progress)=>runReferenceJob(data,'_hd_solve',{
    ...query,boardOpt:null,limits:{...query.limits,jointBoards:false},
    account:{...query.account,boards:boardPlanningBaseline(query.account.boards,query.boardOpt)},
  },progress);
  if(operation==='_hd_solve'&&options.goal!=='next'){
    return lineupJob({...payload,options:{...options,topN:Math.max(24,options.topN)}},onProgress);
  }
  const objective=boardOpt?.objective??payload.extras?.objective;
  let planners=cpuBoardPlanners.get(data);
  if(!planners){planners=new Map();cpuBoardPlanners.set(data,planners);}
  if(!planners.has(objective)){
    planners.set(objective,import('./gpu-team-optimizer').then(module=>module.createCpuBoardPlanner(data,objective)));
  }
  const planner=await planners.get(objective);
  if(operation==='_hd_plan')return planner.plan(payload);
  if(operation==='_hd_solve'){
    return planner.solveNext(payload,async query=>(await lineupJob(query,onProgress)).results??[]);
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
      if(!song.difficulties.some(chart=>chart.gameOnly))return [song];
      const difficulties=song.difficulties.flatMap(chart=>!chart.gameOnly?[chart]:
        chart.pcCurve?[{...chart,curve:chart.pcCurve}]:[]);
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
      const base=(await optimizerPack(selected).catch(()=>null))?.data??await loadReferenceData();
      if(!selected?.mobile)return base;
      const [{loadOptimizerResources},{overlayGameOptimizerSongs,nextGameOptimizerSongRelease}]=await Promise.all([
        import('./team-optimizer-resources'),import('./game-optimizer-songs'),
      ]);
      const resources=await loadOptimizerResources(selected.mobile);
      if(gameDataKey===key)nextGameSongRelease=nextGameOptimizerSongRelease(resources,now);
      const data=selected.gameCatalog?overlayGameOptimizerCards(base,resources,selected.gameCatalog):base;
      return overlayGameOptimizerSongs(data,resources,now);
    })().catch(error=>{if(gameDataKey===key)gameDataKey=undefined;throw error;});
  }
  return gameDataRequest;
}
let eventsRequest;
let songUnlocksRequest;
async function loadSongUnlocks() {
  const updated=await pack();
  if(updated)return updated.unlocks;
  songUnlocksRequest??=fetch('/assets/team-optimizer/song-unlocks.json').then(response=>{
    if(!response.ok)throw Error('Unable to load song unlock rules.');
    return response.json();
  }).catch(error=>{songUnlocksRequest=undefined;throw error;});
  return songUnlocksRequest;
}
async function loadEvents() {
  const updated=await pack();
  eventsRequest??=fetch('/assets/team-optimizer/optimizer-events.json').then(response=>{
    if(!response.ok)throw Error('Unable to load optimizer events.');
    return response.json();
  }).then(value=>value.events);
  const bundled=await eventsRequest;
  const base=normalizeOptimizerEvents([...(updated?.events.events??[]),...bundled]);
  if(!source?.mobile)return base;
  const {loadOptimizerResources}=await import('./team-optimizer-resources');
  return overlayGameOptimizerEvents(base,await loadOptimizerResources(source.mobile));
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
function solveShards(payload,selection,onProgress,ports) {
  const singleNext=payload.options.goal==='next'&&(payload.extras.nextAcquisition||hasBoardProtection(payload.boardOpt));
  const count=gpuSearches.has(selection)||singleNext?1:logicalShardCount();
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
async function planReferenceRows(payload,rows,selection,onProgress,ports,fullCount) {
  const {options,account,boardOpt}=payload;
  const gpu=gpuSearches.has(selection);
  const scoreKey=options.sortBy==='max'?'maxScore':'score';
  const jobs=(indices,lite,previews)=>indices.map(index=>{
    const row=rows[index];
    const fixed=(gpu||hasBoardProtection(boardOpt))&&row.outfitId;
    const order=(row.activeSpecialist?previews?.[index]?.plan?.after?.order:null)??row.order;
    return {operation:'_hd_plan',payload:{
      account,options:fixed?{...options,leaderMode:'fixed'}:options,
      team:order,leaderChar:row.leaderChar,
      ...(gpu&&row.activeSpecialist?{activeSpecialist:true}:{}),
      outfitId:fixed||(options.leaderMode==='fixed'?options.outfitId:null),
      boardOpt:{...boardOpt,litePlan:lite},
    }};
  });
  const progress=(done,total,fraction)=>onProgress(done,total,fraction,'Planning Boards');
  const indices=rows.map((_,index)=>index);
  if(gpu?hasGpuBoardBonusTargets(boardOpt.keep?.targets??{}):hasBoardBonusTargets(boardOpt)){
    const full=await runJobs(jobs(indices,false),selection,progress,ports);
    return full.map(response=>response.plan??null);
  }
  const lite=await runJobs(jobs(indices,true),selection,progress,ports);
  const gpuRating=gpu&&options.lbCharts?.length;
  const score=plan=>(gpu?plan?.after?.value:plan?.after?.[scoreKey])??-1;
  const refine=lite.map((response,index)=>({index,value:score(response.plan)}))
    .filter(row=>row.value>=0).sort((a,b)=>b.value-a.value).slice(0,fullCount??Math.max(12,options.topN));
  if(gpuRating){
    const active=rows.flatMap((row,index)=>row.activeSpecialist&&score(lite[index]?.plan)>=0?[{row,index}]:[]);
    // The short Board pass cannot realize deeper Active Chance branches.
    // Give nominated lineups a full pass even if their preview ranks lower.
    const slots=Math.min(2,active.length,refine.length);
    for(const {index} of active.slice(0,slots)){
      if(refine.some(row=>row.index===index))continue;
      const replace=refine.findLastIndex(({index})=>!rows[index].activeSpecialist);
      if(replace>=0)refine[replace]={index};
    }
  }
  const full=await runJobs(jobs(refine.map(row=>row.index),false,lite),selection,progress,ports);
  const plans=lite.map(response=>response.plan??null);
  refine.forEach(({index},position)=>{
    if(score(full[position]?.plan)>=score(plans[index])&&full[position]?.plan)plans[index]=full[position].plan;
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

function mobileRoster(data,account,context) {
  return data.cards.filter(card=>account.owned[card.id]?.owned)
    .map(card=>({id:card.id,power:Object.values(context.stats.get(card.id)).reduce((sum,value)=>sum+value,0)}))
    .sort((a,b)=>b.power-a.power).map(card=>card.id);
}

function nextPulls(row) {
  return row.pulls?.length?row.pulls:row.candidateId?[{id:row.candidateId,new:true,copies:1}]:[];
}

function nextScenarioKey(row) {
  return nextPulls(row).map(({id,new:acquired,copies,level,bloom})=>JSON.stringify([id,acquired,copies,level,bloom]))
    .sort().join('|');
}

function nextCardEntry(card,extras,pull,base) {
  if(pull.level>=0)return {level:pull.level,bloom:pull.bloom,...(!pull.new&&base?.sp!=null?{sp:base.sp}:{})};
  return {level:extras.nextLevel>0?Math.min(extras.nextLevel,card.maxLevel):card.maxLevel,
    bloom:Math.min(extras.nextBloom??0,card.maxBloom)};
}

function mobileTeam(row,payload,cards) {
  const {account,options,extras}=payload;
  if(options.goal!=='next')return {...row,lineup:row.order.map(id=>account.owned[id])};
  const entries={};
  for(const pull of nextPulls(row)){
    const card=cards.get(pull.id);
    if(!card||(!pull.new&&!(pull.level>=1)))throw new MobileCoverageError('An upgrade has no reviewed card state.');
    const entry=nextCardEntry(card,extras,pull,account.owned[pull.id]);
    if(!Number.isInteger(entry.level)||entry.level<1||entry.level>card.maxLevel||
      !Number.isInteger(entry.bloom)||entry.bloom<0||entry.bloom>card.maxBloom)
      throw new MobileCoverageError('An upgrade has an unsupported Level or Bloom.');
    entries[pull.id]=entry;
  }
  const lineup=row.order.map(id=>entries[id]??account.owned[id]);
  if(lineup.some(entry=>!entry))throw new MobileCoverageError('An acquisition has no reviewed card state.');
  return {...row,entries,lineup};
}

function mobileSearchRows(data,payload,cards,baseAccount) {
  const {options}=payload;
  const next=options.goal==='next';
  const context=createReferenceScoreContext(data,baseAccount.owned,baseAccount.boards,baseAccount.ranks,options,baseAccount.dreamRank);
  const evaluate=(row,plan,chartOptions=options)=>{
    const entries=next?mobileTeam(row,payload,cards).entries:null;
    const owned=entries?{...baseAccount.owned,...Object.fromEntries(Object.entries(entries).map(([id,entry])=>[id,{...entry,owned:true}]))}:baseAccount.owned;
    const activePlan=plan??row.plan;
    const scores=next||activePlan||chartOptions!==options?createReferenceScoreContext(data,owned,
      activePlan?.saves??row.boards??baseAccount.boards,activePlan?.ranks??baseAccount.ranks,chartOptions,baseAccount.dreamRank):context;
    return {...(next?{candidateId:row.candidateId,pulls:row.pulls,boards:row.boards,plan:activePlan}:{}),
      ...evaluateReferenceTeam(scores,row.order.map(id=>cards.get(id)),row.outfitId,row.leaderChar)};
  };
  return {evaluate,roster:next?[]:mobileRoster(data,baseAccount,context),scenarioKey:next?nextScenarioKey:undefined};
}

async function prepareMobileRating(data,payload,input,charts,selection,ports) {
  const {boardOpt}=payload;
  const account={...payload.account,boards:boardPlanningBaseline(payload.account.boards,boardOpt)};
  if(unresolvedBoardEntries(data,account.boards))throw new MobileCoverageError('Some Board entries are unavailable.');
  const engine=await reviewedEngine(data,{...payload,account,options:{...payload.options,scoringMode:'chart'}},
    input,charts,'Some eligible Holomem Rating charts are outside the reviewed Mobile chart pack.');
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const score=(row,keys,averageOnly)=>{
    try {
      return engine.scoreCharts(mobileTeam(row,payload,cards),keys,averageOnly);
    }catch(error){throw new MobileCoverageError(error.message);}
  };
  return {
    engine,score,team:row=>mobileTeam(row,payload,cards),
    async search(query,progress,keys,{optimize,summarize,compareScores}){
      const {options}=query;
      const next=options.goal==='next';
      const seed={...query,account:next?query.account:account,boardOpt:next?query.boardOpt:null,limits:{...query.limits,jointBoards:false},
        options:{...options,topN:Math.max(12,options.topN*2)}};
      const responses=await solveShards(seed,selection,progress,ports);
      const gpuSearch=gpuSearches.get(selection);
      if(gpuSearch)responses[0].results=await gpuSearch.rankResults(seed,responses[0].results??[]);
      const {evaluate,roster,scenarioKey}=mobileSearchRows(data,query,cards,account);
      const result=await searchReviewedMobile(responses,{
        options,roster,memberOf:id=>cards.get(id)?.characterId,progress,scenarioKey,
        planRows:optimize&&!next?mobileBoardPlans(query,selection,progress,ports):null,
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

async function reviewedNextBaseline(data,payload,account,cards,engine,selection,progress,ports) {
  const focusCardIds=payload.extras.nextDeck??[];
  const options={...payload.options,goal:focusCardIds.length?'holomem':'best',focusCardIds,topN:1};
  const query={...payload,options};
  const proposal={...query,account,boardOpt:null,limits:{...payload.limits,jointBoards:false},options:{...options,topN:12}};
  const baselineProgress=(done,total,fraction)=>progress(done,total,fraction,'Scoring current team for Mobile');
  const responses=await solveShards(proposal,selection,baselineProgress,ports);
  const {evaluate,roster}=mobileSearchRows(data,query,cards,account);
  const result=await searchReviewedMobile(responses,{
    options,roster,memberOf:id=>cards.get(id)?.characterId,progress:baselineProgress,
    score:row=>engine.score(mobileTeam(row,query,cards)),buildRow:evaluate,
    planRows:payload.boardOpt?mobileBoardPlans(query,selection,baselineProgress,ports):null,
    keepBoardBonuses:hasBoardBonusTargets(payload.boardOpt),
  });
  const score=result?.rows[0]?.reviewedScore;
  if(!score)throw new MobileCoverageError('The current team could not be scored with the reviewed Mobile model.');
  return options.sortBy==='max'?score.maximum:score.average;
}

async function runReviewedMobile(data,payload,input,selection,progress,ports) {
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
  const query={...payload,account:next?payload.account:account,boardOpt:next?boardOpt:null,limits:{...payload.limits,jointBoards:false},
    options:{...options,topN:Math.max(24,options.topN*2)}};
  const responses=await solveShards(query,selection,progress,ports);
  const gpuSearch=gpuSearches.get(selection);
  if(gpuSearch)responses[0].results=await gpuSearch.rankResults(query,responses[0].results??[]);
  const {evaluate,roster,scenarioKey}=mobileSearchRows(data,payload,cards,account);
  const planRows=boardOpt&&!next?mobileBoardPlans(payload,selection,progress,ports):null;
  const result=await searchReviewedMobile(responses,{
    options,roster,memberOf:id=>cards.get(id)?.characterId,progress,planRows,rankScore:event?.rankScore,scenarioKey,
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
    baseline=await reviewedNextBaseline(data,payload,account,cards,engine,selection,progress,ports);
  const rows=(result?.rows??[]).map(row=>({...row,...row.reviewedScore.eventPoints,
    ...(boardOpt?.ignoreExisting&&!row.boards?{boards:account.boards}:{})}));
  const teams=teamsForUi(data,rows,payload).map((team,index)=>anySong?team:{...team,reviewIndex:index});
  if(!anySong)lastReview={engine,rows:teams.map(team=>mobileTeam(team,payload,cards))};
  return {results:withDisplayUnitScores(data,payload,teams),baseline,reviewedCount:result?.scored??0,evaluated:responses.length};
}

async function planUnitScoreRows(data,payload,rows,selection,onProgress,ports) {
  if(!payload.boardOpt||!rows.length)return rows;
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
    if(directTeams.has(team)&&!gpuSearches.has(selection)&&!hasBoardProtection(boardOpt)){
      onProgress(checked++,directTeams.size,checked/directTeams.size,'Optimizing Boards for Unit Score');
      const direct=improveUnitScoreBoards(data,payload,team);
      if(compareUnitScore(direct,best)<0)best=direct;
    }
    return best;
  }).sort(compareUnitScore);
}

function boardBudgetMessages(data,account,input){
  const imported=new Map((input.importedMemberRanks??[]).map(row=>[row.characterId,row.level]));
  const importedBoards=input.importedBoards&&new Map(input.importedBoards.map(row=>
    [row.characterId,{nodes:row.releasedSkillTreeNodeGroupIds}]));
  const names=new Map(data.cards.map(card=>[card.characterId,card.character]));
  const mismatches=[],overrides=[];
  for(const row of input.boardPointBalances??[]){
    const id=row.skillTreePointId.replace(/^skill_tree_point-/,'');
    const rank=imported.get(id),planned=account.ranks[id];
    const board=importedBoards?importedBoards.get(id):account.boards[id],nodes=data.boards[id];
    if(!nodes||!board||!Number.isInteger(rank))continue;
    const byId=new Map(nodes.map(node=>[node.id,node]));
    if(board.nodes.some(node=>!byId.has(node)))continue;
    const spent=[...new Set(board.nodes)].reduce((sum,node)=>sum+byId.get(node).pts,0);
    const name=names.get(id)??id;
    if(boardPointsAtRank(data.boardPointLadder,rank)-spent!==Number(row.quantity))mismatches.push(name);
    else if(Number.isInteger(planned)&&planned!==rank)overrides.push({characterId:id,name,planned,rank});
  }
  return {mismatches,overrides};
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
  return rows.map(row=>({
    ...row,cardIds:row.order,leaderName:names.get(row.leaderChar)??row.leaderChar,
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
        account.owned[id]??payload.options.pinnedConnectEntries?.[id];
      return entry?[[id,entry.bloom]]:[];
    }))}:{}),
  }));
}

async function loadPreviewChartData(key, pc) {
  if(!key)return null;
  const {loadOptimizerResources}=await import('./team-optimizer-resources');
  const {decodeOptimizerChart}=await import('../hololive/vendor/shared/optimizer-chart-pack');
  const {pack,previewHits,previewGeometry}=await loadOptimizerResources(source?.mobile);
  const row=pack.rowsByKey.get(key);
  if(!row)return null;
  const decoded=decodeOptimizerChart(pack,key,pc?'pc':'mobile');
  const events={times:decoded.eventTimesMicroseconds,types:decoded.eventNoteTypes,officialHash:row[3]};
  const bundled=bundledChartGeometry[key];
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

async function resultPreview({data,payload,input,previewData},team,chartKey,simulate,pc=payload.options.pc,stream=false) {
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
  const context=createReferenceScoreContext(data,owned,boards,ranks,{...options,cardPool:'owned',
    scoringMode:'unit',eventBonus:false,eventPoints:false},account.dreamRank);
  const outfit=team.outfitId,leader=team.leaderChar;
  const rankFor=(ranks,value)=>ranks?.findLast(rank=>rank.value<=value)??null;
  const summarize=context=>{
    const {breakdown}=evaluateReferenceTeam(context,order,outfit,leader);
    const power=['parameters','board','passive','memory','powerUp','leader'].reduce((sum,key)=>sum+breakdown[key],0);
    const bonuses=referenceTeamScoreBonus(context,order,outfit,leader);
    const unitScore=referenceUnitScore(power,bonuses.total);
    return {breakdown,power,bonuses,unitScore,
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
    const generic=createReferenceScoreContext(data,owned,boards,ranks,{...context.options,pc,scoringMode:'generic',
      songId:null,difficulty:''},account.dreamRank);
    let skills;
    const {score}=evaluateReferenceTeam(generic,order,outfit,leader);
    evaluateReferenceTeam(generic,order,outfit,leader,false,null,windows=>{skills??=windows;});
    const genericChart=skills?{seconds:skills.seconds,active:skills.active,special:[],countCurve:[],
      slots:[],weightCurve:[],pc}:undefined;
    return {report:{overall,score,backend:'reference',genericChart}};
  }
  const chartContext=withReferenceChart({...context,options:{...context.options,scoringMode:'chart',
    eventBonus:options.eventBonus,pc}},song,chart);
  const thisSong=summarize(chartContext);
  let skillWindows;
  evaluateReferenceTeam(chartContext,order,outfit,leader,false,null,windows=>{skillWindows=windows;});
  const chartInfo={key:chartKey,seconds:chart.seconds,notes:chart.notes,level:chart.level,pc,
    countCurve:chart.countCurve??[],weightCurve:chart.curve??[],slots:chart.slots??[],
    active:skillWindows?.active??[],special:skillWindows?.special??[]};
  const gameChart=await loadPreviewChartData(chartKey,pc).catch(()=>null);
  if(gameChart?.level===chart.level&&gameChart.notes===chart.notes)chartInfo.events=gameChart.events;
  if(stream){
    const evaluate=random=>evaluateReferenceTeam(chartContext,order,outfit,leader,false,random).score;
    const referenceScore=evaluateReferenceTeam(chartContext,order,outfit,leader);
    let score=referenceScore.score,maxScore=referenceScore.maxScore,backend=pc&&chart.gameOnly?'game-pc-estimate':'reference',timeline=[];
    let minimum=evaluate(()=>1),maximum=evaluate(()=>-1);
    let sample=runs=>Array.from({length:runs},()=>({score:evaluate(Math.random),count:1}));
    if(input?.reviewedMobile!==false){
      try{
        const engine=await reviewedEngine(data,{...payload,options:{...options,pc},account:{...account,owned,boards,ranks}},input,
          [{key:chartKey,level:chart.level,notes:chart.notes}],'This chart is outside reviewed Mobile coverage.');
        const model=engine.previewSimulation({...team,order:team.cardIds},chartKey);
        if(model){
          const scale=value=>applyEventSongBonus(value,referenceScore.breakdown.eventBonus);
          backend=pc?'steam':'reviewed-mobile';
          score=scale(model.average);
          minimum=scale(model.minimum);
          maxScore=maximum=scale(model.maximum);
          timeline=model.timeline.map(point=>({...point,score:scale(point.score)}));
          sample=runs=>model.sample(runs).map(row=>({...row,score:scale(row.score)}));
        }
      }catch{/* The fixed reference scorer covers additional songs and lineups offline. */}
    }
    if(chart.gameOnly&&!pc&&backend!=='reviewed-mobile')return {report:{overall,chart:gameChart??chartInfo,chartOnly:true}};
    let event;
    if(options.eventPoints&&data.epBonus){
      const eventCardBonuses=referenceEventCardBonuses(data.epBonus,order,id=>owned[id]?.bloom);
      const epPermil=eventCardBonuses.reduce((total,bonus)=>total+bonus,0);
      const seconds=await eventSongSeconds(data,{...options,songId,difficulty}).catch(()=>chart.seconds);
      const points=referenceEventPoints({epPermil,score:referenceEventPointBase(score,epPermil),
        maxScore:referenceEventPointBase(maxScore,epPermil)},seconds,input?.liveBoost,input?.holoPassport);
      event={...points,score,maxScore,epPermil,eventCardBonuses};
    }
    return {report:{overall,thisSong,chart:{...chartInfo,averageScore:score,maxScore},score,maxScore,backend,...event},
      sampler:{minimum,maximum,sample,timeline}};
  }
  if(!simulate)return {overall,thisSong,chart:chartInfo};
  let seed=2718;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const samples=Array.from({length:512},()=>evaluateReferenceTeam(chartContext,order,outfit,leader,false,random).score).sort((a,b)=>a-b);
  const minimum=samples[0],maximum=samples.at(-1),width=Math.max(1,(maximum-minimum)/24);
  const histogram=Array.from({length:24},(_,i)=>({from:minimum+i*width,to:minimum+(i+1)*width,count:0}));
  for(const sample of samples)histogram[Math.min(23,Math.floor((sample-minimum)/width))].count++;
  const percentiles=Object.fromEntries([5,25,50,75,95].map(p=>['p'+p,samples[Math.floor((samples.length-1)*p/100)]]));
  return {overall,thisSong,chart:chartInfo,details:{minimum,maximum,histogram,percentiles,runs:samples.length}};
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
  if(!runs)return timeline.length?{timeline}:undefined;
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
        for(const {score,count} of sampler.sample(32))add(score,count);
      }while(performance.now()<deadline);
      const now=performance.now();
      if(now-run.started>=durationMs){session.run=null;notifyPreview(session);}
      else{
        if(now-lastUpdate>=200){notifyPreview(session);lastUpdate=now;}
        setTimeout(tick,0);
      }
    }catch(error){
      session.run=null;
      notify('review-details',{request:session.request,...session.report,error:error.message});
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
      if(entry){
        context.entry.set(card.id,{...entry,owned:true});
        context.stats.set(card.id,referenceCardStats(card,entry.level,entry.bloom));
      }
    }
    const {displayUnitScore}=evaluateUnitScore(context,order,team.outfitId,team.leaderChar);
    return Number.isFinite(displayUnitScore)?{...team,displayUnitScore}:team;
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
  const account={...payload.account,owned:{...payload.account.owned},boards:saved.boards,ranks:saved.boardRanks??payload.account.ranks};
  const current=order.map((card,index)=>{
    const {level,bloom,sp}=saved.lineup[index];
    return account.owned[card.id]={owned:true,level:Math.min(card.maxLevel,level),bloom:Math.min(card.maxBloom,bloom),
      ...(sp==null?{}:{sp})};
  });
  if(unresolvedBoardEntries(data,account.boards))throw Error('The current catalog is missing entries from the saved Board setup.');
  if(Object.values(account.boards).some(board=>Object.values(board.cards).some(id=>!account.owned[id])))
    throw Error('A card assigned to a saved Connect slot is missing from your imported collection.');
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
  const gameOnly=selected.some(({chart})=>chart.gameOnly);
  const referenceData=saved.pc?jobData:withoutGameOnlyCharts(jobData);
  const referenceCharts=saved.pc?selected:selected.filter(({chart})=>!chart.gameOnly);
  const seconds=options.eventPoints?await eventSongSeconds(jobData,options):0;
  const contexts=new Map();
  const ratingContexts=new WeakMap();
  const entriesFor=lineup=>Object.fromEntries(order.map((card,index)=>[card.id,{...lineup[index],owned:true}]));
  const ladderGain=(card,level)=>{
    let value=0;
    for(const [threshold,bonus] of jobData.powerUpLadder[card.cardLevelGroupId??'']??[]){if(level>=threshold)value=bonus;}
    return value;
  };
  // A custom pool already applies its assumptions across the roster. For
  // other saved lineups, start at imported levels and add the lineup's gain.
  const baselineOwned=!assumptions
    ?payload.extras.accountOwned:account.owned;
  const observed=payload.options.powerUpOverride??jobData.cards.reduce((sum,card)=>{
    const entry=baselineOwned[card.id];
    return sum+(entry?.owned?ladderGain(card,entry.level):0);
  },0);
  const starting=order.map(card=>ladderGain(card,baselineOwned[card.id]?.level??0));
  const powerUp=lineup=>{
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
      const entry=lineup[index];
      context.entry.set(card.id,{...entry,owned:true});
      context.stats.set(card.id,referenceCardStats(card,entry.level,entry.bloom));
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
    if(unitMode)return unit;
    if(saved.charts.length&&gameOnly&&!saved.pc)throw Error(gameChartCoverageError);
    if(!referenceCharts.length)throw Error(gameChartCoverageError);
    const context=contextFor(lineup,false,true);
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
      return {...unit,...ratingResult(scores)};
    }
    const row=evaluate(context);
    const score=options.eventPoints?referenceEventPoints(row,seconds,input.liveBoost,input.holoPassport):row;
    return {...unit,score:score.score,maxScore:score.maxScore,eventPointsAvg:score.eventPointsAvg,eventPointsMax:score.eventPointsMax};
  }
  async function reviewed(lineups,includeUnit=false){
    if(unitMode||input.reviewedMobile===false)return null;
    try{
      const engine=await reviewedEngine(jobData,{...payload,account},input,charts,'The saved charts are outside reviewed Mobile coverage.');
      const event=await reviewedEventScoring(jobData,{...payload,account},input,cards,selection);
      return lineups.map(lineup=>{
        const row=evaluate(contextFor(lineup,false));
        const entries=entriesFor(lineup);
        const team={...row,lineup,entries,powerUpOverride:powerUp(lineup)};
        const unit=includeUnit?{displayUnitScore:unitScore(lineup)}:{};
        if(ratingMode){
          const scores=engine.scoreCharts(team,charts.map(chart=>chart.key),saved.sortBy!=='max');
          return {...unit,...ratingResult(scores)};
        }
        const modeled=engine.score(team),score=event?event.score(row,modeled,entries):modeled;
        return {...unit,score:score.average,maxScore:score.maximum,eventPointsAvg:score.eventPoints?.eventPointsAvg,
          eventPointsMax:score.eventPoints?.eventPointsMax};
      });
    }catch{return null;}
  }
  return {current,reference,reviewed,powerUp};
}

async function scoreSavedLineup(saved,input) {
  const scorer=await prepareFixedLineup(saved,input);
  const reviewed=await scorer.reviewed([scorer.current],true);
  return reviewed?.[0]??scorer.reference(scorer.current,true);
}

self.addEventListener('message',async({data:message,ports})=>{
  let gpuSearch;
  try{
    if (message.type === 'review-details') {
      if(message.stream){
        const session={request:message.request,run:null,samples:newPreviewSamples()};
        previewSession=session;
        try{
          if(!message.team||!lastPreview)throw Error('The optimizer result is unavailable.');
          const preview=await resultPreview(lastPreview,message.team,message.chartKey,false,message.pc,true);
          if(session!==previewSession)return;
          if(!preview)throw Error('Some selected cards are outside the optimizer catalog.');
          Object.assign(session,preview);
          if(session.sampler)runPreviewSimulation(session,'initial',initialSimulationDuration);
          else notifyPreview(session);
        }catch(error){
          if(session===previewSession)notify('review-details',{request:message.request,error:error.message});
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
            histogram:details.histogram.map(bin=>({...bin,from:scale(bin.from),to:scale(bin.to)})),
            percentiles:Object.fromEntries(Object.entries(details.percentiles).map(([key,value])=>[key,scale(value)])),
            timeline:details.timeline.map(point=>({...point,score:scale(point.score)})),
          };
        }
        const preview=message.team&&lastPreview?await resultPreview(lastPreview,message.team,message.chartKey,!details):null;
        notify('review-details', { request: message.request, ...preview, details:details??preview?.details });
      } catch (error) {
        notify('review-details', { request: message.request, error: error.message });
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
      catch(error){notify('lineup-score',{error:error.message});}
    }else if(message.type==='catalog'){
      const localMetadata=file=>fetch(`/assets/team-optimizer/${file}.json`).then(response=>response.ok?response.json():{}).catch(()=>({}));
      const [updated,bundled]=await Promise.all([pack(),localMetadata('workspace')]);
      if(!bundled.bundledCardIds?.length)throw Error('The bundled optimizer workspace could not open.');
      if(!updated&&!source?.gameCatalog&&!source?.mobile){notify('catalog',bundled);return;}
      const [events,unlocks,eventArt,eventTitles,data,resources]=await Promise.all([
        loadEvents(),loadSongUnlocks(),localMetadata('event-art'),localMetadata('event-titles'),activeData(),
        source?.mobile?import('./team-optimizer-resources').then(module=>module.loadOptimizerResources(source.mobile)):null,
      ]);
      const gameSongs=resources?.songs.map(song=>({...song,startTime:resources.previewSongStarts?.[song.id]}));
      notify('catalog',buildOptimizerWorkspace({data,events,unlocks,bundledCardIds:bundled.bundledCardIds,bundledSongIds:bundled.bundledSongIds,
        eventArt,eventTitles,updated,gameArtwork:source?.gameCatalog?.artwork,gameSongs,
        gameReleaseId:resources?.gameEvents?.length?source?.mobile?.id:undefined,
        nextSongRelease:Number.isFinite(nextGameSongRelease)?nextGameSongRelease:undefined}));
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
      const notes=[];
      let boardRankOverrides=[];
      if(payload.boardOpt&&!payload.boardOpt.maxBoardPoints&&!payload.boardOpt.ignoreExisting){
        const {mismatches,overrides}=boardBudgetMessages(data,payload.account,input);
        if(mismatches.length)boardWarnings.push(`Board Points do not reconcile for ${mismatches.join(', ')}. Refresh Import data and check for catalog updates in Settings.`);
        boardRankOverrides=overrides;
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
      if(options.pc){
        selection={...selection,pcGameCharts:true};
        jobData=await dataFor(selection);
      }
      const chart=options.scoringMode==='chart'?selectedChart(jobData,options):null;
      if(options.scoringMode==='chart'&&!chart)throw Error('The selected chart is unavailable in the local optimizer catalog.');
      const gameOnly=chart?.gameOnly===true;
      const wantsReviewed=input.reviewedMobile===true&&['chart','generic'].includes(options.scoringMode)&&
        ['score','event','eventPoints'].includes(input.objective)&&['best','holomem','next'].includes(options.goal);
      const wantsMobileRating=input.reviewedMobile===true&&!options.pc&&input.objective==='holomemLb'&&
        ['best','holomem','next'].includes(options.goal);
      if(gameOnly&&!options.pc&&!wantsReviewed)throw Error(gameChartCoverageError);
      const pcGameEstimate=options.pc&&(chart?.gameOnly||options.scoringMode==='generic'&&
        referenceRangeCharts(jobData,options).some(({chart})=>chart.gameOnly));
      const websiteOnly=async()=>{
        if(withoutGameOnlyCharts(jobData)===jobData)return;
        selection={...selection,websiteSongsOnly:true};
        jobData=await dataFor(selection);
        if(input.useGpu){
          gpuSearch?.close();
          const {createGpuTeamOptimizer}=await import('./gpu-team-optimizer');
          gpuSearch=await createGpuTeamOptimizer(jobData,input.objective);
          gpuSearches.set(selection,gpuSearch);
        }
      };
      if(!options.pc&&!wantsReviewed&&!wantsMobileRating){
        selection={...selection,websiteSongsOnly:true};
        jobData=await dataFor(selection);
      }
      lastPreview={data:jobData,payload,input,previewData};
      let compute;
      if(input.useGpu){
        progress(0,1,0,'Starting GPU search');
        const {createGpuTeamOptimizer}=await import('./gpu-team-optimizer');
        gpuSearch=await createGpuTeamOptimizer(jobData,input.objective);
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
        if(!['best','holomem'].includes(options.goal))throw Error('Choose Best team or Build around cards for Unit Score.');
        const candidates=await searchUnitScoreRows(jobData,payload,selection,progress,ports);
        const ranked=await planUnitScoreRows(jobData,payload,candidates,selection,progress,ports);
        const rows=ranked.slice(0,options.topN).map(team=>({...team,score:undefined,maxScore:undefined,unitScore:undefined}));
        if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
        notify('result',{results:teamsForUi(data,rows,payload),excluded,boardWarnings,boardRankOverrides,compute});
        return;
      }
      const runFallback=job=>runReferenceJob(jobData,job.operation,job.payload);
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
          solve:async(query,ratingProgress=progress,{rawJoint=false}={})=>{
            const responses=await solveShards(query,selection,ratingProgress,ports);
            if(gpuSearch){
              const rows=responses[0]?.results??[];
              return query.boardOpt?rows:gpuSearch.rankResults(query,rows);
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
        let rating,mobile;
        if(wantsMobileRating){
          try {
            rating=await searchReferenceRating(jobData,payload,ratingInput,{...driver,prepareMobile:async charts=>{
              mobile=await prepareMobileRating(jobData,payload,input,charts,selection,ports);
              return mobile;
            }});
          }catch(error){
            if(!(error instanceof MobileCoverageError))throw error;
            mobile=null;
            notes.push(error.message);
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
        const detailRows=[];
        const displayRows=rows=>withDisplayUnitScores(jobData,payload,teamsForUi(data,rows,payload)).map(team=>{
          if(!mobile)return team;
          const reviewIndex=detailRows.push(mobile.team(team))-1;
          return {...team,reviewIndex};
        });
        const results=displayRows(rating.results);
        const ratingGroups=rating.ratingGroups.map(group=>({...group,results:displayRows(group.results)}));
        if(mobile)lastReview={engine:mobile.engine,rows:detailRows};
        if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
        notify('result',{...rating,excluded,notes,boardWarnings,boardRankOverrides,results,ratingGroups,compute,
          scoringModel:wantsMobileRating?(mobile?'mobile':'website'):undefined});
        return;
      }
      if(wantsReviewed){
        try{
          const mobile=await runReviewedMobile(jobData,payload,input,selection,progress,ports);
          if(mobile){
            if(gpuSearch)compute={backend:'gpu',...gpuSearch.metrics()};
            notify('result',{...mobile,scoringModel:options.pc?'steam':'mobile',unresolved,excluded,notes,boardWarnings,boardRankOverrides,compute});
            return;
          }
        }catch(error){
          if(!(error instanceof MobileCoverageError))throw error;
          if(gameOnly&&!options.pc)throw Error(`${gameChartCoverageError} ${error.message}`);
          notes.push(error.message);
          progress(0,1,0,options.pc?'Searching with PC estimates':'Searching with score estimates');
        }
      }
      if(gameOnly&&!options.pc)throw Error(gameChartCoverageError);
      if(!options.pc)await websiteOnly();
      if(options.scoringMode==='generic'&&(options.pc||jobData!==previewData)&&referenceRangeCharts(jobData,options).length===0)
        throw Error('Verified Mobile scoring is unavailable for this chart range with the selected setup.');
      lastPreview={data:jobData,payload,input,previewData};
      const responses=await solveShards(payload,selection,progress,ports);
      const result=mergeReferenceResults(responses,options);
      let rows;
      if(gpuSearch){
        const candidates=await gpuSearch.rankResults(payload,responses[0]?.results??[]);
        rows=candidates.slice(0,payload.boardOpt&&options.goal!=='next'?Math.max(8,options.topN):options.topN);
        if(payload.boardOpt&&options.goal!=='next'){
          const plans=await planReferenceRows(payload,rows,selection,progress,ports,Math.min(6,rows.length));
          rows=rows.map((row,index)=>plans[index]?{...row,...plans[index].after,plan:plans[index]}:row)
            .sort((a,b)=>b.value-a.value);
        }
        compute={backend:'gpu',...gpuSearch.metrics()};
      }else rows=payload.limits.jointBoards?await runBoard(responses,payload):result.results;
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
      notify('result',{results,baseline:result.baseline,reviewedCount:0,scoringModel:pcGameEstimate?'game-pc-estimate':wantsReviewed?'website':undefined,
        evaluated:responses.length,unresolved,excluded,notes,boardWarnings,boardRankOverrides,compute});
    }
  }catch(error){notify('error',{message:error instanceof Error?error.message:String(error),
    ...(error?.name==='OptimizerGpuError'?{code:'gpu'}:{})});}
  finally{
    gpuSearch?.close();
    for(const port of ports)port.close();
  }
});
