import {collectBoardFinalists,hasBoardBonusTargets} from './reference-team-solver.js';

const NEIGHBOR_SEEDS=[3,2];
const NEIGHBOR_FINALISTS=[4,3];
const FRONTIER_MARGIN=.015;
const PRIORITY={neighbor:1,lite:2,front:3,reserve:5};
const lineupKey=row=>row.order.slice().sort().join('|');

function topIndices(indices,limit,valueOf) {
  return [...indices].map(index=>({index,value:valueOf(index)})).filter(row=>row.value>=0)
    .sort((a,b)=>b.value-a.value).slice(0,limit).map(row=>row.index);
}

export async function optimizeReferenceBoards(responses,payload,{workerCount,runJob,runFallback,onProgress=()=>{},outputLimit=payload.options.topN}) {
  const candidates=collectBoardFinalists(responses,payload.options);
  if(!candidates.length)return [];
  const {account,options,boardOpt}=payload;
  const scoreKey=options.sortBy==='max'?'maxScore':'score';
  const outfitId=options.leaderMode==='fixed'?options.outfitId:null;
  const plans=candidates.map(()=>null);
  const keepBoardBonuses=hasBoardBonusTargets(boardOpt);
  const validatedPlans=new Set();
  const knownTeams=new Map(candidates.map((row,index)=>[lineupKey(row),index]));
  const primary=candidates.flatMap((row,index)=>row.source==='reserve'?[]:[index]);
  const fullLimit=Math.max(12,options.topN);
  const planScore=plan=>plan?.after?.[scoreKey]??-1;
  const scoreAt=index=>planScore(plans[index]);
  const lens=(index,key)=>candidates[index].lens?.[key]??-1;
  const report=(done,total)=>onProgress(done,total,total?done/total:1,'Planning Boards');

  function keepPlan(index,plan,lite) {
    if(keepBoardBonuses&&plan&&!lite){
      validatedPlans.add(index);
      plans[index]=plan;
    }else if(!validatedPlans.has(index)&&(!plans[index]||(plan&&planScore(plan)>=scoreAt(index)))){
      plans[index]=plan??null;
    }
  }
  function planRequest(index,lite) {
    const team=candidates[index];
    return {operation:'_hd_plan',payload:{account,options,team:team.order,leaderChar:team.leaderChar,
      outfitId,boardOpt:{...boardOpt,litePlan:lite}}};
  }
  function results() {
    const hasPlans=plans.some(Boolean);
    return candidates.map((row,index)=>({row,plan:plans[index]}))
      .filter((entry,index)=>keepBoardBonuses?validatedPlans.has(index):!hasPlans||entry.plan)
      .sort((a,b)=>(b.plan?.after?.[scoreKey]??b.row[scoreKey])-(a.plan?.after?.[scoreKey]??a.row[scoreKey]))
      .slice(0,outputLimit).map(({row,plan})=>plan?{...row,...plan.after,plan}:row);
  }
  async function compatibility() {
    if(!runFallback)return results();
    const indices=candidates.flatMap((row,index)=>row.source==='reserve'?[]:[index]);
    let done=0,total=indices.length+Math.min(fullLimit,indices.length);
    const plan=async(index,lite)=>{
      try{keepPlan(index,(await runFallback(planRequest(index,lite)))?.plan,lite);}
      catch{/* The reference keeps any earlier successful plan. */}
      report(++done,total);
    };
    for(const index of indices)await plan(index,true);
    const finalists=topIndices(indices,fullLimit,scoreAt);
    total=done+finalists.length;
    for(const index of finalists)await plan(index,false);
    return results();
  }
  if(!workerCount)return compatibility();

  return new Promise((resolve,reject)=>{
    const queue=[],idle=[],running=new Map(),slots=new Set();
    const planning=new Set(),fullScheduled=new Set(),fullFinished=new Set();
    const initialFull=new Set(),frontPending=new Set(),primaryPending=new Set(primary);
    let sequence=0,done=0,total=0,finished=false,discardedReserve=false;
    let frontierReady=false,frontierScore=0,hasLeadPlans=false,round=-1,walking=false;
    let pendingWalks=0,pendingRoundLite=0,pendingRoundFull=0,roundCandidates=[];
    let ceilingByIndex,maxByIndex;

    function queueJob(job) {
      queue.push({...job,sequence:sequence++,attempts:0});
      total++;
    }
    function planJob(index,stage,priority,lite) {
      return {kind:'plan',index,stage,priority,lite};
    }
    function removeQueuedPlans(index) {
      for(let position=queue.length-1;position>=0;position--){
        if(queue[position].kind==='plan'&&queue[position].index===index){queue.splice(position,1);total--;}
      }
    }
    function nextJob() {
      if(!queue.length)return;
      let next=0;
      for(let index=1;index<queue.length;index++){
        const a=queue[index],b=queue[next];
        if(a.priority<b.priority||(a.priority===b.priority&&a.sequence<b.sequence))next=index;
      }
      return queue.splice(next,1)[0];
    }
    function dispatch(slot) {
      if(finished||!slots.has(slot))return;
      const job=nextJob();
      if(!job){idle.push(slot);return;}
      running.set(slot,job);
      if(job.kind==='plan')planning.add(job.index);
      const request=job.kind==='plan'?planRequest(job.index,job.lite):{
        operation:'_hd_neighbors',payload:{account,options,boardOpt,teams:[candidates[job.index].order],
          boards:[job.boards],exclude:job.exclude,perSeed:12},
      };
      Promise.resolve().then(()=>runJob(slot,request)).then(
        response=>complete(slot,job,response),()=>failSlot(slot,job),
      ).catch(reject);
    }
    function dispatchIdle() {
      for(const slot of idle.splice(0))dispatch(slot);
    }
    function schedule(jobs) {
      for(const job of jobs)queueJob(job);
      report(done,total);
      dispatchIdle();
    }
    function maybeFinish() {
      if(finished)return;
      if(!discardedReserve){
        if(round<NEIGHBOR_SEEDS.length||walking||!frontierReady||frontPending.size||pendingRoundFull)return;
        discardedReserve=true;
        for(let index=queue.length-1;index>=0;index--){
          if(queue[index].priority===PRIORITY.reserve){queue.splice(index,1);total--;}
        }
        report(done,total);
      }
      if(running.size||queue.length)return;
      finished=true;
      resolve(results());
    }
    function nextRound() {
      round++;
      const seeds=round<NEIGHBOR_SEEDS.length?topIndices(fullFinished,NEIGHBOR_SEEDS[round],scoreAt):[];
      if(!seeds.length){round=NEIGHBOR_SEEDS.length;walking=false;maybeFinish();return;}
      walking=true;
      ceilingByIndex=new Map();
      maxByIndex=new Map();
      pendingWalks=seeds.length;
      const exclude=[...fullScheduled].map(index=>candidates[index].order);
      schedule(seeds.map(index=>({kind:'walk',index,priority:PRIORITY.neighbor,boards:plans[index]?.saves??null,exclude})));
    }
    function maybeStartRounds() {
      if(round===-1&&!initialFull.size&&(hasLeadPlans||(frontierReady&&!frontPending.size)))nextRound();
    }
    function promoteNeighbors() {
      const eligible=roundCandidates.filter(index=>!planning.has(index)&&!fullScheduled.has(index));
      const finalists=topIndices(eligible,NEIGHBOR_FINALISTS[round],scoreAt);
      pendingRoundFull=finalists.length;
      if(!finalists.length){nextRound();return;}
      for(const index of finalists){fullScheduled.add(index);removeQueuedPlans(index);}
      schedule(finalists.map(index=>planJob(index,'roundFull',PRIORITY.neighbor,false)));
    }
    function finishWalk(neighbors) {
      for(const row of neighbors){
        const key=lineupKey(row);
        let index=knownTeams.get(key);
        if(index!==undefined&&fullScheduled.has(index))continue;
        if(index===undefined){
          index=candidates.length;
          candidates.push(row);
          plans.push(null);
          knownTeams.set(key,index);
        }
        for(const [lensKey,values] of [['ceiling',ceilingByIndex],['max',maxByIndex]]){
          const value=row.lens?.[lensKey]??-1;
          if(value>(values.get(index)??-1))values.set(index,value);
        }
      }
      if(--pendingWalks>0)return;
      const eligible=[...ceilingByIndex.keys()].filter(index=>!planning.has(index)&&!fullScheduled.has(index));
      roundCandidates=topIndices(eligible,12,index=>ceilingByIndex.get(index)??-1);
      if(scoreKey==='maxScore'){
        for(const index of topIndices(eligible,12,index=>maxByIndex.get(index)??-1)){
          if(!roundCandidates.includes(index))roundCandidates.push(index);
        }
      }
      const needPlan=roundCandidates.filter(index=>plans[index]===null);
      pendingRoundLite=needPlan.length;
      if(!needPlan.length){promoteNeighbors();return;}
      for(const index of needPlan)removeQueuedPlans(index);
      schedule(needPlan.map(index=>planJob(index,'roundLite',PRIORITY.neighbor,true)));
    }
    function establishFrontier() {
      frontierReady=true;
      const top=topIndices(primary,fullLimit,scoreAt);
      frontierScore=top.length?scoreAt(top[0]):0;
      const finalists=top.filter(index=>!fullScheduled.has(index));
      for(const index of finalists){fullScheduled.add(index);frontPending.add(index);removeQueuedPlans(index);}
      if(finalists.length){schedule(finalists.map(index=>planJob(index,'front',PRIORITY.front,false)));return;}
      maybeStartRounds();
      maybeFinish();
    }
    function finishPlan(job,plan) {
      const {index,stage}=job;
      planning.delete(index);
      keepPlan(index,plan,job.lite);
      if(primaryPending.delete(index)&&!primaryPending.size)establishFrontier();
      switch(stage){
        case 'reserve':
          if(frontierScore>0&&planScore(plan)>=frontierScore*(1-FRONTIER_MARGIN)&&!fullScheduled.has(index)){
            fullScheduled.add(index);
            frontPending.add(index);
            schedule([planJob(index,'front',PRIORITY.front,false)]);
          }
          break;
        case 'front':
          fullFinished.add(index);
          frontPending.delete(index);
          initialFull.delete(index);
          maybeStartRounds();
          maybeFinish();
          break;
        case 'roundLite':
          if(--pendingRoundLite===0)promoteNeighbors();
          break;
        case 'roundFull':
          fullFinished.add(index);
          if(--pendingRoundFull===0)nextRound();
          break;
        default: maybeFinish();
      }
    }
    function process(job,response) {
      done++;
      if(job.kind==='plan')finishPlan(job,response?.plan??null);
      else finishWalk(response?.results??[]);
      maybeFinish();
      report(done,total);
    }
    function complete(slot,job,response) {
      if(finished||running.get(slot)!==job)return;
      running.delete(slot);
      process(job,response);
      dispatch(slot);
    }
    function failSlot(slot,job) {
      if(finished||running.get(slot)!==job)return;
      slots.delete(slot);
      running.delete(slot);
      if(job.kind==='plan')planning.delete(job.index);
      if(++job.attempts<2&&slots.size)queue.push(job);
      else process(job,null);
      if(!slots.size&&!finished){finished=true;compatibility().then(resolve,reject);return;}
      dispatchIdle();
    }

    const initialLens=scoreKey==='maxScore'&&primary.some(index=>lens(index,'max')>=0)?'max':'ceiling';
    const leads=topIndices(primary,2,index=>lens(index,initialLens));
    hasLeadPlans=leads.length>0;
    for(const index of leads){
      fullScheduled.add(index);
      initialFull.add(index);
      frontPending.add(index);
      queueJob(planJob(index,'front',PRIORITY.neighbor,false));
    }
    for(const index of primary){if(!fullScheduled.has(index))queueJob(planJob(index,'lite',PRIORITY.lite,true));}
    candidates.forEach((row,index)=>{if(row.source==='reserve')queueJob(planJob(index,'reserve',PRIORITY.reserve,true));});
    if(!primaryPending.size)establishFrontier();
    report(done,total);
    const count=Math.min(workerCount,queue.length);
    for(let slot=0;slot<count;slot++)slots.add(slot);
    for(const slot of slots)dispatch(slot);
  });
}
