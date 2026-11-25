import {finalistOrders,finalistSetups} from './finalist-orders.js';

const orderKey=row=>JSON.stringify([row.order,row.leaderChar,row.outfitId]);
const lineupKey=row=>row.order.slice().sort().join('|');

export class MobileCoverageError extends Error {}

function distinctLineups(rows,scenarioKey) {
  const seen=new Set();
  return rows.filter(row=>{
    const key=scenarioKey?JSON.stringify([scenarioKey(row),lineupKey(row)]):lineupKey(row);
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

function* swaps(team) {
  const order=team.order;
  for(let left=0;left<order.length;left++){
    for(let right=left+1;right<order.length;right++){
      const next=order.slice();
      [next[left],next[right]]=[next[right],next[left]];
      yield {...team,order:next};
    }
  }
}

function* substitutions(team,roster,memberOf,locked,noOverlap) {
  const order=team.order;
  const members=order.map(memberOf);
  for(const card of roster){
    if(order.includes(card))continue;
    const member=memberOf(card);
    if(noOverlap&&member===team.leaderChar)continue;
    for(const [index,id] of order.entries()){
      if(locked.has(id)||members.some((value,slot)=>slot!==index&&value===member))continue;
      const next=order.slice();
      next[index]=card;
      yield {...team,order:next};
    }
  }
}

// Count legal composition/outfit pairs before scoring. Discard the whole
// enumeration if it exceeds the budget so roster order cannot bias a partial pass.
function boundedMobileSetups(roster,memberOf,options,outfits,chartCount){
  const limit=Math.floor(16000/(120*Math.max(1,chartCount)));
  if(!limit||!outfits?.length)return [];
  const locked=[...new Set(options.focusCardIds)],lockedMembers=new Set(locked.map(memberOf));
  if(locked.length>5||lockedMembers.size!==locked.length||locked.some(id=>!roster.includes(id)))return [];
  const members=new Map();
  for(const id of roster){
    const member=memberOf(id);
    if(lockedMembers.has(member))continue;
    if(!members.has(member))members.set(member,[]);
    members.get(member).push(id);
  }
  const setups=[];
  for(const [outfitId,outfit] of outfits){
    const leaderChar=outfit.characterId;
    if(options.leaderNoOverlap&&lockedMembers.has(leaderChar))continue;
    const choices=[...members].filter(([id])=>!options.leaderNoOverlap||id!==leaderChar).map(([,cards])=>cards);
    function choose(order,start){
      if(order.length===5){
        setups.push({order,outfitId,leaderChar});
        return;
      }
      for(let i=start;i<=choices.length-(5-order.length);i++)for(const id of choices[i]){
        choose([...order,id],i+1);
        if(setups.length>limit)return;
      }
    }
    choose(locked,0);
    if(setups.length>limit)return [];
  }
  return setups;
}

export async function searchReviewedMobile(responses,{options,roster,memberOf,score,buildRow,planRows,deepen,keepBoardBonuses=false,progress,rankScore,compareScores,scenarioKey,onUnverified,outfits,chartCount=1}) {
  const metric=options.sortBy==='max'?'maximum':'average';
  const value=row=>rankScore?rankScore(row.reviewedScore):row.reviewedScore[metric];
  const compare=compareScores?(a,b)=>compareScores(a.reviewedScore,b.reviewedScore):(a,b)=>value(b)-value(a);
  const distinct=rows=>distinctLineups(rows,scenarioKey);
  const evaluated=new Map();
  const unverified=new Set();
  let firstUnverified;
  let scored=0;
  function skippable(error){
    return options.leaderMode!=='fixed'&&error instanceof MobileCoverageError&&
      error.message.split('; ').every(reason=>reason.startsWith('static-modifier-composition:'));
  }
  function inspect(row) {
    let reviewedScore;
    try { reviewedScore=score(row); }
    catch(error) { throw new MobileCoverageError(error.message,{cause:error}); }
    if(!Number.isFinite(reviewedScore.average)||!Number.isFinite(reviewedScore.maximum)||
      (rankScore&&!Number.isFinite(rankScore(reviewedScore))))
      throw new MobileCoverageError('The requested Mobile score is unavailable.');
    scored++;
    return {...row,reviewedScore};
  }
  function consider(row,generated=false) {
    const key=scenarioKey?JSON.stringify([scenarioKey(row),orderKey(row),row.boards]):orderKey(row);
    if(evaluated.has(key)||unverified.has(key))return false;
    try{
      evaluated.set(key,inspect(generated?{...row,...buildRow(row)}:row));
    }catch(error){
      // Automatic outfit selection can propose an unverified combination
      // of otherwise verified effects. The other outfits can still compete.
      if(!deepen||!skippable(error))throw error;
      firstUnverified??=error;
      unverified.add(key);
      onUnverified?.(error);
      return false;
    }
    return true;
  }
  const ranked=()=>[...evaluated.values()].sort(compare);

  // Give each shard a chance to propose a team before narrowing on Mobile score.
  const lists=responses.map(response=>response.results??[]);
  const seedLimit=Math.max(24,options.topN*2);
  for(let index=0;index<Math.max(0,...lists.map(rows=>rows.length))&&evaluated.size<seedLimit;index++){
    for(const rows of lists){
      if(rows[index])consider(rows[index]);
      if(evaluated.size>=seedLimit)break;
    }
  }
  const complete=!scenarioKey&&!options.pc?boundedMobileSetups(roster,memberOf,options,outfits,chartCount):[];
  if(!evaluated.size&&!complete.length){
    if(firstUnverified)throw firstUnverified;
    return null;
  }
  progress(evaluated.size,seedLimit,1,'Scoring Mobile teams');
  const locked=new Set(options.focusCardIds);
  const roundBudget=32;
  for(let round=0;round<2;round++){
    const leaders=distinct(ranked()).slice(0,4);
    const queues=leaders.flatMap(row=>scenarioKey?[swaps(row)]:[swaps(row),substitutions(row,roster,memberOf,locked,options.leaderNoOverlap)]);
    let remaining=roundBudget;
    while(queues.length&&remaining>0){
      for(let index=queues.length-1;index>=0&&remaining>0;index--){
        const next=queues[index].next();
        if(next.done)queues.splice(index,1);
        else if(consider(next.value,true))remaining--;
      }
    }
    progress(round+1,2,(round+1)/2,'Refining Mobile teams');
    if(remaining===roundBudget)break;
  }
  let rows=ranked();
  if(complete.length>1||!rows.length&&complete.length){
    const exact=[];
    for(const [index,setup] of complete.entries()){
      const seed={...setup,...buildRow(setup)};
      let best;
      for(const order of finalistOrders(seed.order)){
        try{
          const candidate=inspect({...seed,order});
          if(!best||compare(candidate,best)<0)best=candidate;
        }catch(error){
          if(!skippable(error))throw error;
          firstUnverified??=error;
          onUnverified?.(error);
        }
      }
      if(best)exact.push(best);
      progress(index+1,complete.length,(index+1)/complete.length,'Checking small Mobile rosters');
    }
    rows=[...exact,...rows].sort(compare);
    if(!rows.length&&firstUnverified)throw firstUnverified;
  }

  if(planRows){
    function applyPlan(row,plan) {
      if(!plan?.saves)return row;
      const proposal=inspect({...row,...plan.after,plan});
      const keepOrder=orderKey(proposal)!==orderKey(row)?inspect({...row,plan}):null;
      const best=keepOrder&&compare(keepOrder,proposal)<0?keepOrder:proposal;
      if(!keepBoardBonuses&&compare(best,row)>=0)return row;
      const adjusted=best===keepOrder?buildRow(best,plan):null;
      return {...best,...adjusted,plan:{...plan,
        before:{...plan.before,reviewedScore:row.reviewedScore},
        after:{...plan.after,...adjusted,reviewedScore:best.reviewedScore},
      }};
    }
    const seeds=distinct(rows).slice(0,Math.max(10,options.topN));
    if(keepBoardBonuses){
      const full=await planRows(seeds,false);
      rows=distinct(seeds.map((seed,index)=>applyPlan(seed,full[index]?.plan)).sort(compare));
    }else{
      const lite=await planRows(seeds,true);
      const planned=seeds.map((seed,index)=>({seed,best:applyPlan(seed,lite[index]?.plan)}));
      const finalists=planned.slice().sort((a,b)=>compare(a.best,b.best)).slice(0,Math.max(6,options.topN));
      const full=await planRows(finalists.map(({seed})=>seed),false);
      const refined=finalists.map(({seed},index)=>applyPlan(seed,full[index]?.plan));
      rows=[...refined,...planned.map(({best})=>best),...rows].sort(compare);
    }
  }
  if(deepen&&!keepBoardBonuses){
    progress(0,1,.99,'Refining final teams');
    const candidates=await deepen(distinct(rows).slice(0,3));
    const refined=candidates.flatMap(candidate=>{
      try {
        const row=inspect(candidate);
        if(row.plan){
          const original=inspect({...row,plan:undefined,boards:undefined});
          row.plan={...row.plan,before:{...row.plan.before,reviewedScore:original.reviewedScore},
            after:{...row.plan.after,reviewedScore:row.reviewedScore}};
        }
        return [row];
      }catch(error){
        // A speculative refinement may introduce an unverified skill
        // combination. Keep that proposal out of this verified search.
        if(error instanceof MobileCoverageError){onUnverified?.(error);return [];}
        throw error;
      }
    });
    rows=[...rows,...refined].sort(compare);
  }
  if(!options.pc){
    const finalists=finalistSetups(rows,Math.max(6,options.topN),scenarioKey);
    rows=finalists.map((seed,index)=>{
      let best;
      for(const order of finalistOrders(seed.order)){
        const proposal=inspect({...seed,order});
        if(!best||compare(proposal,best)<0)best=proposal;
      }
      const after=buildRow(best,best.plan);
      const winner={...best,...after,reviewedScore:best.reviewedScore};
      if(seed.plan){
        const original={...winner,plan:undefined,boards:undefined};
        const baseline=buildRow(original);
        const before=inspect({...original,...baseline});
        winner.plan={...seed.plan,orderExhaustive:true,before:{...seed.plan.before,...baseline,reviewedScore:before.reviewedScore},
          after:{...seed.plan.after,...after,reviewedScore:winner.reviewedScore}};
      }
      progress(index+1,finalists.length,(index+1)/finalists.length,'Checking all 120 Mobile slot orders');
      return winner;
    }).sort(compare);
  }
  return {rows:distinct(rows).slice(0,options.topN),scored};
}
