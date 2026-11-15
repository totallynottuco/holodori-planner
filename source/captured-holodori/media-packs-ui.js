import {formatNumber} from './regional-formats.js';

const labels={outfits:'Live2D outfit previews',animations:'Animated card artwork',charts:'Chart artwork',music:'Soundtracks'};
const phases={downloading:'Downloading…',verifying:'Verifying…',installing:'Installing…'};
const states={installed:'Installed',missing:'Not installed',update:'Update available',
  incomplete:'Incomplete install',removing:'Removal incomplete'};

function size(bytes){
  if(bytes==null)return null;
  const unit=Math.min(3,Math.floor(Math.log(Math.max(1,bytes))/Math.log(1024)));
  return `${formatNumber(bytes/1024**unit,{maximumFractionDigits:unit===0?0:1})} ${['B','KiB','MiB','GiB'][unit]}`;
}

export function createMediaPacks({h,reactive,vnode,Dialog,invoke,buttonClass,blocked}){
  const state=reactive({catalog:null,busy:'',error:'',notice:'',progress:null,reload:false,removePack:null});
  async function run(key,operation){
    if(state.busy)return;
    state.busy=key;state.error='';state.notice='';
    try{state.catalog=await operation();}
    catch(error){state.error=error?.message??String(error);}
    finally{state.busy='';state.progress=null;}
  }
  const check=(checkOnline=false)=>run('check',async()=>{
    const catalog=await invoke('desktop_media_packs_status',{checkOnline});
    if(checkOnline&&catalog.online){
      const updates=catalog.packs.filter(pack=>pack.state==='update').length;
      state.notice=updates?`${formatNumber(updates)} ${updates===1?'pack has':'packs have'} an update available.`:'No media pack updates available.';
    }
    return catalog;
  });
  const choose=()=>run('folder',()=>invoke('desktop_media_packs_choose_folder'));
  const install=id=>run(id,async()=>{
    const unsubscribe=await window.__TAURI__?.event?.listen('desktop-media-progress',({payload})=>{
      if(payload.id===id)state.progress=payload;
    }).catch(()=>null);
    try{
      const result=await invoke('desktop_media_pack_install',{id});
      state.reload=true;
      return result;
    }finally{unsubscribe?.();}
  });
  const cancelRemoval=()=>{state.removePack=null;};
  const remove=id=>run(`remove-${id}`,async()=>{
    try{
      const result=await invoke('desktop_media_pack_remove',{id});
      state.reload=true;
      return result;
    }catch(error){
      state.catalog=await invoke('desktop_media_packs_status',{checkOnline:false}).catch(()=>state.catalog);
      throw error;
    }
  });
  const confirmRemoval=()=>{
    const pack=state.removePack;
    cancelRemoval();
    if(pack)void remove(pack.id);
  };
  const danger=buttonClass.replace('bg-gray-600 hover:bg-gray-500','bg-red-700 hover:bg-red-600');
  const button=(text,onClick,{disabled=false,className=buttonClass,label}={})=>h('button',{
    type:'button',class:className,disabled:!!state.busy||blocked()||disabled,'aria-label':label,onClick,
  },text);
  return {
    cancelRemoval,
    busy:()=>!!state.busy&&state.busy!=='check',
    open(event){if(event.currentTarget.open&&!state.catalog)void check();},
    dialog(){
      const pack=state.removePack;
      return vnode(Dialog,{visible:!!pack,'onUpdate:visible':visible=>{if(!visible)cancelRemoval();},
        header:pack?`Remove ${labels[pack.id]}?`:'',modal:true,draggable:false,dismissableMask:true,
        'aria-describedby':'desktop-media-remove-description',style:{width:'420px',maxWidth:'calc(100vw - 32px)'}},{
        default:()=>h('p',{id:'desktop-media-remove-description',class:'text-sm'},[
          pack?.installedSize!=null?`This frees ${size(pack.installedSize)} on this device. `:'',
          'You can reinstall the pack from Settings.',
        ]),
        footer:()=>h('div',{class:'flex flex-wrap justify-end gap-2'},[
          button('Cancel',cancelRemoval),button('Remove pack',confirmRemoval,{className:danger}),
        ]),
      });
    },
    render(){
      const rows=state.catalog?.packs??[];
      return [
        ...rows.map(pack=>{
          const progress=state.busy===pack.id?state.progress:null;
          const footprint=pack.canRemove?size(pack.installedSize):null;
          const detail=pack.canRemove?(footprint?`${footprint} on disk`:'Size unavailable'):
            pack.size?`${size(pack.size)} ${pack.local?'archive':'download'}`:null;
          return h('div',{key:pack.id,class:'desktop-data-row desktop-media-pack'},[
            h('div',{},[
              h('p',{class:'text-sm font-semibold'},labels[pack.id]),
              h('p',{class:'text-xs text-gray-300',title:footprint?`${formatNumber(pack.installedSize)} bytes`:undefined},
                [states[pack.state],detail].filter(Boolean).join(' · ')),
              progress?.phase==='downloading'?h('progress',{class:'holo-encore-meter',value:progress.bytes,max:progress.total,
                'aria-label':`Downloading ${labels[pack.id]}`}):null,
            ]),
            h('div',{class:'desktop-settings-actions'},[
              pack.canRemove?button(state.busy===`remove-${pack.id}`?'Removing…':pack.state==='removing'?'Finish removal':'Remove',
                ()=>{state.removePack=pack;},{label:`${pack.state==='removing'?'Finish removing':'Remove'} ${labels[pack.id]}`}):null,
              !['installed','removing'].includes(pack.state)?button(state.busy===pack.id?(phases[progress?.phase]??'Starting…'):
                pack.state==='update'?'Update':pack.local?'Install':'Download',()=>install(pack.id),{disabled:!pack.canInstall}):null,
            ]),
          ]);
        }),
        !state.catalog&&state.busy?h('p',{class:'text-sm text-gray-300',role:'status'},'Checking installed media…'):null,
        state.catalog?h('div',{class:'desktop-settings-actions'},[
          state.catalog.online?button(state.busy==='check'?'Checking…':'Check media updates',()=>check(true)):null,
          button(state.busy==='folder'?'Choosing…':'Choose offline folder',choose),
        ]):state.error?button('Retry',()=>check()):null,
        state.catalog&&!state.catalog.online&&rows.some(pack=>!['installed','removing'].includes(pack.state)&&!pack.canInstall)?
          h('p',{class:'text-xs text-gray-300'},'Choose the payload folder next to Setup to install the packs offline.'):null,
        state.error?h('p',{class:'text-sm text-red-400',role:'alert'},state.error):null,
        state.notice?h('p',{class:'text-xs text-gray-300',role:'status'},state.notice):null,
        state.reload?h('div',{class:'desktop-data-row desktop-settings-rule'},[
          h('p',{class:'text-xs text-gray-300',role:'status'},'Reload to apply media changes.'),
          button('Reload to apply',()=>window.__holodoriDesktop.reloadCatalog()),
        ]):null,
      ];
    },
  };
}
