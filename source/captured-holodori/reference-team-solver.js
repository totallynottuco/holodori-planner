import {referencePowerUpBonus} from './reference-rating-math.js';
import {pinsBoardConnects,retainedConnectorPaths} from './board-protection.js';
import {isTeamCardEligible,teamRarityFilter} from './team-card-pool';

const endpoint = '/assets/team-optimizer/';
const expected = {
  'hdsolver.wasm':'f7e2ab93c3a155bdd0cbdd5623fb7ca887b26f62f8894599bd805af7320665d3',
  'solver-data.json':'70a394fb276e7276380210a04f35cce1a4f2d5b0a654b4ef1e9c5514aac0e48e',
};

let dataRequest, moduleRequest;
async function asset(file) {
  const response=await fetch(endpoint+file);
  if(!response.ok)throw Error('Unable to load optimizer asset '+file);
  const bytes=await response.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(expected[file]&&digest!==expected[file])throw Error('Optimizer asset changed: '+file);
  return bytes;
}
export function loadReferenceData() {
  dataRequest??=asset('solver-data.json').then(bytes=>JSON.parse(new TextDecoder().decode(bytes)))
    .catch(error=>{dataRequest=undefined;throw error;});
  return dataRequest;
}
async function getModule() {
  moduleRequest??=Promise.all([
    import(endpoint+'hdsolver.js'),asset('hdsolver.wasm').then(bytes=>WebAssembly.compile(bytes)),
  ]).then(([{default:createSolver},module])=>createSolver({
    instantiateWasm(imports,ready){ready(new WebAssembly.Instance(module,imports));return {};},
  })).catch(error=>{moduleRequest=undefined;throw error;});
  return moduleRequest;
}
function call(solver,name,value,read) {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const pointer=solver._hd_alloc(bytes.length+1);
  if(!pointer)throw Error('The optimizer ran out of memory.');
  try{
    solver.HEAPU8.set(bytes,pointer);
    solver.HEAPU8[pointer+bytes.length]=0;
    return read(solver[name](pointer,bytes.length));
  }finally{solver._hd_free(pointer);}
}
let lastData;
const byRarity=new WeakMap();
export function hasBoardBonusTargets(boardOpt) {
  return Object.keys(boardOpt?.keep?.targets??{}).length>0;
}

export async function runReferenceJob(data,job,payload,onProgress) {
  const filter=teamRarityFilter(payload.options??{});
  if(filter&&job!=='_hd_plan'){
    const options=payload.options;
    if(options.powerUpOverride==null)payload={...payload,options:{...options,
      powerUpOverride:referencePowerUpBonus(payload.account.owned,data,options.cardPool)}};
    if(!byRarity.has(data))byRarity.set(data,[]);
    const variants=byRarity.get(data);
    variants[filter]??={...data,cards:data.cards.filter(card=>isTeamCardEligible(card,options))};
    data=variants[filter];
  }
  const solver=await getModule();
  if(lastData!==data){
    call(solver,'_hd_load_data',data,status=>{
      if(status!==0)throw Error(solver.UTF8ToString(solver._hd_last_error()));
    });
    lastData=data;
  }
  globalThis.__hdProgress=onProgress;
  try{
    return call(solver,job,payload,pointer=>{
      const response=JSON.parse(solver.UTF8ToString(pointer));
      if(response.error)throw Error(response.error);
      return response;
    });
  }finally{delete globalThis.__hdProgress;}
}

export function referenceCardPool(data,owned,input) {
  const {cardPool,customLevel,customBloom,noDelevel=true,noDebloom=true}=input;
  if(!['allMaxed','allCustom','ownedCustom'].includes(cardPool))return owned;
  const result={};
  for(const card of data.cards){
    const existing=owned[card.id];
    const cap=card.maxLevel;
    if(cardPool==='allMaxed')result[card.id]={owned:true,level:card.maxLevel,bloom:card.maxBloom};
    if(cardPool==='allCustom')result[card.id]={owned:true,
      level:Math.min(customLevel>0?customLevel:card.maxLevel,cap),
      bloom:customBloom==null||customBloom<0?card.maxBloom:Math.min(customBloom,card.maxBloom)};
    if(cardPool==='ownedCustom'&&existing){
      const level=Math.max(Math.min(customLevel>0?customLevel:existing.level,cap),noDelevel?existing.level:1);
      const bloom=Math.max(customBloom==null||customBloom<0?existing.bloom:Math.min(customBloom,card.maxBloom),noDebloom?existing.bloom:0);
      const sp=existing.sp!=null&&level>=existing.level?
        Math.max(existing.sp,card.levelLimits?.findIndex(limit=>level<=limit)??0):undefined;
      result[card.id]={owned:true,level,bloom,...(sp===undefined?{}:{sp})};
    }
  }
  return result;
}

export function referenceSearchRoster(data,owned,input) {
  return withAssumedOutfitCard(referenceCardPool(data,owned,input),input.outfitAssumption);
}

function withAssumedOutfitCard(owned,assumption) {
  if(!assumption)return owned;
  const {cardId,level,bloom}=assumption;
  return {...owned,[cardId]:{owned:true,level,bloom}};
}

function validateOutfitAssumption(data,options,assumption) {
  if(!assumption)return;
  const {outfitId,cardId,level,bloom}=assumption;
  const outfit=data.costumes?.[outfitId];
  const card=data.cards.find(card=>card.id===cardId);
  if(options.leaderMode!=='fixed'||options.outfitId!==outfitId||!outfit||outfit.cardId!==cardId||
    !card||outfit.characterId!==card.characterId||(options.leaderChar&&options.leaderChar!==outfit.characterId))
    throw Error('The assumed card must unlock the selected outfit.');
  if(!Number.isInteger(level)||level<1||level>card.maxLevel||!Number.isInteger(bloom)||bloom<0||bloom>card.maxBloom)
    throw Error('Choose a valid Level and Bloom for the assumed outfit card.');
  return {outfitId,cardId,level,bloom};
}

export const optimizerPowerUpPresets=[
  ['search','Search roster'],['allMax','All cards, max level'],['ownedMax','Owned cards, max level'],['owned','Owned cards, current levels'],
];

export function referencePowerUpPreset(data,owned,preset) {
  if(preset==='allMax')return referencePowerUpBonus({},data,'allMaxed');
  if(preset==='ownedMax'){
    const maxed=Object.fromEntries(data.cards.filter(card=>owned[card.id]?.owned).map(card=>[card.id,{...owned[card.id],level:card.maxLevel}]));
    return referencePowerUpBonus(maxed,data,'owned');
  }
  if(preset==='owned')return referencePowerUpBonus(owned,data,'owned');
}

export function referencePowerUpOverride(data,owned,input,currentOwned=owned) {
  const {outfitAssumption}=input;
  if(input.powerUpPreset==='search')
    return referencePowerUpBonus(referenceSearchRoster(data,owned,input),data,'owned');
  const preset=referencePowerUpPreset(data,currentOwned,input.powerUpPreset);
  if(preset!==undefined)return preset;
  const imported=input.upgradeBonusPermyriad;
  const current=Number.isInteger(imported)&&imported>=0&&imported<=5000?imported:
    referencePowerUpBonus(currentOwned,data,'owned');
  if(!outfitAssumption)return current;
  const subset={...data,cards:data.cards.filter(card=>card.id===outfitAssumption.cardId)};
  const before=referencePowerUpBonus(currentOwned,subset,'owned');
  const after=referencePowerUpBonus(withAssumedOutfitCard({},outfitAssumption),subset,'owned');
  return Math.max(0,Math.min(5000,current+after-before));
}

/** Match the captured memory table unless the current account supplied a measured value. */
export function measuredMemoryEffect(data,count,observed) {
  if(!Number.isSafeInteger(observed)||observed<0)return undefined;
  let current=0;
  for(const [threshold,value] of data.memoryEffects)if(count>=threshold)current=value;
  return current===observed?undefined:observed;
}

export function unresolvedBoardEntries(data,boards) {
  let total=0;
  for(const [member,board] of Object.entries(boards)){
    const nodeIds=new Set(data.boards[member]?.map(node=>node.id));
    total+=board.nodes.filter(id=>!nodeIds.has(id)).length;
    total+=Object.entries(board.cards).filter(([id,card])=>!nodeIds.has(id)||!Object.hasOwn(data.connects,card)).length;
  }
  return total;
}

export function prepareReferenceSearch(data,input) {
  const raw=input.options??{};
  const [chartSong,chartDifficulty]=(input.chartKey??'').split('_');
  const goal=raw.goal??(input.lockedCardIds?.length?'holomem':'best');
  const options={
    goal,focusCardIds:goal==='holomem'?input.lockedCardIds??[]:[],
    leaderMode:'auto',outfitId:null,leaderChar:input.leaderCharacterId??'',
    leaderInvitedOnly:true,leaderAllHolomems:false,leaderNoOverlap:false,
    scoringMode:chartSong?'chart':'generic',songId:chartSong||null,difficulty:chartDifficulty||'expert',
    anyDiffMin:1,anyDiffMax:30,pc:false,cardPool:'owned',memories:input.memoryCount??0,
    topN:input.resultLimit??10,eventBonus:false,eventPoints:false,sortBy:'avg',...raw,
  };
  const accountOwned=Object.fromEntries((input.plannedCards??input.cards).map(card=>[card.cardId,{owned:true,level:card.level,
    bloom:card.potentialUpgradeCount,...(input.plannedCards&&card.levelLimitBreakCount!=null?{sp:card.levelLimitBreakCount}:{})}]));
  const outfitAssumption=validateOutfitAssumption(data,options,input.outfitAssumption);
  const scenario={...input,goal,cardPool:options.cardPool,outfitAssumption};
  const currentOwned=input.plannedCards?Object.fromEntries(input.cards.map(card=>[card.cardId,{owned:true,level:card.level}])):accountOwned;
  if(goal!=='next'||input.powerUpPreset!=='search')
    options.powerUpOverride??=referencePowerUpOverride(data,accountOwned,scenario,currentOwned);
  const owned=referenceSearchRoster(data,accountOwned,scenario);
  if(teamRarityFilter(options)){
    const locked=new Set([...(options.focusCardIds??[]),...(input.nextDeck??[])]);
    if(data.cards.some(card=>locked.has(card.id)&&!isTeamCardEligible(card,options)))
      throw Error('Unlock the excluded cards in Lineup or include their rarity.');
  }
  const ownedCostumeIds=input.ownedCostumeIds??[];
  if(outfitAssumption){
    options.leaderChar=data.costumes[outfitAssumption.outfitId].characterId;
  }
  // The roster already contains the pool's exact projected entries. Preserve
  // the explicit assumptions when the solver applies its all-maxed default.
  if(outfitAssumption&&options.cardPool==='allMaxed')options.cardPool='owned';
  const ranks=Object.fromEntries(input.members.map(member=>[member.characterId,member.level]));
  const boards=input.useBoards===false?{}:Object.fromEntries((input.boards??[]).map(board=>[
    board.characterId,{nodes:board.releasedSkillTreeNodeGroupIds,
      cards:Object.fromEntries(board.connectedSkillTreeNodeGroupIds.map((slot,index)=>[slot,board.connectedSkillTreeNodeCardIds[index]])
        .filter(([,id])=>pinsBoardConnects(input.boardOpt,board.characterId)||
          !(input.plannedCards||input.savedBoardMode)||owned[id]?.owned))},
  ]));
  let boardOpt=input.useBoards!==false&&input.boardOpt?.branches?.length?input.boardOpt:null;
  const rank=boardOpt?.maxBoardPoints?1_000_000:input.dreamRank??0;
  if(boardOpt?.preserveConnects&&boardOpt.ignoreExisting&&!boardOpt.connectorPaths){
    boardOpt={...boardOpt,connectorPaths:retainedConnectorPaths(boards,owner=>data.boards[owner],rank)};
  }
  if((boardOpt?.preserveConnects||boardOpt?.protection)&&input.plannedCards){
    const pinned=new Set(Object.entries(boards).flatMap(([owner,board])=>
      pinsBoardConnects(boardOpt,owner)?Object.values(board.cards):[]));
    const entries=Object.fromEntries(input.cards.filter(card=>pinned.has(card.cardId)&&!owned[card.cardId])
      .map(card=>[card.cardId,{owned:true,level:card.level,bloom:card.potentialUpgradeCount,sp:card.levelLimitBreakCount}]));
    if(Object.keys(entries).length)options.pinnedConnectEntries=entries;
  }
  return {
    account:{dreamRank:rank,owned,boards,ranks,ownedCostumeIds:outfitAssumption?
      [...new Set([...ownedCostumeIds,outfitAssumption.outfitId])]:ownedCostumeIds},options,
    limits:{jointBoards:!!boardOpt&&(goal==='best'||goal==='holomem'),shardIndex:0,shardCount:1},
    extras:{accountOwned:goal==='next'?owned:withAssumedOutfitCard(accountOwned,outfitAssumption),outfitAssumption,
      nextDeck:input.nextDeck,nextLevel:input.nextEntry?.level,nextBloom:input.nextEntry?.bloom,
      nextCount:input.nextCount,nextBlooms:input.nextBlooms,
      ...(goal==='next'&&input.nextAcquisition?{nextAcquisition:input.nextAcquisition,objective:input.objective}:{})},
    boardOpt,
  };
}

const teamKey=row=>row.order.slice().sort().join('|');
const pulls=row=>row.pulls?.length?row.pulls:row.candidateId?[{id:row.candidateId,new:true,copies:1}]:[];
export function mergeReferenceResults(responses,options) {
  const key=options.sortBy==='max'?'maxScore':'score';
  const rows=responses.flatMap(response=>response.results??[]).sort((a,b)=>b[key]-a[key]);
  const distinct=new Map();
  for(const row of rows){
    const upgrade=options.goal==='next'?pulls(row).map(pull=>pull.id+':'+(pull.new?'n':'b')+pull.copies).sort().join('|')+'#':'';
    const id=upgrade+teamKey(row);
    if(!distinct.has(id))distinct.set(id,row);
    if(distinct.size>=options.topN)break;
  }
  const baseline=responses.reduce((best,response)=>Number.isFinite(response.baseline)?Math.max(best,response.baseline):best,-1);
  return {results:[...distinct.values()],baseline:baseline<0?null:baseline};
}

export function collectBoardFinalists(responses,options) {
  const scoreKey=options.sortBy==='max'?'maxScore':'score';
  const teams=new Map();
  for(const row of responses.flatMap(response=>response.results??[])){
    const id=teamKey(row),current=teams.get(id);
    if(!current){teams.set(id,{...row,sources:new Set(row.source?[row.source]:[])});continue;}
    if(row.lens&&current.lens){
      for(const key of ['ceiling','saved','potential','max']){
        if(row.lens[key]>current.lens[key])current.lens={...current.lens,[key]:row.lens[key]};
      }
    }
    if(row.source)current.sources.add(row.source);
  }
  const all=[...teams.values()];
  if(!all.some(row=>row.lens))return all.sort((a,b)=>b[scoreKey]-a[scoreKey]).slice(0,96);
  const byLens=key=>all.filter(row=>(row.lens?.[key]??-1)>=0).sort((a,b)=>b.lens[key]-a.lens[key]);
  const bySource=key=>all.filter(row=>row.sources.has(key)).sort((a,b)=>(b.lens?.ceiling??-1)-(a.lens?.ceiling??-1));
  const seen=new Set(),finalists=[];
  const take=(rows,max)=>{
    let added=0;
    for(const row of rows){
      if(added===max)break;
      const id=teamKey(row);
      if(seen.has(id))continue;
      seen.add(id);
      const {sources,...candidate}=row;
      finalists.push(candidate);
      added++;
    }
  };
  take(byLens('ceiling'),48);
  take(byLens('saved'),12);
  take(byLens('potential'),12);
  if(scoreKey==='maxScore')take(byLens('max'),12);
  take(bySource('proxy'),8);
  take(bySource('net'),6);
  take(bySource('neighbor'),8);
  const primaryCount=finalists.length;
  take(byLens('ceiling'),24);
  for(let index=primaryCount;index<finalists.length;index++)finalists[index]={...finalists[index],source:'reserve'};
  return finalists;
}

export function referenceEventPointBase(songScore,permil) {
  return (120+songScore/15000)*(1+permil/1000);
}

export function referenceEventPoints(row,seconds,boost=3,passport=false) {
  const index=Math.min(10,Math.max(1,Math.round(boost)))-1;
  const multiplier=[8,16,24,30,37,42,46,50,53,56][index];
  const lengthBonus=Math.max(0,Math.ceil((seconds-50)*10/29*(1+([300,200,200][index]??0)/1000)));
  const factor=1+row.epPermil/1000;
  const points=value=>Math.floor(Math.ceil(value)*(1+lengthBonus/100)*multiplier)*(passport?2:1);
  return {
    rawScore:row.score,rawMaxScore:row.maxScore,
    score:(row.score/factor-120)*15000,
    maxScore:row.maxScore==null?null:(row.maxScore/factor-120)*15000,
    eventPointsAvg:points(row.score),
    eventPointsMax:row.maxScore==null?null:points(row.maxScore),
    eventLengthBonus:lengthBonus,
    eventBoostMultiplier:multiplier,
    eventPassportMultiplier:passport?2:1,
  };
}
