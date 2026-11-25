import {decodeOptimizerChart,officialComboMultiplierPermil} from '../hololive/vendor/shared/optimizer-chart-pack';
import {inspectChartScoreEvidence} from '../hololive/vendor/shared/chart-score-baseline';
import {projectedMobileNoteAward} from '../hololive/vendor/shared/live-score';
import {clientSupportedSkillRatio} from '../hololive/vendor/shared/live-skill-arithmetic';

// Signed chart data is immutable. Keep chart geometry across finalists, but keep
// formation-dependent scores in the individual finalist evaluator.
const chartTables=new WeakMap();
export function mobileRangeNotes(resources,song,chart){
  if(!resources)return null;
  let tables=chartTables.get(resources);
  if(!tables)chartTables.set(resources,tables=new Map());
  const key=song.id+'_'+chart.type, row=resources.pack.rowsByKey.get(key), music=resources.data.songs[song.id];
  if(!row||!music||row[2]!==chart.level||row[5]!==chart.notes||!resources.denominators.get(key))return null;
  if(tables.has(key))return tables.get(key);
  const combo=resources.data.comboGroups[music.comboGroupId];
  if(combo?.length!==11||!combo.every((band,i)=>band.comboCountFrom===100*i&&band.scoreUpPermil===10*i))return null;
  const decoded=decodeOptimizerChart(resources.pack,key,'mobile');
  const evidence=inspectChartScoreEvidence(decoded,resources.denominators).denominator;
  if(!evidence)return null;
  const table=prepareNoteTable(decoded,evidence,music.scoreCoefficientPermil);
  tables.set(key,table);
  return table;
}

function prepareNoteTable(chart,evidence,songCoefficient){
  const times=chart.eventTimesMicroseconds,weights=chart.eventWeightsPermil;
  const kinds=[...new Set(weights)],stride=kinds.length;
  const classes=Uint8Array.from(weights,(weight,i)=>(officialComboMultiplierPermil(i+1)-1000)/10*stride+kinds.indexOf(weight));
  const ties=[];
  for(let boundary=99;boundary<Math.min(1000,times.length);boundary+=100){
    let start=boundary,end=boundary+1;
    while(start>0&&times[start-1]===times[boundary])start--;
    if(start===boundary)continue;
    while(end<times.length&&times[end]===times[boundary])end++;
    if(new Set(weights.subarray(start,end)).size>1)
      ties.push({start,end,highSlots:end-boundary,first:(boundary+1)/100*stride-stride});
  }
  const offsets=new Map(),spans=new Map();
  // A proc or SP check sees the combo strictly before notes at its timestamp.
  function notesBefore(seconds){
    let value=offsets.get(seconds);
    if(value!==undefined)return value;
    let low=0,high=times.length;
    while(low<high){
      const mid=(low+high)>>>1;
      if(times[mid]/1e6<seconds)low=mid+1;else high=mid;
    }
    if(offsets.size<4096)offsets.set(seconds,low);
    return low;
  }
  function span(start,end){
    const key=start*(times.length+1)+end;
    let value=spans.get(key);
    if(value)return value;
    const counts=new Map();
    for(let i=start;i<end;i++)counts.set(classes[i],(counts.get(classes[i])??0)+1);
    value={counts:[...counts],ties:ties.filter(tie=>tie.start>=start&&tie.start<end)};
    if(spans.size<2048)spans.set(key,value);
    return value;
  }
  function awards(power,board,tower=0){
    const award=projectedMobileNoteAward(power,songCoefficient,chart.difficultyLevel,evidence.completePerfectSumPermil,
      evidence.chartScoreCoefficientPermyriad??10000,board,tower);
    const cache=new Map();
    return strength=>{
      let values=cache.get(strength);
      if(!values){
        values=Float64Array.from({length:11*stride},(_,i)=>award(Math.floor(i/stride)/100,strength,kinds[i%stride]));
        cache.set(strength,values);
      }
      return values;
    };
  }
  return {seconds:chart.durationMicroseconds/1e6,slots:chart.special_points,notesBefore,span,awards,
    count:times.length,classes,stride};
}

// Inputs may contain projected formation modifiers. Notes, half-open windows,
// float32 awards and strongest-successful-Active probabilities use Mobile rules.
export function scoreMobileWindows(table,windows,awards,collectSegment){
  const edges=new Map(),base=awards(0);
  function edge(index){
    let row=edges.get(index);
    if(!row)edges.set(index,row={open:[],close:[]});
    return row;
  }
  function add(window){
    const start=table.notesBefore(window.s),end=table.notesBefore(window.e);
    if(start===end)return;
    edge(start).open.push(window);
    edge(end).close.push(window);
  }
  for(const window of windows.active)if(window.p>0&&window.raw>0)add(window);
  for(const window of windows.special)if(window.sup>0)add(window);
  edge(0);
  const indices=[...edges.keys()].filter(i=>i<table.count).sort((a,b)=>a-b),open=new Set();
  let score=0,maxScore=0,unskilled=0,plainScore=0,lowerAdjustment=0,upperAdjustment=0;
  for(let i=0;i<indices.length;i++){
    const start=indices[i],end=indices[i+1]??table.count,updates=edges.get(start);
    for(const window of updates.close)open.delete(window);
    for(const window of updates.open)open.add(window);
    let support=0;
    for(const window of open)if(window.sup>support)support=window.sup;
    const outcomes=[];
    for(const window of open){
      if(window.raw===undefined)continue;
      const plain=window.plain??=clientSupportedSkillRatio(Math.round(window.raw*10),windows.outfit+window.eff*1000,0);
      const strength=support?clientSupportedSkillRatio(Math.round(window.raw*10),windows.outfit+window.eff*1000,Math.fround(support)):plain;
      outcomes.push({window,strength,probability:window.p,points:awards(strength),plain:awards(plain)});
    }
    outcomes.sort((a,b)=>b.strength-a.strength);
    let survival=1;
    for(const row of outcomes){
      row.mass=survival*row.probability;
      survival*=1-row.probability;
    }
    const strongest=outcomes[0]?.points??base;
    const expected=id=>{
      let total=survival*base[id];
      for(const row of outcomes)total+=row.mass*row.points[id];
      return total;
    };
    const span=table.span(start,end);
    if(collectSegment){
      const total=points=>span.counts.reduce((sum,[id,count])=>sum+count*points[id],0);
      collectSegment(total(base),outcomes.map(row=>({window:row.window,score:total(row.points)})));
    }
    for(const [id,count] of span.counts){
      let plain=survival*base[id];
      for(const row of outcomes)plain+=row.mass*row.plain[id];
      score+=count*expected(id);
      plainScore+=count*plain;
      maxScore+=count*strongest[id];
      unskilled+=count*base[id];
    }
    // The reviewed expectation takes the midpoint of legal simultaneous-note
    // orders at combo boundaries. The maximum uses the stored chart order.
    for(const tie of span.ties){
      const deltas=[];
      let recorded=0;
      for(let j=tie.start;j<tie.end;j++){
        const low=tie.first+table.classes[j]%table.stride;
        const delta=expected(low+table.stride)-expected(low);
        deltas.push(delta);
        if(table.classes[j]!==low)recorded+=delta;
      }
      deltas.sort((a,b)=>a-b);
      lowerAdjustment-=recorded;
      upperAdjustment-=recorded;
      for(let j=0;j<tie.highSlots;j++){
        lowerAdjustment+=deltas[j];
        upperAdjustment+=deltas[deltas.length-1-j];
      }
    }
  }
  const specialPoints=score-plainScore;
  score=(Math.floor((score+lowerAdjustment)*1000)+Math.floor((score+upperAdjustment)*1000))/2000;
  return {score,maxScore,activePermil:unskilled?(plainScore/unskilled-1)*1000:0,
    specialPermil:unskilled?specialPoints/unskilled*1000:0,uptime:windows.uptime};
}
