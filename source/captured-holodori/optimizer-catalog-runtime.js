let activeSource;
let activeMobile;
let activeExchanges;

function asSource(record){
  return record?{id:record.id,url:URL.createObjectURL(new Blob([record.json],{type:'application/json'}))}:null;
}

async function readSource(invoke,mobile){
  let payload;
  try{
    payload=await invoke('desktop_optimizer_catalog_bytes',{mobile});
  }catch{
    const record=await invoke(mobile?'desktop_mobile_scoring_read':'desktop_optimizer_catalog_read');
    return mobile?asMobile(record):asSource(record);
  }
  const bytes=new Uint8Array(payload);
  if(!bytes.length)return null;
  const headerEnd=bytes.subarray(0,256).indexOf(10);
  if(headerEnd<0)throw Error('The optimizer cache response is invalid.');
  const {id,publicKey}=JSON.parse(new TextDecoder().decode(bytes.subarray(0,headerEnd)));
  return {
    id,url:URL.createObjectURL(new Blob([bytes.subarray(headerEnd+1)],{type:'application/json'})),
    ...(mobile?{publicKey}:{}),
  };
}

function catalogSource(invoke){
  activeSource??=readSource(invoke,false).catch(()=>null);
  return activeSource;
}
const asMobile=record=>record?{...asSource(record),publicKey:record.publicKey}:null;

function mobileSource(invoke){
  activeMobile??=readSource(invoke,true).catch(()=>null);
  return activeMobile;
}

function exchangeSource(invoke){
  activeExchanges??=invoke('desktop_optimizer_exchange_catalog_read').catch(()=>null);
  return activeExchanges;
}

export async function optimizerCatalogSource(invoke,workspaceSource=catalogSource(invoke),gameCatalog){
  const [source,mobile,exchangeCatalog]=await Promise.all([workspaceSource,mobileSource(invoke),exchangeSource(invoke)]);
  return mobile||gameCatalog||exchangeCatalog?{...source,...(mobile?{mobile}:{}),...(gameCatalog?{gameCatalog}:{}),
    ...(exchangeCatalog?{exchangeCatalog}:{})}:source;
}

function requestCatalogWorker(message,replyType){
  return new Promise((resolve,reject)=>{
    const worker=new Worker('/app/team-optimizer-worker.js',{type:'module'});
    const finish=(callback,value)=>{clearTimeout(timer);worker.terminate();callback(value);};
    const timer=setTimeout(()=>finish(reject,Error('Optimizer catalog verification timed out.')),30000);
    worker.onmessage=({data})=>{
      if(data.type===replyType)finish(resolve,data);
      if(data.type==='error')finish(reject,Error(data.message));
    };
    worker.onerror=()=>finish(reject,Error('Optimizer catalog verification could not start.'));
    worker.postMessage(message);
  });
}

function catalogChanged(id){
  window.dispatchEvent(new CustomEvent('holodori-optimizer-catalog-updated',{detail:id}));
}

export async function countCardsAwaitingOptimizer(invoke,cardIds,gameCatalog){
  const source=await optimizerCatalogSource(invoke,undefined,gameCatalog);
  const {missing}=await requestCatalogWorker({type:'catalog-coverage',source,cardIds},'catalog-coverage');
  return missing;
}

async function checkCatalog(invoke,continueUpdate){
  if(!continueUpdate())return false;
  const record=await invoke('desktop_optimizer_catalog_stage');
  if(!record||!continueUpdate())return false;
  const previous=await catalogSource(invoke);
  const source=asSource(record);
  let committed=false;
  try{
    await requestCatalogWorker({type:'validate-catalog',source:{...source,previous}},'validated');
    if(!continueUpdate())return false;
    await invoke('desktop_optimizer_catalog_commit',{id:source.id});
    committed=true;
    activeSource=Promise.resolve(source);
    catalogChanged(source.id);
    return source.id;
  }finally{if(!committed)URL.revokeObjectURL(source.url);}
}

async function checkMobile(invoke,continueUpdate){
  if(!continueUpdate())return false;
  const record=await invoke('desktop_mobile_scoring_stage');
  if(!record||!continueUpdate())return false;
  const previous=await mobileSource(invoke);
  const source=asMobile(record);
  let committed=false;
  try{
    await requestCatalogWorker({type:'validate-mobile-scoring',source,previous},'validated');
    if(!continueUpdate())return false;
    await invoke('desktop_mobile_scoring_commit',{id:source.id,publicKey:source.publicKey});
    committed=true;
    activeMobile=Promise.resolve(source);
    catalogChanged(source.id);
    return source.id;
  }finally{if(!committed)URL.revokeObjectURL(source.url);}
}

async function checkExchanges(invoke,continueUpdate){
  if(!continueUpdate())return false;
  const catalog=await invoke('desktop_optimizer_exchange_catalog_refresh');
  if(!catalog)return false;
  activeExchanges=Promise.resolve(catalog);
  if(continueUpdate())catalogChanged('exchanges');
  return true;
}

export async function checkOptimizerCatalog(invoke,continueUpdate){
  const results=await Promise.allSettled([checkCatalog(invoke,continueUpdate),checkMobile(invoke,continueUpdate),checkExchanges(invoke,continueUpdate)]);
  const updated=results.find(result=>result.status==='fulfilled'&&result.value);
  const [catalog,mobile]=results;
  return {
    updated:!!updated,
    catalogError:catalog.status==='rejected'?String(catalog.reason):null,
    mobileError:mobile.status==='rejected'?String(mobile.reason):null,
  };
}
