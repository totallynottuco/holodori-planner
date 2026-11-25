let current;
let pending;

window.addEventListener('holodori-optimizer-catalog-updated',()=>{
  current=undefined;
  pending=undefined;
});

export const optimizerWorkspaceCatalog=()=>current?.catalog.nextSongRelease<=Date.now()?undefined:current;

async function readCatalog(){
  const source=await window.__holodoriDesktop.optimizerWorkspaceSource();
  const worker=new Worker('/app/team-optimizer-worker.js',{type:'module'});
  try{
    return await new Promise((resolve,reject)=>{
      const finish=(callback,value)=>{clearTimeout(timeout);callback(value);};
      const timeout=setTimeout(()=>reject(Error('The optimizer catalog took too long to open.')),30_000);
      worker.onmessage=({data})=>{
        if(data.type==='catalog'){
          const {type,...catalog}=data;
          finish(resolve,{catalog,source});
        }else if(data.type==='error')finish(reject,Error(data.message));
      };
      worker.onerror=worker.onmessageerror=()=>finish(reject,Error('The optimizer catalog could not open.'));
      worker.postMessage({type:'catalog',source});
    });
  }finally{
    worker.terminate();
  }
}

export function prepareOptimizerWorkspace(){
  const ready=optimizerWorkspaceCatalog();
  if(ready)return Promise.resolve(ready);
  if(pending)return pending;
  const request=readCatalog().then(result=>{
    if(pending!==request)return prepareOptimizerWorkspace();
    current=result;
    return result;
  }).finally(()=>{
    if(pending===request)pending=undefined;
  });
  pending=request;
  return request;
}
