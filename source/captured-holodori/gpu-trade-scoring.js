// Score the captured Active/Special windows on the GPU. The host prepares
// Board effects, unlock conditions and chart curves using the shared model.
const shader=`
struct Options { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage,read> rows: array<f32>;
@group(0) @binding(1) var<storage,read> offsets: array<u32>;
@group(0) @binding(2) var<uniform> options: Options;
@group(0) @binding(3) var<storage,read_write> scores: array<f32>;

@compute @workgroup_size(64)
fn scoreTimelines(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= options.count) { return; }
  let head = offsets[id.x];
  let activeCount = u32(rows[head+1u]);
  let specialCount = u32(rows[head+2u]);
  let segmentCount = u32(rows[head+3u]);
  let activeStart = head+4u;
  let special = activeStart+5u*activeCount;
  let segments = special+3u*specialCount;
  var expected = 0.0;
  var maximum = 0.0;
  for (var i = 0u; i < segmentCount; i++) {
    let weight = rows[segments+i];
    if (weight <= 0.0) { continue; }
    var specialUp = 0.0;
    for (var s = 0u; s < specialCount; s++) {
      let k = special+3u*s;
      if (f32(i) >= rows[k] && f32(i) < rows[k+1u]) { specialUp = max(specialUp,rows[k+2u]); }
    }
    var values: array<f32,64>;
    var probabilities: array<f32,64>;
    var count = 0u;
    for (var a = 0u; a < activeCount; a++) {
      let k = activeStart+5u*a;
      if (f32(i) < rows[k] || f32(i) >= rows[k+1u]) { continue; }
      let value = rows[k+2u]*(1.0+rows[head]+rows[k+3u]+specialUp);
      var p = count;
      loop {
        if (p == 0u || values[p-1u] >= value) { break; }
        values[p] = values[p-1u];
        probabilities[p] = probabilities[p-1u];
        p -= 1u;
      }
      values[p] = value;
      probabilities[p] = rows[k+4u];
      count += 1u;
    }
    if (count > 0u) { maximum += values[0]*weight; }
    var remaining = 1.0;
    for (var a = 0u; a < count; a++) {
      expected += values[a]*probabilities[a]*remaining*weight;
      remaining *= 1.0-probabilities[a];
    }
  }
  scores[2u*id.x] = 1.0+expected/100.0;
  scores[2u*id.x+1u] = 1.0+maximum/100.0;
}
`;

const unitShader=`
struct Size { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage,read> powers: array<f32>;
@group(0) @binding(1) var<storage,read> skills: array<f32>;
@group(0) @binding(2) var<uniform> size: Size;
@group(0) @binding(3) var<storage,read_write> scores: array<f32>;

fn activeAverage(head: u32, upgraded: bool) -> f32 {
  var total = 0.0;
  for (var tick = 1u; tick <= 200u; tick++) {
    var weighted = 0.0;
    var probabilities = 0.0;
    let second = f32(tick);
    for (var member = 0u; member < 5u; member++) {
      let offset = head+2u+member*11u;
      let duration = skills[offset+5u];
      var cooldown = skills[offset+4u];
      if (cooldown <= 0.0 || duration <= 0.0) { continue; }
      var magnitude = select(skills[offset],skills[offset+1u],second < skills[offset+2u]);
      var probability = skills[offset+3u];
      if (upgraded) {
        let effect = skills[head+1u]+skills[offset+7u]+skills[offset+8u];
        magnitude = ceil(magnitude*(1.0+effect/1000.0)-0.0001);
        probability = ceil(probability*(1.0+skills[offset+9u]/1000.0)-0.0001);
        cooldown /= 1.0+skills[offset+10u]/1000.0;
      }
      let start = floor((second+0.0001)/cooldown)*cooldown;
      if (start > 0.0 && second+0.0001 < start+duration) {
        weighted += magnitude*probability;
        probabilities += probability;
      }
    }
    if (probabilities > 0.0) { total += weighted/max(1000.0,probabilities); }
  }
  return ceil(total/200.0-0.0001);
}

@compute @workgroup_size(64)
fn scoreUnits(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= size.count) { return; }
  let power = powers[id.x];
  let head = id.x*57u;
  var bonus = skills[head];
  if (bonus < 0.0) {
    let base = activeAverage(head,false);
    var special = 0.0;
    var passive = false;
    var board = false;
    for (var member = 0u; member < 5u; member++) {
      let offset = head+2u+member*11u;
      special += skills[offset+6u];
      passive = passive || skills[offset+7u] > 0.0;
      board = board || skills[offset+8u] > 0.0 || skills[offset+9u] > 0.0 || skills[offset+10u] > 0.0;
    }
    let sources = select(0u,1u,skills[head+1u] > 0.0)+select(0u,1u,passive)+select(0u,1u,board);
    var boost = 0.0;
    if (sources > 0u) { boost = max(0.0,activeAverage(head,true)+f32(sources-1u)-base); }
    bonus = base+boost+ceil((base*special)/120000.0-0.0001);
  }
  scores[id.x] = ceil(power*(1000.0+bonus)*(101867.0/50000000.0));
}
`;

function boardMetric(scores,{sortBy='avg',merged=false},eventBonus=0,epPermil){
  const index=sortBy==='max'?1:0;
  if(merged){
    const top=scores.map(score=>score[index]).sort((a,b)=>b-a).slice(0,3);
    return {value:top.reduce((total,score)=>total+Math.ceil(score/5000),0),
      tie:top.reduce((total,score)=>total+score,0)};
  }
  let total=scores.reduce((sum,row)=>sum+row[index],0);
  if(eventBonus>0)total=Math.ceil(total*(1+eventBonus/1000));
  if(epPermil!==undefined)total=(120+total/15000)*(1+epPermil/1000);
  return {value:total,tie:total};
}

/** Rank funded proposals on the GPU, with shared reference math for finalists. */
export function createGpuObjectiveScorer(kernels,scoreTimelines=createGpuTradeScorer(kernels)){
  let unitPipeline;
  return async function scoreObjectives(trials,options={}){
    if(!trials.length)return [];
    if(options.unit){
      unitPipeline??=kernels.pipeline(unitShader,'scoreUnits');
      const batches=[];
      for(let start=0;start<trials.length;start+=65536){
        const batch=trials.slice(start,start+65536);
        const powers=new Uint32Array(Float32Array.from(batch,row=>Math.round(row.power)).buffer);
        const skills=new Float32Array(batch.length*57);
        for(const [index,row] of batch.entries()){
          const offset=index*57;
          skills[offset]=row.members?-1:row.bonus;
          skills[offset+1]=row.outfitBonus??0;
          for(const [position,member] of (row.members??[]).entries()){
            skills.set([member.mag,member.magLo,member.onset,member.prob,member.cooldown,member.duration,
              member.magS*member.durS*(1+member.riderS/2000),member.ePassive,member.eBoard,member.probUp,member.shorten],
            offset+2+position*11);
          }
        }
        const scores=await kernels.dispatch(await unitPipeline,[powers,new Uint32Array(skills.buffer),[batch.length,0,0,0]],
          batch.length,[Math.ceil(batch.length/64)]);
        batches.push(...new Float32Array(scores.buffer,scores.byteOffset,scores.length));
      }
      return batches.map(value=>({value,tie:value}));
    }
    const scores=await scoreTimelines(trials.map(trial=>trial.windows));
    return scores?.map((row,index)=>boardMetric(row,options,trials[index].eventBonus,trials[index].epPermil))??null;
  };
}

function curveAt(curve,time,seconds){
  if(!curve.length)return Math.min(1,Math.max(0,time/seconds));
  const index=Math.max(0,Math.min(curve.length-1,Math.floor(time)));
  if(index===curve.length-1)return curve[index];
  return curve[index]+(curve[index+1]-curve[index])*(time-index);
}

export function createGpuTradeScorer(kernels){
  let pipeline;
  let curveCount=0;
  const curves=new WeakMap();
  const timelineKeys=new WeakMap();
  const cache=new Map();
  function multiplierKey({active,special,seconds,curve,outfit}){
    const previous=timelineKeys.get(active);
    if(previous?.special===special&&previous.seconds===seconds&&previous.curve===curve&&previous.outfit===outfit)
      return previous.key;
    if(!curves.has(curve))curves.set(curve,curveCount++);
    const key=JSON.stringify([curves.get(curve),seconds,outfit,active,special]);
    timelineKeys.set(active,{special,seconds,curve,outfit,key});
    return key;
  }
  return async function scoreTrades(trials){
    const rows=[],offsets=[],ranges=[],pending=new Map();
    for(const trial of trials){
      const range=[];
      for(const timeline of trial){
        const {active,special,seconds,curve,outfit,base}=timeline;
        // Parameters and song bonuses scale the same Active/Special windows.
        // Reuse the GPU multiplier when only these values change.
        const key=multiplierKey(timeline);
        range.push({key,base});
        if(cache.has(key)||pending.has(key))continue;
        pending.set(key,offsets.length);
        const edges=new Set([0,seconds]);
        for(const {s,e} of active){edges.add(s);edges.add(e);}
        for(const {s,e} of special){
          if(s<seconds)edges.add(Math.max(0,s));
          if(e<seconds)edges.add(Math.max(0,e));
        }
        const sorted=[...edges].sort((a,b)=>a-b),segments=[];
        for(let i=0;i<sorted.length-1;i++){
          const left=sorted[i],right=sorted[i+1];
          const weight=curveAt(curve,right,seconds)-curveAt(curve,left,seconds);
          segments.push(weight);
        }
        offsets.push(rows.length);
        const edgeIndex=new Map(sorted.map((time,index)=>[time,index]));
        if(active.length>64){
          const overlapDelta=new Int32Array(sorted.length);
          for(const {s,e} of active){
            overlapDelta[edgeIndex.get(s)]++;
            overlapDelta[edgeIndex.get(e)]--;
          }
          let overlap=0;
          for(const delta of overlapDelta)if((overlap+=delta)>64)return null;
        }
        rows.push(outfit/1000,active.length,special.length,segments.length);
        for(const {s,e,raw,eff,p} of active)rows.push(edgeIndex.get(s),edgeIndex.get(e),raw,eff,p);
        for(const {s,e,sup} of special)rows.push(edgeIndex.get(Math.max(0,s))??segments.length,
          edgeIndex.get(Math.max(0,e))??segments.length,sup);
        for(const value of segments)rows.push(value);
      }
      ranges.push(range);
    }
    if(offsets.length){
      pipeline??=kernels.pipeline(shader,'scoreTimelines');
      const words=new Uint32Array(Float32Array.from(rows).buffer);
      const scores=new Float32Array(offsets.length*2);
      const compute=await pipeline;
      // Fit even the minimum WebGPU storage limits when a large proposal
      // batch includes several long Generic or Rating chart scenarios.
      for(let start=0;start<offsets.length;){
        let end=start+1;
        while(end<offsets.length&&end-start<16384&&(offsets[end+1]??words.length)-offsets[start]<1048576)end++;
        const chunk=words.subarray(offsets[start],offsets[end]??words.length);
        const count=end-start;
        const indices=Uint32Array.from(offsets.slice(start,end),index=>index-offsets[start]);
        const output=await kernels.dispatch(compute,[chunk,indices,[count,0,0,0]],count*2,[Math.ceil(count/64)]);
        scores.set(new Float32Array(output.buffer,output.byteOffset,output.length),start*2);
        start=end;
      }
      for(const [key,index] of pending)cache.set(key,[scores[index*2],scores[index*2+1]]);
    }
    const result=ranges.map(range=>range.map(({key,base})=>{
      const [average,maximum]=cache.get(key);
      return [base*average,base*maximum];
    }));
    while(cache.size>1024)cache.delete(cache.keys().next().value);
    return result;
  };
}
