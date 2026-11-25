import {evaluateReferenceTeam,withReferenceChart} from './reference-rating-math';
import {boardFrontierPaths,boardPointsAtRank} from './unit-score-board-search';
import {boardPlanningBaseline,boardProtection} from './board-protection';
import {eligibleTeamOutfits as eligibleGpuOutfits,isTeamCardEligible} from './team-card-pool';
export {eligibleGpuOutfits};

const workgroupSize=64;

// The host supplies up to five ordered lists of eligible card indices. The
// mixed-radix index represents an actual five-slot lineup, not a score input
// precomputed by the reference solver.
const teamShader=`
struct Card { member: u32, power: u32, cardType: u32, performance: u32 }
struct Candidate { index: u32, value: u32 }
struct Search { count: u32, preferredAttribute: u32, performance: u32, retainAll: u32 }
@group(0) @binding(0) var<storage,read> cards: array<Card>;
@group(0) @binding(1) var<storage,read> slots: array<u32>;
@group(0) @binding(2) var<uniform> search: Search;
@group(0) @binding(3) var<storage,read_write> winners: array<Candidate>;
var<workgroup> candidates: array<Candidate,64>;

fn better(a: Candidate, b: Candidate) -> bool {
  return a.value > b.value || (a.value == b.value && a.index < b.index);
}

fn slotCard(seat: u32, index: u32) -> Card {
  return cards[slots[slots[5u+seat]+index]];
}

fn contribution(card: Card) -> u32 {
  let matchesType = search.preferredAttribute != 0u && card.cardType == search.preferredAttribute;
  return card.power + select(0u,card.power/10u,matchesType) + card.performance*search.performance/100u;
}

@compute @workgroup_size(64)
fn searchTeams(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let batch = group.x + group.y * 1024u;
  let index = batch * 64u + lane;
  var result = Candidate(0xffffffffu, 0u);
  if (index < search.count) {
    var code = index;
    var members: array<u32,5>;
    var valid = true;
    var power = 0u;
    for (var i = 0u; i < 5u; i++) {
      let width = slots[i];
      let card = slotCard(i,code%width);
      code /= width;
      for (var j = 0u; j < i; j++) { valid = valid && members[j] != card.member; }
      members[i] = card.member;
      power += contribution(card);
    }
    if (valid) { result = Candidate(index, power); }
  }
  if (search.retainAll != 0u) {
    if (index < search.count) { winners[index] = result; }
    return;
  }
  candidates[lane] = result;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride /= 2u) {
    if (lane < stride && better(candidates[lane+stride],candidates[lane])) {
      candidates[lane] = candidates[lane+stride];
    }
    workgroupBarrier();
  }
  if (lane == 0u && batch * 64u < search.count) { winners[batch] = candidates[0]; }
}

// The least-significant slot forms contiguous ranges within the original
// reduction batch. Evaluate those ranges against cards already sorted by
// exact contribution, without scoring every permutation in the range.
@compute @workgroup_size(64)
fn reduceTeamRanges(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let batch = (group.x + group.y*1024u)*64u+lane;
  let batchCount = (search.count-1u)/64u+1u;
  if (batch >= batchCount) { return; }
  let end = min(64u,search.count-batch*64u)+batch*64u;
  let width = slots[0u];
  let ranked = arrayLength(&slots)-width;
  var start = batch*64u;
  var result = Candidate(0xffffffffu,0u);
  for (; start < end;) {
    let offset = start%width;
    let size = min(width-offset,end-start);
    var code = start/width;
    let b = slotCard(1u,code%slots[1u]);
    code /= slots[1u];
    let c = slotCard(2u,code%slots[2u]);
    code /= slots[2u];
    let d = slotCard(3u,code%slots[3u]);
    code /= slots[3u];
    let e = slotCard(4u,code);
    if (b.member != c.member && b.member != d.member && b.member != e.member &&
        c.member != d.member && c.member != e.member && d.member != e.member) {
      for (var n = 0u; n < width; n++) {
        let position = slots[ranked+n];
        if (position < offset || position-offset >= size) { continue; }
        let a = slotCard(0u,position);
        if (a.member == b.member || a.member == c.member || a.member == d.member || a.member == e.member) { continue; }
        let value = Candidate(start-offset+position,contribution(a)+contribution(b)+
          contribution(c)+contribution(d)+contribution(e));
        if (better(value,result)) { result = value; }
        break;
      }
    }
    start += size;
  }
  winners[batch] = result;
}
`;

// One GPU lane per complete Board move. Positive finite f32 score bits sort
// in the same order as the scores. The CPU rescoring stage resolves ties.
const boardShader=`
struct Options { count: u32, materials: u32, unlimited: u32, reserved: u32 }
@group(0) @binding(0) var<storage,read> moves: array<u32>;
@group(0) @binding(1) var<storage,read> available: array<u32>;
@group(0) @binding(2) var<uniform> options: Options;
@group(0) @binding(3) var<storage,read_write> legal: array<u32>;

@compute @workgroup_size(64)
fn checkBoards(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= options.count) { return; }
  let offset = index*(5u+options.materials);
  var valid = moves[offset] <= moves[offset+1u] && moves[offset+2u] <= available[0] &&
    moves[offset+3u] <= available[1];
  if (options.unlimited == 0u) {
    for (var material = 0u; material < options.materials; material++) {
      valid = valid && moves[offset+4u+material] <= available[2u+material];
    }
  }
  legal[index] = select(0u,moves[offset+4u+options.materials],valid);
}
`;

const uint=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;

const tradeShader=`
struct Size { count: u32, materials: u32, unlimited: u32, padding: u32 }
@group(0) @binding(0) var<storage,read> trades: array<u32>;
@group(0) @binding(1) var<storage,read> stock: array<u32>;
@group(0) @binding(2) var<uniform> size: Size;
@group(0) @binding(3) var<storage,read_write> winners: array<u32>;
@compute @workgroup_size(64)
fn checkTrades(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= size.count) { return; }
  let base = i * (4u + 2u * size.materials);
  var legal = trades[base] <= trades[base+1u] && trades[base+2u] <= stock[0];
  if (size.unlimited == 0u) {
    for (var m = 0u; m < size.materials; m++) {
      let debit = trades[base+4u+m];
      let credit = trades[base+4u+size.materials+m];
      legal = legal && debit-min(debit,credit) <= stock[m+1u];
    }
  }
  winners[i] = select(0u,trades[base+3u],legal);
}
`;

// Rectangular maximum-weight assignment. Each socket has a dummy column
// available so a zero-value placement can stay empty. One invocation owns
// the alternating paths, prices, and column claims for a complete layout.
const connectShader=(rows,columns)=>`
struct Size { rows: u32, cards: u32, columns: u32, padding: u32 }
@group(0) @binding(0) var<storage,read> weights: array<i32>;
@group(0) @binding(1) var<storage,read> reserved: array<u32>;
@group(0) @binding(2) var<uniform> size: Size;
@group(0) @binding(3) var<storage,read_write> result: array<u32>;
@compute @workgroup_size(1)
fn matchConnects() {
  var rowPrice: array<i32, ${rows+1}>;
  var colPrice: array<i32, ${columns+1}>;
  var claim: array<u32, ${columns+1}>;
  var previous: array<u32, ${columns+1}>;
  var distance: array<i32, ${columns+1}>;
  var used: array<bool, ${columns+1}>;
  for (var row = 1u; row <= size.rows; row++) {
    result[row-1u] = 0u;
    claim[0] = row;
    var column = 0u;
    for (var j = 0u; j <= size.columns; j++) {
      distance[j] = 0x3fffffff;
      used[j] = false;
    }
    loop {
      used[column] = true;
      let owner = claim[column];
      var delta = 0x3fffffff;
      var next = 0u;
      for (var j = 1u; j <= size.columns; j++) {
        if (used[j]) { continue; }
        var weight = 0;
        if (j <= size.cards && reserved[j-1u] == 0u) {
          weight = weights[(owner-1u)*size.cards+j-1u];
        }
        let reduced = -weight-rowPrice[owner]-colPrice[j];
        if (reduced < distance[j]) {
          distance[j] = reduced;
          previous[j] = column;
        }
        if (distance[j] < delta) {
          delta = distance[j];
          next = j;
        }
      }
      for (var j = 0u; j <= size.columns; j++) {
        if (used[j]) {
          rowPrice[claim[j]] += delta;
          colPrice[j] -= delta;
        } else {
          distance[j] -= delta;
        }
      }
      column = next;
      if (claim[column] == 0u) { break; }
    }
    loop {
      let prior = previous[column];
      claim[column] = claim[prior];
      column = prior;
      if (column == 0u) { break; }
    }
  }
  for (var j = 1u; j <= size.cards; j++) {
    let row = claim[j];
    if (row != 0u && reserved[j-1u] == 0u && weights[(row-1u)*size.cards+j-1u] > 0) {
      result[row-1u] = j;
    }
  }
}
`;

export class OptimizerGpuError extends Error {
  constructor(message,cause){super(message,{cause});this.name='OptimizerGpuError';}
}

export async function createGpuDispatcher(gpu=globalThis.navigator?.gpu) {
  let device;
  try{
    const adapter=await gpu?.requestAdapter({powerPreference:'high-performance'});
    if(!adapter||adapter.info?.isFallbackAdapter)throw Error('Hardware adapter unavailable.');
    device=await adapter.requestDevice();
  }catch(cause){
    throw new OptimizerGpuError('WebGPU could not start on a hardware adapter. Try again or turn off Use GPU in Settings.',cause);
  }
  let lost=false;
  device.lost.then(()=>{lost=true;});
  const lostError=cause=>new OptimizerGpuError('The GPU stopped during the search. Try again or turn off Use GPU in Settings.',cause);
  const pipeline=async(code,entryPoint)=>{
    const module=device.createShaderModule({code});
    const {messages}=await module.getCompilationInfo();
    const errors=messages.filter(message=>message.type==='error');
    if(errors.length)throw Error(errors.map(error=>error.message).join('\n'));
    return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
  };
  const available=new Map();
  let cachedBytes=0;
  const cacheLimit=64*1024*1024;

  async function dispatch(compute,inputs,words,groups){
    if(lost)throw lostError();
    if(!groups.every(size=>size<=device.limits.maxComputeWorkgroupsPerDimension)||
      [words,...inputs.map(data=>data.length)].some(size=>size*4>device.limits.maxStorageBufferBindingSize))
      throw Error('The GPU search batch exceeds the adapter limits.');
    const buffers=[];
    function buffer(words,usage){
      const size=Math.min(device.limits.maxBufferSize,2**Math.ceil(Math.log2(words*4)));
      const key=usage+':'+size;
      const free=available.get(key),reused=free?.pop();
      if(free?.length===0)available.delete(key);
      if(reused)cachedBytes-=reused.size;
      const next=reused??device.createBuffer({size,usage});
      buffers.push({next,key});
      return next;
    }
    let complete=false;
    try{
      const uploaded=inputs.map((data,index)=>{
        const usage=index===2?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE;
        const input=buffer(data.length,usage|GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(input,0,data instanceof Uint32Array?data:Uint32Array.from(data));
        return input;
      });
      const output=buffer(words,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
      const readback=buffer(words,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      const bindGroup=device.createBindGroup({layout:compute.getBindGroupLayout(0),
        entries:[...uploaded,output].map((buffer,binding)=>({binding,resource:{buffer,
          size:(inputs[binding]?.length??words)*4}}))});
      const encoder=device.createCommandEncoder();
      // Each kernel writes every output word, including unassigned slots.
      const pass=encoder.beginComputePass();
      pass.setPipeline(compute);
      pass.setBindGroup(0,bindGroup);
      pass.dispatchWorkgroups(...groups);
      pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,words*4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ,0,words*4);
      const result=new Uint32Array(readback.getMappedRange(0,words*4)).slice();
      readback.unmap();
      complete=true;
      return result;
    }catch(error){
      if(lost)throw lostError(error);
      throw error;
    }finally{
      for(const {next,key} of buffers){
        if(complete&&!lost&&cachedBytes+next.size<=cacheLimit){
          if(!available.has(key))available.set(key,[]);
          available.get(key).push(next);
          cachedBytes+=next.size;
        }else next.destroy();
      }
    }
  }
  return {pipeline,dispatch,close(){device.destroy();}};
}

export async function createGpuSearchKernels(gpu,dispatcher) {
  const {pipeline,dispatch,close}=dispatcher??await createGpuDispatcher(gpu);
  let team,teamRanges,board,trade;
  const connectPipelines=new Map();
  const timings={teamDispatch:0,teamRead:0,teamPasses:0};
  async function checkBoardBatch(moves,available,{unlimited=false}={}){
    const width=available.length+3,count=moves.length/width;
    if(!count)return new Uint32Array();
    if(available.length<2||!available.every(uint)||!uint(count))
      throw Error('The Board search inputs exceed the GPU kernel range.');
    board??=pipeline(boardShader,'checkBoards');
    return dispatch(await board,[moves,available,[count,available.length-2,Number(unlimited),0]],
      count,[Math.ceil(count/workgroupSize)]);
  }
  return {
    timings,
    pipeline,dispatch,
    async searchTeams(cards,slots,{attribute=0,performance=0,retainAll=false,deduplicate=false}={}){
      if(slots.length!==5)throw Error('GPU team search requires five slots.');
      if(slots.some(slot=>!slot.length))return {examined:0,teams:[]};
      if(!cards.every(card=>card.length===4&&card.every(uint)&&card[1]<=100000000)||
        !slots.every(slot=>slot.every(index=>uint(index)&&index<cards.length))||!uint(attribute)||
        !Number.isInteger(performance)||performance<0||performance>500)
        throw Error('The team search inputs exceed the GPU kernel range.');
      const count=slots.reduce((product,slot)=>product*slot.length,1);
      if(!uint(count))throw Error('The team search needs a smaller GPU batch.');
      const lookup=slots.map(slot=>slot.length);
      let offset=10;
      for(const slot of slots){lookup.push(offset);offset+=slot.length;}
      for(const slot of slots)for(const index of slot)lookup.push(index);
      const batches=Math.ceil(count/workgroupSize);
      // Only aggregate ranges when sums cannot wrap. This preserves the
      // original shader's unsigned arithmetic on unusual synthetic inputs.
      const contribution=([,power,type,perf])=>power+(attribute&&type===attribute?Math.floor(power/10):0)+
        Math.floor((Math.imul(perf,performance)>>>0)/100);
      const compact=!retainAll&&slots[0].length>=8&&cards.every(card=>contribution(card)<=0xffffffff/5);
      let compute,groups;
      if(compact){
        const ranked=slots[0].map((id,position)=>({position,value:contribution(cards[id])}))
          .sort((a,b)=>b.value-a.value||a.position-b.position);
        for(const {position} of ranked)lookup.push(position);
        teamRanges??=pipeline(teamShader,'reduceTeamRanges');
        compute=teamRanges;
        groups=Math.ceil(batches/workgroupSize);
      }else{
        team??=pipeline(teamShader,'searchTeams');
        compute=team;
        groups=batches;
      }
      let started=globalThis.performance.now();
      const result=await dispatch(await compute,[cards.flat(),lookup,[count,attribute,performance,Number(retainAll)]],
        (retainAll?count:batches)*2,[Math.min(1024,groups),Math.ceil(groups/1024)]);
      timings.teamDispatch+=globalThis.performance.now()-started;
      timings.teamPasses++;
      started=globalThis.performance.now();
      if(deduplicate&&!retainAll&&cards.length<=1024){
        const groups=new Map(),order=new Int32Array(5),sorted=new Int32Array(5);
        const unpack=code=>{
          for(let i=0;i<5;i++){
            order[i]=slots[i][code%slots[i].length];
            code=Math.floor(code/slots[i].length);
          }
        };
        for(let i=0;i<result.length;i+=2){
          const code=result[i];
          if(code===0xffffffff)continue;
          unpack(code);
          sorted.set(order);
          sorted.sort();
          let key=0;
          for(let slot=0;slot<5;slot++)key=1024*key+sorted[slot];
          const existing=groups.get(key);
          if(existing)existing.lastCode=code;
          else groups.set(key,{order:[...order],firstCode:code,lastCode:code,power:result[i+1]});
        }
        const teams=[...groups.values()];
        for(const row of teams)if(row.firstCode!==row.lastCode){
          unpack(row.lastCode);
          row.lastOrder=[...order];
        }
        timings.teamRead+=globalThis.performance.now()-started;
        return {examined:count,teams};
      }
      const teams=[];
      for(let index=0;index<result.length;index+=2){
        let code=result[index];
        if(code===0xffffffff)continue;
        const order=slots.map(slot=>{const id=slot[code%slot.length];code=Math.floor(code/slot.length);return id;});
        teams.push({order,power:result[index+1]});
      }
      timings.teamRead+=globalThis.performance.now()-started;
      return {examined:count,teams};
    },
    async checkBoards(moves,available,{unlimited=false}={}){
      if(!moves.length)return new Uint32Array();
      if(moves.some(move=>move.length!==available.length+3||!move.every(uint)))
        throw Error('The Board search inputs exceed the GPU kernel range.');
      return checkBoardBatch(Uint32Array.from(moves.flat()),available,{unlimited});
    },
    checkBoardBatch,
    async matchConnects(weights,reserved){
      const rows=weights.length,cards=reserved.length;
      if(!rows||!cards)return new Uint32Array(rows);
      const columns=rows+cards;
      if(!reserved.every(value=>value===0||value===1)||weights.some(row=>row.length!==cards||
        row.some(value=>!uint(value)||value>10000000)))throw Error('Connect assignment exceeds the GPU kernel range.');
      const capacity=n=>2**Math.ceil(Math.log2(n));
      const key=capacity(rows)+','+capacity(columns);
      if(!connectPipelines.has(key))connectPipelines.set(key,pipeline(connectShader(capacity(rows),capacity(columns)),'matchConnects'));
      return dispatch(await connectPipelines.get(key),[weights.flat(),reserved,[rows,cards,columns,0]],rows,[1]);
    },
    async checkTrades(trades,stock,{unlimited=false}={}){
      if(!trades.length)return new Uint32Array();
      const materials=stock.length-1;
      if(materials<0||!stock.every(uint)||trades.some(row=>row.length!==4+2*materials||!row.every(uint)))
        throw Error('The Board trade inputs exceed the GPU kernel range.');
      trade??=pipeline(tradeShader,'checkTrades');
      const compute=await trade;
      const result=new Uint32Array(trades.length);
      for(let offset=0;offset<trades.length;offset+=65536){
        const batch=trades.slice(offset,offset+65536);
        result.set(await dispatch(compute,[batch.flat(),stock,[batch.length,materials,Number(unlimited),0]],
          batch.length,[Math.ceil(batch.length/workgroupSize)]),offset);
      }
      return result;
    },
    close,
  };
}

function activeSkillLevel(skill,bloom){
  const levels=skill?.levels;
  return levels?.[skill.bloomUnlock&&bloom>=skill.bloomUnlock?levels.length-1:0];
}

const activeOutfit=outfit=>outfit?.effects?.some(({type})=>type==='LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP');

function fitsOutfit(outfit,lineup){
  return (outfit.triggers??[]).every(trigger=>{
    const required=trigger.count??1;
    if(trigger.type==='DECK_CARD_ATTRIBUTE')return lineup.filter(card=>card.attribute===trigger.attr).length>=required;
    if(trigger.type==='DECK_CARD_CHARACTER_GROUPING')return lineup.filter(card=>
      card.groupingIds.includes(trigger.grouping)).length>=required;
    return true;
  });
}

function projectedActiveBoards(data,payload,context,cards){
  const {account,boardOpt}=payload;
  if(!boardOpt?.branches?.includes('blue'))return null;
  const board=new Map(context.board);
  const startingBoards=boardPlanningBaseline(account.boards,boardOpt);
  const branches=new Set(boardOpt.branches);
  for(const owner of new Set(cards.map(card=>card.characterId))){
    const protection=boardProtection(boardOpt,owner);
    if(protection==='locked')continue;
    const nodes=data.boards[owner];
    const rank=boardOpt.maxBoardPoints?data.boardPointLadder.length-1:account.ranks[owner]??(boardOpt.allInvited?1:0);
    if(!rank||!nodes)continue;
    let save=startingBoards[owner]??{nodes:[],cards:{}};
    const budget=boardPointsAtRank(data.boardPointLadder,rank);
    const stats={};
    const awarded=new Set(save.nodes);
    const base=board.get(owner);
    if(!base)continue;
    const skillValue=node=>node.kind==='activeChance'?node.value:
      node.kind==='activeFreq'?0.6*node.value:0;
    const parameterValue=node=>node.kind==='param'?node.value*3/30:
      ['performance','technique','sense'].includes(node.kind)?node.value/30:
      node.kind?.endsWith('Permil')?node.value/3:0;
    // Blue Board opportunities are a separate screening lens. New socket
    // locations can amplify connected blue nodes, and the Board planner
    // will choose the actual Connect cards and validate all spending.
    for(;;){
      const frontier=boardFrontierPaths(nodes,save,account.dreamRank,branches,8);
      if(!frontier)break;
      let best;
      for(const move of frontier.paths){
        if(!move.points||move.points+frontier.spent>budget||move.path.some(node=>node.branch&&node.branch!=='blue'))continue;
        const gain=move.path.reduce((sum,node)=>sum+skillValue(node)+parameterValue(node),0)/(1+move.points);
        if(gain>(best?.gain??0))best={move,gain};
      }
      if(!best)break;
      const {move}=best;
      save={...save,nodes:[...save.nodes,...move.path.filter(node=>node.pts).map(node=>node.id)]};
    }
    const sockets=nodes.filter(node=>node.socket&&(node.pts===0||save.nodes.includes(node.id)));
    for(const node of nodes){
      if(awarded.has(node.id)||!save.nodes.includes(node.id)||(!skillValue(node)&&!parameterValue(node)))continue;
      const hasConnectReach=sockets.some(socket=>Math.abs(socket.x-node.x)+Math.abs(socket.y-node.y)<=3);
      const value=node.value*(hasConnectReach?2.25:1);
      stats[node.kind]=(stats[node.kind]??0)+value;
    }
    if(Object.keys(stats).length){
      const projected={...base};
      for(const [kind,gain] of Object.entries(stats))projected[kind]=(projected[kind]??0)+gain;
      board.set(owner,projected);
    }
  }
  return {...context,board};
}

export async function shortlistGpuTeams(kernels,data,payload,context,score,{limit=24,width=16,boardScores=[],rounds=3,activeProjection=true}={}){
  const timing={sweep:0,initialScore:0,swapScore:0,activeScore:0};
  let started=performance.now();
  const {account,options}=payload;
  const cards=data.cards.filter(card=>account.owned[card.id]?.owned&&isTeamCardEligible(card,options));
  const members=new Map(),attributes=new Map();
  const index=(map,value)=>{
    if(value==null)return 0;
    if(!map.has(value))map.set(value,map.size+1);
    return map.get(value);
  };
  const byId=new Map(cards.map((card,i)=>[card.id,i]));
  const stats=cards.map(card=>{
    const stat=context.stats.get(card.id);
    const power=stat.performance+stat.technique+stat.sense;
    return [index(members,card.characterId),power,index(attributes,card.attribute),stat.performance];
  });
  const skillWeights=cards.map(card=>{
    const bloom=account.owned[card.id].bloom;
    const active=activeSkillLevel(card.active,bloom),special=activeSkillLevel(card.special,bloom);
    const potential=active?.cooldown>0?
      Math.max(active.scoreUp,active.upScoreUp??0)*active.prob*active.duration/active.cooldown:0;
    const passive=activeSkillLevel(card.passive,bloom);
    const chance=[passive,...passive?.additionalEffects??[]].reduce((sum,effect)=>
      sum+(effect?.stat==='activeChance'?effect.value*(effect.targetCount??5):0),0);
    const support=Math.max(special?.scoreUp??0,special?.upScoreUp??0);
    return Math.round(potential*5+support*(special?.duration??0)*2+((special?.actRateUp??0)+chance)*25);
  });
  const locked=(options.focusCardIds??[]).map(id=>byId.get(id));
  if(locked.length>5||locked.some(id=>id==null)||new Set(locked.map(id=>stats[id][0])).size!==locked.length)
    return {examined:0,teams:[]};
  const eligibleOutfits=eligibleGpuOutfits(data,payload);
  if(!eligibleOutfits.length)return {examined:0,teams:[]};
  const broadOutfits=!options.leaderChar&&eligibleOutfits.length>12;
  function screenOutfits(){
    if(!broadOutfits)return eligibleOutfits;
    const fixed=new Set(locked.map(index=>cards[index].characterId));
    const base=locked.map(index=>cards[index]);
    const powers=new Map(cards.map((card,index)=>[card.id,stats[index][1]+skillWeights[index]]));
    if(options.challengeStage){
      const featured=new Set(options.challengeStage.bonusCharacterIds);
      const teamPower=stats.map(row=>row[1]).sort((a,b)=>b-a).slice(0,5).reduce((sum,n)=>sum+n,0);
      for(const card of cards)if(featured.has(card.characterId))
        powers.set(card.id,powers.get(card.id)+teamPower*options.challengeStage.bonusPermil/1000);
    }
    const candidates=cards.filter(card=>!fixed.has(card.characterId));
    const fields={PERFORMANCE_UP_PERMIL_UP:'performance',TECHNIQUE_UP_PERMIL_UP:'technique',
      SENSE_UP_PERMIL_UP:'sense'};
    const match=(row,card)=>row.type==='DECK_CARD_ATTRIBUTE'?card.attribute===row.attr:
      row.type==='DECK_CARD_CHARACTER_GROUPING'?card.groupingIds.includes(row.grouping):true;
    function build(outfit,weighted){
      if(options.leaderNoOverlap&&fixed.has(outfit.characterId))return null;
      const points=card=>{
        const stats=context.stats.get(card.id);
        return powers.get(card.id)+(weighted?outfit.effects.reduce((sum,effect)=>
          sum+(fields[effect.type]?stats[fields[effect.type]]*effect.permil/1000:0),0):0);
      };
      const pool=candidates.filter(card=>!options.leaderNoOverlap||card.characterId!==outfit.characterId)
        .map(card=>({card,points:points(card)})).sort((a,b)=>b.points-a.points);
      const lineup=base.slice(),used=new Set(fixed);
      const take=choice=>{
        lineup.push(choice.card);
        used.add(choice.card.characterId);
      };
      for(const trigger of outfit.triggers??[]){
        const required=trigger.count??1;
        while(lineup.length<5&&lineup.filter(card=>match(trigger,card)).length<required){
          const choice=pool.find(({card})=>!used.has(card.characterId)&&match(trigger,card));
          if(!choice)break;
          take(choice);
        }
      }
      for(const choice of pool){
        if(lineup.length===5)break;
        if(!used.has(choice.card.characterId))take(choice);
      }
      return lineup.length===5&&(!weighted||fitsOutfit(outfit,lineup))?lineup:null;
    }
    const screened=[];
    for(const entry of eligibleOutfits){
      const [id,outfit]=entry;
      const lineups=[build(outfit,false),build(outfit,true)].filter(Boolean);
      const tested=new Set();
      let best=-Infinity;
      for(const lineup of lineups){
        const key=lineup.map(card=>card.id).join('|');
        if(tested.has(key))continue;
        tested.add(key);
        for(const order of [lineup,lineup.slice().reverse()]){
          const row=score(order,id,outfit.characterId);
          best=Math.max(best,row.value,...boardScores.map(estimate=>estimate(order,id,outfit.characterId).value));
        }
      }
      if(Number.isFinite(best))screened.push({entry,best});
    }
    screened.sort((a,b)=>b.best-a.best);
    const diverse=new Map();
    for(const row of screened){
      const [,outfit]=row.entry;
      const skill=outfit.effects.map(effect=>effect.type).sort().join('|');
      if(!diverse.has(skill)&&row.best>=screened[0].best*.9)diverse.set(skill,row);
    }
    return [...new Set([...screened.slice(0,8),...diverse.values()])].slice(0,12).map(({entry})=>entry);
  }
  const outfits=screenOutfits();
  if(!outfits.length)return {examined:0,teams:[]};
  const merged=activeProjection&&options.lbCharts?.length>0;
  const activeContext=merged?projectedActiveBoards(data,payload,context,cards):null;
  timing.activeScore+=performance.now()-started;
  started=performance.now();
  const activeCharts=activeContext?options.lbCharts.map(({songId,difficulty})=>{
    const song=data.songs.find(row=>row.id===songId);
    return withReferenceChart(activeContext,song,song.difficulties.find(row=>row.type===difficulty));
  }):[];
  const activeMetric=options.sortBy==='max'?'maxScore':'score';
  const scored=new Map(),currentScored=new Map(),orders=new Map();
  const evaluated=new Map(),bestByOutfit=new Map(),activeOrders=new Map();
  const supportByCard=activeContext?new Map(cards.map(card=>[card.id,activeSkillLevel(card.special,account.owned[card.id].bloom)])):null;
  const compare=(a,b)=>b.potential-a.potential||b.value-a.value;
  const compareActive=(a,b)=>b.activePotential-a.activePotential||b.activeTieScore-a.activeTieScore;
  const compareGrowth=(a,b)=>(b.activePotential-0.65*b.value)-(a.activePotential-0.65*a.value)||compareActive(a,b);
  const compareSynergy=(a,b)=>b.activeSynergy-a.activeSynergy||compareActive(a,b);
  const supportStrength=(lineup,card)=>{
    const support=supportByCard.get(card.id);
    if(!support?.actRateUp)return 0;
    const gate=support.actRateUpType==='ATTRIBUTE'?lineup.filter(other=>other.attribute===support.actRateUpAttr).length:
      support.actRateUpType==='GROUPING'?lineup.filter(other=>other.groupingIds.includes(support.actRateUpGrouping)).length:Infinity;
    return gate>=(support.actRateUpThreshold??0)?support.actRateUp*support.duration:0;
  };
  function evaluate(lineup,outfitId,leader){
    const key=lineup.map(card=>card.id).join(',')+'|'+outfitId;
    if(evaluated.has(key))return evaluated.get(key);
    const row=score(lineup,outfitId,leader);
    const potential=Math.max(row.value,...boardScores.map(estimate=>estimate(lineup,outfitId,leader).value));
    const result={...row,potential};
    evaluated.set(key,result);
    const best=bestByOutfit.get(outfitId);
    if((!best||compare(result,best)<0)&&fitsOutfit(data.costumes[outfitId],lineup))bestByOutfit.set(outfitId,result);
    return result;
  }
  function evaluateActive(key,lineup,outfitId,leader,team){
    if(!activeCharts.length)return;
    if(team.activePotential===undefined){
      const scores=activeCharts.map(chart=>evaluateReferenceTeam(chart,lineup,outfitId,leader)[activeMetric])
        .sort((a,b)=>b-a).slice(0,3);
      team.activePotential=scores.reduce((sum,value)=>sum+Math.ceil(value/5000),0);
      team.activeTieScore=scores.reduce((sum,value)=>sum+value,0);
      team.activeSynergy=lineup.reduce((sum,card)=>sum+supportStrength(lineup,card),0);
    }
    if(!activeOrders.has(key)||compareActive(team,activeOrders.get(key))<0)activeOrders.set(key,team);
  }
  function record(key,team){
    if(!scored.has(key)||compare(team,scored.get(key))<0)scored.set(key,team);
    if(!currentScored.has(key)||team.value>currentScored.get(key).value)currentScored.set(key,team);
  }
  let examined=0;
  const lenses=[[0,0,0],...[...attributes.values()].map(value=>[value,0,0]),[0,150,0],
    ...[...attributes.values()].map(value=>[value,150,0])];
  for(const [,outfit] of outfits){
    for(const trigger of outfit.triggers??[]){
      if(trigger.type!=='DECK_CARD_ATTRIBUTE'||!attributes.has(trigger.attr)||trigger.count>5)continue;
      const type=attributes.get(trigger.attr);
      const performance=Math.max(0,...outfit.effects.filter(effect=>effect.type==='PERFORMANCE_UP_PERMIL_UP')
        .map(effect=>Math.min(500,Math.round(effect.permil/10))));
      if(!lenses.some(([a,p,n])=>a===type&&p===performance&&n===trigger.count))
        lenses.push([type,performance,trigger.count]);
    }
  }
  const outfitOrders=new Map();
  for(const [attribute,performance,required] of lenses){
    const preferred=stats.map((row,id)=>({id,value:(row[1]+row[3]*performance/100)*(attribute&&row[2]===attribute?1.45:1)}))
      .sort((a,b)=>b.value-a.value).map(({id})=>id);
    const pool=preferred.filter(id=>!locked.some(fixed=>stats[id][0]===stats[fixed][0]));
    const requiredPool=required?pool.filter(id=>stats[id][2]===attribute):pool;
    const needed=Math.max(0,required-locked.filter(id=>stats[id][2]===attribute).length);
    const slots=Array.from({length:5},(_,slot)=>locked[slot]==null?
      (slot-locked.length<needed?requiredPool:pool).slice(0,width):[locked[slot]]);
    const result=await kernels.searchTeams(stats,slots,{attribute,performance,deduplicate:true});
    examined+=result.examined;
    for(const {order,power,lastOrder} of result.teams){
      const key=[...order].sort((a,b)=>a-b).join(',');
      const normalized=power/(performance?1.5:1);
      if(!orders.has(key)||normalized>orders.get(key).power)orders.set(key,{order,power:normalized});
      if(required){
        const lens=attribute+':'+performance+':'+required;
        const candidates=outfitOrders.get(lens)??new Map();
        candidates.set(key,{order:lastOrder??order,power});
        outfitOrders.set(lens,candidates);
      }
    }
  }
  if(options.scoringMode==='chart'){
    const weighted=stats.map((row,id)=>[row[0],row[1]+skillWeights[id],row[2],row[3]]);
    const pool=weighted.map((_,id)=>id).filter(id=>!locked.some(fixed=>stats[id][0]===stats[fixed][0]))
      .sort((a,b)=>weighted[b][1]-weighted[a][1]);
    const slots=Array.from({length:5},(_,slot)=>locked[slot]==null?pool.slice(0,width):[locked[slot]]);
    const result=await kernels.searchTeams(weighted,slots,{deduplicate:true});
    examined+=result.examined;
    const skillOrders=new Map();
    for(const row of result.teams)skillOrders.set(row.order.slice().sort((a,b)=>a-b).join(','),
      {order:row.lastOrder??row.order,power:row.power});
    outfitOrders.set('skill',skillOrders);
    // Retain strong proposals at each attainable bonus-member count. A
    // weaker individual card can make an entire Challenge Live lineup win.
    if(options.challengeStage){
      const featured=new Set(options.challengeStage.bonusCharacterIds);
      const bonusPool=pool.filter(i=>featured.has(cards[i].characterId));
      const available=new Set(bonusPool.map(i=>cards[i].characterId)).size;
      const open=5-locked.length;
      for(let count=1;count<=Math.min(open,available);count++){
        const slots=[...locked.map(i=>[i]),...Array.from({length:open},(_,i)=>
          (i<count?bonusPool:pool).slice(0,width))];
        const sweep=await kernels.searchTeams(weighted,slots,{deduplicate:true});
        examined+=sweep.examined;
        const candidates=new Map();
        for(const {order,power} of sweep.teams)candidates.set(order.slice().sort((a,b)=>a-b).join(','),{order,power});
        outfitOrders.set('challenge:'+count,candidates);
      }
    }
    if(boardScores.length||payload.boardOpt&&!payload.ratingScout){
      // Explore lineups without requiring each skill to look strong in
      // isolation. Attribute- and generation-gated skills need partners.
      const groups=new Map();
      const outfitPerformance=new Map();
      for(const [,outfit] of outfits){
        const performance=Math.max(0,...outfit.effects.filter(effect=>effect.type==='PERFORMANCE_UP_PERMIL_UP')
          .map(effect=>Math.min(500,Math.round(effect.permil/10))));
        for(const trigger of outfit.triggers??[]){
          const key=trigger.type==='DECK_CARD_ATTRIBUTE'?'attribute:'+trigger.attr:
            trigger.type==='DECK_CARD_CHARACTER_GROUPING'?'group:'+trigger.grouping:null;
          if(key)outfitPerformance.set(key,Math.max(performance,outfitPerformance.get(key)??0));
        }
      }
      for(const [i,card] of cards.entries()){
        for(const key of ['attribute:'+card.attribute,...card.groupingIds.map(id=>'group:'+id)]){
          if(!boardScores.length&&!outfitPerformance.has(key))continue;
          const ids=groups.get(key)??[];
          ids.push(i);
          groups.set(key,ids);
        }
      }
      for(const [key,ids] of groups){
        const performance=outfitPerformance.get(key)??0;
        const strength=id=>weighted[id][1]+weighted[id][3]*performance/100;
        const core=performance?pool.slice().sort((a,b)=>strength(b)-strength(a)).slice(0,16):pool.slice(0,12);
        const partners=ids.filter(id=>!locked.some(fixed=>stats[id][0]===stats[fixed][0]))
          .sort((a,b)=>strength(b)-strength(a)).slice(0,10);
        if(new Set(partners.map(id=>stats[id][0])).size<2||locked.length>3)continue;
        const slots=Array.from({length:5},(_,slot)=>locked[slot]===undefined?
          (slot-locked.length<2?partners:core):[locked[slot]]);
        const result=await kernels.searchTeams(weighted,slots,{deduplicate:true,performance});
        examined+=result.examined;
        const compositions=new Map();
        for(const row of result.teams)compositions.set(row.order.slice().sort((a,b)=>a-b).join(','),
          {order:row.lastOrder??row.order,power:row.power});
        outfitOrders.set(key,compositions);
      }
    }
  }
  timing.sweep+=performance.now()-started;
  started=performance.now();
  const selectedOrders=new Map();
  for(const {order} of [...orders.values()].sort((a,b)=>b.power-a.power).slice(0,limit*12))
    selectedOrders.set(order.slice().sort((a,b)=>a-b).join(','),order);
  for(const [lens,candidates] of outfitOrders){
    const gated=lens.startsWith('attribute:')||lens.startsWith('group:');
    const ordered=[...candidates.values()].sort((a,b)=>b.power-a.power);
    const keep=ordered.slice(0,gated?24:limit*4);
    if(lens.startsWith('group:')&&!merged){
      const pair=({order})=>order.slice(0,2).map(id=>stats[id][0]).sort((a,b)=>a-b).join('|');
      const seen=new Set(keep.map(pair));
      for(const entry of ordered){
        const key=pair(entry);
        if(seen.has(key))continue;
        keep.push(entry);seen.add(key);
        if(keep.length>=36)break;
      }
    }
    for(const {order} of keep)
      selectedOrders.set(order.slice().sort((a,b)=>a-b).join(','),order);
  }
  for(const order of selectedOrders.values()){
    const lineup=order.map(id=>cards[id]);
    const key=order.slice().sort((a,b)=>a-b).join(',');
    for(const [outfitId,outfit] of outfits){
      if(options.leaderNoOverlap&&lineup.some(card=>card.characterId===outfit.characterId))continue;
      const team=evaluate(lineup,outfitId,outfit.characterId);
      record(key,team);
    }
  }
  timing.initialScore+=performance.now()-started;
  started=performance.now();
  // Expand the highest-scoring compositions across the full owned roster.
  // This admits lower-power cards whose skills trigger a stronger outfit.
  const expanded=new Set(),tested=new Set();
  for(let round=0;round<rounds;round++){
    const ranked=[...scored.values()].sort(compare);
    const leadingOutfits=new Set(ranked.slice(0,6).map(row=>row.outfitId));
    const untested=row=>!expanded.has(row.order.join(','));
    const specialist=payload.boardOpt&&!merged&&options.scoringMode==='chart'?
      [...bestByOutfit.values()].filter(row=>row.outfitId!==ranked[0]?.outfitId&&
        data.costumes[row.outfitId]?.triggers?.length&&row.value>=ranked[0].value*.9&&untested(row))
        .sort(compare)[0]:undefined;
    const leaders=[...new Set([...ranked.filter(untested).slice(0,specialist?5:6),...(specialist?[specialist]:[])])];
    for(const leader of leaders){
      expanded.add(leader.order.join(','));
      const order=leader.order.map(id=>byId.get(id));
      const outfit=data.costumes[leader.outfitId];
      for(const [slot,id] of order.entries()){
        if(locked.includes(id))continue;
        const occupied=new Set(order.filter((_,position)=>position!==slot).map(index=>stats[index][0]));
        const available=stats.flatMap(([member],index)=>occupied.has(member)||
          options.leaderNoOverlap&&cards[index].characterId===outfit.characterId?[]:[index]);
        const slots=order.map((index,position)=>slot===position?available:[index]);
        const result=await kernels.searchTeams(stats,slots,{retainAll:true});
        examined+=result.examined;
        for(const {order} of result.teams){
          const key=[...order].sort((a,b)=>a-b).join(',');
          const orderKey=order.join(',');
          if(tested.has(orderKey))continue;
          tested.add(orderKey);
          const lineup=order.map(index=>cards[index]);
          for(const [outfitId,outfit] of outfits){
            if(options.leaderNoOverlap&&lineup.some(card=>card.characterId===outfit.characterId))continue;
            const team=evaluate(lineup,outfitId,outfit.characterId);
            record(key,team);
          }
        }
      }
    }
    // The full Board search independently revisits nearby lineups around
    // its finalists. Before then, widen only where the initial walk gave
    // weak coverage or changed which outfits could compete.
    if(round<rounds-1&&merged&&boardScores.length&&scored.size>=limit&&
      options.sortBy!=='max'&&options.lbCharts.length>=5&&leadingOutfits.size>0&&
      [...scored.values()].sort(compare).slice(0,6).every(row=>leadingOutfits.has(row.outfitId)))break;
  }
  timing.swapScore+=performance.now()-started;
  started=performance.now();
  const ranked=[...scored.values()];
  if(activeCharts.length){
    // Two replacements can activate a gated Special together even if the
    // individual replacements both lose in the normal one-card walk.
    const diversity=new Set();
    const providers=cards.filter(card=>supportByCard.get(card.id)?.actRateUp>0).map(card=>{
      const special=supportByCard.get(card.id);
      const chance=activeContext.board.get(card.characterId)?.activeChance??0;
      const current=context.board.get(card.characterId)?.activeChance??0;
      const i=byId.get(card.id);
      return {card,priority:stats[i][1]+skillWeights[i]+special.actRateUp*special.duration*16+(chance-current)*18};
    }).sort((a,b)=>b.priority-a.priority).filter(({card})=>{
      if(diversity.has(card.characterId))return false;
      diversity.add(card.characterId);
      return true;
    }).slice(0,20).map(({card})=>card);
    const keyFor=lineup=>lineup.map(card=>byId.get(card.id)).sort((a,b)=>a-b).join(',');
    const seeds=new Set(ranked.sort(compare).slice(0,3));
    const fromBoard=cards.filter(card=>supportByCard.get(card.id)?.actRateUp>0).map(card=>{
      const current=context.board.get(card.characterId),projected=activeContext.board.get(card.characterId);
      return {card,gain:(projected?.activeChance??0)-(current?.activeChance??0)};
    }).filter(({gain})=>gain>0).sort((a,b)=>b.gain-a.gain).slice(0,10);
    const boardGains=new Map(fromBoard.map(({card,gain})=>[card.id,gain]));
    const grounded=new Map();
    for(const seed of seeds){
      const base=seed.order.map(id=>cards[byId.get(id)]);
      const outfit=data.costumes[seed.outfitId];
      const seen=new Set();
      const submit=lineup=>{
        const key=keyFor(lineup);
        if(seen.has(key))return;
        seen.add(key);
        const row=evaluate(lineup,seed.outfitId,seed.leaderChar);
        evaluateActive(key,lineup,seed.outfitId,seed.leaderChar,row);
      };
      submit(base);
      const replacements=[...new Set([...providers,...fromBoard.map(({card})=>card)])];
      const eligible=lineup=>fitsOutfit(outfit,lineup);
      // A Special provider can lose with imported Boards and win with
      // the projected Blue branch. The ordinary swap search sees only the
      // former, and requiring a pair can discard the right existing partner.
      for(const [slot,incumbent] of base.entries()){
        if(locked.includes(byId.get(incumbent.id)))continue;
        const occupied=new Set(base.filter((_,index)=>index!==slot).map(card=>card.characterId));
        for(const card of replacements){
          if(card===incumbent||occupied.has(card.characterId)||
            options.leaderNoOverlap&&card.characterId===seed.leaderChar)continue;
          const lineup=base.slice();
          lineup[slot]=card;
          if(!eligible(lineup))continue;
          submit(lineup);
        }
      }
      for(let left=0;left<base.length;left++)for(let right=left+1;right<base.length;right++){
        if(locked.includes(byId.get(base[left].id))||locked.includes(byId.get(base[right].id)))continue;
        const keep=base.filter((_,slot)=>slot!==left&&slot!==right);
        const occupied=new Set(keep.map(card=>card.characterId));
        const available=replacements
          .filter(card=>!occupied.has(card.characterId)&&
          (!options.leaderNoOverlap||card.characterId!==seed.leaderChar));
        const shortlist=[];
        for(let first=0;first<available.length;first++)for(let second=first+1;second<available.length;second++){
          if(available[first].characterId===available[second].characterId)continue;
          const supports=[supportByCard.get(available[first].id),supportByCard.get(available[second].id)];
          const lineup=base.slice();
          lineup[left]=available[first];
          lineup[right]=available[second];
          if(!eligible(lineup))continue;
          const support=lineup.reduce((sum,card)=>sum+supportStrength(lineup,card),0);
          const strength=lineup.reduce((sum,card)=>{
            const i=byId.get(card.id);
            const projected=activeContext.board.get(card.characterId);
            return sum+stats[i][1]+skillWeights[i]+(projected?.activeChance??0)*15;
          },0);
          const kinds=supports.map(skill=>skill?.actRateUpType??'ALWAYS');
          const gain=(boardGains.get(available[first].id)??0)+(boardGains.get(available[second].id)??0);
          shortlist.push({lineup,strength,support,gain,kinds:kinds.sort().join('|')});
        }
        const composites=shortlist.sort((a,b)=>(b.strength-a.strength)+(b.support-a.support)*24);
        const bestByKind=new Map();
        for(const row of composites)if(!bestByKind.has(row.kinds))bestByKind.set(row.kinds,row);
        const boardPair=shortlist.filter(row=>row.gain>0).sort((a,b)=>
          (b.strength-a.strength)+(b.support-a.support)*24+(b.gain-a.gain)*70)[0];
        if(boardPair)grounded.set(keyFor(boardPair.lineup),boardPair.gain);
        for(const {lineup} of new Set([...composites.slice(0,3),...bestByKind.values(),...(boardPair?[boardPair]:[])])){
          submit(lineup);
          const reversed=lineup.slice();
          [reversed[left],reversed[right]]=[reversed[right],reversed[left]];
          const key=keyFor(reversed);
          const row=evaluate(reversed,seed.outfitId,seed.leaderChar);
          evaluateActive(key,reversed,seed.outfitId,seed.leaderChar,row);
        }
      }
    }
    for(const [key,gain] of grounded){
      const row=activeOrders.get(key);
      if(row)row.activeBoardGain=gain;
    }
  }
  const current=[...currentScored.values()].sort((a,b)=>b.value-a.value).slice(0,Math.ceil(limit/3));
  const teams=new Map();
  const lineupKey=row=>row.order.slice().sort().join(',');
  const add=row=>teams.set(lineupKey(row)+'|'+row.outfitId,row);
  for(const row of [...ranked.sort(compare).slice(0,limit-current.length),...current]){
    add(row);
  }
  // Preserve outfit diversity even if one outfit wins most base-board
  // comparisons. A full Board rebuild can change which outfit leads.
  for(const best of bestByOutfit.values())add(best);
  if(payload.boardOpt&&!merged&&options.scoringMode==='chart'){
    for(const [outfit,best] of bestByOutfit){
      if(!data.costumes[outfit]?.triggers?.length||best.value<ranked[0]?.value*.9)continue;
      const distinct=new Set([lineupKey(best)]);
      for(const row of [...evaluated.values()].filter(row=>row.outfitId===outfit).sort(compare)){
        const key=lineupKey(row);
        if(distinct.has(key)||!fitsOutfit(data.costumes[outfit],row.order.map(id=>cards[byId.get(id)])))continue;
        add(row);
        distinct.add(key);
        if(distinct.size===3)break;
      }
    }
  }
  const active=[...activeOrders.values()];
  for(const row of active.sort(compareActive).slice(0,8))add(row);
  const grounded=active.filter(row=>row.activeBoardGain).sort((a,b)=>
    (b.activeTieScore-a.activeTieScore)+(b.activeBoardGain-a.activeBoardGain)*900);
  for(const row of grounded.slice(0,4))add(row);
  for(const row of active.sort(compareGrowth).slice(0,6))add(row);
  for(const row of active.sort(compareSynergy).slice(0,6))add(row);
  for(const row of ranked){
    if(teams.size>=limit)break;
    add(row);
  }
  timing.activeScore+=performance.now()-started;
  return {examined,teams:[...teams.values()],timing};
}
