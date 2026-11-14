import {initializeRegionalFormats} from './regional-formats.js';
/* Native boundary only: Vue retains its synchronous save contract; Rust owns disk IO. */
import {createDesktopSettings,showStartupError} from './desktop-settings.js';
import {hydrateValues,hydrateWorkspace,nativePatch,readCaptured,profileExport,parseProfileExport,profileToCaptured,projectProfile,capturedFields,canonicalProfile,freshProfile} from './profile-codec';
import {previewAccountImport,applyAccountImport,mergeCapturedAccountImport} from './account-import';
import {runNativeSmoke} from './native-smoke';
import {defaultBoosts,setPassport as changePassport} from '../hololive/boosts';
import {activateBootstrap,createCatalogUpdater} from './catalog-runtime';
import {removeProfileFilters} from './card-filters';
import {saveExtraSongs} from './optimizer-song-unlocks';
import {removeOptimizerPreferences} from './optimizer-preferences';
import {checkOptimizerCatalog,countCardsAwaitingOptimizer,optimizerCatalogSource} from './optimizer-catalog-runtime';
import {editAccountProgress} from './account-progress';
import {loadAchievementCatalog} from './achievements';
import {compareAccountImports} from './import-changes';
import {loadInventoryEvents} from './inventory-events';
import {readSavedLineups,optimizerBoards} from './saved-lineups';
import {boardChanges,checkSavedBoardAssignments,validateSavedBoard} from './saved-boards';
(() => {
  'use strict';
  const invoke=(name,args)=>window.__TAURI__.core.invoke(name,args);
  const values=new Map(), nativeValues={}, pending=new Map(), debounces=new Set(), operations=new Set(),failedOperations=new Map(),artVersions=new Map(),artChains=new Map(),profileReads=new Map();
  let timer, writing=null, loaded=false, closing=false, error=null, revision=0, dataDir='',actionCompletion=null,profileReadBytes=0,storageBlocked=false,deleteToken=null,deleteTimer=null;
  let ui={saveState:'loading',saveText:'Opening local profiles…',message:'',messageError:false,details:'',busy:null,dataDir:'',recovery:'',restore:null,restorePending:false,restoreError:'',restoreDetails:'',profileImport:null,profileImportError:'',gameImport:null,gameImportError:'',gameReadError:'',gameImportPendingSave:false,deleteStage:0,deletePending:false,deleteError:'',deleteDetails:''};
  let profileCandidate=null,profileTarget=null,gameCandidate=null,gameReadToken=0;
  const PROFILE_READ_CACHE_BYTES=32_000_000;
  const domReady=()=>document.readyState==='loading'?new Promise(r=>document.addEventListener('DOMContentLoaded',r,{once:true})):Promise.resolve();
  function status(state,text){ui.saveState=state;ui.saveText=text;document.documentElement.dataset.desktopSave=state;}
  async function finishStartup(loadApp){
    try{
      await desktop.ready;
      const app=await loadApp();
      await app.startCapturedApp();
      await window.__seelieApp.$router.isReady();
      await window.__seelieApp.$nextTick();
    }catch(e){
      status('error','Local files could not open');error=String(e);
      showStartupError(error,{openFolder:()=>invoke('desktop_open_folder')});
    }
    // Lay out the ready route (or recovery view) before exposing the Windows surface.
    document.getElementById('app').getBoundingClientRect();
    await invoke('desktop_show_ready');
    if(backgroundCatalogEnabled){
      catalogUpdater.scheduleBackground(15_000);
      catalogTimer=setInterval(()=>catalogUpdater.scheduleBackground(),30*60*1000);
    }
  }
  function notify(text,type='error'){
    const app=window.__seelieApp;
    if(app){app.toastType=type;app.toast=String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  }
  function fail(e){const previous=error;error=e instanceof Error?e.message:String(e);status('error','Save needs attention');message('Your latest changes could not be saved. Try Save now again.',true,error);if(error!==previous)notify('Could not save local data. Open Settings to retry.');}
  function message(text,isError=false,details=''){ui.message=text;ui.messageError=isError;ui.details=details;}
  function changed(key,value){pending.set(key,value);status('saving','Saving changes…');clearTimeout(timer);timer=setTimeout(()=>drain().catch(fail),200);}
  const methods={
    getItem:key=>values.get(String(key))??null,
    setItem:(key,value)=>{if(storageBlocked)return;key=String(key);value=String(value);if(values.get(key)===value)return;values.set(key,value);changed(key,value);},
    removeItem:key=>{if(storageBlocked)return;key=String(key);if(values.delete(key))changed(key,null);},
    clear:()=>{if(storageBlocked)return;for(const key of values.keys())changed(key,null);values.clear();},
    key:index=>[...values.keys()][Number(index)]??null
  };
  const storage=new Proxy(Object.create(null),{
    get:(_,key)=>key==='length'?values.size:key===Symbol.toStringTag?'Storage':Object.hasOwn(methods,key)?methods[key]:values.get(key),
    set:(_,key,value)=>{methods.setItem(key,value);return true;},
    deleteProperty:(_,key)=>{methods.removeItem(key);return true;},
    ownKeys:()=>[...values.keys()],
    getOwnPropertyDescriptor:(_,key)=>values.has(key)?{configurable:true,enumerable:true,writable:true,value:values.get(key)}:undefined,
    has:(_,key)=>Object.hasOwn(methods,key)||values.has(key)
  });
  Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
  let optimizerGameCatalog;
  function setOptimizerGameCatalog(overlay,boot){
    if(!overlay||overlay.candidateId===optimizerGameCatalog?.id)return;
    const caps=Object.fromEntries(Object.entries(overlay.rarities).map(([rarity,row])=>[rarity,
      [row.initialLevelCap,...row.trainingStages.map(stage=>stage.levelCap)]]));
    const artwork={};
    for(const card of overlay.cards){
      const entry=boot.candidate.assets['landscape:'+card.assetId];
      if(entry)artwork[card.id]=window.__TAURI__.core.convertFileSrc(`${boot.assetDir.replace(/[\\/]+$/u,'')}/${entry.path}`);
    }
    optimizerGameCatalog={id:overlay.candidateId,cards:overlay.cards.map(card=>({...card,levelLimits:caps[card.rarity]})),
      costumes:overlay.costumes,artwork};
    window.dispatchEvent(new CustomEvent('holodori-optimizer-catalog-updated',{detail:overlay.candidateId}));
  }
  const catalogUpdater=createCatalogUpdater({invoke,onState:state=>{ui.catalog=state;},
    onReady:(boot,overlay)=>setOptimizerGameCatalog(overlay,boot),getEnabled:()=>storage.getItem('catalog_updates')!=='false',
    setEnabled:async enabled=>{methods.setItem('catalog_updates',String(enabled));await flush();},
    checkOptimizer:continueUpdate=>checkOptimizerCatalog(invoke,continueUpdate),
    countCardsAwaitingOptimizer:cardIds=>countCardsAwaitingOptimizer(invoke,cardIds,optimizerGameCatalog),checkPreloads:()=>invoke('desktop_catalog_preloads_check')});
  let catalogTimer=null,backgroundCatalogEnabled=false;
  async function reloadCatalog(){
    if(ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return;
    try{flushEdits();await flush();location.reload();}catch(e){fail(e);}
  }
  window.addEventListener('pagehide',()=>{catalogUpdater.dispose();clearInterval(catalogTimer);});
  async function drain(){
    if(writing){await writing;if(pending.size)return drain();return;}
    if(!pending.size){if(!error&&!failedOperations.size)status('saved','All changes saved');return;}
    const sourcePatch=Object.fromEntries(pending);pending.clear();
    let patch;try{patch=nativePatch(Object.fromEntries(values),sourcePatch,nativeValues);}catch(e){for(const [k,v]of Object.entries(sourcePatch))if(!pending.has(k))pending.set(k,v);fail(e);throw e;}
    writing=invoke('desktop_save',{patch}).then(r=>{revision=typeof r==='number'?r:r.revision;if(typeof r==='object')ui.backupWarning=r.backupWarning||'';if(!failedOperations.size)error=null;for(const [key,value]of Object.entries(patch)){if(value===null){delete nativeValues[key];if(!pending.has(key))values.delete(key);}else{nativeValues[key]=value;if(!pending.has(key))values.set(key,value);}}if(ui.messageError&&!error)message('');},e=>{for(const [k,v]of Object.entries(sourcePatch))if(!pending.has(k))pending.set(k,v);fail(e);throw e;});
    try{await writing;}finally{writing=null;}
    if(pending.size)return drain();if(!failedOperations.size)status('saved','All changes saved');else status('error','Save needs attention');
  }
  function flushEdits(){
    for(const ref of debounces){const fn=ref.deref();if(fn)fn.flush();else debounces.delete(ref);}
  }
  function prepareProfileSwitch(){
    if(ui.busy||ui.profileImport||ui.restore||ui.gameImport||ui.deleteStage||closing)return false;
    flushEdits();return true;
  }
  async function flush(){
    await desktop.ready;
    flushEdits();
    await Promise.resolve();await window.__seelieApp?.$nextTick();
    do{
      while(operations.size)await Promise.allSettled([...operations]);
      for(const [key,operation]of [...failedOperations]){
        if(failedOperations.get(key)!==operation)continue;
        if(!operation.retry)throw operation.error;
        await trackOperation(Promise.resolve().then(operation.retry),operation);
      }
      clearTimeout(timer);await drain();
    }while(operations.size||failedOperations.size||pending.size);
  }
  async function action(id,fn){
    if(ui.busy||closing||(ui.gameImport&&id!=='game-import')||(ui.deleteStage&&!id.startsWith('delete-')))return;ui.busy=id;message('');
    let finish;const completion=new Promise(resolve=>{finish=resolve;});actionCompletion=completion;
    try{
      try{if(!ui.deletePending)await flush();}catch(e){fail(e);if(id==='game-import')ui.gameImportError=gameCandidate?.applied?'The imported changes are waiting to save. Try Retry save again.':'Save your existing changes before importing the game account.';if(id==='game-read')ui.gameReadError='Save your pending changes before reading the game account.';if(id.startsWith('delete-'))ui.deleteError='Save your pending changes before deleting data.';return;}
      try{await fn();}catch(e){
        const label={backup:'create the backup',export:'export the backup',chooseRestore:'open the backup',restore:'restore the backup',folder:'open the data folder','profile-export':'export the profile','profile-delete':'delete the profile'}[id]||'complete this action';
        if(id.startsWith('delete-')){ui.deleteError=String(e.message||e);}
        else if(id==='restore'){ui.restorePending=String(e).includes('Desktop restore is pending');ui.restoreError=ui.restorePending?'Restore was interrupted. Try Finish restore, or close and reopen the app to complete recovery.':'Could not restore this backup. Try again or choose another file.';ui.restoreDetails=String(e);}
        else if(id==='profile-import')ui.profileImportError=String(e.message||e);
        else if(id==='game-import')ui.gameImportError=gameCandidate?.applied?'The imported changes are waiting to save. Try Retry save again.':String(e.message||e);
        else if(id==='game-read'){ui.gameReadError=String(e.message||e);message('Could not read the game account. Open the Steam game, finish loading, and try again.',true,ui.gameReadError);}
        else {const text=`Could not ${label}. Try again.`;message(text,true,String(e));if(id==='profile-delete')ui.profileActionError=text;}
      }
    }finally{ui.busy=null;if(actionCompletion===completion)actionCompletion=null;finish();}
  }
  async function showData(){
    const app=window.__seelieApp;if(!app)return;
    await app.$router.push('/settings');await app.$nextTick();
    const panel=document.getElementById('desktop-data');
    if(panel){panel.open=true;panel.scrollIntoView({block:'start'});panel.querySelector('summary')?.focus({preventScroll:true});}
  }
  async function requestClose(){
    if(closing)return;closing=true;
    if(actionCompletion)await actionCompletion;
    try{if(loaded&&!ui.deletePending)await flush();}catch(e){closing=false;fail(e);await showData();return;}
    clearGameImport(true);
    try{await invoke('desktop_close');}catch(e){closing=false;message('Could not create the closing backup. Check your data folder and try closing again.',true,String(e));notify('Could not finish closing. Details are available in Settings.');await showData();}
  }
  function trackOperation(promise,{saving=true,retry,key={},token}={}){
    if(!saving)return promise;
    status('saving','Saving changes…');
    const current=()=>!token||artVersions.get(key)===token;
    const tracked=Promise.resolve(promise).then(result=>{operations.delete(tracked);if(current())failedOperations.delete(key);if(!operations.size&&!pending.size&&!writing&&!failedOperations.size){error=null;status('saved','All changes saved');if(ui.messageError)message('');}return result;},e=>{operations.delete(tracked);if(current()){failedOperations.set(key,{key,token,retry,error:e});fail(e);}throw e;});
    operations.add(tracked);return tracked;
  }
  function nativeArt(op,key,data){
    const run=async()=>{
      const payload=typeof data==='function'?await data():data??null;
      // A queued crop update can discover its artwork has since been removed.
      if(op==='put'&&typeof data==='function'&&payload===null)return null;
      return invoke('desktop_art',{op,key,data:payload});
    };
    if(op==='get')return run();
    const token={};artVersions.set(key,token);failedOperations.delete(key);
    const enqueue=()=>{
      const operation=(artChains.get(key)||Promise.resolve()).catch(()=>{}).then(()=>artVersions.get(key)===token?run():null);
      artChains.set(key,operation);
      operation.finally(()=>{if(artChains.get(key)===operation)artChains.delete(key);}).catch(()=>{});
      return operation;
    };
    return trackOperation(enqueue(),{retry:enqueue,key,token});
  }
  async function cancelRestore(){
    if(ui.busy||ui.restorePending)return;ui.restore=null;ui.restoreError='';ui.restoreDetails='';
    try{await invoke('desktop_cancel_restore');}catch(e){message('Could not close the backup preview.',true,String(e));}
  }
  function openDeleteData(){
    if(ui.busy||ui.restore||ui.profileImport||ui.gameImport||ui.deleteStage||closing)return;
    ui.deleteStage=1;ui.deletePending=false;ui.deleteReady=false;ui.deleteError='';ui.deleteDetails='';deleteToken=null;
  }
  async function cancelDeleteData(){
    if(ui.busy||ui.deletePending)return;
    clearTimeout(deleteTimer);ui.deleteStage=0;ui.deleteReady=false;ui.deleteError='';ui.deleteDetails='';deleteToken=null;
    try{await invoke('desktop_cancel_delete_data');}catch(e){message('Could not close the deletion warning. Try again.',true,String(e));}
  }
  async function advanceDeleteData(){
    if(ui.deleteStage!==1)return;
    await action('delete-prepare',async()=>{deleteToken=await invoke('desktop_prepare_delete_data');ui.deleteStage=2;ui.deleteReady=false;ui.deleteError='';const ticket=deleteToken;deleteTimer=setTimeout(()=>{if(ui.deleteStage===2&&deleteToken===ticket)ui.deleteReady=true;},1000);});
  }
  async function confirmDeleteData(){
    if(ui.deleteStage!==2||!deleteToken||(!ui.deleteReady&&!ui.deletePending))return;
    await action('delete-all',async()=>{
      const result=await invoke('desktop_delete_all_data',{token:deleteToken});
      if(result.pending){storageBlocked=true;clearTimeout(timer);pending.clear();ui.deletePending=true;ui.deleteError='Deletion was interrupted. Finish deleting, or restart the app to complete it.';ui.deleteDetails=result.error||'';return;}
      if(!result.completed)throw Error(result.error||'Could not delete data. Your remaining files have been preserved.');
      storageBlocked=true;loaded=false;clearTimeout(timer);pending.clear();failedOperations.clear();profileReads.clear();profileReadBytes=0;
      catalogUpdater.dispose();clearInterval(catalogTimer);location.reload();
    });
  }
  async function confirmRestore(){
    await action('restore',async()=>{validateRestore(ui.restore);await invoke('desktop_restore');ui.restore=null;ui.restorePending=false;location.reload();});
  }
  function validateRestore(preview){
    if(!preview||!preview.values||typeof preview.values!=='object'||Array.isArray(preview.values))throw Error('This backup does not contain readable Holodori profiles.');
    hydrateValues(preview.values);return preview;
  }
  function gameSignature(id){return [storage.getItem('account'),storage.getItem('accounts'),storage.getItem('settings'),storage.getItem(`${id}-holodori`),...capturedFields.map(field=>storage.getItem(`${id}-${field}`))];}
  function gameCandidateIsCurrent(candidate){
    const account=window.__seelieApp?.account||storage.getItem('account')||'main';
    const signature=gameSignature(candidate.id);
    return account===candidate.id&&storage.getItem('account')===candidate.id&&revision===candidate.revision&&candidate.signature.every((value,index)=>value===signature[index]);
  }
  function clearGameImport(force=false){
    if(!force&&(ui.busy==='game-import'||gameCandidate?.applied))return false;
    gameReadToken++;gameCandidate=null;ui.gameImport=null;ui.gameImportError='';ui.gameImportPendingSave=false;return true;
  }
  function cancelGameImport(){return clearGameImport(false);}
  async function readGameAccount(){
    if(ui.profileImport||ui.restore||ui.gameImport)return null;
    const id=window.__seelieApp?.account||storage.getItem('account')||'main';
    await action('game-read',async()=>{
      const token=++gameReadToken,signature=gameSignature(id),expectedRevision=revision;
      ui.gameReadError='';ui.gameImportError='';
      const [raw,eventWindows]=await Promise.all([invoke('desktop_capture_game_account'),loadInventoryEvents(invoke)]);
      if(closing||token!==gameReadToken)return;
      const candidate={id,signature,revision:expectedRevision,applied:false};
      if(!gameCandidateIsCurrent(candidate))throw Error('This profile changed while the game was being read. Read the account again before importing.');
      const previous=projectProfile(Object.fromEntries(values),id);
      const preview=previewAccountImport(raw,previous,eventWindows,Date.now());
      if(preview.accountStatus.linkedIdentity&&!preview.accountStatus.identity)throw Error('The game account identity could not be verified for this linked profile. Wait for the main lobby and read the account again.');
      const lastImport=previous.gameAccountImport?.snapshot;
      const catalog=lastImport?.tables.missions&&preview.snapshot.tables.missions
        ? await loadAchievementCatalog().catch(()=>null) : null;
      if(closing||token!==gameReadToken)return;
      if(!gameCandidateIsCurrent(candidate))throw Error('This profile changed while the game was being read. Read the account again before importing.');
      const changes=compareAccountImports(lastImport,preview.snapshot,catalog?.categories);
      candidate.snapshot=preview.snapshot;candidate.eventWindows=eventWindows;gameCandidate=candidate;
      const settings=JSON.parse(storage.getItem('settings')||'{}');
      const profileName=settings.account_names?.[id]||(id==='main'?'Main':id);
      const available=[];
      const points=preview.snapshot.balances.gachaPoints;
      if(points)available.push({key:'gachaPoints',label:'Gacha Point balances',count:Object.keys(points).length});
      for(const [key,label] of [['songs','Song records'],['costumes','Live outfits']]){
        const rows=preview.snapshot.tables[key];if(rows)available.push({key,label,count:rows.length});
      }
      for(const [key,label]of Object.entries({boards:'Holomem boards',boardPoints:'Board point records',missions:'Mission progress',counts:'Account counters',achievementCategories:'Achievement categories',achievementGroups:'Achievement groups',missionGroups:'Mission groups',missionDefinitions:'Mission definitions',missionProgressDefinitions:'Mission progress definitions',boardDefinitions:'Board definitions'})){
        const rows=preview.snapshot.tables[key];if(rows!==undefined)available.push({key,label,count:Array.isArray(rows)?rows.length:rows&&typeof rows==='object'?Object.keys(rows).length:0});
      }
      ui.gameImport={profileName,capturedAt:preview.snapshot.capturedAt,accountStatus:preview.accountStatus,counts:preview.counts,cardChanges:preview.cardChanges,inventoryChanges:preview.inventoryChanges,members:preview.members,warnings:preview.warnings,available,changes};
    });
    return ui.gameImport;
  }
  async function confirmGameImport(){
    if(!gameCandidate||!ui.gameImport)return;
    await action('game-import',async()=>{
      const candidate=gameCandidate;
      if(!candidate.applied){
        if(!gameCandidateIsCurrent(candidate))throw Error('This profile changed after the preview. Cancel and read the game account again.');
        await invoke('desktop_backup');
        if(!gameCandidateIsCurrent(candidate))throw Error('This profile changed before import. Cancel and read the game account again.');
        const previous=projectProfile(Object.fromEntries(values),candidate.id),next=applyAccountImport(previous,candidate.snapshot,candidate.eventWindows,Date.now()),existing=readCaptured(Object.fromEntries(values),candidate.id,previous);
        const patch=mergeCapturedAccountImport(existing,profileToCaptured(next),next.gameAccountImport.ownedCardIds,next.gameAccountImport.materialKeys);
        // Serialize and clone everything before mutating synchronous Vue storage.
        const importedFields={...patch,holodori:next};
        const serialized=Object.fromEntries(Object.entries(importedFields).map(([key,value])=>[key,JSON.stringify(value)]));
        const app=window.__seelieApp,data=app?{...app.data,...Object.fromEntries(Object.entries(importedFields).map(([key,value])=>[`${candidate.id}-${key}`,structuredClone(value)]))}:null;
        candidate.applied=true;ui.gameImportPendingSave=true;
        for(const [field,value]of Object.entries(serialized))methods.setItem(`${candidate.id}-${field}`,value);
        const at=new Date().toISOString();methods.setItem('last_update',at);
        if(app){app.data=data;app.applyUpdate?.(at);}
      }
      await flush();ui.profileRevision=(ui.profileRevision||0)+1;clearGameImport(true);ui.gameReadError='';message('Account data imported.');
    });
  }
  async function exportProfile(vm){
    if(vm){vm.errorMsg=null;vm.successMsg=null;}
    const id=vm?.account||storage.getItem('account')||'main';
    await action('profile-export',async()=>{
      const output=profileExport(Object.fromEntries(values),id);
      const settings=JSON.parse(storage.getItem('settings')||'{}');
      const name=settings.account_names?.[id]||(id==='main'?'Main':id);
      output.profileName=name;
      const bytes=new TextEncoder().encode(JSON.stringify(output,null,2));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
      try{if(await invoke('desktop_download',{name:`Holodori-${name}.json`,data:btoa(binary)})&&vm)vm.successMsg='Profile exported.';}
      catch(e){if(vm)vm.errorMsg='Could not export this profile. Try again.';throw e;}
    });
  }
  async function uploadProfile(event,vm){
    const file=event.target.files?.item(0);if(!file)return;
    const id=vm.account;
    try{
      vm.errorMsg=null;vm.successMsg=null;
      if(file.size>75_000_000)throw Error('This profile file exceeds the supported export size. Choose a profile exported by this app.');
      const candidate=parseProfileExport(await file.text());
      if(vm.account!==id)throw Error('The selected profile changed. Select the intended profile and choose its backup again.');
      if(ui.busy||ui.restore||ui.gameImport||ui.deleteStage||closing)throw Error('Finish the current data action before importing a profile.');
      profileCandidate=candidate;profileTarget={id,vm};
      const settings=JSON.parse(storage.getItem('settings')||'{}');
      ui.profileImport={fileName:file.name,cards:Object.keys(candidate.profile.cards).length,profileName:settings.account_names?.[id]||(id==='main'?'Main':id)};ui.profileImportError='';
    }catch(error){vm.errorMsg=String(error.message||error);message(String(error.message||error),true);}
    finally{event.target.value='';}
  }
  function cancelProfileImport(){if(ui.busy)return;profileCandidate=null;profileTarget=null;ui.profileImport=null;ui.profileImportError='';}
  async function confirmProfileImport(){
    if(!profileCandidate||!profileTarget)return;
    await action('profile-import',async()=>{
      const {id,vm}=profileTarget;if(vm.account!==id)throw Error('Select the intended profile and choose its backup again.');
      await invoke('desktop_backup');
      for(const field of capturedFields)methods.setItem(`${id}-${field}`,JSON.stringify(profileCandidate.captured[field]));
      methods.setItem(`${id}-holodori`,JSON.stringify(profileCandidate.profile));
      const next={...vm.data,[`${id}-holodori`]:structuredClone(profileCandidate.profile)};for(const field of capturedFields)next[`${id}-${field}`]=structuredClone(profileCandidate.captured[field]);vm.data=next;
      const at=new Date().toISOString();methods.setItem('last_update',at);vm.applyUpdate?.(at);
      await flush();ui.profileRevision=(ui.profileRevision||0)+1;vm.successMsg='Profile imported.';profileCandidate=null;profileTarget=null;ui.profileImport=null;
    });
  }
  async function deleteProfile(vm){
    const id=vm.account;if(id==='main')return;
    await action('profile-delete',async()=>{
      if(vm.account!==id)throw Error('Select the intended profile and try deleting it again.');
      await invoke('desktop_backup');
      const nativeKey=(...parts)=>parts.map(part=>Array.from(new TextEncoder().encode(String(part)),byte=>byte.toString(16).padStart(2,'0')).join('')).join('-');
      await invoke('desktop_art',{op:'clear',key:nativeKey('hololive',id),data:null});
      for(const key of ['share-art-variants','share-art-crops']){
        const entries=JSON.parse(storage.getItem(key)||'{}'),prefix=`hololive:${id}:`;
        const remaining=Object.fromEntries(Object.entries(entries).filter(([owner])=>!owner.startsWith(prefix)));
        if(Object.keys(remaining).length!==Object.keys(entries).length)methods.setItem(key,JSON.stringify(remaining));
      }
      for(const key of ['account_names','characters_order','characters_sort_by','tasks_order']){
        const entries=vm.settings?.[key];
        if(entries&&Object.hasOwn(entries,id)){
          const remaining={...entries};delete remaining[id];vm.setSetting(key,remaining);
        }
      }
      removeProfileFilters(storage,id);
      saveExtraSongs(storage,id,[]);
      removeOptimizerPreferences(storage,id);
      const ids=JSON.parse(storage.getItem('accounts')||'[]').filter(value=>value!==id);
      for(const key of [...values.keys()])if(key.startsWith(`${id}-`))methods.removeItem(key);
      methods.setItem('accounts',JSON.stringify(ids));methods.setItem('account','main');
      const data={...vm.data};for(const key of Object.keys(data))if(key.startsWith(`${id}-`))delete data[key];vm.data=data;vm.accounts=ids;vm.account='main';vm.deleteModal=false;
      const at=new Date().toISOString();methods.setItem('last_update',at);vm.applyUpdate?.(at);await flush();message('Profile deleted.');
    });
  }
  function install({h,reactive,vnode,resolve,Dialog,Switch}){
    const view=createDesktopSettings({h,reactive,vnode,resolve,Dialog,Switch,state:ui,invoke,action,message,restore:{cancel:cancelRestore,confirm:confirmRestore},profiles:{confirm:confirmProfileImport,cancel:cancelProfileImport},gameAccount:{read:readGameAccount,confirm:confirmGameImport,cancel:cancelGameImport},deleteData:{open:openDeleteData,next:advanceDeleteData,cancel:cancelDeleteData,confirm:confirmDeleteData},catalog:{check:()=>catalogUpdater.checkUpdates(),setEnabled:enabled=>catalogUpdater.setEnabled(enabled).catch(fail),reload:reloadCatalog},options:{getProfileSummary:()=>desktop.getProfileSummary(),setPreferences,setPassport}});ui=view.state;desktop.settingsComponent=view.component;
  }
  function setPreferences(patch){
    if(ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return;
    const app=window.__seelieApp,id=app?.account||storage.getItem('account')||'main';
    const profile=projectProfile(Object.fromEntries(values),id);profile.preferences={...profile.preferences,...patch};methods.setItem(`${id}-holodori`,JSON.stringify(profile));if(app)app.data[`${id}-holodori`]=profile;ui.profileRevision=(ui.profileRevision||0)+1;
  }
  function setPassport(enabled){
    if(ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return;
    const app=window.__seelieApp,id=app?.account||storage.getItem('account')||'main';
    const profile=desktop.getProfileSummary(id),boosts=changePassport(profile.boosts||defaultBoosts(),enabled,Date.now());methods.setItem(`${id}-boosts`,JSON.stringify(boosts));if(app){app.data[`${id}-boosts`]=boosts;const at=new Date().toISOString();methods.setItem('last_update',at);app.applyUpdate?.(at);}ui.profileRevision=(ui.profileRevision||0)+1;
  }
  function setAccountProgress(id,edit){
    const app=window.__seelieApp;
    if(!app||app.account!==id||closing||storageBlocked||ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return false;
    const profile=projectProfile(Object.fromEntries(values),id);
    const account=editAccountProgress(profile.account,profile.gameAccountImport?.snapshot.tables.members??[],edit);
    if(account===profile.account)return true;
    const next={...profile,account};
    methods.setItem(`${id}-holodori`,JSON.stringify(next));
    app.data[`${id}-holodori`]=next;
    ui.profileRevision=(ui.profileRevision||0)+1;
    return true;
  }
  function saveTeamGoals(id,goals){
    const app=window.__seelieApp;
    if(!app||app.account!==id||closing||storageBlocked||ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return false;
    const key=`${id}-goals`,at=new Date().toISOString();
    methods.setItem(key,JSON.stringify(goals));
    methods.setItem('last_update',at);
    app.data[key]=goals;
    app.applyUpdate(at);
    return true;
  }
  async function saveBoardPlans(id,boards,expected){
    const app=window.__seelieApp;
    if(!app||app.account!==id||closing||storageBlocked||ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)
      throw Error('Finish the open Settings action before saving Boards.');
    const profile=projectProfile(Object.fromEntries(values),id);
    for(const [owner,board] of Object.entries(boards))validateSavedBoard(owner,board);
    const imported=optimizerBoards(profile.gameAccountImport?.snapshot.tables.boards);
    const current={...imported,...profile.savedBoards};
    for(const [owner,board] of Object.entries(boards)){
      if(boardChanges(expected[owner],current[owner]).length&&boardChanges(board,current[owner]).length)
        throw Error('This saved Board changed after the search. Run the optimizer again to edit the latest plan.');
    }
    const savedBoards={...profile.savedBoards,...boards};
    checkSavedBoardAssignments({...imported,...savedBoards});
    const key=`${id}-holodori`;
    methods.setItem(key,JSON.stringify({...profile,savedBoards}));
    app.data[key]={...(app.data[key]??profile),savedBoards};
    await flush();
  }
  function getSavedLineups(id){
    return readSavedLineups(JSON.parse(storage.getItem(`${id}-saved_lineups`)??'[]'));
  }
  function saveLineups(id,lineups){
    const app=window.__seelieApp;
    if(!app||app.account!==id||closing||storageBlocked||ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return false;
    methods.setItem(`${id}-saved_lineups`,JSON.stringify(readSavedLineups(lineups)));
    return true;
  }
  function setCardArtworkPreferences(cardId,patch,id=storage.getItem('account')||'main'){
    if(ui.busy||ui.gameImport||ui.restore||ui.profileImport||ui.deleteStage)return false;
    const profile=projectProfile(Object.fromEntries(values),id),card=profile.cards[cardId];
    if(!card)return false; // A preview preference must not create a planned card.
    const allowed={};for(const key of ['animation','signature'])if(['inherit','on','off'].includes(patch[key]))allowed[key]=patch[key];
    if(!Object.keys(allowed).length)return false;
    card.artworkPreferences={...card.artworkPreferences,...allowed};
    methods.setItem(`${id}-holodori`,JSON.stringify(profile));
    const app=window.__seelieApp;if(app)app.data[`${id}-holodori`]=profile;
    ui.profileRevision=(ui.profileRevision||0)+1;return true;
  }
  let startupProfiles;
  function onMounted(){
    const app=window.__seelieApp;
    if(app&&startupProfiles)for(const [id,profile]of startupProfiles)app.data[`${id}-holodori`]=profile;
    startupProfiles=null;
    if(ui.recovery)notify('Local data recovered. Details are available in Settings.','warning');
  }
  function profileRead(id){
    // Vue retains its existing reactive account/revision reads. Cache only the
    // expensive projection, keyed by every source field it can consume.
    const signature=[values.get(`${id}-holodori`),...capturedFields.map(field=>values.get(`${id}-${field}`)),values.get('game_id'),values.get('settings'),values.get('account'),values.get('accounts')];
    let cached=profileReads.get(id);
    if(cached){profileReads.delete(id);profileReadBytes-=cached.bytes;}
    if(!cached||!signature.every((value,index)=>value===cached.signature[index])){
      const profile=projectProfile(Object.fromEntries(values),id);
      const summary={preferences:profile.preferences,boosts:profile.boosts,lastImportedAt:profile.gameAccountImport?.snapshot.capturedAt||null,accountIdentity:profile.gameAccountImport?.identity||null,passportExpiresAtMs:profile.gameAccountImport?.snapshot.accountStatus?.holoPassport?.expiresAtMs||null,artwork:Object.fromEntries(Object.entries(profile.cards).map(([key,card])=>[key,card.artworkPreferences]))};
      const bytes=signature.reduce((size,value)=>size+(value?.length||0)*2,0)+(signature[0]?.length||0)*2;
      cached={signature,profile,summary,json:null,bytes};
    }
    if(cached.bytes<=PROFILE_READ_CACHE_BYTES){profileReads.set(id,cached);profileReadBytes+=cached.bytes;while(profileReads.size>8||profileReadBytes>PROFILE_READ_CACHE_BYTES){const first=profileReads.keys().next().value;profileReadBytes-=profileReads.get(first).bytes;profileReads.delete(first);}}
    return cached;
  }
  function getProfile(id=storage.getItem('account')||'main'){
    const cached=profileRead(id);
    if(cached.json===null){cached.json=JSON.stringify(cached.profile);cached.profile=null;}
    // Callers change preferences on returned profiles; no mutable cached object
    // ever escapes into Vue, imports, or native save preparation.
    return JSON.parse(cached.json);
  }
  function getProfileSummary(id=storage.getItem('account')||'main'){const {artwork,...summary}=profileRead(id).summary;return JSON.parse(JSON.stringify(summary));}
  function getArtworkSettings(cardId,id=storage.getItem('account')||'main'){const summary=profileRead(id).summary;return {animation:summary.artwork[cardId]?.animation||'inherit',signature:summary.artwork[cardId]?.signature||'inherit',cardAnimationsDefault:summary.preferences.cardAnimationsDefault};}
  const desktop=window.__seelieDesktop=window.__holodoriDesktop={flush,flushEdits,prepareProfileSwitch,validateRestore,requestClose,trackOperation,nativeArt,install,onMounted,finishStartup,readGameAccount,confirmGameImport,cancelGameImport,openDeleteData,advanceDeleteData,cancelDeleteData,confirmDeleteData,checkCatalog:()=>catalogUpdater.checkUpdates(),reloadCatalog,trackDebounce:fn=>debounces.add(new WeakRef(fn)),get revision(){return revision;},get settingsState(){return ui;},showData,exportProfile,uploadProfile,deleteProfile,getProfile,getProfileSummary,getArtworkSettings,setCardArtworkPreferences,setAccountProgress,saveTeamGoals,saveBoardPlans,getSavedLineups,saveLineups};
  desktop.optimizerCatalogSource=source=>optimizerCatalogSource(invoke,source,source?.gameCatalog??optimizerGameCatalog);
  desktop.optimizerWorkspaceSource=()=>optimizerCatalogSource(invoke,undefined,optimizerGameCatalog);
  const eventBanners=new Map();
  desktop.optimizerEventBanner=hash=>{
    if(!eventBanners.has(hash))eventBanners.set(hash,invoke('desktop_optimizer_event_banner',{hash}).catch(()=>null).then(url=>{
      if(!url)eventBanners.delete(hash);
      return url;
    }));
    return eventBanners.get(hash);
  };
  desktop.optimizerGameEventBanner=(eventId,releaseId)=>{
    const key=releaseId+':'+eventId;
    if(!eventBanners.has(key))eventBanners.set(key,invoke('desktop_optimizer_game_event_banner',{eventId,releaseId}).catch(()=>null).then(url=>{
      if(!url)eventBanners.delete(key);
      return url;
    }));
    return eventBanners.get(key);
  };
  desktop.inventoryEventWindows=()=>loadInventoryEvents(invoke);
  desktop.ready=(async()=>{
    await domReady();
    status('saving','Opening local profiles…');
    const boot=await invoke('desktop_bootstrap');
    Object.assign(nativeValues,boot.values);
    const catalogBoot=activateBootstrap(boot.catalog,window.__TAURI__.core.convertFileSrc);
    setOptimizerGameCatalog(catalogBoot.overlay,boot.catalog);
    if(catalogBoot.warning)ui.catalogBootWarning=catalogBoot.warning;
    const workspace=hydrateWorkspace(boot.values);
    startupProfiles=workspace.profiles;
    for(const [k,v]of Object.entries(workspace.values))values.set(k,v);
    initializeRegionalFormats(JSON.parse(storage.getItem('settings')||'{}'));
    catalogUpdater.restorePreloads(boot.catalogPreloads??null);
    ui.catalog={...catalogUpdater.getState(),enabled:storage.getItem('catalog_updates')!=='false',...(storage.getItem('catalog_updates')==='false'?{phase:'disabled',message:'Automatic updates are off.'}:{})};
    let animationDir=boot.animationDir||'';if(animationDir.startsWith('\\\\?\\'))animationDir=animationDir.slice(4);animationDir=animationDir.replaceAll('\\','/');
    window.__holodoriAnimationUrl=(id,kind)=>animationDir&&window.__TAURI__.core.convertFileSrc?window.__TAURI__.core.convertFileSrc(`${animationDir}/${id}/${kind}.webm`):`/animations/${id}/${kind}.webm`;
    dataDir=boot.dataDir;revision=boot.revision;ui.dataDir=dataDir;loaded=true;status('saved','All changes saved');
    ui.recovery=boot.recovery.join('\n');
    backgroundCatalogEnabled=!!boot.catalog&&!boot.smoke;
    if(boot.smoke)runSmoke(boot.smoke);
  })();
  // The original image/account exports use download links. Route them to Windows Save As.
  const click=HTMLAnchorElement.prototype.click;
  async function saveDownload(anchor){
    try{const response=await fetch(anchor.href);const blob=await response.blob();const data=await new Promise((resolve,reject)=>{const r=new FileReader;r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});await invoke('desktop_download',{name:anchor.download||'Holodori-export',data});}catch(e){message('Could not export the file. Try again.',true,String(e));notify('Could not export the file. Your local saves are unchanged.');}
  }
  HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')){void saveDownload(this);return;}return click.call(this);};
  document.addEventListener('click',e=>{const a=e.target.closest?.('a[download]');if(a){e.preventDefault();e.stopImmediatePropagation();void saveDownload(a);}},true);
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(e.shiftKey)showData();else flush().catch(fail);}else if(e.key==='F5'||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='r')){e.preventDefault();Promise.resolve(actionCompletion).then(flush).then(()=>{clearGameImport(true);location.reload();}).catch(fail);}});
  window.addEventListener('blur',()=>{if(loaded)flush().catch(fail);});
  document.addEventListener('visibilitychange',()=>{if(loaded&&document.hidden)flush().catch(fail);});
  async function runSmoke(stage){return runNativeSmoke(stage,{invoke,desktop});}
})();
