import {desktopButtonClass} from './desktop-settings.js';

function releaseNotesContent(h,notes){
  const content=[];
  let bullets=[];
  for(const line of notes.split(/\r?\n/)){
    const bullet=line.match(/^\s*[-*+]\s+(.+)/);
    if(bullet){
      bullets.push(h('li',null,bullet[1]));
      continue;
    }
    if(bullets.length){
      content.push(h('ul',{class:'list-disc pl-5 space-y-1'},bullets));
      bullets=[];
    }
    const heading=line.match(/^#{1,6}\s+(.+)/);
    if(heading)content.push(h('h3',{class:'font-semibold'},heading[1]));
    else if(line.trim())content.push(h('p',null,line.trim()));
  }
  if(bullets.length)content.push(h('ul',{class:'list-disc pl-5 space-y-1'},bullets));
  return content;
}

export function createAppUpdates({h,reactive,vnode,Dialog,invoke,flush,blocked,enabled}){
  const state=reactive({version:null,phase:'idle',visible:false,error:'',notes:null,notesSaving:false,notesError:false});
  const busy=()=>['downloading','installing'].includes(state.phase);
  const dismiss=()=>{if(!busy())state.visible=false;};
  async function start(){
    try{
      state.notes=await invoke('desktop_app_update_notes');
    }catch{
      // An unavailable notes file should not prevent the update check.
    }
    await check();
  }
  async function dismissNotes(){
    if(!state.notes||state.notesSaving)return;
    state.notesSaving=true;
    state.notesError=false;
    try{
      await invoke('desktop_app_update_acknowledge',{version:state.notes.version});
      state.notes=null;
    }catch{
      state.notesError=true;
    }finally{
      state.notesSaving=false;
    }
  }
  async function check(){
    if(!enabled||blocked()||state.phase==='checking'||busy())return;
    state.phase='checking';
    state.error='';
    try{
      state.version=await invoke('desktop_app_update_check');
      state.phase=state.version?'available':'latest';
      if(state.version&&!state.notes&&!blocked()&&!document.querySelector('.p-dialog-mask'))state.visible=true;
    }catch{
      state.phase='error';
    }
  }
  async function install(){
    if(!state.version||busy()||blocked())return;
    const version=state.version;
    state.error='';
    state.phase='downloading';
    try{
      await invoke('desktop_app_update_download',{version});
      state.phase='installing';
      try{await flush();}catch{throw Error('Save your pending changes and try again.');}
      if(blocked())throw Error('Finish the current data action and try again.');
      await invoke('desktop_app_update_install',{version});
    }catch(error){
      state.phase='available';
      state.error=error?.message??String(error);
    }
  }
  const status=()=>({
    checking:'Checking for app updates…',
    latest:'You’re up to date.',
    available:`Version ${state.version} is available.`,
    error:'Could not check for app updates. Try again when you’re online.',
    downloading:'Downloading Setup…',
    installing:'Saving and starting the update…',
  })[state.phase]??'';
  const primary=desktopButtonClass.replace('bg-gray-600 hover:bg-gray-500','bg-purple-700 hover:bg-purple-600');
  const settings=()=>h('div',{class:'desktop-data-row'},[
    h('p',{class:state.phase==='error'?'text-xs text-red-400':'text-xs text-gray-300',role:state.phase==='error'?'alert':'status'},
      status()||'The app checks for a new version at startup.'),
    h('button',{type:'button',class:desktopButtonClass,disabled:state.phase==='checking'||busy()||blocked(),
      'aria-busy':state.phase==='checking'||undefined,
      onClick:()=>state.version&&state.phase==='available'?state.visible=true:check()},
    state.phase==='checking'?'Checking…':state.version&&state.phase==='available'?'View app update':'Check for app updates'),
  ]);
  const dialog={render(){
    if(!enabled)return null;
    if(state.notes){
      const {version,notes}=state.notes;
      return vnode(Dialog,{key:'installed-release',visible:true,'onUpdate:visible':visible=>{if(!visible)void dismissNotes();},
        modal:true,showHeader:false,draggable:false,closeOnEscape:!state.notesSaving,dismissableMask:!state.notesSaving,
        'aria-labelledby':'desktop-app-update-notes-title',style:{width:'480px',maxWidth:'calc(100vw - 32px)'}},{
        default:()=>h('div',{class:'mt-4'},[
          h('h2',{id:'desktop-app-update-notes-title',class:'text-xl font-bold'},`What’s new in v${version}`),
          h('div',{class:'mt-3 space-y-2 text-sm text-gray-300',style:{maxHeight:'45vh',overflowY:'auto',overflowWrap:'anywhere'}},
            notes?releaseNotesContent(h,notes):'This release has no published notes.'),
          state.notesError?h('p',{class:'mt-3 text-sm text-red-400',role:'alert'},'Could not save your dismissal. Try again.'):null,
        ]),
        footer:()=>h('div',{class:'flex justify-end'},[
          h('button',{type:'button',class:primary,disabled:state.notesSaving,onClick:dismissNotes},'Got it'),
        ]),
      });
    }
    if(!state.visible)return null;
    return vnode(Dialog,{visible:true,'onUpdate:visible':visible=>{if(!visible)dismiss();},modal:true,
      showHeader:false,draggable:false,closeOnEscape:!busy(),dismissableMask:!busy(),
      'aria-labelledby':'desktop-app-update-title',style:{width:'440px',maxWidth:'calc(100vw - 32px)'}},{
      default:()=>h('div',{class:'mt-4'},[
        h('h2',{id:'desktop-app-update-title',class:'text-xl font-bold'},'App update available'),
        h('p',{class:'mt-3 text-sm'},`Hololive Dreams Planner v${state.version} is ready to install.`),
        h('p',{class:'mt-1 text-sm text-gray-300'},'The app will save your changes, install the update, and reopen.'),
        busy()?h('p',{class:'mt-3 text-sm',role:'status'},status()):null,
        state.error?h('p',{class:'mt-3 text-sm text-red-400',role:'alert'},state.error):null,
      ]),
      footer:()=>h('div',{class:'flex justify-end gap-2'},[
        h('button',{type:'button',class:desktopButtonClass,disabled:busy(),onClick:dismiss},'Later'),
        h('button',{type:'button',class:primary,disabled:busy()||blocked(),onClick:install},'Update and restart'),
      ]),
    });
  }};
  return {enabled,start,busy,settings,dialog};
}
