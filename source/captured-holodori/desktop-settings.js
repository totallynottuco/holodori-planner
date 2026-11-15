import {numberFormats,dateFormats,formatNumber,formatDate,formatDateTime} from './regional-formats.js';
import {getCard,resourceLabels} from './game';
import {accountCharactersById,resolveBoardNodes} from '../hololive/vendor/shared/account-data';
import {boardNodeLabel} from './holomem-board';
import {createMediaPacks} from './media-packs-ui.js';

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
export function createDesktopSettings({h,reactive,vnode,resolve,Dialog,Switch,state,invoke,action,message,restore,profiles,gameAccount,catalog,deleteData,appUpdates,options}) {
  state=reactive(state);
  const blocked=()=>!!(state.busy||state.restore||state.profileImport||state.gameImport||state.deleteStage||appUpdates?.busy());
  const primary=desktopButtonClass.replace('bg-gray-600 hover:bg-gray-500','bg-blue-600 hover:bg-blue-500');
  const danger=desktopButtonClass.replace('bg-gray-600 hover:bg-gray-500','bg-red-700 hover:bg-red-600');
  const control=(label,onClick,{disabled=false,className=desktopButtonClass,busy=false}={})=>h('button',{
    type:'button',class:className,disabled,'aria-busy':busy||undefined,onClick,
  },label);
  const button=(label,id,busyLabel,fn)=>control(state.busy===id?busyLabel:label,()=>action(id,fn),{disabled:blocked(),busy:state.busy===id});
  const note=(text,attributes={})=>h('p',{class:'text-xs text-gray-300',...attributes},text);
  const description=(title,text)=>h('div',{class:'desktop-settings-copy'},[h('p',{class:'font-semibold text-sm'},title),note(text)]);
  const actions=(...buttons)=>h('div',{class:'desktop-settings-actions'},buttons);
  const row=(copy,...buttons)=>h('div',{class:'desktop-data-row'},[copy,buttons.length?actions(...buttons):null]);
  const fields=(title,children)=>h('div',{class:'desktop-settings-fields'},[h('h4',{},title),...children]);
  const toggle=(label,value,update)=>vnode(Switch,{modelValue:value,disabled:blocked(),'onUpdate:modelValue':update},{default:()=>[label]});
  const dialog=(titleId,title,visible,cancel,locked,width,body,buttons,error,details)=>{
    return vnode(Dialog,{
      visible,'onUpdate:visible':open=>{if(!open)cancel();},modal:true,draggable:false,'aria-labelledby':titleId,
      closable:!locked,closeOnEscape:!locked,dismissableMask:!locked,style:{width,maxWidth:'calc(100vw - 24px)'},
    },{
      header:()=>h('h2',{id:titleId,class:'text-base font-semibold'},title),
      default:()=>h('div',{class:'desktop-settings-dialog-body'},body),
      footer:()=>[
        error?note(error,{class:'desktop-settings-dialog-error text-sm text-red-400',role:'alert'}):null,
        details?h('details',{class:'desktop-settings-dialog-error desktop-settings-details'},[
          h('summary',{},'Details'),h('p',{class:'whitespace-pre-wrap break-words'},details),
        ]):null,
        h('div',{class:'desktop-settings-dialog-actions'},buttons),
      ],
    });
  };
  const reviewSection=(title,content)=>h('details',{class:'desktop-settings-review'},[h('summary',{},title),content]);
  const feedback=scope=>state.message&&state.messageScope===scope?h('div',{class:'desktop-settings-feedback'},[
    h('p',{class:state.messageError?'text-red-400':'text-green-500',role:state.messageError?'alert':'status'},state.message),
    state.details?h('details',{class:'desktop-settings-details'},[
      h('summary',{},'Details'),h('p',{class:'whitespace-pre-wrap break-words'},state.details),
    ]):null,
  ]):null;
  const progress=value=>value?`Lv ${value.level} · SP ${value.trainingStage??value.levelLimitBreakCount} · B${value.bloomStage??value.potentialUpgradeCount}`:'New';
  const identity=value=>value?[value.name,`ID ${value.publicUserId}`].filter(Boolean).join(' · '):'';
  const boostAmount=(value,cap)=>value===null||value===undefined?'Not started':`${value} / ${cap}`;
  const boostComparison=row=>row?.status==='unavailable'?'Kept — unavailable':row?.status==='skipped'?'Kept — unsupported value':boostAmount(row?.value,row?.cap);
  const expiry=value=>{const time=Number(value),date=new Date(time);return value&&time>0&&Number.isFinite(date.getTime())?formatDateTime(date):null;};
  const table=(head,rows)=>h('div',{class:'mt-2',style:{maxHeight:'min(16rem,35vh)',overflow:'auto'}},[h('table',{class:'w-full text-sm'},[h('thead',{class:'text-gray-400 text-left'},[h('tr',{},head.map(text=>h('th',{class:'py-1 pr-3 font-semibold'},text)))]),h('tbody',{},rows.map(row=>h('tr',{class:'border-b border-gray-600'},row.map(text=>h('td',{class:'py-1.5 pr-3'},String(text))))))])]);
  const boardCard=id=>id?(getCard(id)?.cardName??id):'Empty';
  const boardReview=review=>review&&(review.completed||review.pending||review.unobserved||review.conflicts.length)?
    h('section',{class:'mt-3 text-sm','aria-label':'Protected Boards'},[
      h('h3',{class:'font-semibold'},'Protected Boards'),
      h('p',{class:'text-xs text-gray-300 mt-1'},
        `${formatNumber(review.completed)} completed · ${formatNumber(review.pending)} pending`),
      review.unobserved?h('p',{class:'text-xs text-gray-300 mt-1'},
        'Boards missing from this import will keep their last observed layout and saved plans.'):null,
      review.conflicts.length?h('p',{class:'text-xs text-gray-300 mt-1'},
        'Choose how to resolve each conflict. A Connect choice keeps other pending changes and may move a card between Boards.'):null,
      ...review.conflicts.map(({owner,layout,missingBaseline,slots,cards,game,saved})=>{
        const name=accountCharactersById.get(owner)?.name??owner;
        const included=[...new Set([...slots,...Object.keys({...game.cards,...saved.cards}).filter(slot=>
          cards.includes(game.cards[slot])||cards.includes(saved.cards[slot]))])];
        const nodeNames=layout||missingBaseline?new Map(resolveBoardNodes(owner).map(node=>[node.groupId,boardNodeLabel(node)])):null;
        const differences=(left,right)=>left.filter(id=>!right.includes(id)).map(id=>nodeNames.get(id)??id);
        return h('div',{key:owner,class:'bg-gray-700 rounded-md p-2 mt-2'},[
          h('p',{class:'font-semibold'},name),
          missingBaseline?h('p',{class:'text-xs text-gray-300 mt-1'},'No previous imported layout is available for comparison.'):null,
          nodeNames?h('details',{class:'text-xs mt-1'},[
            h('summary',{class:'cursor-pointer'},'Layout differences'),
            table(['Game Board only','Saved Board only'],[[
              differences(game.nodes,saved.nodes).join(', ')||'—',
              differences(saved.nodes,game.nodes).join(', ')||'—',
            ]]),
          ]):null,
          layout?h('p',{class:'text-xs text-gray-300 mt-1'},'A pending change no longer has a valid path on the imported Board.'):null,
          cards.length?h('p',{class:'text-xs text-gray-300 mt-1'},`Another Board also uses ${cards.map(boardCard).join(', ')}.`):null,
          included.length?table(['Connect slot','Game Board','Saved Board'],
            included.map(slot=>[slot,boardCard(game.cards[slot]),boardCard(saved.cards[slot])])):null,
          h('div',{class:'flex flex-wrap gap-1 mt-2',role:'group','aria-label':`Choose layout for ${name}`},
            [['game',nodeNames?'Use game Board':'Use game Connect'],['saved',nodeNames?'Keep saved Board':'Keep saved Connect']].map(([choice,label])=>h('button',{
              key:choice,type:'button',class:desktopButtonClass+(review.choices[owner]===choice?' ring-1 ring-purple-400':''),
              'aria-pressed':review.choices[owner]===choice,disabled:!!state.busy||state.gameImportPendingSave,
              onClick:()=>gameAccount.chooseBoard(owner,choice),
            },label))),
        ]);
      }),
      review.error?h('p',{class:'text-xs text-red-400 mt-1',role:'alert'},review.error):null,
    ]):null;
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
  const media=createMediaPacks({h,reactive,vnode,Dialog,invoke,buttonClass:desktopButtonClass,blocked});
  const section=(id,title,subtitle,content,onToggle)=>h('details',{
    id,ref:id,class:'desktop-settings-section','aria-labelledby':id+'-title',onToggle,
  },[
    h('summary',{class:'desktop-settings-summary'},[
      h('span',{},[h('strong',{id:id+'-title'},title),h('small',{class:'text-gray-300'},subtitle)]),
      vnode(resolve('chevron-right-icon'),{class:'desktop-settings-chevron','aria-hidden':'true'}),
    ]),
    h('div',{class:'desktop-settings-body'},content),
  ]);
  const group=(id,title,sections)=>h('section',{class:'desktop-settings-group','aria-labelledby':id},[
    h('h2',{id},title),h('div',{class:'desktop-settings-list'},sections),
  ]);
  const openProblems=vm=>{
    if(state.gameReadError&&vm.$refs['desktop-import-data'])vm.$refs['desktop-import-data'].open=true;
    if(state.saveState==='error'&&vm.$refs['desktop-data'])vm.$refs['desktop-data'].open=true;
  };
  const component={name:'DesktopDataSettings',
    computed:{
      importError(){return state.gameReadError;},
      saveState(){return state.saveState;},
    },
    watch:{
      importError(error){if(error)openProblems(this);},
      saveState(status){if(status==='error')openProblems(this);},
    },
    mounted(){openProblems(this);},
    beforeUnmount(){media.cancelRemoval();if(state.deleteStage)deleteData.cancel();if(state.restore)restore.cancel();if(state.profileImport)profiles.cancel();if(state.gameImport||state.busy==='game-read')gameAccount.cancel();},render(){
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
        disabled:blocked(),
        onChange:event=>{if(!app.setSetting(key,event.target.value))event.target.value=app.settings[key]??'system';}},
        choices.map(([id,name])=>h('option',{key:id,value:id},name))),
      h('span',{class:'text-xs text-gray-300 tabular-nums'},example),
    ]);
    const passport=profile.boosts?.holoPassport||false,passportExpiry=expiry(profile.passportExpiresAtMs);
    const updates=state.catalog;
    const updateStatus=updates?.message&&!['idle','disabled'].includes(updates.phase)?updates.message:'';
    const reloadReady=updates?.phase==='ready';
    const importData=section('desktop-import-data','Import game data from PC client','Steam account, cards, inventory and progress',[
      row(h('ol',{class:'desktop-settings-steps text-sm text-gray-300'},[
        h('li',{},'Open hololive Dreams on Steam and reach the main lobby.'),
        h('li',{},'Choose your profile, then click Import from game.'),
        h('li',{},'Review the preview, then confirm the import.'),
      ]),control(state.busy==='game-read'?'Reading account…':'Import from game',gameAccount.read,
        {className:primary,disabled:blocked(),busy:state.busy==='game-read'})),
      profile.accountIdentity||importedAt?h('div',{class:'desktop-settings-meta'},[
        profile.accountIdentity?note(identity(profile.accountIdentity),{'data-linked-account':''}):null,
        importedAt?note('Last imported '+formatDateTime(importedAt)):null,
      ]):null,
      feedback('game'),
    ]);
    const data=section('desktop-data','Local data & backups','Save location, backups and reset',[
      row(h('div',{class:'desktop-settings-copy'},[
        h('p',{class:'font-semibold text-sm'},'Autosave'),
        note(state.saveText,{class:'text-xs '+(state.saveState==='error'?'text-red-400':state.saveState==='saving'?'text-purple-300':'text-gray-300'),role:'status'}),
      ]),button('Save now','save','Saving…',()=>{})),
      feedback('data'),
      fields('Backups',[
        note('Full backups include every profile, app settings, and custom artwork.'),
        actions(
          button('Create backup','backup','Creating…',async()=>{await invoke('desktop_backup');state.backupWarning='';message('Backup created in your data folder.');}),
          button('Export backup','export','Exporting…',async()=>{if(await invoke('desktop_export'))message('Backup exported.');}),
          button('Restore backup','chooseRestore','Opening…',async()=>{const preview=await invoke('desktop_import');if(!preview)return;window.__holodoriDesktop.validateRestore(preview);state.restore=preview;state.restoreError='';state.restoreDetails='';}),
        ),
        feedback('backups'),
        state.backupWarning?note('The automatic backup failed. Use Create backup to try again.',{class:'text-xs text-orange-400',role:'status'}):null,
      ]),
      row(h('div',{class:'desktop-settings-copy'},[
        h('p',{class:'font-semibold text-sm'},'Save location'),
        h('code',{class:'desktop-data-path text-xs text-gray-300',title:state.dataDir},state.dataDir),
      ]),button('Open data folder','folder','Opening…',()=>invoke('desktop_open_folder'))),
      feedback('folder'),
      state.recovery?h('details',{class:'desktop-settings-details'},[
        h('summary',{},'Local data recovered at startup'),h('p',{class:'whitespace-pre-wrap break-words'},state.recovery),
      ]):null,
      h('div',{class:'desktop-settings-rule'},[row(description('Reset planner','Permanently deletes all profiles, settings, and local backups.'),
        h('button',{id:'delete-all-data',type:'button',class:danger,disabled:blocked(),onClick:deleteData.open},'Delete all data'))]),
    ]);
    const planner=section('desktop-planner-settings','Planner & goals','Materials, goal summaries and expanded cards',[
      fields('Material entry',this.$slots.materialEntry()),
      fields('Planner summary',this.$slots.goals()),
      fields('Expanded cards',this.$slots.cardDetails()),
    ]);
    const boosts=section('desktop-boost-settings','Boosts & HoloPassport','Minigame and Live Boost limits',[
      toggle('HoloPassport',passport,options.setPassport),
      h('dl',{class:'desktop-settings-meta desktop-settings-boosts'},[
        h('div',{},[h('dt',{},'Minigame cap'),h('dd',{},formatNumber(passport?200:100))]),
        h('div',{},[h('dt',{},'Live cap'),h('dd',{},formatNumber(passport?20:10))]),
      ]),
      passportExpiry?note('Last imported expiry '+passportExpiry):null,
    ]);
    const optimizer=section('desktop-optimizer-settings','Team Optimizer','GPU search',[
      toggle('Use GPU',app?.settings?.optimizer_use_gpu===true,value=>app.setSetting('optimizer_use_gpu',value)),
      note('GPU search is experimental and can return weaker teams than the default CPU search.'),
    ]);
    const display=section('desktop-appearance-settings','Appearance','Sidebar and card animations',[
      h('div',{class:'desktop-settings-sidebar-options'},this.$slots.sidebar()),
      toggle('Enable card animations',profile.preferences.cardAnimationsDefault,value=>options.setPreferences({cardAnimationsDefault:value})),
    ]);
    const formats=section('holodori-preferences','Regional formats','Number, date and time display',[
      h('div',{class:'desktop-format-controls'},[
        formatPicker('Number format','number_format',numberFormats,formatNumber(1234567.89)),
        formatPicker('Date format','date_format',dateFormats,formatDate(new Date(2026,10,12))),
        ...this.$slots.formats(),
      ]),
    ]);
    const catalogSettings=section('desktop-catalog-settings','Catalog updates','Cards, artwork and optimizer data',[
      row(h('div',{},[toggle('Automatic catalog updates',updates?.enabled!==false,catalog.setEnabled)]),
        control(updates?.busy?'Checking…':'Check catalog',catalog.check,{disabled:blocked()||!!updates?.busy,busy:!!updates?.busy})),
      updateStatus||reloadReady?row(note(updateStatus,{class:'text-xs '+(updates.phase==='error'?'text-red-400':'text-gray-300'),role:'status'}),
        ...(reloadReady?[control('Reload to apply',catalog.reload,{disabled:blocked()||media.busy()})]:[])):null,
      updates?.optimizerNotice?note(updates.optimizerNotice,{role:'status'}):null,
      updates?.error?h('details',{class:'desktop-settings-details'},[
        h('summary',{},'Update error details'),h('p',{class:'whitespace-pre-wrap break-words'},updates.error),
      ]):null,
      updates?preloadChanges(h,updates):null,
    ]);
    const appUpdateSection=appUpdates?.enabled?section('desktop-app-updates','App updates','Hololive Dreams Planner versions',[appUpdates.settings()]):null;
    const mediaSection=section('desktop-media-settings','Media packs','Offline previews, artwork and music',media.render(),media.open);
    return h('div',{class:'desktop-settings-sections'},[
      h('div',{class:'desktop-settings-column'},[
        group('desktop-account-heading','Account & data',[importData,data]),
        group('desktop-planning-heading','Planning',[planner,boosts,optimizer]),
      ]),
      h('div',{class:'desktop-settings-column'},[
        group('desktop-display-heading','Display',[display,formats]),
        group('desktop-downloads-heading','Updates & downloads',[appUpdateSection,catalogSettings,mediaSection]),
      ]),
      media.dialog(),

      dialog('desktop-delete-data-title',state.deleteStage===1?'Delete all data?':'Final warning',!!state.deleteStage,deleteData.cancel,
        !!state.busy||state.deletePending,'440px',[
          h('p',{},state.deleteStage===1
            ?'This deletes every profile, all saved progress, preferences, imports, and custom artwork.'
            :'The app will reopen with one empty Main profile and default settings.'),
          h('p',{class:'text-red-400 font-semibold'},state.deleteStage===1
            ?'Local backups will also be deleted. This affects every profile.'
            :'This permanently deletes your planner data and backups.'),
        ],[
          control('Cancel',deleteData.cancel,{disabled:!!state.busy||state.deletePending}),
          control(state.busy==='delete-all'?'Deleting…':state.busy==='delete-prepare'?'Preparing…':state.deleteStage===1?'Continue':state.deletePending?'Finish deleting':'Delete all data',
            state.deleteStage===1?deleteData.next:deleteData.confirm,{className:danger,
              disabled:!!state.busy||(state.deleteStage===2&&!state.deleteReady&&!state.deletePending)}),
        ],state.deleteError,state.deleteDetails),
      dialog('desktop-restore-title','Restore backup?',!!state.restore,restore.cancel,!!state.busy||state.restorePending,'440px',[
        h('p',{},'This replaces all current profiles and settings. A recovery backup will be created first.'),
        description(state.restore?.fileName||'Backup',formatNumber(state.restore?.profileCount||0)+' profiles, preferences, and custom artwork'),
      ],[
        control('Cancel',restore.cancel,{disabled:!!state.busy||state.restorePending}),
        control(state.busy==='restore'?'Restoring…':state.restorePending?'Finish restore':'Restore',restore.confirm,{disabled:!!state.busy,className:danger}),
      ],state.restoreError,state.restoreDetails),
      dialog('desktop-profile-import-title','Import profile?',!!state.profileImport,profiles.cancel,!!state.busy,'440px',[
        h('p',{},'This replaces '+(state.profileImport?.profileName||'the selected profile')+'. A recovery backup will be created first.'),
        description(state.profileImport?.fileName||'Profile',formatNumber(state.profileImport?.cards||0)+' saved cards, plus inventory, tasks and boost trackers'),
      ],[
        control('Cancel',profiles.cancel,{disabled:!!state.busy}),
        control(state.busy==='profile-import'?'Importing…':'Import',profiles.confirm,{disabled:!!state.busy,className:primary}),
      ],state.profileImportError),
      dialog('desktop-game-import-title','Import account data?',!!preview,gameAccount.cancel,!!state.busy||state.gameImportPendingSave,'650px',preview?[
        h('div',{class:'desktop-settings-notes'},[
          h('p',{class:'font-semibold break-words'},'Planner profile · '+preview.profileName),
          accountStatus?note(accountStatus.identity?'Game account · '+identity(accountStatus.identity):'Game account unavailable',
            {'data-source-account':'',class:'text-sm text-gray-300 break-words'}):null,
          accountStatus?.identityStatus==='new'?note('This account will be linked to the selected profile.'):null,
          note('Read '+formatDateTime(preview.capturedAt)+' · A recovery backup will be created before importing.'),
          note([formatNumber(preview.counts.sourceCards)+' owned cards',formatNumber(preview.counts.newCards)+' new',
            formatNumber(preview.counts.updatedCards)+' updated',formatNumber(preview.counts.unchangedCards)+' unchanged'].join(' · ')),
        ]),
        preview.warnings?.length?h('ul',{class:'desktop-settings-import-warnings text-orange-400'},
          preview.warnings.map(warning=>h('li',{},warning.message))):null,
        changeReview(preview.changes),
        boardReview(preview.boardReview),
        accountStatus?reviewSection('Boosts & HoloPassport',h('div',{'data-account-boost-preview':''},[
          table(['Tracker','Current','From game'],[
            ['Minigame Boost',boostAmount(accountStatus.boosts?.minigame?.previous,accountStatus.boosts?.minigame?.previousCap),boostComparison(accountStatus.boosts?.minigame)],
            ['Live Boost',boostAmount(accountStatus.boosts?.live?.previous,accountStatus.boosts?.live?.previousCap),boostComparison(accountStatus.boosts?.live)],
            ['HoloPassport',accountStatus.holoPassport?.previous?'Enabled':'Disabled',accountStatus.holoPassport?.active==null?'Kept — unavailable':accountStatus.holoPassport.active?'Enabled':'Disabled'],
          ]),
        ])):null,
        reviewSection('Cards ('+formatNumber(preview.counts.sourceCards)+')',
          table(['Card','Current','From game'],preview.cardChanges.map(row=>[
            [row.memberName,row.cardName].filter(Boolean).join(' · ')+(row.status==='unknown'?' (retained)':row.status==='unsupported'?' (needs catalog update)':''),
            progress(row.previous),progress(row.observed),
          ]))),
        reviewSection('Materials ('+formatNumber(preview.counts.materials)+')',
          table(['Material','Current','From game'],preview.inventoryChanges.map(row=>[
            resourceLabels[row.key]||row.key,formatNumber(row.previous),row.authoritative?formatNumber(row.value):'Kept — expiration unverified',
          ]))),
        reviewSection('Holomem progress ('+formatNumber(preview.counts.members)+')',
          table(['Holomem','Current rank','Game rank','EXP'],preview.members.map(row=>[
            row.name,row.previousRank??'—',
            row.plannerRank!==null&&row.plannerRank!==row.level?row.level+' · planner keeps '+row.plannerRank+' for its Board plan':row.level,
            formatNumber(BigInt(row.expTotal??0)),
          ]))),
        preview.available?.length?reviewSection('Additional account data',
          h('dl',{class:'desktop-settings-meta'},preview.available.map(row=>h('div',{key:row.key,class:'desktop-settings-count'},
            [h('dt',{},row.label),h('dd',{},formatNumber(row.count))])))):null,
      ]:[],[
        control('Cancel',gameAccount.cancel,{disabled:!!state.busy||state.gameImportPendingSave}),
        control(state.busy==='game-import'?'Importing…':state.gameImportPendingSave?'Retry save':'Import',gameAccount.confirm,
          {className:primary,disabled:!!state.busy||!!preview?.boardReview?.error||
            !!preview?.boardReview?.conflicts.some(({owner})=>!preview.boardReview.choices[owner])}),
      ],state.gameImportError),
    ]);
  }};

  return {state,component,mediaBusy:media.busy};
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
