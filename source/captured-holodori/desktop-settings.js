import {numberFormats,dateFormats,formatNumber,formatDate,formatDateTime} from './regional-formats.js';
import {getCard,resourceLabels} from './game';
import {accountCharactersById} from '../hololive/vendor/shared/account-data';

function preloadChanges(h,{preloads,preloadUnavailable}) {
  if(!preloads&&!preloadUnavailable)return null;
  const changes=preloads?.lastChanges;
  const note=text=>h('p',{class:'text-xs text-gray-300'},text);
  const group=(label,entries,title)=>Object.keys(entries).length?h('section',{class:'desktop-catalog-group'},[
    h('h3',{class:'font-semibold'},label+' · '+formatNumber(Object.keys(entries).length)),
    h('ul',{},Object.entries(entries).map(([id,assets])=>
      h('li',{key:id},[
        h('p',{class:'font-semibold'},title(id)),
        ...assets.map(asset=>h('p',{key:asset,class:'text-xs text-gray-400'},asset))
      ])
    ))
  ]):null;
  const member=id=>accountCharactersById.get('chr-'+id)?.name;
  const card=id=>{
    const entry=getCard('card-'+id);
    return entry?[entry.memberName,entry.cardName].join(' · '):[member(id.split('-')[0]),id].filter(Boolean).join(' · ');
  };
  const status=preloadUnavailable?'Could not check for new assets.':preloads.added
    ?formatNumber(preloads.added)+' new '+(preloads.added===1?'asset':'assets')+' in the game catalog.'
    :'No new card, banner, or character assets in the latest check.';
  return h('div',{class:'desktop-settings-notes','data-catalog-preloads':''},[
    note(status),
    changes?h('details',{class:'desktop-settings-details'},[
      h('summary',{},'What changed'),
      h('div',{class:'desktop-settings-notes'},[
        note('Asset catalog '+changes.fromRevision+' → '+changes.toRevision),
        note('These assets are listed in the game catalog. Release status is unverified.'),
        h('div',{class:'desktop-catalog-changes'},[
          group('Cards',changes.cards,card),
          group('Banner art',changes.banners,id=>id),
          group('Character assets',changes.characters,id=>member(id)??id),
        ]),
      ]),
    ]):null
  ]);
}

// A normal Vue Settings component, using the captured app's existing design tokens.
export const desktopButtonClass='bg-gray-600 hover:bg-gray-500 shadow rounded-md py-2 px-3 transition-colors disabled:opacity-50 disabled:pointer-events-none';
export function createDesktopSettings({h,reactive,vnode,resolve,Dialog,Switch,state,invoke,action,message,restore,profiles,gameAccount,catalog,deleteData,options}) {
  state=reactive(state);
  const button=(label,id,busyLabel,fn)=>h('button',{type:'button',class:desktopButtonClass,disabled:!!state.busy||state.restorePending||!!state.gameImport||!!state.deleteStage,'aria-busy':state.busy===id,onClick:()=>action(id,fn)},state.busy===id?busyLabel:label);
  const description=(title,text)=>h('div',{class:'min-w-0'},[h('p',{class:'font-semibold text-sm'},title),h('p',{class:'text-sm text-gray-300 mt-1'},text)]);
  const toggle=(label,value,update)=>vnode(Switch,{modelValue:value,disabled:!!(state.busy||state.restore||state.profileImport||state.gameImport||state.deleteStage),'onUpdate:modelValue':update},{default:()=>[label]});
  const progress=value=>value?`Lv ${value.level} · SP ${value.trainingStage??value.levelLimitBreakCount} · B${value.bloomStage??value.potentialUpgradeCount}`:'New';
  const identity=value=>value?[value.name,`ID ${value.publicUserId}`].filter(Boolean).join(' · '):'';
  const boostAmount=(value,cap)=>value===null||value===undefined?'Not started':`${value} / ${cap}`;
  const boostComparison=row=>row?.status==='unavailable'?'Kept — unavailable':row?.status==='skipped'?'Kept — unsupported value':boostAmount(row?.value,row?.cap);
  const expiry=value=>{const time=Number(value),date=new Date(time);return value&&time>0&&Number.isFinite(date.getTime())?formatDateTime(date):null;};
  const table=(head,rows)=>h('div',{class:'mt-2',style:{maxHeight:'min(16rem,35vh)',overflow:'auto'}},[h('table',{class:'w-full text-sm'},[h('thead',{class:'text-gray-400 text-left'},[h('tr',{},head.map(text=>h('th',{class:'py-1 pr-3 font-semibold'},text)))]),h('tbody',{},rows.map(row=>h('tr',{class:'border-b border-gray-600'},row.map(text=>h('td',{class:'py-1.5 pr-3'},String(text))))))])]);
  const changeReview=changes=>{
    const note=text=>h('p',{class:'text-xs text-gray-400 mt-1'},text);
    if(!changes)return h('section',{class:'mt-3','data-import-changes':''},[
      h('h3',{class:'font-semibold text-sm'},'What changed'),note('This is the first game import for this profile.'),
    ]);
    const {boards,achievements}=changes;
    const boardCount=boards?boards.nodes.length+boards.connections.length:0;
    const ready=achievements?.filter(row=>row.status==='Ready in game').length??0;
    const received=(achievements?.length??0)-ready;
    const boardRows=boards?.nodes.map(row=>[row.member,[
      row.unlocked.length?'Unlocked '+row.unlocked.join(', '):'',
      row.removed.length?'Removed '+row.removed.join(', '):'',
      row.points?'Board Pt '+row.points.join(' → '):'',
    ].filter(Boolean).join(' · ')]);
    return h('section',{class:'mt-3','data-import-changes':''},[
      h('h3',{class:'font-semibold text-sm'},'What changed'),
      note('Compared with '+formatDateTime(changes.previousAt)),
      boards?h('details',{class:'mt-2 text-sm'},[
        h('summary',{class:'cursor-pointer'},'Holomem Boards · '+(boardCount?boardCount+' changes':'No changes')),
        boards.incomplete?note('Changes are shown for members present in both imports.'):null,
        boardRows.length?table(['Holomem','Board changes'],boardRows):null,
        boards.connections.length?table(['Connect card','Previous slot','New slot'],boards.connections.map(row=>[row.card,row.from,row.to])):null,
      ]):note('Board comparison unavailable.'),
      achievements?h('details',{class:'mt-2 text-sm'},[
        h('summary',{class:'cursor-pointer'},'Achievements · '+(achievements.length?[ready?ready+' ready in game':'',received?received+' received':''].filter(Boolean).join(' · '):'No changes')),
        achievements.length?table(['Achievement','Rewards','Status'],achievements.map(row=>[[row.group,row.title].filter(Boolean).join(' · '),row.rewards||'—',row.status])):null,
      ]):note('Achievement comparison unavailable.'),
    ]);
  };
  const section=(id,title,subtitle,content)=>h('details',{
    id,ref:id,class:'desktop-settings-section','aria-labelledby':id+'-title',
  },[
    h('summary',{class:'desktop-settings-summary'},[
      h('span',{},[h('strong',{id:id+'-title'},title),h('small',{class:'text-gray-300'},subtitle)]),
      vnode(resolve('chevron-right-icon'),{class:'desktop-settings-chevron','aria-hidden':'true'}),
    ]),
    h('div',{class:'desktop-settings-body'},content),
  ]);
  const component={name:'DesktopDataSettings',
    computed:{
      importError(){return state.gameReadError;},
      saveState(){return state.saveState;},
    },
    watch:{
      importError(error){if(error)this.$refs['desktop-import-data'].open=true;},
      saveState(status){if(status==='error')this.$refs['desktop-data'].open=true;},
    },
    beforeUnmount(){if(state.deleteStage)deleteData.cancel();if(state.restore)restore.cancel();if(state.profileImport)profiles.cancel();if(state.gameImport||state.busy==='game-read')gameAccount.cancel();},render(){
    // Reading the root account and local revision keeps captured Vue controls
    // reactive while the native boundary retains its synchronous storage API.
    const account=window.__seelieApp?.account,revision=state.profileRevision;
    const profile=options.getProfileSummary(),importedAt=profile.lastImportedAt;
    const preview=state.gameImport;
    const accountStatus=preview?.accountStatus;
    const app=window.__seelieApp;
    const formatPicker=(label,key,choices,example)=>h('label',{class:'desktop-format-row'},[
      h('span',{class:'font-semibold'},label),
      h('select',{'aria-label':label,class:'bg-gray-600 rounded-md',value:app?.settings?.[key]??'system',
        disabled:!!(state.busy||state.restore||state.profileImport||state.gameImport||state.deleteStage),
        onChange:event=>{if(!app.setSetting(key,event.target.value))event.target.value=app.settings[key]??'system';}},
        choices.map(([id,name])=>h('option',{key:id,value:id},name))),
      h('span',{class:'text-xs text-gray-300 tabular-nums'},example),
    ]);
    const passport=profile.boosts?.holoPassport||false;
    const updates=state.catalog;
    const updateStatus=updates?.message&&!['idle','disabled'].includes(updates.phase)?updates.message:'';
    const reloadReady=updates?.phase==='ready';
    return h('div',{class:'desktop-settings-sections'},[
      section('desktop-import-data','Import game data from PC client','Steam · Cards, inventory and account progress',[
        h('div',{class:'desktop-data-row'},[
          h('p',{class:'text-sm text-gray-300'},'Import your hololive Dreams account into the active planner profile.'),
          h('button',{type:'button',class:desktopButtonClass.replace('bg-gray-600 hover:bg-gray-500','bg-blue-600 hover:bg-blue-500'),disabled:!!(state.busy||state.restore||state.profileImport||state.gameImport||state.deleteStage),'aria-busy':state.busy==='game-read',onClick:gameAccount.read},state.busy==='game-read'?'Reading account data…':'Import from game')
        ]),
        h('ol',{class:'text-sm text-gray-300 space-y-1',style:{listStyleType:'decimal',paddingLeft:'1.25rem'}},[
          h('li',{},'Log in to hololive Dreams on Steam and reach the main lobby.'),
          h('li',{},'Select your planner profile above, then click Import from game.'),
          h('li',{},'Review the preview and click Import to save.')
        ]),
        profile.accountIdentity||importedAt?h('div',{class:'desktop-settings-notes'},[
          profile.accountIdentity?h('p',{class:'text-sm text-gray-300 break-words','data-linked-account':''},`Account: ${identity(profile.accountIdentity)}`):null,
          importedAt?h('p',{class:'text-xs text-gray-300'},`Last imported ${formatDateTime(importedAt)}`):null,
        ]):null,
        state.gameReadError?h('p',{class:'text-red-400 text-sm',role:'alert'},state.gameReadError):null,
      ]),
      section('holodori-preferences','Display & formats','Number, date and time formats · Animations and sidebar',[
        h('div',{class:'desktop-format-controls'},[
          formatPicker('Number format','number_format',numberFormats,formatNumber(1234567.89)),
          formatPicker('Date format','date_format',dateFormats,formatDate(new Date(2026,10,12))),
          ...this.$slots.formats(),
        ]),
        toggle('Enable card animations',profile.preferences.cardAnimationsDefault,value=>options.setPreferences({cardAnimationsDefault:value})),
        h('div',{class:'desktop-settings-sidebar-options'},this.$slots.sidebar()),
      ]),
      section('desktop-planner-settings','Planner & boosts','Material entry, expanded cards and HoloPassport',[
        ...this.$slots.planner(),
        h('div',{class:'desktop-settings-switches'},[
          toggle('HoloPassport',passport,options.setPassport),
          h('p',{class:'text-xs text-gray-300'},`Boost limits · Minigame ${passport?200:100} · Live ${passport?20:10}`),
          expiry(profile.passportExpiresAtMs)?h('p',{class:'text-xs text-gray-400'},`Last imported HoloPassport expiry · ${expiry(profile.passportExpiresAtMs)}`):null,
        ]),
      ]),
      section('desktop-optimizer-settings','Team Optimizer','Compute preferences',[
        toggle('Use GPU',app?.settings?.optimizer_use_gpu===true,value=>app.setSetting('optimizer_use_gpu',value)),
        h('p',{class:'text-xs text-gray-300'},'GPU search is experimental and may return weaker teams than the default CPU search.'),
      ]),
      section('desktop-catalog-settings','Catalog updates','Cards, artwork and optimizer data',[
        h('div',{class:'desktop-data-row'},[
          h('div',{},[toggle('Check for catalog updates automatically',updates?.enabled!==false,catalog.setEnabled)]),
          h('button',{type:'button',class:desktopButtonClass,disabled:!!updates?.busy,onClick:catalog.check},updates?.busy?'Updating…':'Check for updates')
        ]),
        updateStatus||reloadReady?h('div',{class:'desktop-data-row desktop-settings-rule'},[
          h('p',{class:`text-sm ${updates.phase==='error'?'text-red-400':'text-gray-300'}`,role:'status'},updateStatus),
          reloadReady?h('button',{type:'button',class:desktopButtonClass,disabled:!!(state.busy||state.restore||state.profileImport||state.gameImport||state.deleteStage),onClick:catalog.reload},'Reload to apply'):null,
        ]):null,
        updates?.optimizerNotice?h('p',{class:'text-xs text-gray-300',role:'status'},updates.optimizerNotice):null,
        updates?.error?h('details',{class:'desktop-settings-details'},[
          h('summary',{},'Details'),h('p',{class:'whitespace-pre-wrap break-words'},updates.error),
        ]):null,
        updates?preloadChanges(h,updates):null,
      ]),
      section('desktop-data','Local data & backups','Autosave, backup, restore and reset',[
        h('div',{class:'desktop-data-row'},[
          h('div',{},[h('p',{class:'font-semibold text-sm'},'Autosave'),h('p',{class:'text-sm text-gray-300 mt-1'},'Changes save automatically on this computer.'),
            h('p',{class:`text-xs mt-1 ${state.saveState==='error'?'text-red-400':state.saveState==='saving'?'text-purple-300':'text-gray-300'}`,role:'status','aria-live':'polite'},state.saveText)]),
          button('Save now','save','Saving…',async()=>message('All changes saved.'))
        ]),
        h('div',{class:'desktop-settings-storage-row'},[
          description('Backups','Keep a copy of every profile, preferences, and custom artwork. The latest 20 automatic backups are kept locally.'),
          h('div',{class:'desktop-settings-actions'},[
            button('Create backup','backup','Creating backup…',async()=>{await invoke('desktop_backup');state.backupWarning='';message('Backup created in your data folder.');}),
            button('Export all profiles','export','Exporting…',async()=>{if(await invoke('desktop_export'))message('Desktop backup exported.');}),
            button('Restore backup','chooseRestore','Opening…',async()=>{const preview=await invoke('desktop_import');if(preview)window.__holodoriDesktop.validateRestore(preview);state.restore=preview;state.restoreError='';state.restoreDetails='';})
          ]),
          state.backupWarning?h('p',{class:'text-sm text-orange-400 mt-2',role:'status'},'Your changes are saved, but the automatic backup could not be created. Try Create backup again.'):null
        ]),
        h('div',{class:'desktop-settings-storage-row'},[
          h('p',{class:'font-semibold text-sm'},'Save location'),
          h('div',{class:'desktop-data-row mt-1'},[h('code',{class:'bg-gray-600 rounded-md py-2 px-3 text-xs desktop-data-path'},state.dataDir),button('Open data folder','folder','Opening…',async()=>invoke('desktop_open_folder'))])
        ]),
        h('div',{class:'desktop-settings-storage-row desktop-data-row'},[
          description('Delete all data','Reset every profile and setting to an empty default. Local backups will also be deleted.'),
          h('button',{id:'delete-all-data',type:'button',class:desktopButtonClass.replace('bg-gray-600 hover:bg-gray-500','bg-red-700 hover:bg-red-600'),disabled:!!(state.busy||state.restore||state.profileImport||state.gameImport||state.deleteStage),onClick:deleteData.open},'Delete all data')
        ]),
        state.recovery?h('div',{class:'desktop-settings-storage-row'},[
          description('Data recovery','Your local data was recovered when the app opened.'),
          h('details',{class:'text-sm text-gray-400 mt-2'},[h('summary',{class:'cursor-pointer'},'Details'),h('p',{class:'whitespace-pre-wrap break-words mt-2'},state.recovery)])
        ]):null,
        h('p',{class:'text-xs text-gray-400'},'Ctrl+S saves pending changes.'),
      ]),
      state.message?h('p',{class:`mt-2 font-semibold leading-tight ${state.messageError?'text-red-400':'text-green-500'}`,role:state.messageError?'alert':'status'},state.message):null,
      state.details?h('details',{class:'text-sm text-gray-400 mt-2'},[h('summary',{class:'cursor-pointer'},'Details'),h('p',{class:'whitespace-pre-wrap break-words mt-2'},state.details)]):null,
      vnode(Dialog,{visible:!!state.deleteStage,'onUpdate:visible':visible=>{if(!visible)deleteData.cancel();},showHeader:false,draggable:false,modal:true,dismissableMask:!state.busy&&!state.deletePending,closeOnEscape:!state.busy&&!state.deletePending,'aria-labelledby':'desktop-delete-data-title',style:{width:'480px',maxWidth:'calc(100vw - 32px)'}},{default:()=>[
        h('div',{class:'mt-8'},[
          h('h2',{id:'desktop-delete-data-title',class:'text-xl font-bold'},state.deleteStage===1?'Delete all data?':'Final warning'),
          h('p',{class:'mt-3'},state.deleteStage===1?'This permanently deletes every profile and all saved cards, goals, inventory, reminders, settings, imports and custom artwork.':'All your planner data and local backups will be permanently deleted. The app will reopen with one empty Main profile and default settings.'),
          h('p',{class:'mt-3 font-semibold text-red-400'},state.deleteStage===1?'Local backups will also be deleted. This affects every profile.':'Are you sure you want to delete everything? This cannot be undone.'),
        ])
      ],footer:()=>[
        state.deleteError?h('p',{class:'mb-3 text-red-400 font-semibold leading-tight',style:{textAlign:'left',maxHeight:'6rem',overflow:'auto'},role:'alert'},state.deleteError):null,
        state.deleteDetails?h('p',{class:'mb-3 text-xs text-gray-400',style:{textAlign:'left',maxHeight:'4rem',overflow:'auto'}},state.deleteDetails):null,
        h('div',{class:'flex items-center justify-end'},[
          h('button',{type:'button',class:'bg-gray-700 shadow rounded-md py-2 px-3 disabled:opacity-50',disabled:!!state.busy||state.deletePending,onClick:deleteData.cancel},'Cancel'),
          h('button',{type:'button',class:'bg-red-700 shadow rounded-md py-2 px-3 ml-2 font-semibold disabled:opacity-50',disabled:!!state.busy||(state.deleteStage===2&&!state.deleteReady&&!state.deletePending),onClick:state.deleteStage===1?deleteData.next:deleteData.confirm},state.busy==='delete-all'?'Deleting…':state.busy==='delete-prepare'?'Preparing…':state.deleteStage===1?'Continue':state.deletePending?'Finish deleting':'Delete all data')
        ])
      ]}),
      vnode(Dialog,{visible:!!state.restore,'onUpdate:visible':visible=>{if(!visible)restore.cancel();},showHeader:false,draggable:false,modal:true,dismissableMask:!state.busy&&!state.restorePending,closeOnEscape:!state.busy&&!state.restorePending,'aria-labelledby':'desktop-restore-title','aria-describedby':'desktop-restore-description',style:{width:'480px',maxWidth:'calc(100vw - 32px)'}},{default:()=>[
        h('div',{class:'mt-8'},[
          h('h2',{id:'desktop-restore-title',class:'text-xl font-bold'},'Restore backup?'),
          h('p',{id:'desktop-restore-description',class:'mt-3'},'This replaces all current profiles and settings. A recovery backup will be created first.'),
          h('div',{class:'bg-gray-700 rounded-md p-3 mt-3'},[
            h('p',{class:'font-semibold break-words'},state.restore?.fileName||''),
            h('p',{class:'text-sm text-gray-300 mt-1'},`${formatNumber(state.restore?.profileCount||0)} profiles, preferences, and custom artwork`)
          ]),
          state.restoreError?h('p',{class:'mt-2 text-red-400 font-semibold leading-tight',role:'alert'},state.restoreError):null,
          state.restoreDetails?h('details',{class:'text-sm text-gray-400 mt-2'},[h('summary',{class:'cursor-pointer'},'Details'),h('p',{class:'whitespace-pre-wrap break-words mt-2'},state.restoreDetails)]):null,
          h('div',{class:'flex items-center justify-end mt-3'},[
            h('button',{type:'button',class:'bg-gray-700 shadow rounded-md py-2 px-3 disabled:opacity-50',disabled:!!state.busy||state.restorePending,onClick:restore.cancel},'Cancel'),
            h('button',{type:'button',class:'bg-red-700 shadow rounded-md py-2 px-3 ml-2 font-semibold disabled:opacity-50',disabled:!!state.busy,onClick:restore.confirm},state.busy==='restore'?'Restoring…':state.restorePending?'Finish restore':'Restore')
          ])
        ])
      ]}),
      vnode(Dialog,{visible:!!state.profileImport,'onUpdate:visible':visible=>{if(!visible)profiles.cancel();},showHeader:false,draggable:false,modal:true,dismissableMask:!state.busy,closeOnEscape:!state.busy,'aria-labelledby':'desktop-profile-import-title',style:{width:'480px',maxWidth:'calc(100vw - 32px)'}},{default:()=>[
        h('div',{class:'mt-8'},[
          h('h2',{id:'desktop-profile-import-title',class:'text-xl font-bold'},'Import profile?'),
          h('p',{class:'mt-3'},`This replaces ${state.profileImport?.profileName||'the selected profile'}. A recovery backup will be created first.`),
          h('div',{class:'bg-gray-700 rounded-md p-3 mt-3'},[
            h('p',{class:'font-semibold break-words'},state.profileImport?.fileName||''),
            h('p',{class:'text-sm text-gray-300 mt-1'},`${formatNumber(state.profileImport?.cards||0)} saved cards, inventory, tasks and boost trackers`)
          ]),
          state.profileImportError?h('p',{class:'mt-2 text-red-400 font-semibold leading-tight',role:'alert'},state.profileImportError):null,
          h('div',{class:'flex items-center justify-end mt-3'},[
            h('button',{type:'button',class:'bg-gray-700 shadow rounded-md py-2 px-3 disabled:opacity-50',disabled:!!state.busy,onClick:profiles.cancel},'Cancel'),
            h('button',{type:'button',class:'bg-blue-600 shadow rounded-md py-2 px-3 ml-2 font-semibold disabled:opacity-50',disabled:!!state.busy,onClick:profiles.confirm},state.busy==='profile-import'?'Importing…':'Import')
          ])
        ])
      ]}),
      vnode(Dialog,{visible:!!preview,'onUpdate:visible':visible=>{if(!visible)gameAccount.cancel();},showHeader:false,draggable:false,modal:true,dismissableMask:!state.busy&&!state.gameImportPendingSave,closeOnEscape:!state.busy&&!state.gameImportPendingSave,'aria-labelledby':'desktop-game-import-title',style:{width:'650px',maxWidth:'calc(100vw - 32px)'}},{default:()=>[
        h('div',{class:'mt-8'},[
          h('h2',{id:'desktop-game-import-title',class:'text-xl font-bold'},'Import account data?'),
          h('p',{class:'mt-3'},'Import this account’s card levels, SP, Bloom, Holomem ranks, inventory and available boost data. A recovery backup is created first.'),
          h('div',{class:'bg-gray-700 rounded-md p-3 mt-3'},[
            h('p',{class:'font-semibold break-words'},`Planner profile: ${preview?.profileName||'the selected profile'}`),
            accountStatus?h('p',{class:'text-sm text-gray-300 mt-1 break-words','data-source-account':''},accountStatus.identity?`Game account: ${identity(accountStatus.identity)}`:'Game account: unavailable'):null,
            accountStatus?.identityStatus==='new'?h('p',{class:'text-xs text-gray-400 mt-1'},'This game account will be linked to the profile when you import.'):null,
            h('p',{class:'text-sm text-gray-300 mt-1'},`${formatNumber(preview?.counts.sourceCards||0)} owned cards · ${formatNumber(preview?.counts.members||0)} Holomem · ${formatNumber(preview?.counts.materials||0)} materials`),
            h('p',{class:'text-sm text-gray-300 mt-1'},`${formatNumber(preview?.counts.newCards||0)} new cards · ${formatNumber(preview?.counts.updatedCards||0)} updated · ${formatNumber(preview?.counts.unchangedCards||0)} unchanged`),
            preview?h('p',{class:'text-xs text-gray-400 mt-1'},`Read ${formatDateTime(preview.capturedAt)}`):null,
            ...(preview?.available||[]).map(row=>h('p',{class:'text-xs text-gray-400 mt-1'},`${row.label}: ${row.count}`)),
          ]),
          preview?.warnings.length?h('div',{class:'bg-gray-700 rounded p-3 mt-3',style:{maxHeight:'8rem',overflow:'auto'}},preview.warnings.map(warning=>h('p',{class:'text-sm text-orange-400 mt-1'},warning.message))):null,
          preview?changeReview(preview.changes):null,
          accountStatus?h('div',{class:'mt-3','data-account-boost-preview':''},[
            h('p',{class:'font-semibold text-sm'},'Boosts'),
            table(['Tracker','Current','From game'],[
              ['Minigame Boost',boostAmount(accountStatus.boosts?.minigame?.previous,accountStatus.boosts?.minigame?.previousCap),boostComparison(accountStatus.boosts?.minigame)],
              ['Live Boost',boostAmount(accountStatus.boosts?.live?.previous,accountStatus.boosts?.live?.previousCap),boostComparison(accountStatus.boosts?.live)],
              ['HoloPassport',accountStatus.holoPassport?.previous?'Enabled':'Disabled',accountStatus.holoPassport?.active===null||accountStatus.holoPassport?.active===undefined?'Kept — unavailable':accountStatus.holoPassport.active?'Enabled':'Disabled'],
            ]),
          ]):null,
          h('details',{class:'mt-3 text-sm'},[
            h('summary',{class:'font-semibold cursor-pointer'},`Cards (${formatNumber(preview?.counts.sourceCards||0)})`),
            table(['Card','Current','From game'],(preview?.cardChanges||[]).map(row=>[`${row.memberName}${row.memberName?' · ':''}${row.cardName}${row.status==='unknown'?' (retained)':row.status==='unsupported'?' (needs catalog update)':''}`,progress(row.previous),progress(row.observed)])),
          ]),
          h('details',{class:'mt-3 text-sm',open:true},[
            h('summary',{class:'font-semibold cursor-pointer'},`Materials (${formatNumber(preview?.counts.materials||0)})`),
            table(['Material','Current','From game'],(preview?.inventoryChanges||[]).map(row=>[resourceLabels[row.key]||row.key,formatNumber(row.previous),row.authoritative?formatNumber(row.value):'Kept — expiration unverified'])),
          ]),
          h('details',{class:'mt-3 text-sm'},[
            h('summary',{class:'font-semibold cursor-pointer'},`Holomem progress (${formatNumber(preview?.counts.members||0)})`),
            table(['Holomem','Current rank','Game rank','EXP'],(preview?.members||[]).map(row=>[
              row.name,row.previousRank??'—',
              row.plannerRank!==null&&row.plannerRank!==row.level?`${row.level} · planner keeps ${row.plannerRank} for its Board plan`:row.level,
              formatNumber(BigInt(row.expTotal??0)),
            ])),
          ]),
        ]),
      ],footer:()=>[
        state.gameImportError?h('p',{class:'mb-3 text-red-400 font-semibold leading-tight',style:{textAlign:'left',maxHeight:'6rem',overflow:'auto'},role:'alert'},state.gameImportError):null,
        h('div',{class:'flex items-center justify-end'},[
          h('button',{type:'button',class:'bg-gray-700 shadow rounded-md py-2 px-3 disabled:opacity-50',disabled:!!state.busy||state.gameImportPendingSave,onClick:gameAccount.cancel},'Cancel'),
          h('button',{type:'button',class:'bg-blue-600 shadow rounded-md py-2 px-3 ml-2 font-semibold disabled:opacity-50',disabled:!!state.busy,onClick:gameAccount.confirm},state.busy==='game-import'?'Importing…':state.gameImportPendingSave?'Retry save':'Import'),
        ]),
      ]}),
    ]);
  }};

  return {state,component};
}

export function showStartupError(error,{openFolder}) {
  const panel=document.createElement('section');panel.className='container mx-auto px-4 py-16 text-white';
  const heading=document.createElement('h1');heading.className='text-xl font-bold';heading.textContent='Local data could not open';
  const card=document.createElement('div');card.className='bg-gray-700 p-3 rounded-md mt-4';
  const description=document.createElement('p');description.textContent='Your existing files have been preserved. Try again, or open the data folder to check file access and recovery copies.';
  const details=document.createElement('details');details.className='text-sm text-gray-400 mt-3';const summary=document.createElement('summary');summary.className='cursor-pointer';summary.textContent='Details';const text=document.createElement('p');text.className='whitespace-pre-wrap break-words mt-2';text.textContent=String(error);details.append(summary,text);
  const actions=document.createElement('div');actions.className='flex flex-wrap gap-2 mt-3';
  const retry=document.createElement('button');retry.className=desktopButtonClass;retry.textContent='Try again';retry.onclick=()=>location.reload();
  const folder=document.createElement('button');folder.className=desktopButtonClass;folder.textContent='Open data folder';folder.onclick=async()=>{folder.disabled=true;try{await openFolder();}catch(e){text.textContent=String(e);details.open=true;}finally{folder.disabled=false;}};
  actions.append(retry,folder);card.append(description,details,actions);panel.append(heading,card);document.getElementById('app').replaceChildren(panel);
}
