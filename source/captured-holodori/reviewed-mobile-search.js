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

export async function searchReviewedMobile(responses,{options,roster,memberOf,score,buildRow,planRows,deepen,keepBoardBonuses=false,progress,rankScore,compareScores,scenarioKey}) {
  const metric=options.sortBy==='max'?'maximum':'average';
  const value=row=>rankScore?rankScore(row.reviewedScore):row.reviewedScore[metric];
  const compare=compareScores?(a,b)=>compareScores(a.reviewedScore,b.reviewedScore):(a,b)=>value(b)-value(a);
  const distinct=rows=>distinctLineups(rows,scenarioKey);
  const evaluated=new Map();
  const unverified=new Set();
  let firstUnverified;
  let scored=0;
  function inspect(row) {
    let reviewedScore;
    try { reviewedScore=score(row); }
    catch(error) { throw new MobileCoverageError(error.message); }
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
      evaluated.set(key,inspect(generated?buildRow(row):row));
    }catch(error){
      // Automatic outfit selection can propose an unverified combination
      // of otherwise verified effects. The other outfits can still compete.
      if(!deepen||options.leaderMode==='fixed'||!(error instanceof MobileCoverageError)||
        !error.message.split('; ').every(reason=>reason.startsWith('static-modifier-composition:')))throw error;
      firstUnverified??=error;
      unverified.add(key);
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
  if(!evaluated.size){
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
  let rows=distinct(ranked());

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
    const seeds=rows.slice(0,Math.max(10,options.topN));
    if(keepBoardBonuses){
      const full=await planRows(seeds,false);
      rows=distinct(seeds.map((seed,index)=>applyPlan(seed,full[index]?.plan)).sort(compare));
    }else{
      const lite=await planRows(seeds,true);
      const planned=seeds.map((seed,index)=>({seed,best:applyPlan(seed,lite[index]?.plan)}));
      const finalists=planned.slice().sort((a,b)=>compare(a.best,b.best)).slice(0,Math.max(6,options.topN));
      const full=await planRows(finalists.map(({seed})=>seed),false);
      const refined=finalists.map(({seed},index)=>applyPlan(seed,full[index]?.plan));
      rows=distinct([...refined,...planned.map(({best})=>best),...rows].sort(compare));
    }
  }
  if(deepen&&!keepBoardBonuses){
    progress(0,1,.99,'Refining final teams');
    const candidates=await deepen(rows.slice(0,3));
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
        if(error instanceof MobileCoverageError)return [];
        throw error;
      }
    });
    rows=distinct([...rows,...refined].sort(compare));
  }
  return {rows:rows.slice(0,options.topN),scored};
}
