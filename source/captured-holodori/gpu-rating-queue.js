import {createGpuDispatcher,OptimizerGpuError} from './gpu-search-kernels';
import {boardPlanningBaseline} from './board-protection';

function serve(port,invoke){
  port.onmessage=async({data:{id,method,args}})=>{
    try{
      const value=await invoke(method,args);
      port.postMessage({id,value},value instanceof Uint32Array?[value.buffer]:[]);
    }catch(error){
      port.postMessage({id,error:error.message,gpu:error.name==='OptimizerGpuError'});
    }
  };
}

function channel(port){
  const pending=new Map();
  let next=0,closed;
  port.onmessage=({data:{id,value,error,gpu}})=>{
    const task=pending.get(id);
    if(!task)return;
    pending.delete(id);
    if(error!==undefined)task.reject(gpu?new OptimizerGpuError(error):Error(error));
    else task.resolve(value);
  };
  function close(error=Error('GPU search closed.')){
    closed=error;
    for(const task of pending.values())task.reject(error);
    pending.clear();
    port.close();
  }
  port.onmessageerror=()=>close(new OptimizerGpuError('A GPU worker returned an unreadable response.'));
  return {close,call(method,args,transfer=[]){
    return new Promise((resolve,reject)=>{
      if(closed){reject(closed);return;}
      const id=next++;
      pending.set(id,{resolve,reject});
      try{port.postMessage({id,method,args},transfer);}
      catch(error){pending.delete(id);reject(error);}
    });
  }};
}

export async function serveRatingDevice(ports){
  const driver=await createGpuDispatcher();
  const pipelines=new Map(),compiled=[];
  for(const port of ports)serve(port,(method,args)=>{
    if(method==='pipeline'){
      const [code,entry]=args,key=entry+'\0'+code;
      if(!pipelines.has(key)){
        pipelines.set(key,compiled.length);
        compiled.push(driver.pipeline(code,entry));
      }
      const id=pipelines.get(key);
      return compiled[id].then(()=>id);
    }
    const [id,...rest]=args;
    return compiled[id].then(pipeline=>driver.dispatch(pipeline,...rest));
  });
}

export function ratingDeviceClient(port){
  const client=channel(port);
  return {pipeline:(...args)=>client.call('pipeline',args),
    dispatch:(pipeline,inputs,words,groups)=>{
      const data=inputs.map(input=>Uint32Array.from(input));
      return client.call('dispatch',[pipeline,data,words,groups],data.map(input=>input.buffer));
    },close:client.close};
}

export function serveRatingLane(port,engine){
  let accountId,account;
  serve(port,async(method,[id,payload,...args])=>{
    if(payload.account){account=payload.account;accountId=id;}
    if(id!==accountId)throw Error('The shared GPU worker lost the search account.');
    const value=await engine[method]({...payload,account},...args);
    const {examined,boardMoves,objectiveTrials,kernelTiming,timings,tradeTiming,timelineCache}=engine.metrics();
    const metrics={examined,boardMoves,objectiveTrials,kernelTiming,timings,tradeTiming,timelineCache};
    if(method==='plan'&&value.plan){
      const base=boardPlanningBaseline(account.boards,payload.boardOpt);
      const {saves}=value.plan;
      const omitted=Object.keys(base).filter(owner=>!Object.hasOwn(saves,owner));
      const changed=Object.fromEntries(Object.entries(saves).filter(([owner,board])=>board!==base[owner]));
      return {value:{plan:{...value.plan,saves:changed}},omitted,metrics};
    }
    return {value,metrics};
  });
}

export function createGpuRatingPool(selection,source,leaderConcurrency,host){
  const count=Math.min(4,Math.max(1,(navigator.hardwareConcurrency||4)-1));
  const workers=[],clients=[],free=[],scores=[],lineups=[],boards=[];
  const accountIds=new WeakMap(),accountsByLane=[];
  let nextAccount=0;
  let ready,closed;
  function close(error=new OptimizerGpuError('The shared GPU queue closed.')){
    if(closed)return;
    closed=error;
    for(const worker of workers)worker.terminate();
    for(const client of clients)client.close(error);
    for(const job of [...lineups,...boards])job.reject(error);
    lineups.length=boards.length=0;
  }
  const spawn=(message,ports)=>new Promise((resolve,reject)=>{
    const fail=error=>{reject(error);close(error);};
    const stopped=()=>fail(new OptimizerGpuError('A shared GPU worker stopped.'));
    const receive=({data})=>data.type==='gpu-ready'?resolve():
      fail(new OptimizerGpuError(data.message??'The shared GPU queue could not start.'));
    if(host){
      const {port1,port2}=new MessageChannel();
      workers.push({terminate(){port1.postMessage(null);port1.close();}});
      port1.onmessage=receive;
      port1.onmessageerror=stopped;
      host(message,[port2,...ports]);
      return;
    }
    const worker=new Worker('/app/team-optimizer-worker.js',{type:'module'});
    workers.push(worker);
    worker.onerror=worker.onmessageerror=stopped;
    worker.onmessage=receive;
    worker.postMessage(message,ports);
  });
  async function start(){
    const devicePorts=[],lanes=[];
    for(let index=0;index<count;index++){
      const device=new MessageChannel(),jobs=new MessageChannel();
      devicePorts.push(device.port1);
      clients.push(channel(jobs.port1));
      lanes.push([device.port2,jobs.port2]);
    }
    await Promise.all([spawn({type:'gpu-rating-device'},devicePorts),
      ...lanes.map(ports=>spawn({type:'gpu-rating-lane',source,selection},ports))]);
    free.push(...clients.keys());
  }
  function pump(){
    while(!closed&&free.length&&(lineups.length||boards.length)){
      const index=free.shift(),job=(lineups.length?lineups:boards).shift();
      const [payload,...args]=job.args;
      const {account,...query}=payload;
      if(!accountIds.has(account))accountIds.set(account,nextAccount++);
      const id=accountIds.get(account);
      if(accountsByLane[index]!==id){query.account=account;accountsByLane[index]=id;}
      clients[index].call(job.method,[id,query,...args]).then(({value,omitted,metrics})=>{
        if(omitted){
          const saves={...boardPlanningBaseline(account.boards,query.boardOpt),...value.plan.saves};
          for(const owner of omitted)delete saves[owner];
          value.plan.saves=saves;
        }
        scores[index]=metrics;
        job.resolve(value);
      },error=>{job.reject(error);close(error);}).finally(()=>{free.push(index);pump();});
    }
  }
  async function enqueue(method,args){
    if(closed)throw closed;
    ready??=start().catch(error=>{close(error);throw error;});
    await ready;
    if(closed)throw closed;
    return new Promise((resolve,reject)=>{
      (method==='plan'?boards:lineups).push({method,args,resolve,reject});
      pump();
    });
  }
  const sum=(key)=>scores.reduce((value,lane)=>value+(lane?.[key]??0),0);
  const phaseTotals=key=>Object.fromEntries(Object.keys(scores.find(Boolean)?.[key]??{})
    .map(phase=>[phase,scores.reduce((total,lane)=>total+(lane?.[key]?.[phase]??0),0)]));
  return {shared:true,leaderConcurrency,close,solve:(...args)=>enqueue('solve',args),
    plan:(...args)=>enqueue('plan',args),rankResults:(...args)=>enqueue('rankResults',args),
    rankFundedTeams:(...args)=>enqueue('rankFundedTeams',args),
    metrics:()=>({leaderConcurrency,hostWorkers:count,examined:sum('examined'),boardMoves:sum('boardMoves'),
      objectiveTrials:sum('objectiveTrials'),kernelTiming:phaseTotals('kernelTiming'),timings:phaseTotals('timings'),
      tradeTiming:phaseTotals('tradeTiming'),timelineCache:phaseTotals('timelineCache')})};
}
