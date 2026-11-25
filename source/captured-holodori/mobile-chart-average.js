import {evaluateReferenceTeam,referenceBoardSongMatches,referenceChartBatch,referenceRangeCharts,withReferenceChart} from './reference-rating-math.js';
import {mobileRangeNotes,scoreMobileWindows} from './mobile-range-notes';

/** Preserve the frequency of each distinct Board trigger in the planning range.
 * Finalists are scored separately on every eligible chart. */
export function boardRangeCharts(data,{options,account,boardOpt}){
  const charts=referenceRangeCharts(data,options);
  const chartBudget=12;
  if(charts.length<=chartBudget)return charts.map(row=>({...row,weight:1/charts.length}));
  const owners=boardOpt.allInvited?Object.keys(data.boards):new Set([...Object.keys(account.ranks),...Object.keys(account.boards)]);
  const triggers=new Map();
  for(const owner of owners){
    const purchased=new Set(account.boards[owner]?.nodes);
    for(const node of data.boards[owner]??[]){
      if(!node.songTrigger||!purchased.has(node.id)&&(!boardOpt.branches.includes(node.branch)||
        (node.hide??0)>account.dreamRank||(node.lock??0)>account.dreamRank))continue;
      triggers.set(JSON.stringify([owner,node.songTrigger]),{owner,trigger:node.songTrigger});
    }
  }
  const conditions=[...triggers.values()],groups=new Map(),songKeys=new Map();
  for(const entry of charts){
    const {song}=entry;
    if(!songKeys.has(song)){
      const key=conditions.map(({owner,trigger})=>referenceBoardSongMatches(trigger,owner,{song,data})?'1':'0').join('');
      songKeys.set(song,key);
    }
    const key=songKeys.get(song);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(entry);
  }
  const representatives=[];
  for(const group of groups.values()){
    group.sort((a,b)=>a.chart.seconds-b.chart.seconds);
    const samples=Math.max(1,Math.round(chartBudget*group.length/charts.length));
    const stride=Math.ceil(group.length/samples);
    for(let i=0;i<group.length;i+=stride){
      const count=Math.min(stride,group.length-i);
      representatives.push({...group[i+Math.floor(count/2)],weight:count/charts.length});
    }
  }
  return representatives;
}

const averagedFields=['score','maxScore','unitScore','deckPower','scoreUpPermil','activeUptime'];
export function averageChartRows(rows,weights){
  const first=rows[0],result={...first,breakdown:{...first.breakdown}};
  const mean=(read)=>rows.reduce((total,row,i)=>total+read(row)*(weights?.[i]??1),0)/(weights?1:rows.length);
  for(const field of averagedFields)result[field]=mean(row=>row[field]);
  for(const field of Object.keys(first.breakdown))result.breakdown[field]=mean(row=>row.breakdown[field]);
  return result;
}

function noteScenario(context,table){
  return {...context.scenarios[0],seconds:table.seconds,slots:table.slots,notesBefore:table.notesBefore};
}

/** Use the same schedule and awards in a finalist's single-song drilldown.
 * One roll per Active check is shared by all note segments in its window. */
export function mobileRangeChartPreview(context,song,chart,order,outfit,leader,resources,towerBonusPermil=0){
  const table=mobileRangeNotes(resources,song,chart);
  if(!table)return null;
  const scenarios=[noteScenario(context,table)];
  let windows;
  const row=evaluateReferenceTeam({...context,scenarios},order,outfit,leader,false,null,value=>{windows=value;});
  const checks=new Map(windows.active.map((window,index)=>[window,index])),segments=[];
  const totals=scoreMobileWindows(table,windows,table.awards(row.deckPower,row.breakdown.songBonus,towerBonusPermil),(base,outcomes)=>{
    segments.push({base,outcomes:outcomes.map(({window,score})=>({check:checks.get(window),score}))});
  });
  const minimum=segments.reduce((sum,segment)=>sum+(segment.outcomes.find(({check})=>windows.active[check].p===1)?.score??segment.base),0);
  return {windows,...totals,sampler:{minimum,maximum:totals.maxScore,timeline:[],sample(runs,seed){
    const hits=new Uint8Array(windows.active.length);
    return Array.from({length:runs},()=>{
      for(let i=0;i<hits.length;i++){
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        hits[i]=seed/4294967296<windows.active[i].p;
      }
      const score=segments.reduce((sum,segment)=>sum+(segment.outcomes.find(row=>hits[row.check])?.score??segment.base),0);
      return {score,count:1};
    });
  }}};
}

/** Apply the same range weights to projected per-note scores and any chart
 * available only as a reference curve. Screening never needs the note tables. */
export function mobileChartEvaluator(context,charts,resources,towerBonusPermil=0){
  if(!charts)return (order,outfit,leader)=>evaluateReferenceTeam(context,order,outfit,leader);
  if(!charts.length)throw Error('No Mobile charts match this range.');
  let perNote=0;
  const contexts=charts.map(({song,chart})=>{
    const ctx=withReferenceChart(context,song,chart),table=mobileRangeNotes(resources,song,chart);
    if(!table)return ctx;
    perNote++;
    const scenarios=[noteScenario(ctx,table)];
    const scoresByBonus=new Map(),awardsByBonus=new Map();
    return {...ctx,scenarios,screenScenarios:scenarios,noteTotals(key,power,bonus,windows){
      // Each context has fixed Boards, song and leader-dependent bonus. The
      // schedule key includes power, skill recipients and occupied SP slots.
      if(!scoresByBonus.has(bonus)){
        scoresByBonus.set(bonus,new Map());
        awardsByBonus.set(bonus,new Map());
      }
      const scores=scoresByBonus.get(bonus),awards=awardsByBonus.get(bonus);
      if(scores.has(key))return scores.get(key);
      if(!awards.has(power))awards.set(power,table.awards(power,bonus,towerBonusPermil));
      const result=scoreMobileWindows(table,windows(),awards.get(power));
      scores.set(key,result);
      return result;
    }};
  });
  const batch=referenceChartBatch(contexts), indices=contexts.map((_,index)=>index);
  return (order,outfit,leader)=>{
    const rows=batch(indices,order,outfit,leader);
    return {...averageChartRows(rows),chartCount:charts.length,...(resources?{rangeCoverage:{perNote,reference:charts.length-perNote}}:{})};
  };
}
