import {formatNumber,parseNumber,formatDate,formatDateTime} from './regional-formats.js';
import {game,resourceImage} from './game';
import {accountManifest,accountRosterBranches,boardPointsForMemberLevel,resolveBoardNodes} from '../hololive/vendor/shared/account-data';
import {loadExtraSongs,saveExtraSongs} from './optimizer-song-unlocks';
import {loadOptimizerPreferences,saveOptimizerPreferences} from './optimizer-preferences';
import {boardChangeBadge,createHolomemBoard} from './holomem-board-ui';
import {boardNodeLabel,connectCard} from './holomem-board';
import {accountProgressRank,accountProgressMemoryBonus} from './account-progress';
import {currentBoards,currentMemberRank,currentOwnedCards,currentGachaPoints,currentUpgradeBonus,currentDreamRank} from './current-account';
import {automaticChapter,defaultEvent,eventStatus} from './optimizer-events';
import {optimizerPowerUpPresets,referencePowerUpOverride,referenceSearchRoster} from './reference-team-solver';
import {referencePowerUpBonus} from './reference-rating-math';
import {previewTeamPlan} from './team-plan';
import {plannedOptimizerCards} from './planned-optimizer-cards';
import {optimizerBoards,savedLineupSchema} from './saved-lineups';
import {boardChanges,boardTable,mergeSavedBoards,projectBoardSelection,protectedSavedBoards,remainingBoardChanges} from './saved-boards';
import {boardPlanningBaseline,boardProtection,boardProtectionModes,preservesBoard} from './board-protection';
import {boardBill,optimizerResetLimit,quoteBoardBudget,resetGold} from './board-budget';
import {createOutfitPreview} from './outfit-preview.js';
import {optimizerWorkspaceCatalog,prepareOptimizerWorkspace} from './optimizer-workspace-catalog.js';
import {previewSoundtrack,rememberPreviewSoundtrack} from './optimizer-preview-audio.js';
import {createPreviewHitPlayback} from './optimizer-preview-hit-playback.js';
import {loadChartHitEvents} from './optimizer-chart-hit-events.js';
import {preloadPreviewHitSounds,previewHitSoundTypes} from './optimizer-preview-hit-sounds.js';
import {loadChartArtwork,chartArtworkCrop,chartArtworkPoint,chartArtworkViewBox,chartArtworkWindows} from './optimizer-chart-artwork.js';
import {activeGachaCurrencies,nextAcquisitionChoices,quoteCardAcquisitions} from './acquisition-exchanges.js';

export {prepareOptimizerWorkspace};

const workers = new WeakMap();
const searchWorkers = new WeakMap();
const lineupWorkers = new WeakMap();
const outfitSwipes = new WeakMap();
const boardPreviews = new WeakMap();
const hitPlayback = new WeakMap();
const defaultHitSoundTypes = ['type1','type2','type3','type4'];
const workerUrl = '/app/team-optimizer-worker.js';
let outfitPreviews;
let outfitUpdates;
const outfitIdPattern=/^\d{5}-[a-z]+-\d{4}-\d{2}$/;
const outfitUpdateDirectory='/assets/outfit-updates/';
const outfitIndex=(url,options)=>fetch(url,options).then(response=>response.ok?response.json():{}).catch(()=>({}));
function loadOutfitPreviews(){
  outfitPreviews??=outfitIndex('/assets/outfits/index.json');
  outfitUpdates??=outfitIndex(outfitUpdateDirectory+'index.json',{cache:'no-store'}).finally(()=>{outfitUpdates=undefined;});
  return Promise.all([outfitPreviews,outfitUpdates]).then(([bundled,updates])=>{
    const merged={...bundled,rooms:{...bundled.rooms},thumbnails:{...bundled.thumbnails},
      reactions:{...bundled.reactions},updated:{}};
    for(const [id,entry] of Object.entries(updates??{})){
      if(!outfitIdPattern.test(id)||typeof entry?.asset!=='string'||!entry.asset.startsWith(id+'.')||
        !/^[0-9a-f]{16}$/.test(entry.asset.slice(id.length+1))||!Array.isArray(entry.atlases)||!entry.atlases.length||
        !entry.atlases.every(name=>typeof name==='string'&&name.startsWith(entry.asset+'.atlas-')&&
          /^\d+\.webp$/.test(name.slice(entry.asset.length+7))))continue;
      merged[id]=entry.atlases;
      merged.updated[id]=entry.asset;
      const slots=updates.reactions?.[id];
      merged.reactions[id]=Array.isArray(slots)?slots.filter(slot=>Number.isInteger(slot)&&slot>0&&slot<=100):[];
      const thumbnail=updates.thumbnails?.[id];
      if(thumbnail===`thumb-${entry.asset}.webp`)merged.thumbnails[id]=outfitUpdateDirectory+thumbnail;
    }
    for(const [id,room] of Object.entries(updates?.rooms??{}))if(/^\d{5}$/.test(id)&&room===`room-${id}.webp`)
      merged.rooms[id]=outfitUpdateDirectory+room;
    return merged;
  });
}
const action = 'holo-team-action rounded bg-gray-700 hover:bg-gray-600 font-semibold';
const primary = 'holo-team-action rounded bg-purple-600 hover:bg-purple-500 font-semibold';
const inputClass = 'holo-team-input p-inputtext p-component';
const modes = [['best','Best team'],['holomem','Build around cards'],['next','Next upgrades']];
const difficulties = ['easy','normal','hard','expert'];
const powerUpLabel=value=>`+${formatNumber(value/100,{minimumFractionDigits:2,maximumFractionDigits:2})}%`;
const eventDateRange=event=>Number.isFinite(event.startTime)&&Number.isFinite(event.endTime)&&event.endTime>=event.startTime?
  [...new Set([formatDate(event.startTime),formatDate(event.endTime)])].join(' – '):
  Number.isFinite(event.startTime)?formatDate(event.startTime):event.gameDate?formatDate(`${event.gameDate}T12:00:00`):'';
const objectives = [['score','Score'],['unitScore','Unit Score'],['holomemLb','Holomem Rating'],
  ['event','Event Song Score'],['eventPoints','Event Points']];
const steps = [['build','Build'],['target','Target'],['lineup','Lineup'],['boards','Boards'],['run','Run & results']];
const modeDescriptions = {
  best:['star','Find your strongest lineup'],
  holomem:['check-circle','Start with cards you pick'],
  next:['plus','Compare new cards and Blooms'],
};
const boardBonusGroups = [
  ['Holowork','workrewardquantityuppermilup','holowork',true],
  ['Holomem skill','livedeckleaderactiveskilladdition','holomemSkill',true],
  ['Holomem skill upgrade','livedeckleaderactiveskilllevelup','holomemSkillUp',true],
  ['Member EXP up','liverewardcardexpquantityuppermilup',['memberExp','leaderExp']],
  ['Hologold up','liverewardquantityuppermilup',['memberGold','leaderGold']],
  ['Minigame reward up','minigamerewardquantityuppermilup','minigame'],
];
const boardBonusLabels = {
  memberExp:'Green branch',leaderExp:'Red branch',memberGold:'Green branch',leaderGold:'Red branch',
  cube:'Cube drop rate',lesson:'Lesson Pt drop rate',training:'Training item drop rate',
  judgement_enhance:'GOOD becomes PERFECT',life_recovery:'LIFE recovery',
  jump_rope:'Hoppin’ Rope',circuit:'Mega Circuit',cooking_puzzle:'Collect Cooking',combo_card_game:'Pokajan!',
  chase:'Shadowbound Chase',splash_ball:'Splash Ball',
};
const objectiveDescriptions = {
  score:['flag','Aim for the highest score on a chart or across songs.'],
  event:['calendar','Build around an event’s song score bonus.'],
  eventPoints:['beaker','Get more event points per play.'],
  holomemLb:['star','Find the best songs and teams for one Holomem.'],
  unitScore:['star','Maximize team power and skill bonuses without choosing a song.'],
};
const boardChoices = [['imported','Use current Boards'],['saved','Use saved Board plans'],['optimize','Optimize Boards'],['none','Ignore Boards']];
const boardDescriptions = {
  imported:'Keep your unlocks and Connect cards.',
  saved:'Use your saved Board plans alongside imported Boards.',
  optimize:'Preview new unlocks and Connect changes.',
  none:'Search without Board effects.',
};
const pools = [['owned','My owned cards'],['ownedCustom','Owned cards, custom level and Bloom'],
  ['allMaxed','All cards, maxed'],['allCustom','All cards, custom level and Bloom']];
const poolHints={
  owned:'Use your saved Level and Bloom.',
  ownedCustom:'Set training assumptions for your owned cards.',
  allMaxed:'Use every card at its maximum Level, SP, and Bloom.',
  allCustom:'Set training assumptions for every card.',
};
const plannedPools=[['owned','My planned cards'],['ownedCustom','Planned cards, custom level and Bloom'],...pools.slice(2)];
const colors = [['red','leader'],['blue','card'],['yellow','content'],['green','allmember']];
const boardItems = colors.flatMap(([color,branch])=>['Cube','Hexa'].map((kind,index)=>({
  id:`item-skill_tree_${branch}-${index+1}`,key:color+kind,label:`${capitalize(color)} ${kind}`,
})));
const boardRosterGroups=accountRosterBranches.flatMap(branch=>branch.generations);
const boardRosterOrder=new Map(boardRosterGroups.flatMap((group,index)=>
  group.characters.map((member,order)=>[member.id,{group,index,order}])));
const breakdownLabels = {
  parameters:'Member Parameter',board:'Holomem Board Bonus',passive:'Passive Skill',memory:'Memory Bonus',
  powerUp:'Member Power-Up Bonus',leader:'Outfit',active:'Active',special:'Special Support',songBonus:'Board Singer Bonus',eventBonus:'Event Bonus',
};
const count = value => Number.isFinite(value) ? formatNumber(Math.round(value)) : '—';
const percent = value => `${value<0?'':'+'}${formatNumber(value/10,{minimumFractionDigits:1,maximumFractionDigits:1})}%`;
const contains = (text,query) => String(text).toLocaleLowerCase().includes(query);
function capitalize(text){return text.charAt(0).toUpperCase()+text.slice(1);}
const chartName = chart => `${capitalize(chart.difficulty)}${chart.difficultyLevel==null?'':` · Lv. ${chart.difficultyLevel}`}`;
const memberId = cardId => accountManifest.cardParameterProfiles[cardId]?.characterId;
const clone = data => data == null ? undefined : JSON.parse(JSON.stringify(data));
const optimizerArt = '/assets/team-optimizer/';
const jacket = id => `${optimizerArt}jackets/${id}.webp`;
const jacketUpdates = optimizerArt+'jacket-updates/';
async function loadJacketUpdates(){
  return fetch(jacketUpdates+'index.json',{cache:'no-store'}).then(response=>response.ok?response.json():null)
    .catch(()=>null);
}
const memberIcon = id => `/assets/members/${id.slice(4)}.webp`;
let previewLanePack;
function previewLanes(chart){
  if(!chart?.key||!chart.events?.officialHash)return null;
  if(chart.events.lanes?.length===chart.events.times.length)return Promise.resolve(chart.events.lanes);
  previewLanePack??=Promise.all([
    fetch(optimizerArt+'optimizer-preview-lanes.json').then(response=>response.ok?response.json():null),
    fetch(optimizerArt+'optimizer-preview-lanes.bin').then(response=>response.ok?response.arrayBuffer():null),
  ]).catch(()=>[]);
  return previewLanePack.then(([index,buffer])=>{
    const row=index?.[chart.key];
    if(!row||!buffer)return null;
    const [offset,length,hash]=row;
    return hash===chart.events.officialHash&&length===chart.events.times.length&&offset+length<=buffer.byteLength?
      new Uint8Array(buffer,offset,length):null;
  });
}

/** Team search and planning inside the captured Seelie shell. */
export function createTeamOptimizer({h,vnode,resolve,Search,Dialog,Toggle,headingClass,titleClass}) {
  const OutfitPreview=createOutfitPreview(h);
  const Board = createHolomemBoard({h,vnode,Search,Dialog});
  const BoardPlanView={props:{view:Function},data:()=>({open:false,expanded:{},editing:{},
    selected:{},connectOverrides:{},pending:false,message:'',error:''}),
    render(){return this.view(this);}};
  const TeamDetailsView={props:{view:Function,report:Object},data:()=>({
    unit:'overall',distribution:'stats',histogramBin:null,histogramExpanded:false,continueOpen:false,continueSeconds:10,
    timelineCursor:null,skillWindow:null,
  }),
    render(){return this.view(this,this.report);}};
  const SkillCropView={
    props:{artwork:Object,crop:Object,onArtworkError:Function},
    data(){return {view:this.crop.view,pointers:new Map()};},
    methods:{
      changeView(svg,from,to,scale=1){
        const matrix=svg.getScreenCTM()?.inverse();
        if(!matrix)return;
        const a=new DOMPoint(from.x,from.y).matrixTransform(matrix);
        const b=new DOMPoint(to.x,to.y).matrixTransform(matrix);
        const current=this.view,limit=this.crop.view;
        const ratio=Math.min(limit.width/current.width,Math.max(limit.width/(8*current.width),scale));
        const width=current.width*ratio,height=current.height*ratio;
        const x=a.x-(b.x-current.x)*ratio;
        const y=a.y-(b.y-current.y)*ratio;
        this.view={x:Math.max(limit.x,Math.min(limit.x+limit.width-width,x)),
          y:Math.max(limit.y,Math.min(limit.y+limit.height-height,y)),width,height};
      },
      pointerDown(event){
        if(event.button!==0||this.pointers.size>=2)return;
        event.currentTarget.setPointerCapture(event.pointerId);
        this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      },
      pointerMove(event){
        if(!this.pointers.has(event.pointerId))return;
        const previous=this.pointers.get(event.pointerId),next={x:event.clientX,y:event.clientY};
        this.pointers.set(event.pointerId,next);
        if(this.pointers.size===1){
          this.changeView(event.currentTarget,previous,next);
        }else{
          const fixed=[...this.pointers].find(([id])=>id!==event.pointerId)[1];
          const before=Math.hypot(previous.x-fixed.x,previous.y-fixed.y);
          const after=Math.hypot(next.x-fixed.x,next.y-fixed.y);
          if(before>0&&after>0)this.changeView(event.currentTarget,
            {x:(previous.x+fixed.x)/2,y:(previous.y+fixed.y)/2},
            {x:(next.x+fixed.x)/2,y:(next.y+fixed.y)/2},before/after);
        }
      },
    },
    render(){
      const viewBox=({x,y,width,height})=>[x,y,width,height].join(' ');
      return h('svg',{class:'holo-team-chart-window-art',viewBox:viewBox(this.view),
        role:'img','aria-label':'Selected skill window',
        onWheel:event=>{
          if(!event.cancelable)return;
          event.preventDefault();
          const anchor={x:event.clientX,y:event.clientY};
          this.changeView(event.currentTarget,anchor,anchor,event.deltaY<0 ? .85 : 1/.85);
        },onPointerdown:this.pointerDown,onPointermove:this.pointerMove,
        onLostpointercapture:event=>this.pointers.delete(event.pointerId)},[
        h('svg',{...this.crop.artwork,viewBox:viewBox(this.crop.artwork),overflow:'hidden'},[
          h('image',{href:this.artwork.url,width:this.artwork.layout.totalW,height:this.artwork.layout.totalH,
            onError:this.onArtworkError}),
        ]),
        h('path',{d:this.crop.shading,fill:'rgba(20, 22, 28, .62)','fill-rule':'evenodd'}),
      ]);
    },
  };
  const ChartDetailsView={props:{view:Function,chart:Object},data:()=>({
    chartSpan:30,chartStart:0,chartDrag:null,hiddenSkills:[],targetScore:'',chance:5,selectedOverlay:null,
    lanes:null,artwork:null,trackUrl:null,trackStatus:'loading',trackTime:0,trackDuration:0,trackPlaying:false,
    follow:localStorage.getItem('holodori.previewChartFollow')==='true',trackVolume:.75,trackRate:1,trackLoop:false,
    hitTypes:defaultHitSoundTypes,hitType:localStorage.getItem('holodori.previewChartHitType')??'type1',
    hitVolume:Math.min(1,Math.max(0,Number(localStorage.getItem('holodori.previewChartHitVolume')??1)||0)),hitUnavailable:false,
  }),
    watch:{chart:{immediate:true,async handler(chart){
      if(this.chart?.key!==this.laneChartKey||this.chart?.events?.officialHash!==this.laneChartHash){
        this.lanes=null;
        this.laneChartKey=chart?.key;
        this.laneChartHash=chart?.events?.officialHash;
        const lanes=await previewLanes(chart);
        if(this.chart?.key===chart?.key&&this.chart?.events?.officialHash===chart?.events?.officialHash)this.lanes=lanes;
      }
    }}},
    mounted(){
      const chartKey=this.chart.key;
      const lifetime=new AbortController();
      this.trackLifetime=lifetime;
      void previewHitSoundTypes().then(types=>{
        if(lifetime.signal.aborted||!types.length)return;
        this.hitTypes=types;
        if(!types.includes(this.hitType))this.setHitType(types[0]);
      });
      if(this.hitVolume>0){
        void preloadPreviewHitSounds(this.hitType);
        this.hitEvents=loadChartHitEvents(this.chart);
      }
      void this.useChartArtwork();
      const songId=this.chart.key.split('_')[0];
      previewSoundtrack(songId,lifetime.signal).then(track=>{
        this.useSoundtrack(track);
      }).catch(()=>{if(!lifetime.signal.aborted)this.trackStatus='unavailable';});
    },
    beforeUnmount(){
      this.trackLifetime?.abort();
      this.disposeHitPlayback();
      this.$refs.soundtrack?.pause();
      cancelAnimationFrame(this.trackFrame);
      this.trackRelease?.();
      this.artwork?.release?.();
    },
    methods:{
      async useChartArtwork(forceGame=false){
        if(forceGame&&this.artwork?.release)return;
        if(forceGame)this.artwork=null;
        const chart=this.chart;
        const signal=this.trackLifetime.signal;
        let artwork=forceGame?null:await loadChartArtwork(chart.key);
        if(signal.aborted)return;
        if(!artwork&&chart.events?.previewGeometry){
          try{
            const {renderGameChartArtwork}=await import('./optimizer-game-chart-artwork.js');
            if(!signal.aborted)artwork=renderGameChartArtwork(chart);
          }catch{/* The lane viewer still uses the verified event times. */}
        }
        if(signal.aborted){artwork?.release?.();return;}
        this.artwork?.release?.();
        this.artwork=artwork;
      },
      onArtworkError(){
        if(this.artwork?.release){this.artwork.release();this.artwork=null;}
        else if(this.artwork)void this.useChartArtwork(true);
      },
      useSoundtrack(track){
        if(this.trackLifetime.signal.aborted){track?.release?.();return;}
        this.disposeHitPlayback();
        this.$refs.soundtrack?.pause();
        this.trackRelease?.();
        this.trackRelease=track?.release;
        this.trackUrl=track?.url??null;
        this.trackTime=0;
        this.trackDuration=0;
        this.trackStatus=track?'ready':'unavailable';
      },
      disposeHitPlayback(){
        hitPlayback.get(this)?.dispose();
        hitPlayback.delete(this);
        this.hitUnavailable=false;
      },
      startHitPlayback(){
        const audio=this.$refs.soundtrack;
        if(!audio||!this.hitVolume)return;
        let playback=hitPlayback.get(this);
        if(!playback){
          playback=createPreviewHitPlayback(audio,this.hitEvents??=loadChartHitEvents(this.chart),{
            type:this.hitType,volume:this.hitVolume,onUnavailable:value=>{this.hitUnavailable=value;},
          });
          if(playback)hitPlayback.set(this,playback);
        }
        playback?.unlock();
      },
      setHitVolume(value){
        this.hitVolume=value;
        localStorage.setItem('holodori.previewChartHitVolume',String(value));
        hitPlayback.get(this)?.setVolume(value);
        if(this.trackPlaying&&value)this.startHitPlayback();
      },
      setHitType(value){
        this.hitType=value;
        localStorage.setItem('holodori.previewChartHitType',value);
        const playback=hitPlayback.get(this);
        if(playback)void playback.setType(value);
        else if(this.hitVolume>0)void preloadPreviewHitSounds(value);
      },
      async addSoundtrack(event){
        const file=event.target.files?.[0];
        event.target.value='';
        if(!file)return;
        this.trackStatus='loading';
        try{
          this.useSoundtrack(await rememberPreviewSoundtrack(this.chart.key.split('_')[0],file));
        }catch(error){
          if(!this.trackLifetime.signal.aborted){
            this.trackStatus='error';
            this.trackError=error.message;
          }
        }
      },
      updatePlayhead(){
        const audio=this.$refs.soundtrack;
        if(!audio)return;
        this.trackTime=audio.currentTime;
        if(this.follow && !this.chartDrag){
          const span=Math.min(this.chartSpan,this.chart.seconds);
          const next=Math.min(this.chart.seconds,audio.currentTime);
          this.chartStart=Math.max(0,Math.min(this.chart.seconds-span,next-span/2));
        }
      },
      setFollow(value){
        this.follow=value;
        localStorage.setItem('holodori.previewChartFollow',String(value));
        if(value){
          if(this.chartSpan>=this.chart.seconds)this.chartSpan=Math.min(15,this.chart.seconds);
          this.updatePlayhead();
        }
      },
      onPlaybackStart(){
        this.trackPlaying=true;
        cancelAnimationFrame(this.trackFrame);
        let last=0;
        const tick=now=>{
          if(now-last>=66){last=now;this.updatePlayhead();}
          this.trackFrame=requestAnimationFrame(tick);
        };
        this.trackFrame=requestAnimationFrame(tick);
      },
      onPlaybackStop(){
        this.trackPlaying=false;
        cancelAnimationFrame(this.trackFrame);
        this.updatePlayhead();
      },
      toggleSoundtrack(){
        const audio=this.$refs.soundtrack;
        if(!audio)return;
        if(audio.paused){
          this.startHitPlayback();
          audio.play().catch(error=>{
            if(this.$refs.soundtrack!==audio||error.name==='AbortError')return;
            this.trackError='The local soundtrack could not play.';
            this.trackStatus='error';
          });
        }
        else audio.pause();
      },
      seekSoundtrack(seconds){
        const audio=this.$refs.soundtrack;
        if(!audio||!Number.isFinite(audio.duration))return;
        audio.currentTime=Math.max(0,Math.min(audio.duration,seconds));
        this.updatePlayhead();
      },
    },
    render(){return this.view(this);}};
  const icon = (name,className='holo-encore-icon') => vnode(resolve(name+'-icon'),{class:className,'aria-hidden':'true'});
  const button = (label,onClick,options={}) => h('button',{type:'button',class:action,onClick,...options},label);
  const details = (label,body) => h('details',{class:'holo-team-disclosure'},[
    h('summary',{class:'font-semibold'},label),h('div',{class:'holo-team-disclosure-body'},body),
  ]);
  const image = (src,className,width,height) => h('img',{src,class:className,alt:'',width,height,
    loading:'lazy',decoding:'async',draggable:false,
    onError:event=>{event.currentTarget.style.visibility='hidden';},
    onLoad:event=>{event.currentTarget.style.visibility='';}});
  const EventBanner={
    props:{bundled:String,hash:String,eventId:String,releaseId:String,width:Number,height:Number},
    data(){return {cached:null};},
    computed:{bannerKey(){return this.bundled??this.hash??(this.releaseId?this.releaseId+':'+this.eventId:null);}},
    watch:{bannerKey:{immediate:true,async handler(key){
      this.cached=null;
      if(!key||this.bundled)return;
      const desktop=window.__holodoriDesktop;
      const url=this.hash?await desktop?.optimizerEventBanner?.(this.hash):null;
      const cached=url??(this.releaseId?await desktop?.optimizerGameEventBanner?.(this.eventId,this.releaseId):null);
      if(this.bannerKey===key)this.cached=cached;
    }}},
    render(){
      const source=this.cached??this.bundled;
      return source?image(source,null,this.width,this.height):null;
    },
  };

  return {
    name:'HolodoriTeamOptimizer',
    props:{profileKey:String},
    data(){
      const workspace=optimizerWorkspaceCatalog();
      return {
        ...loadOptimizerPreferences(localStorage,this.profileKey||window.__seelieApp?.account||'main'),
        catalog:workspace?.catalog??null,optimizerSource:workspace?.source??null,ratingExtraSongs:[],updatedJackets:null,
        picker:null,pickerVisible:false,query:'',previewCard:null,outfitPreviewId:null,outfitDraftTraining:{},outfitMedia:{},outfitStageReady:false,searching:false,progress:null,result:null,error:'',
        previewTeam:null,reviewDetails:null,detailRequest:0,previewChartKey:'',previewPc:false,previewSection:null,
        previewSlot:null,previewQuery:'',planTeam:null,planError:'',
        savedLineups:[],savedLineupId:null,lineupNameDraft:null,lineupDeleting:false,lineupError:'',lineupScore:null,lineupScoring:false,resultContext:null,
        lineupValueEdit:null,activeStep:'build',visitedSteps:['build'],resultsChanged:false,eventClock:Date.now(),eventTimer:null,eventPage:0,
        catalogRefreshPending:false,catalogLoading:false,searchBackend:null,gpuError:false,gachaError:'',
      };
    },
    computed:{
      useGpu(){return window.__seelieApp?.settings?.optimizer_use_gpu===true;},
      profileId(){return this.profileKey||window.__seelieApp?.account||'main';},
      profile(){return window.__seelieApp?.data?.[`${this.profileId}-holodori`];},
      snapshot(){return this.profile?.gameAccountImport?.snapshot;},
      ownedCostumeIds(){
        return this.snapshot?.tables.costumes?.map(row=>row.costumeId)??this.profile?.account?.ownedCostumeIds??[];
      },
      savedLineup(){return this.savedLineups.find(row=>row.id===this.savedLineupId);},
      missingLineupCards(){return this.savedLineup?this.savedLineup.cardIds.filter(id=>!this.ownedById.has(id)):[];},
      canRecalculateLineup(){
        const pool=this.savedLineup?.cardAssumptions?.cardPool;
        return !!this.savedLineup&&(!!this.ownedCards.length||!!this.savedLineup.plannedCards||pool==='allCustom'||pool==='allMaxed');
      },
      teamPlan(){
        if(!this.planTeam||this.planTeam.profile!==this.profileId)return null;
        const app=window.__seelieApp,account=this.profileId;
        const field=key=>app.data[`${account}-${key}`];
        return previewTeamPlan(this.planTeam.team,{account,$root:{data:app.data},
          goals:field('goals'),inventory:field('inventory'),inactive:field('inactive'),custom_items:field('custom_items')});
      },
      passport(){
        return this.passportOverride ?? window.__seelieApp?.data?.[`${this.profileId}-boosts`]?.holoPassport ??
          this.profile?.boosts?.holoPassport ?? false;
      },
      currentBoardLayouts(){return currentBoards(this.profile);},
      hasBoards(){return !!Object.keys(this.currentBoardLayouts).length;},
      hasSavedBoards(){return !!Object.keys(this.profile?.savedBoards??{}).length;},
      members(){
        const account = this.profile?.account;
        return (account?.unlockedCharacterIds??[]).map(characterId=>({characterId,level:currentMemberRank(this.profile,characterId)}));
      },
      ownedCards(){return currentOwnedCards(this.profile,window.__seelieApp?.data?.[`${this.profileId}-goals`]);},
      gachaPoints(){return currentGachaPoints(this.profile);},
      upgradeBonus(){return currentUpgradeBonus(this.profile,this.ownedCards);},
      ownedById(){return new Map(this.ownedCards.map(card=>[card.cardId,card]));},
      plannedCards(){
        const data=window.__seelieApp?.data;
        return plannedOptimizerCards(data?.[this.profileId+'-goals']??[],data?.[this.profileId+'-inactive']??{},
          this.ownedById,this.catalog?.cardDetails??{});
      },
      rosterCards(){return this.rosterSource==='planned'?this.plannedCards:this.ownedCards;},
      rosterById(){return new Map(this.rosterCards.map(card=>[card.cardId,card]));},
      poolKey(){return this.rosterSource==='planned'?'plannedPool':'pool';},
      effectivePool(){return this[this.poolKey];},
      useOwned(){return this.effectivePool.startsWith('owned');},
      customPool(){return this.effectivePool.endsWith('Custom');},
      powerUpData(){return this.catalog?{powerUpLadder:this.catalog.powerUpLadder,
        cards:Object.entries(this.catalog.cardDetails).map(([id,card])=>({id,...card}))}:null;},
      powerUpChoices(){
        const data=this.powerUpData;
        if(!data)return [['auto','Automatic']];
        const owned=Object.fromEntries(this.rosterCards.map(card=>[card.cardId,{owned:true,level:card.level,bloom:card.potentialUpgradeCount}]));
        const input={goal:this.mode,cardPool:this.effectivePool,customLevel:this.customLevel,customBloom:this.customBloom,
          noDelevel:this.keepHigherLevel,noDebloom:this.keepHigherBloom,
          upgradeBonusPermyriad:this.rosterSource==='owned'?this.upgradeBonus:undefined,
          outfitAssumption:this.activeOutfitAssumption};
        const imported=referencePowerUpOverride(data,owned,input);
        const automatic=imported!==undefined?`${input.outfitAssumption?'Search roster':'Current'} · ${powerUpLabel(imported)}`:this.mode==='next'?'Search roster':
          `Search roster · ${powerUpLabel(referencePowerUpBonus(referenceSearchRoster(data,owned,input),data,'owned'))}`;
        return [['auto',automatic],...optimizerPowerUpPresets.map(([id,label])=>[id,
          `${label} · ${powerUpLabel(referencePowerUpOverride(data,owned,{...input,powerUpPreset:id}))}`])];
      },
      candidates(){
        const outfitCard=this.activeOutfitAssumption?.cardId;
        return (this.catalog?.supportedCardIds ?? []).filter(id=>!this.useOwned||this.rosterById.has(id)||id===outfitCard);
      },
      candidateMembers(){return new Set(this.candidates.map(id=>this.cardMember(id)));},
      lockedMembers(){return new Set(this.lockedCardIds.map(id=>this.cardMember(id)));},
      supportedObjectives(){return new Set(this.catalog?.objectives ?? ['score']);},
      availableEvents(){
        return (this.catalog?.events ?? []).filter(event=>event.metadataOnly||(this.objective==='eventPoints' ? event.points :
          this.releasedSongs.some(song=>(event.scoringSongIds??event.songIds).includes(song.id))));
      },
      event(){return this.availableEvents.find(event=>event.id===this.eventId)??defaultEvent(this.availableEvents.filter(event=>!event.metadataOnly),this.eventClock)??this.availableEvents[0];},
      eventChapters(){return this.event?.chapters??[];},
      defaultChapter(){return automaticChapter(this.eventChapters,this.eventClock)?.number;},
      currentChapter(){
        return (this.eventChapterEventId===this.event?.id&&this.eventChapters.some(chapter=>chapter.number===this.eventChapter)?
          this.eventChapter:this.defaultChapter);
      },
      eventPageCount(){return Math.max(1,Math.ceil(this.availableEvents.length/10));},
      eventPageIndex(){return Math.min(this.eventPage,this.eventPageCount-1);},
      visibleEvents(){return this.availableEvents.slice(this.eventPageIndex*10,(this.eventPageIndex+1)*10);},
      eventMode(){return this.objective==='event' || this.objective==='eventPoints';},
      ratingMode(){return this.objective==='holomemLb';},
      unitMode(){return this.objective==='unitScore';},
      activeLeaderId(){return this.ratingMode?this.ratingCharacterId:this.leaderCharacterId;},
      activeOutfitId(){return this.ratingMode?this.ratingOutfitId:this.outfitId;},
      activeOutfitTraining(){return this.ratingMode?this.ratingOutfitTraining:this.outfitTraining;},
      activeOutfitAssumption(){
        const outfit=this.availableOutfits.find(outfit=>outfit.id===this.activeOutfitId);
        if(this.activeLeaderMode!=='fixed'||!this.isAssumableOutfit(outfit))return null;
        return this.outfitScenario(outfit,this.activeOutfitTraining);
      },
      activeLeaderMode(){return this.ratingMode?this.ratingLeaderMode:this.leaderMode;},
      pickerInvitedOnly(){return this.ratingMode?this.ratingInvitedOnly:this.leaderPickerInvitedOnly;},
      automaticInvitedOnly(){return !this.ratingMode&&!this.allLeaders&&!this.activeLeaderId;},
      songs(){return this.catalog?.songs??[];},
      releasedSongs(){return this.songs.filter(song=>(song.startTime??0)<=this.eventClock&&song.charts.some(chart=>chart.seconds>0));},
      eventSongs(){
        if(this.objective!=='event')return this.releasedSongs;
        const byId=new Map(this.releasedSongs.map(song=>[song.id,song]));
        return (this.event?.scoringSongIds??this.event?.songIds??[]).map(id=>byId.get(id)).filter(Boolean);
      },
      eventSong(){
        if(!this.eventMode)return undefined;
        const songId=this.objective==='event'?this.eventScoreSongId:this.eventPointsSongId;
        return this.eventSongs.find(song=>song.id===songId)??(this.objective==='event'?this.eventSongs[0]:undefined);
      },
      visibleEventSongs(){return this.eventSongs.filter(song=>contains(song.title,this.queryText));},
      selectedChartKey(){return this.objective==='event'?this.eventScoreChartKey:this.objective==='eventPoints'?this.eventPointsChartKey:this.chartKey;},
      eventSongCharts(){return this.eventSong?.charts.filter(chart=>chart.seconds>0)??[];},
      chart(){
        const songs=this.eventMode?(this.eventSong?[this.eventSong]:[]):this.songs;
        for(const song of songs){
          const chart = song.charts.find(chart=>chart.key===this.selectedChartKey&&(!this.eventMode||chart.seconds>0));
          if(chart)return {...chart,songId:song.id,title:song.title};
        }
        return null;
      },
      difficultyBounds(){
        const levels = this.songs.flatMap(song=>song.charts.filter(chart=>chart.seconds>0).map(chart=>chart.difficultyLevel)).filter(Number.isFinite);
        return levels.length ? [Math.min(...levels),Math.max(...levels)] : [1,30];
      },
      lowerDifficulty(){return this.diffMin ?? this.difficultyBounds[0];},
      upperDifficulty(){return this.diffMax ?? this.difficultyBounds[1];},
      rangeCharts(){
        return this.songs.reduce((total,song)=>total+song.charts.filter(chart=>chart.seconds>0 &&
          (!this.pc||!chart.gameOnly||chart.pcEstimate)&&
          (this.difficultyMode==='types' ? this.difficultyTypes.includes(chart.difficulty) :
            chart.difficultyLevel>=this.lowerDifficulty && chart.difficultyLevel<=this.upperDifficulty)).length,0);
      },
      queryText(){return this.query.trim().toLocaleLowerCase();},
      ratingDifficulty(){return this.ratingMaxDifficulty ?? this.difficultyBounds[1];},
      ratingSongs(){
        const now=Date.now();
        return this.songs.filter(song=>song.rateTarget!==false && (song.startTime??0)<=now &&
          song.characterIds?.includes(this.ratingCharacterId) && (song.singerType==='SOLO'||song.singerType==='GROUP'&&song.characterIds.length>1));
      },
      automaticSongs(){
        const imported=new Set(this.snapshot?.tables.songs?.filter(row=>Number(row.releasedTime)<=this.eventClock).map(row=>row.musicId));
        const quest=this.profile?.account?.storyProgress;
        const questStep=quest ? quest.chapter*1000+quest.episode : 0;
        const invited=new Set(this.members.map(row=>row.characterId));
        return new Set(this.songs.filter(({id,unlock})=>imported.has(id)||unlock && (unlock.autoGiven||
          unlock.mainQuestUnlock && questStep>=unlock.mainQuestUnlock[0]*1000+unlock.mainQuestUnlock[1] ||
          invited.has(unlock.holomemUnlock))).map(song=>song.id));
      },
      ratingSongIds(){return [...new Set([...this.automaticSongs,...this.ratingExtraSongs])];},
      visibleRatingSongs(){return this.ratingSongs.filter(song=>contains(song.title,this.queryText));},
      hasRatingChart(){
        const owned=new Set(this.ratingSongIds);
        return this.ratingSongs.some(song=>(this.ratingAllSongs||owned.has(song.id))&&
          song.charts.some(chart=>chart.seconds>0&&chart.difficultyLevel<=this.ratingDifficulty));
      },
      visibleSongs(){
        const words = this.queryText.split(/\s+/);
        return this.songs.map(song=>({
          ...song,charts:song.charts.filter(chart=>words.every(word=>contains(`${song.title} ${chartName(chart)}`,word))),
        })).filter(song=>song.charts.length);
      },
      visibleCards(){
        return this.candidates.map(id=>({id,row:this.rosterById.get(id),card:this.optimizerCard(id)})).filter(({id,row,card})=>
          contains([this.cardName(id),card?.memberName ?? row?.memberName ?? this.catalog.cardDetails?.[id]?.member,id].filter(Boolean).join(' '),this.queryText));
      },
      optimizerGameCards(){return new Map((this.optimizerSource?.gameCatalog?.cards??[]).map(card=>[card.id,card]));},
      availableLeaders(){return this.catalog?.leaders??[];},
      invitedLeaderIds(){return new Set(this.members.map(member=>member.characterId));},
      visibleLeaders(){return this.availableLeaders.filter(leader=>(!this.pickerInvitedOnly||this.invitedLeaderIds.has(leader.id))&&
        contains(leader.name,this.queryText));},
      availableOutfits(){
        const outfits=(this.catalog?.costumes??[]).filter(outfit=>outfit.characterId===this.activeLeaderId);
        const standardFive=outfits.find(outfit=>outfit.isDefault)?.id.replace('-nrml-','-uniq-');
        const order=outfit=>outfit.isDefault?0:outfit.rarity===4?1:outfit.id===standardFive?2:3;
        return outfits.sort((a,b)=>order(a)-order(b));
      },
      visibleOutfits(){return this.availableOutfits.filter(outfit=>contains(outfit.name,this.queryText));},
      previewOutfit(){return this.visibleOutfits.find(outfit=>outfit.id===this.outfitPreviewId)??this.visibleOutfits[0];},
      previewOutfitTraining(){
        const id=this.previewOutfit?.id;
        return this.outfitDraftTraining[id]??(id===this.activeOutfitId?this.activeOutfitTraining:null);
      },
      effectiveBoards(){return this.boardMode==='imported'&&!this.hasBoards||this.boardMode==='saved'&&!this.hasSavedBoards||
        this.boardMode==='optimize'&&this.catalog?.boardOptimization===false?'none':this.boardMode;},
      protectedBoardSetup(){
        if(this.effectiveBoards!=='optimize'||!Object.keys(this.boardProtection).length)return null;
        try{
          return protectedSavedBoards(this.currentBoardLayouts,this.profile?.savedBoards??{},this.boardProtection);
        }catch(error){return {error:error.message};}
      },
      boardStock(){
        const inventory=window.__seelieApp?.data?.[`${this.profileId}-inventory`];
        const quantity=key=>Array.isArray(inventory)?game.getInventory.call({inventory},key,key):
          this.profile?.inventory?.[key]??0;
        return {...Object.fromEntries(boardItems.map(item=>[item.key,this.boardMaterials[item.id]??quantity(item.key)])),
          hologold:quantity('hologold')};
      },
      boardBudget(){
        if(this.effectiveBoards!=='optimize')return null;
        const imported=this.currentBoardLayouts;
        const limits={stock:this.boardStock,maxResets:this.boardMaxResets,infiniteMaterials:this.boardUnlimited};
        const refundResets=!(this.boardIgnoreExisting&&this.boardNoRefund);
        const protectedPlans=this.protectedBoardSetup?.plans??{};
        const flexible=Object.entries(imported).filter(([owner])=>!Object.hasOwn(this.boardProtection,owner));
        try{
          const reserved=boardBill(imported,protectedPlans,refundResets);
          const cleared=this.boardIgnoreExisting?Object.fromEntries(flexible.map(([owner])=>[owner,{nodes:[],cards:{}}])):{};
          const startingBill=this.boardIgnoreExisting?boardBill(imported,{...protectedPlans,...cleared},refundResets):reserved;
          const ceiling=this.boardIgnoreExisting?0:flexible.reduce((total,[,board])=>total+board.nodes.length,0);
          return {imported,protectedPlans,limits,refundResets,reserved,startingBill,
            quote:quoteBoardBudget(startingBill,limits),maxResets:optimizerResetLimit(startingBill.resets,ceiling,limits)};
        }catch(error){return {error:error.message};}
      },
      boardOpt(){
        if(this.effectiveBoards!=='optimize')return undefined;
        const budget=this.boardBudget;
        if(!budget?.quote)return undefined;
        const materials=Object.fromEntries(boardItems.map(item=>[item.id,budget.quote.remaining[item.key]??0]));
        // The full-reset refund is already in the shared starting balance.
        return {ignoreExisting:this.boardIgnoreExisting,noRefund:this.boardIgnoreExisting,
          maxResets:budget.maxResets,infiniteMaterials:this.boardUnlimited,materials,maxBoardPoints:this.boardMaxPoints,
          allInvited:this.boardAllInvited,branches:[...this.boardBranches],keep:{targets:{...this.boardKeep}},
          ...(Object.keys(this.boardProtection).length?{protection:{...this.boardProtection},objective:this.objective}:{})};
      },
      needsChart(){return this.eventMode;},
      searchBlocker(){
        const rosterReady = this.mode==='next' ? this.candidates.length>0 : this.candidateMembers.size>=5;
        if(!this.supportedObjectives.has(this.objective))return ['target','Choose an available objective.'];
        if(this.protectedBoardSetup?.error)return ['boards',this.protectedBoardSetup.error];
        if(this.boardBudget?.error)return ['boards',this.boardBudget.error];
        if(this.boardBudget?.quote&&!this.boardBudget.quote.fits)return ['boards','The starting Boards exceed the shared budget. Check the shortfall in Boards.'];
        if(this.unitMode&&this.mode==='next')return ['build','Choose Best team or Build around cards for Unit Score.'];
        if(this.mode==='next'&&!this.useOwned){
          const outfit=this.activeOutfitAssumption;
          const hasBloomUpgrade=this.nextBlooms&&this.candidates.some(id=>{
            const max=this.catalog.cardDetails[id]?.maxBloom??0;
            const assumedBloom=id===outfit?.cardId?outfit.bloom:this.customPool?this.customBloom:null;
            return (assumedBloom??max)<max;
          });
          if(!hasBloomUpgrade)return ['lineup',this.customPool?
            'Choose a lower assumed Bloom and enable Bloom upgrades to find upgrades in this pool.':
            'The all-maxed pool has no upgrades available.'];
        }
        if(this.eventMode&&!this.event)return ['target','Choose an event.'];
        if(this.eventMode&&this.event.metadataOnly)return ['target','Scoring rules for this event are unavailable.'];
        if(this.eventMode&&!this.eventSong)return ['target',this.objective==='event'?'No playable event songs are available.':'Choose a song for Event Points.'];
        if(this.eventMode&&!this.chart)return ['target','Choose a difficulty for this song.'];
        if(!this.ratingMode&&!this.unitMode&&this.selectedChartKey&&!this.chart)return ['target','The selected chart is unavailable. Choose a chart or use Any song.'];
        if(!this.ratingMode&&!this.unitMode&&this.pc&&this.chart?.gameOnly&&!this.chart.pcEstimate)return ['target','Choose Mobile to score this chart.'];
        if(this.ratingMode&&!this.activeLeaderId)return ['target','Choose a Holomem for Rating.'];
        if(this.ratingMode&&!this.hasRatingChart)return ['target','Adjust song access or the maximum difficulty to include a chart.'];
        if(!this.ratingMode&&!this.unitMode&&!this.chart&&(this.needsChart||this.rangeCharts===0))return ['target','Choose a chart or an available difficulty range.'];
        if(!rosterReady)return ['lineup',this.useOwned&&this.rosterSource==='planned'?'Add more active cards to Planner or choose another card pool.':this.useOwned&&!this.ownedCards.length?'Mark cards as owned in Characters, import your account, or choose another card pool.':
          this.mode==='next'?'Add owned cards to find your next upgrade.':'Choose a card pool with five different Holomems.'];
        if(this.mode==='holomem'&&!this.lockedCardIds.length)return ['lineup','Lock at least one card.'];
        if(this.automaticInvitedOnly&&!this.availableLeaders.some(leader=>this.invitedLeaderIds.has(leader.id)))
          return ['lineup','Unlock members in Progress, choose a leader, or allow all Holomems.'];
        return null;
      },
      canSearch(){return !this.searching&&!this.catalogLoading&&!this.searchBlocker;},
    },
    watch:{
      searching(active){if(!active&&this.catalogRefreshPending)this.refreshOptimizerCatalog();},
      profile(next,previous){if(!next&&previous)this.clearResult();},
      snapshot(){this.reconcile();this.inputsChanged();this.clearLineupScore();},
      'profile.account'(next,previous){if(next!==previous){this.reconcile();this.inputsChanged();this.clearLineupScore();}},
      'profile.boardEdits'(){this.inputsChanged();this.clearLineupScore();},
      'profile.cardOwnership'(){this.reconcile();this.inputsChanged();this.clearLineupScore();},
      'profile.gachaPointEdits'(){this.inputsChanged();},
      passport(){if(this.resultContext?.objective==='eventPoints')this.inputsChanged();},
      useGpu(){this.inputsChanged();},
    },
    mounted(){
      this.savedLineups=window.__holodoriDesktop.getSavedLineups(this.profileId);
      void this.refreshJackets();
      this.reconcile();
      this.ratingExtraSongs=loadExtraSongs(localStorage,this.profileId);
      this.eventTimer=setInterval(()=>{
        this.eventClock=Date.now();
        if(this.catalog?.nextSongRelease<=this.eventClock)this.refreshOptimizerCatalog();
      },60_000);
      window.addEventListener('holodori-optimizer-catalog-updated',this.refreshOptimizerCatalog);
    },
    beforeUnmount(){
      clearInterval(this.eventTimer);
      window.removeEventListener('holodori-optimizer-catalog-updated',this.refreshOptimizerCatalog);
      this.stopWorker();
      this.clearLineupScore();
    },
    deactivated(){if(this.pickerVisible)this.closePicker();},
    methods:{
      async refreshJackets(){
        this.updatedJackets=await loadJacketUpdates()??this.updatedJackets;
      },
      refreshOptimizerCatalog(){
        void this.refreshJackets();
        if(this.searching||this.pickerVisible||this.catalogLoading){this.catalogRefreshPending=true;return;}
        this.catalogRefreshPending=false;
        this.loadCatalog();
      },
      async loadCatalog(){
        this.catalogLoading=true;
        try{
          const {catalog,source}=await prepareOptimizerWorkspace();
          this.catalog=catalog;
          this.optimizerSource=source;
          this.reconcile();
          if(!this.searching)this.error='';
        }catch(error){
          if(!this.catalog)this.error=error.message;
        }finally{
          this.catalogLoading=false;
          if(this.catalogRefreshPending)this.refreshOptimizerCatalog();
        }
      },
      goToStep(step,focus=false){
        this.lineupValueEdit=null;
        this.activeStep=step;
        if(step&&!this.visitedSteps.includes(step))this.visitedSteps=[...this.visitedSteps,step];
        if(focus&&step)this.$nextTick(()=>{
          const trigger=this.$refs['encore-'+step];
          trigger?.focus({preventScroll:true});
          trigger?.scrollIntoView({block:'nearest'});
        });
      },
      showResults(){
        this.$refs.encoreResults?.scrollIntoView({block:'start'});
        this.$refs.encoreResults?.focus({preventScroll:true});
      },
      openWorker(){
        const current = workers.get(this);
        if(current)return current;
        try{
          const worker = new Worker(workerUrl,{type:'module'});
          workers.set(this,worker);
          worker.onmessage = ({data})=>{
            if(workers.get(this)!==worker)return;
            if(data.type==='review-details' && data.request===this.detailRequest)this.reviewDetails=data;
            if(data.type==='progress' && this.searching)this.progress = data;
            if(data.type==='search-backend'&&this.searching)this.searchBackend=data.backend;
            if(data.type==='result' && this.searching){
              this.result = data;
              this.searching = false;
              this.stopSearchWorkers();
            }
            if(data.type==='error'&&this.searching){
              this.error=data.message;
              this.gpuError=data.code==='gpu';
              this.stopWorker();
            }
          };
          worker.onerror = worker.onmessageerror = ()=>{
            if(workers.get(this)!==worker)return;
            this.error = 'Team search could not start. Try again.';
            this.stopWorker();
          };
          return worker;
        }catch{
          this.error = 'Team search could not start. Try again.';
          this.stopWorker();
          return null;
        }
      },
      stopWorker(){
        this.stopSearchWorkers();
        workers.get(this)?.terminate();
        workers.delete(this);
        this.searching = false;
        this.progress = null;
        this.searchBackend = null;
      },
      stopSearchWorkers(){
        for(const {worker,port} of searchWorkers.get(this)??[]){worker.terminate();port.close();}
        searchWorkers.delete(this);
      },
      createSearchPorts(useBoardWorkers, gpuBoards=false){
        const pool=[];
        const ports=[];
        searchWorkers.set(this,pool);
        try{
          const cores=Math.min(16,Math.max(1,(navigator.hardwareConcurrency||4)-1));
          const memory=navigator.deviceMemory;
          const count=gpuBoards?Math.min(2,cores):useBoardWorkers ? (memory===undefined?Math.min(8,cores):memory<=2?1:memory<=4?Math.min(2,cores):cores) : Math.min(4,cores);
          for(let index=0;index<count;index++){
            const worker=new Worker(workerUrl,{type:'module'});
            const {port1,port2}=new MessageChannel();
            pool.push({worker,port:port1});
            ports.push(port2);
            let failed=false;
            const reportFailure=()=>port1.postMessage({type:'worker-error',message:'A solver worker stopped unexpectedly.'});
            port1.onmessage=({data})=>failed?reportFailure():worker.postMessage(data);
            worker.onmessage=({data})=>port1.postMessage(data);
            worker.onerror=worker.onmessageerror=()=>{failed=true;reportFailure();};
          }
          return ports;
        }catch{
          this.stopSearchWorkers();
          for(const port of ports)port.close();
          return [];
        }
      },
      clearResult(){
        if(this.searching)this.stopWorker();
        this.result = null;
        this.resultContext = null;
        this.resultsChanged=false;
        this.searchBackend = null;
        this.gpuError = false;

        this.detailRequest++;
        if(this.catalog)this.error = '';
      },
      inputsChanged(){
        if(this.result||this.searching)this.resultsChanged=true;
        if(this.catalog&&!this.searching){this.error='';this.gpuError=false;}
      },
      updateGachaBalance(point,event){
        const input=event.target;
        this.gachaError='';
        try{window.__holodoriDesktop.setGachaPoints(this.profileId,point,input.value.trim()?parseNumber(input.value):null);}
        catch(error){this.gachaError=error.message;}
        const amount=this.gachaPoints[point];
        input.value=amount==null?'':formatNumber(BigInt(amount));
      },
      reconcile(){
        if(!this.catalog)return;
        if(this.activeLeaderId && !this.availableLeaders.some(leader=>leader.id===this.activeLeaderId)){
          this[this.ratingMode?'ratingCharacterId':'leaderCharacterId'] = '';
          this[this.ratingMode?'ratingOutfitId':'outfitId'] = null;
          this[this.ratingMode?'ratingOutfitTraining':'outfitTraining'] = null;
          this[this.ratingMode?'ratingLeaderMode':'leaderMode'] = 'auto';
        }
        const eligible = new Set(this.candidates);
        this.lockedCardIds = this.lockedCardIds.filter(id=>eligible.has(id));
        if(this.activeOutfitId && !this.availableOutfits.some(outfit=>outfit.id===this.activeOutfitId&&this.canSelectOutfit(outfit))){
          this[this.ratingMode?'ratingOutfitId':'outfitId'] = null;
          this[this.ratingMode?'ratingOutfitTraining':'outfitTraining'] = null;
          this[this.ratingMode?'ratingLeaderMode':'leaderMode'] = 'auto';
        }
      },
      change(key,value){
        if(this[key]===value&&(key!=='eventChapter'||value===null||this.eventChapterEventId===this.event?.id))return;
        const previous=this[key];
        const previousEvent=key==='eventId'?this.event?.id:undefined;
        this[key] = value;
        if(key==='boardMaxResets'&&value!==null)this.boardResetLimit=value;
        if(key==='mode' && value!=='holomem'){
          if(this.leaderMode==='holomem')this.leaderMode='auto';
          if(this.ratingLeaderMode==='holomem')this.ratingLeaderMode='auto';
        }
        if(key==='eventId'&&previousEvent!==this.event?.id){
          this.eventChapter=null;
          this.eventChapterEventId='';
          this.eventScoreSongId='';
          this.eventScoreChartKey='';
        }
        if(key==='eventChapter')this.eventChapterEventId=value===null?'':this.event?.id??'';
        if(key==='objective'&&value!=='unitScore'&&previous!=='unitScore'){
          this.diffMin = null;
          this.diffMax = null;
        }
        if(['mode','pool','plannedPool','objective','rosterSource'].includes(key))this.reconcile();
        this.saveOptions();
        if(key==='leaderPickerInvitedOnly'||key==='ratingInvitedOnly')return;
        this.inputsChanged();
      },
      saveOptions(){saveOptimizerPreferences(localStorage,this.profileId,this);},
      protectBoard(owner,mode){
        if((this.boardProtection[owner]??'flexible')===mode)return;
        const next={...this.boardProtection};
        if(mode==='flexible')delete next[owner];else next[owner]=mode;
        this.change('boardProtection',next);
      },
      openPicker(picker){
        if(picker==='outfit'&&this.picker==='outfit'&&this.pickerVisible)return;
        this.query='';this.eventPage=0;this.picker=picker;this.pickerVisible=true;
        if(picker==='outfit'){
          void loadOutfitPreviews().then(media=>{this.outfitMedia=media;});
          this.outfitPreviewId=this.activeOutfitId??this.availableOutfits.find(outfit=>outfit.isDefault)?.id??null;
          this.outfitDraftTraining={};
          this.outfitStageReady=false;
          // Paint the dialog shell before decoding the atlas and starting WebGL.
          this.$nextTick(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
            if(this.picker==='outfit'&&this.pickerVisible)this.outfitStageReady=true;
          })));
        }
      },
      moveOutfitPreview(direction,focusRow=false){
        const outfits=this.visibleOutfits;
        if(outfits.length<2)return;
        const index=outfits.indexOf(this.previewOutfit);
        this.outfitPreviewId=outfits[(index+direction+outfits.length)%outfits.length].id;
        this.$nextTick(()=>this.revealOutfitPreview(focusRow));
      },
      revealOutfitPreview(focusRow=false){
        const list=this.$refs.outfitList;
        const row=list?.querySelector('[aria-pressed="true"]');
        if(!row)return;
        if(focusRow)row.focus({preventScroll:true});
        const bounds=list.getBoundingClientRect();
        const item=row.getBoundingClientRect();
        if(item.top<bounds.top)list.scrollTop+=item.top-bounds.top;
        else if(item.bottom>bounds.bottom)list.scrollTop+=item.bottom-bounds.bottom;
      },
      startOutfitSwipe(event){
        if(event.button!==0||!event.isPrimary||this.visibleOutfits.length<2)return;
        outfitSwipes.set(event.currentTarget,{id:event.pointerId,x:event.clientX,y:event.clientY});
      },
      trackOutfitSwipe(event){
        const stage=event.currentTarget;
        const swipe=outfitSwipes.get(stage);
        if(!swipe||swipe.id!==event.pointerId||stage.hasPointerCapture(swipe.id))return;
        const x=Math.abs(event.clientX-swipe.x),y=Math.abs(event.clientY-swipe.y);
        if(x>=10&&x>y){
          stage.setPointerCapture(swipe.id);
          stage.dataset.swiping='';
        }
      },
      finishOutfitSwipe(event){
        const stage=event.currentTarget;
        const swipe=outfitSwipes.get(stage);
        if(!swipe||swipe.id!==event.pointerId)return;
        if(event.type==='pointerleave'&&stage.hasPointerCapture(swipe.id))return;
        if(event.type==='lostpointercapture'&&event.target!==stage)return;
        outfitSwipes.delete(stage);
        delete stage.dataset.swiping;
        if(event.type!=='pointerup')return;
        const x=event.clientX-swipe.x,y=event.clientY-swipe.y;
        if(Math.abs(x)>=32&&Math.abs(x)>Math.abs(y))this.moveOutfitPreview(x<0?1:-1);
      },
      chooseEventSong(id){
        const prefix=this.objective==='event'?'eventScore':'eventPoints';
        if(id!==this.eventSong?.id||!id){
          this[`${prefix}SongId`]=id;
          this.change(`${prefix}ChartKey`,'');
          this.saveOptions();
          this.inputsChanged();
        }
        this.closePicker();
      },
      chooseScoringChart(key,chart){
        if(chart.gameOnly&&!chart.pcEstimate&&this.pc)this.change('pc',false);
        this.change(key,chart.key);
      },
      focusPickerSearch(){
        this.$nextTick(()=>{
          if(!this.pickerVisible)return;
          const search=this.$refs.pickerSearch;
          const input=search?.querySelector('input');
          input?.setAttribute('autofocus','');
          input?.focus({preventScroll:true});
          if(this.picker==='outfit')this.revealOutfitPreview();
        });
      },
      cancelPreviewSimulation(){
        workers.get(this)?.postMessage({type:'review-details-simulate',request:this.detailRequest,action:'cancel'});
      },
      closePicker(){
        if(this.picker==='team')this.cancelPreviewSimulation();
        this.pickerVisible=false;this.detailRequest++;this.clearLineupScore();
      },
      openTeam(team,group){
        this.previewTeam=clone(team);
        this.previewSection=null;
        this.previewSlot=null;
        this.previewPc=!!this.resultContext?.pc;
        const chart=group??(team.scoringCharts?.length===1?team.scoringCharts[0]:null)??this.resultContext?.charts?.[0]??
          (team.ratingSongs?.length===1?team.ratingSongs[0]:null);
        this.previewChartKey=chart?.key??(chart?.songId?chart.songId+'_'+chart.difficulty:'');
        this.openPicker('team');
        this.refreshTeamPreview();
      },
      refreshTeamPreview(){
        this.cancelPreviewSimulation();
        this.reviewDetails=null;
        const request=++this.detailRequest;
        if(this.previewTeam?.cardIds.length!==5||this.previewTeam.cardIds.some(id=>!id)||!this.previewTeam.leaderChar||!this.previewTeam.outfitId)return;
        workers.get(this)?.postMessage({
          type:'review-details',stream:true,request,team:clone(this.previewTeam),
          chartKey:this.previewChartKey||null,pc:this.previewPc,
        });
      },
      runPreviewSimulation(action,seconds){
        workers.get(this)?.postMessage({type:'review-details-simulate',request:this.detailRequest,action,durationMs:seconds*1000});
      },
      stopPreviewSimulation(){
        workers.get(this)?.postMessage({type:'review-details-simulate',request:this.detailRequest,action:'stop'});
      },
      patchPreviewTeam(values){
        Object.assign(this.previewTeam,values);
        this.refreshTeamPreview();
      },
      patchPreviewCard(index,id,training){
        const team=this.previewTeam;
        const cardIds=[...team.cardIds],lineup=[...team.lineup];
        if(id!==cardIds[index]){
          cardIds[index]=id;
          const owned=this.ownedById.get(id),master=this.catalog.cardDetails[id];
          lineup[index]={level:owned?.level??master?.maxLevel??1,bloom:owned?.potentialUpgradeCount??0};
        }else lineup[index]={...lineup[index],...training};
        this.patchPreviewTeam({cardIds,lineup});
      },
      changePreviewOutfit(id){
        const outfit=this.catalog.costumes.find(row=>row.id===id);
        this.patchPreviewTeam({outfitId:id||null,outfitName:outfit?.name,outfitDescription:outfit?.description});
      },
      sendPreviewToOptimizer(mode){
        const cards=this.previewTeam.cardIds.filter(Boolean);
        if(!cards.length)return;
        this.closePicker();
        this.change('mode',mode);
        const limit=mode==='next'?4:5;
        const selected=cards.slice(0,limit);
        if(selected.some(id=>!this.candidates.includes(id))){
          if(this.rosterSource==='planned')this.change('rosterSource','owned');
          this.change('pool','allCustom');
        }
        this.change('lockedCardIds',selected.filter(id=>this.candidates.includes(id)));
        this.goToStep('lineup',true);
      },
      writeLineups(rows){
        if(!window.__holodoriDesktop.saveLineups(this.profileId,rows)){
          this.lineupError='Could not save lineups. Finish any open Settings action and try again.';
          return false;
        }
        this.savedLineups=rows;
        this.lineupError='';
        return true;
      },
      resultLineup(team,group){
        const setup=this.resultContext;
        if(!setup)return null;
        const charts=team.scoringCharts??(team.ratingSongs?.length?team.ratingSongs:group?[group]:setup.charts);
        const boards=setup.boardMode==='none'?{}:team.plan?.saves??team.boards??setup.boards;
        return {...setup,outfitAssumption:setup.outfitAssumption?.outfitId===team.outfitId?setup.outfitAssumption:undefined,
          cardIds:team.cardIds,lineup:team.lineup,leaderChar:team.leaderChar,
          outfitId:team.outfitId??null,boards,boardRanks:team.plan?.ranks,charts:charts.map(({songId,difficulty})=>({songId,difficulty}))};
      },
      saveResultLineup(team,group,overrides){
        const result=this.resultLineup(team,group);
        if(!result)return;
        const setup={...result,...overrides};
        const {charts}=setup;
        const song=charts.length===1?this.catalog.songs.find(song=>song.id===charts[0].songId):null;
        const base=(song?.title||team.leaderName||'New')+' lineup';
        const names=new Set(this.savedLineups.map(row=>row.name));
        let number=1,name=base.slice(0,80);
        while(names.has(name)){
          const suffix=` ${++number}`;
          name=base.slice(0,80-suffix.length)+suffix;
        }
        const row=savedLineupSchema.safeParse({...setup,id:crypto.randomUUID(),name});
        if(!row.success){this.error='This result is missing information needed to save its lineup.';return;}
        if(this.writeLineups([row.data,...this.savedLineups])){
          if(this.picker==='team'){this.cancelPreviewSimulation();this.detailRequest++;}
          this.openSavedLineup(row.data.id);
        }
        else this.error=this.lineupError;
      },
      openSavedLineup(id){
        this.clearLineupScore();
        this.savedLineupId=id;
        this.lineupNameDraft=null;
        this.lineupDeleting=false;
        this.lineupError='';
        this.openPicker(id?'saved-lineup':'saved-lineups');
        this.$nextTick(()=>this.$refs.savedLineupBack?.focus({preventScroll:true}));
      },
      renameLineup(){
        const name=this.lineupNameDraft?.trim();
        if(!name||!this.savedLineup)return;
        if(this.writeLineups(this.savedLineups.map(row=>row.id===this.savedLineupId?{...row,name}:row)))this.lineupNameDraft=null;
      },
      deleteLineup(){
        if(this.writeLineups(this.savedLineups.filter(row=>row.id!==this.savedLineupId)))this.openSavedLineup(null);
      },
      clearLineupScore(){
        lineupWorkers.get(this)?.terminate();
        lineupWorkers.delete(this);
        this.lineupScoring=false;
        this.lineupScore=null;
      },
      async recalculateLineup(){
        if(!this.canRecalculateLineup||this.lineupScoring)return;
        this.clearLineupScore();
        this.lineupError='';
        this.lineupScoring=true;
        const finish=(worker,score,error)=>{
          if(lineupWorkers.get(this)!==worker)return;
          this.clearLineupScore();
          this.lineupScore=score??null;
          this.lineupError=error??'';
        };
        try{
          const worker=new Worker(workerUrl,{type:'module'});
          lineupWorkers.set(this,worker);
          worker.onmessage=({data})=>{if(data.type==='lineup-score')finish(worker,data.score,data.error);};
          worker.onerror=()=>finish(worker,null,'Could not recalculate this lineup.');
          const holoPassport=window.__seelieApp?.data?.[`${this.profileId}-boosts`]?.holoPassport??this.profile?.boosts?.holoPassport??false;
          const message={type:'score-lineup',lineup:clone(this.savedLineup),
            input:{...this.accountScoreInput(),liveBoost:this.savedLineup.liveBoost,holoPassport}};
          message.source=await window.__holodoriDesktop.optimizerCatalogSource(clone(this.optimizerSource)??null);
          if(lineupWorkers.get(this)===worker)worker.postMessage(message);
        }catch{
          this.clearLineupScore();
          this.lineupError='Could not recalculate this lineup.';
        }
      },
      openTeamPlan(team){
        window.__holodoriDesktop.flushEdits();
        this.planTeam={profile:this.profileId,team};
        this.planError='';
        this.openPicker('plan-team');
      },
      addTeamPlan(){
        const desktop=window.__holodoriDesktop;
        desktop.flushEdits();
        const plan=this.teamPlan;
        if(!plan?.changed)return;
        if(!desktop.saveTeamGoals(this.planTeam.profile,plan.goals)){
          this.planError='Could not add goals. Finish any open Settings action and try again.';
          return;
        }
        this.closePicker();
        this.$router.push('/planner');
      },
      boardPlanPreview(team,change,base,overrides){
        let previews=boardPreviews.get(team);
        if(!previews){previews=new Map();boardPreviews.set(team,previews);}
        const cached=previews.get(change.owner);
        if(cached&&cached.base===base&&cached.overrides===overrides)return cached.preview;
        const picks=change.picks;
        const {board,points}=projectBoardSelection(change.owner,base,picks,picks.map(pick=>pick.key),change.ptsBudget);
        const oldCards=base?.cards??{};
        const slots=Object.keys(board.cards);
        const connects=new Set(change.connects.map(row=>row.socket));
        const cards=slots.map(slot=>({cardId:board.cards[slot],
          potentialUpgradeCount:team.boardCards?.[board.cards[slot]]??this.resultContext?.connectPool?.[board.cards[slot]]??null}));
        const members=[{characterId:change.owner,level:team.plan.ranks?.[change.owner]??null}];
        const boards=[{characterId:change.owner,releasedSkillTreeNodeGroupIds:board.nodes,
          connectedSkillTreeNodeGroupIds:slots,connectedSkillTreeNodeCardIds:slots.map(slot=>board.cards[slot])}];
        const preview={snapshot:{tables:{boards,members,cards},progress:{dreamRank:this.resultContext?.boardDreamRank}},
          added:new Set(picks.filter(pick=>pick.kind==='buy').map(pick=>pick.id)),
          removed:new Set(picks.filter(pick=>pick.kind==='reset').map(pick=>pick.id)),connects,oldCards,
          available:points===null?null:change.ptsBudget-points};
        previews.set(change.owner,{base,overrides,preview});
        return preview;
      },
      finishPicker(){if(!this.pickerVisible){
        this.picker=null;this.previewCard=null;this.previewTeam=null;this.reviewDetails=null;this.planTeam=null;
        if(this.catalogRefreshPending)this.refreshOptimizerCatalog();
      }},
      searchPicker(query){
        if(query===this.query)return;
        this.query=query;
        const list=this.$refs.pickerList;
        if(list)list.scrollTop=0;
        const outfits=this.$refs.outfitList;
        if(outfits)outfits.scrollTop=0;
      },
      choose(key,value){this.change(key,value);this.closePicker();},
      chooseLeader(id,close=true){
        const key=this.ratingMode?'ratingCharacterId':'leaderCharacterId';
        if(id!==this[key]){
          this[this.ratingMode?'ratingOutfitId':'outfitId'] = null;
          this[this.ratingMode?'ratingOutfitTraining':'outfitTraining'] = null;
          this[this.ratingMode?'ratingLeaderMode':'leaderMode'] = 'auto';
        }
        this.change(key,id);
        this.reconcile();
        this.saveOptions();
        if(close)this.closePicker();
      },
      chooseOutfit(id,mode='fixed',close=true){
        const outfit=id&&this.availableOutfits.find(outfit=>outfit.id===id);
        if(id&&!this.canSelectOutfit(outfit))return;
        this[this.ratingMode?'ratingOutfitTraining':'outfitTraining']=this.isAssumableOutfit(outfit)?this.previewOutfitTraining:null;
        this[this.ratingMode?'ratingOutfitId':'outfitId'] = id;
        this.change(this.ratingMode?'ratingLeaderMode':'leaderMode',mode);
        this.reconcile();
        this.saveOptions();
        this.inputsChanged();
        if(close)this.closePicker();
      },
      canSelectOutfit(outfit){
        return !!outfit&&(!this.useOwned||this.ownsOutfit(outfit)||this.isAssumableOutfit(outfit));
      },
      ownsOutfit(outfit){
        return !!outfit&&(outfit.isDefault||this.rosterById.has(outfit.cardId)||this.ownedCostumeIds.includes(outfit.id));
      },
      isAssumableOutfit(outfit){
        return !!outfit?.cardId&&!this.ownsOutfit(outfit)&&!!this.catalog?.cardDetails?.[outfit.cardId];
      },
      outfitScenario(outfit,training){
        return {outfitId:outfit.id,cardId:outfit.cardId,...this.assumedTraining(outfit.cardId,training)};
      },
      assumedTraining(cardId,training){
        const {maxLevel,maxBloom}=this.catalog.cardDetails[cardId];
        const pool=this.effectivePool;
        const level=pool==='allMaxed'?maxLevel:pool==='allCustom'?this.customLevel??maxLevel:pool==='ownedCustom'?this.customLevel??1:1;
        const bloom=pool==='allMaxed'?maxBloom:pool==='allCustom'?this.customBloom??maxBloom:pool==='ownedCustom'?this.customBloom??0:0;
        return {level:Math.min(training?.level??level,maxLevel),bloom:Math.min(training?.bloom??bloom,maxBloom)};
      },
      setOutfitTraining(key,value){
        const id=this.previewOutfit?.id;
        if(!id)return;
        const values={...this.previewOutfitTraining,[key]:value};
        this.outfitDraftTraining={...this.outfitDraftTraining,[id]:values};
      },
      toggleRatingSong(id){
        const songs=this.ratingExtraSongs;
        const next=songs.includes(id)?songs.filter(song=>song!==id):[...songs,id];
        this.setExtraSongs(next);
      },
      setExtraSongs(next){
        this.change('ratingExtraSongs',next);
        saveExtraSongs(localStorage,this.profileId,next);
      },
      resetDifficultyRange(){
        if(this.difficultyMode==='types')this.change('difficultyTypes',difficulties.slice());
        else{
          this.diffMin=null;
          this.change('diffMax',null);
          this.saveOptions();
          this.inputsChanged();
        }
      },
      clearRatingSongs(){
        const shown=new Set(this.ratingSongs.map(song=>song.id));
        this.setExtraSongs(this.ratingExtraSongs.filter(id=>!shown.has(id)));
      },
      setBoardKeep(id,value){
        const targets={...this.boardKeep};
        if(value===undefined)delete targets[id];else targets[id]=value;
        this.change('boardKeep',targets);
      },
      cardMember(id){return this.catalog?.cardDetails?.[id]?.characterId ?? memberId(id) ?? this.ownedById.get(id)?.master?.characterId ?? id;},
      optimizerCard(id){return this.optimizerGameCards.get(id)??game.getCard(id);},
      cardName(id){return this.optimizerCard(id)?.cardName || this.ownedById.get(id)?.cardName || this.catalog?.cardDetails?.[id]?.name || id;},
      toggleCard(id){
        if(this.lockedCardIds.includes(id))this.change('lockedCardIds',this.lockedCardIds.filter(cardId=>cardId!==id));
        else if(this.lockedCardIds.length<5&&!this.lockedMembers.has(this.cardMember(id)))this.change('lockedCardIds',[...this.lockedCardIds,id]);
      },
      accountScoreInput(){
        const account=this.profile?.account;
        const memoryCount=account?.memoriesCollected??0;
        return {cards:this.ownedCards.map(({cardId,level,potentialUpgradeCount,levelLimitBreakCount})=>({cardId,level,potentialUpgradeCount,levelLimitBreakCount})),
          members:clone(this.members),ownedCostumeIds:clone(this.ownedCostumeIds),dreamRank:currentDreamRank(this.profile),memoryCount,
          memoryBonusPermil:account?accountProgressMemoryBonus(account):undefined,
          upgradeBonusPermyriad:this.upgradeBonus};
      },
      async searchTeams(){
        if(!this.canSearch)return;
        this.clearResult();
        const worker = this.openWorker();
        if(!worker)return;
        const plannedCards=this.rosterSource==='planned'?clone(this.plannedCards):undefined;
        const scoring=this.accountScoreInput();
        const chart = this.ratingMode||this.unitMode?null:this.chart;
        const importedBoards=this.snapshot?.tables.boards;
        const imported=this.currentBoardLayouts;
        const boardMode=this.effectiveBoards;
        const protectedSetup=this.protectedBoardSetup;
        const boards=boardMode==='saved'?boardTable(mergeSavedBoards(imported,this.profile.savedBoards)):
          boardTable(protectedSetup?.boards??imported);
        const pc = this.objective!=='holomemLb' && this.pc;
        const options = {
          goal:this.mode,focusCardIds:this.mode==='holomem'?[...this.lockedCardIds]:[],
          leaderMode:this.activeLeaderMode,outfitId:this.activeOutfitId,leaderChar:this.activeLeaderId,
          leaderInvitedOnly:this.automaticInvitedOnly,leaderAllHolomems:!this.ratingMode&&this.allLeaders,
          scoringMode:chart?'chart':'generic',songId:chart?.songId ?? null,difficulty:chart?.difficulty ?? '',
          anyDiffMin:this.difficultyMode==='types'?this.difficultyBounds[0]:this.lowerDifficulty,
          anyDiffMax:this.difficultyMode==='types'?this.difficultyBounds[1]:this.upperDifficulty,pc,cardPool:this.effectivePool,
          ...(this.difficultyMode==='types'&&!chart?{anyDiffTypes:[...this.difficultyTypes]}:{}),
          memories:scoring.memoryCount,topN:this.topN,eventBonus:this.objective==='event',
          eventPoints:this.objective==='eventPoints',sortBy:chart||this.ratingMode?this.sortBy:'avg',
        };
        const outfitAssumption=clone(this.activeOutfitAssumption);
        const scenario={cardPool:this.effectivePool,customLevel:this.customLevel,customBloom:this.customBloom,
          noDelevel:this.keepHigherLevel,noDebloom:this.keepHigherBloom,outfitAssumption};
        const roster=Object.fromEntries((plannedCards??scoring.cards).map(card=>[card.cardId,{
          owned:true,level:card.level,bloom:card.potentialUpgradeCount,
        }]));
        const connectPool=Object.fromEntries(Object.entries(referenceSearchRoster(this.powerUpData,roster,scenario))
          .map(([id,entry])=>[id,entry.bloom]));
        const eventId=this.eventMode?this.event?.id:undefined;
        const eventChapter=this.objective==='eventPoints'?this.currentChapter??undefined:undefined;
        const boardOpt=this.boardOpt;
        const existing={...imported,...this.profile?.savedBoards};
        const boardPlanBase={...existing};
        for(const owner of Object.keys(boardOpt?.protection??{})){
          const protectedBoard=protectedSetup?.boards?.[owner];
          if(protectedBoard)boardPlanBase[owner]=protectedBoard;else delete boardPlanBase[owner];
        }
        this.resultContext={profileId:this.profileId,connectPool,mode:this.mode,nextAcquisition:this.nextAcquisition,
          objective:this.objective,charts:chart?[chart]:[],pc,anyDiffMin:options.anyDiffMin,
          anyDiffMax:options.anyDiffMax,anyDiffTypes:options.anyDiffTypes,sortBy:options.sortBy,eventId,eventChapter,
          ...(this.customPool||this.effectivePool==='allMaxed'?{cardAssumptions:{cardPool:this.effectivePool,
            customLevel:this.customLevel,customBloom:this.customBloom,
            noDelevel:this.keepHigherLevel,noDebloom:this.keepHigherBloom}}:{}),
          ...(this.powerUpPreset!=='auto'?{powerUpPreset:this.powerUpPreset}:{}),
          ...(outfitAssumption?{outfitAssumption}:{}),
          ...(plannedCards?{plannedCards}:{}),
          liveBoost:this.liveBoost,boardMode,boardDreamRank:this.boardOpt?.maxBoardPoints?1_000_000:scoring.dreamRank,
          boardPlanBase,boardPlanExisting:existing,boardPlanSaved:{},boardProtection:boardOpt?.protection,
          boardBudget:boardOpt?clone(this.boardBudget):null,
          boards:boardMode==='none'?{}:boardPlanningBaseline(optimizerBoards(boards),boardOpt)};
        this.progress = null;
        this.searching = true;
        const useBoardWorkers=this.effectiveBoards==='optimize'&&this.mode!=='next';
        const useGpu=this.useGpu;
        const standaloneGpu=useGpu&&!!boardOpt;
        const nextAcquisition=this.mode==='next'&&this.nextAcquisition!=='any'?{
          mode:this.nextAcquisition,at:Date.now(),balances:clone(this.gachaPoints),
        }:undefined;
        const message={type:'search',input:{
          options,objective:this.objective,reviewedMobile:true,eventId,eventChapter,liveBoost:this.liveBoost,outfitAssumption,plannedCards,
          useGpu,
          holoPassport:this.passport,ratingSongCount:this.ratingSongCount,ratingTeamsPerSong:this.ratingTeamsPerSong,
          ratingMaxDifficulty:this.ratingDifficulty,ratingAllSongs:this.ratingAllSongs,ratingMerge:this.ratingMerge,ratingSongIds:this.ratingSongIds,
          chartKey:chart?.key??'',customLevel:this.customLevel,customBloom:this.customBloom,
          noDelevel:this.keepHigherLevel,noDebloom:this.keepHigherBloom,
          ...scoring,boards:clone(boards),savedBoardMode:boardMode==='saved',boardPointBalances:clone(this.snapshot?.tables.boardPoints),
          importedBoards:clone(importedBoards),
          ...(Object.keys(protectedSetup?.plans??{}).length?{
            protectedSavedOwners:Object.keys(protectedSetup.plans),
          }:{}),
          importedMemberRanks:clone(this.snapshot?.tables.members),
          powerUpPreset:this.powerUpPreset,
          lockedCardIds:this.mode==='best'?[]:[...this.lockedCardIds],leaderCharacterId:this.activeLeaderId || undefined,
          useBoards:this.effectiveBoards!=='none',boardOpt,resultLimit:this.topN,
          ...(this.mode==='next' ? {nextDeck:[...this.lockedCardIds],nextEntry:{level:this.nextLevel,bloom:this.nextBloom},
            nextCount:this.nextCount,nextBlooms:this.nextBlooms,nextAcquisition} : {}),
        }};
        try{
          message.source=await window.__holodoriDesktop.optimizerCatalogSource(clone(this.optimizerSource)??null);
          if(nextAcquisition)nextAcquisition.catalog=message.source?.exchangeCatalog;
          if(workers.get(this)!==worker)return;
          worker.postMessage(message,useGpu&&!standaloneGpu?[]:this.createSearchPorts(useBoardWorkers,standaloneGpu));
        }catch{
          if(workers.get(this)!==worker)return;
          this.stopWorker();
          this.error='Team search could not start. Try again.';
        }
      },
    },
    render(){
      const disabled = this.searching;
      const chart = this.ratingMode||this.unitMode?null:this.chart;
      const songJacket = id => {
        const update=this.updatedJackets?.[id];
        return /^m\d{4,6}$/.test(id??'')&&/^[0-9a-f]{32}$/.test(update?.bundleMd5)&&update.name===`${id}-${update.bundleMd5}.webp`?
          jacketUpdates+update.name:this.catalog?.bundledSongIds?.includes(id)?jacket(id):undefined;
      };
      const cardPortrait = id => game.cardImage(id,'vertical') || this.catalog?.gameArtwork?.[id] ||
        (this.catalog?.bundledCardIds?.includes(id)?`${optimizerArt}portraits/${id}.webp`:undefined);
      const leader = this.availableLeaders.find(leader=>leader.id===this.activeLeaderId);
      const outfit = this.availableOutfits.find(outfit=>outfit.id===this.activeOutfitId);
      const clearable = (control,reset,chartControl=false) => {
        if(!reset)return control;
        return h('div',{class:chartControl?'holo-encore-clearable holo-encore-chart-control':'holo-encore-clearable'},[
          control,
          reset.show?button([icon('x')],event=>{
            const field=event.currentTarget.parentElement;
            reset.clear();
            this.$nextTick(()=>field.querySelector('input,select,button')?.focus({preventScroll:true}));
          },{class:'holo-encore-clear rounded bg-gray-700 hover:bg-gray-600',
            'aria-label':reset.label,title:reset.label,disabled}):null,
        ]);
      };
      const field = (label,control,reset,id) => h(reset?'div':'label',{class:'holo-team-field'},[
        label==null?null:h(id?'label':'span',{class:'holo-team-label font-semibold',for:id},label),clearable(control,reset),
      ]);
      const searchChoice = (key,title,value,blocked=false,media) => button([
        media ? image(media,'holo-team-choice-icon',24,24) : null,
        h('span',{class:'holo-team-choice-text',title:value},value),
        icon('chevron-right','holo-team-choice-arrow'),
      ],()=>this.openPicker(key),{
        class:`${action} holo-team-choice`,disabled:disabled || blocked,'aria-haspopup':'dialog','aria-label':title,
      });
      const select = (key,label,options,value=this[key],onChange,reset) => field(label,h('select',{class:inputClass,disabled,'aria-label':label,
        id:reset?`optimizer-${key}`:undefined,
        value,onChange:event=>{
          const selected = options[event.target.selectedIndex];
          if(selected)(onChange ?? (next=>this.change(key,next)))(selected[0]);
        },
      },options.map(([value,label,unavailable])=>h('option',{key:value,value,disabled:unavailable},label))),reset,reset?`optimizer-${key}`:undefined);
      const number = (key,label,min,max,value=this[key],onChange,name=typeof label==='string'?label:undefined,reset) => field(label,h('input',{
        type:'text',inputmode:'numeric',class:inputClass,disabled,value:formatNumber(value),'aria-label':name,title:label!==name?name:undefined,
        id:reset?`optimizer-${key}`:undefined,
        onChange:event=>{
          const raw = event.target.value.trim();
          const parsed = parseNumber(raw);
          const next = raw && Number.isFinite(parsed) ? Math.min(max,Math.max(min,Math.trunc(parsed))) : value;
          event.target.value = formatNumber(next);
          if(onChange)onChange(next);else this.change(key,next);
        },
      }),reset,reset?`optimizer-${key}`:undefined);
      const trainingSelect = (label,min,max,value,onChange) => field(label,h('select',{
        class:inputClass,disabled,'aria-label':label,value,onChange:event=>onChange(Number(event.target.value)),
      },Array.from({length:max-min+1},(_,i)=>h('option',{key:i+min,value:i+min},count(i+min)))));
      const check = (label,checked,onChange,blocked=false) => Toggle ?
        vnode(Toggle,{label,modelValue:checked,small:true,disabled:disabled || blocked,'onUpdate:modelValue':onChange}) :
        h('label',{class:'holo-team-check text-sm'},[
          h('input',{type:'checkbox',checked,disabled:disabled || blocked,onChange:event=>onChange(event.target.checked)}),label,
        ]);
      const flag = (key,label,blocked=false) => check(label,this[key],value=>this.change(key,value),blocked);
      const outfitAssumptionSummary = assumption => assumption?h('p',{class:'holo-outfit-assumption-summary'},[
        icon('star'),h('span',{},`Assume ${this.cardName(assumption.cardId)} · Lv. ${count(assumption.level)} · Bloom ${count(assumption.bloom)}`),
      ]):null;
      const lineupRange = (key,label,min,max,{fallback=min,automatic,format=count}={}) => {
        const stored=this[key];
        const value=stored??fallback;
        const display=stored==null&&automatic?automatic:format(value);
        const ref='lineup-value-'+key;
        const finish=(input,commit,focus)=>{
          if(this.lineupValueEdit!==key)return;
          this.lineupValueEdit=null;
          const raw=input.value.trim();
          const parsed=parseNumber(raw);
          if(commit&&raw&&Number.isFinite(parsed))this.change(key,Math.max(min,Math.min(max,Math.round(parsed))));
          if(focus)this.$nextTick(()=>this.$refs[ref]?.focus({preventScroll:true}));
        };
        return h('div',{class:'holo-lineup-range'},[
          h('span',{class:'holo-team-label font-semibold'},label),
          h('div',{class:'holo-lineup-range-control'},[
            this.lineupValueEdit===key?h('input',{key:'edit',ref,type:'text',inputmode:'numeric',
              class:inputClass+' holo-lineup-value','aria-label':label+' value',value:formatNumber(value),
              onBlur:event=>finish(event.currentTarget,true,false),
              onKeydown:event=>{
                if(event.key!=='Enter'&&event.key!=='Escape')return;
                event.preventDefault();
                event.stopPropagation();
                finish(event.currentTarget,event.key==='Enter',true);
              },
            }):button(display,()=>{
              this.lineupValueEdit=key;
              this.$nextTick(()=>{
                const input=this.$refs[ref];
                input?.focus({preventScroll:true});
                input?.select();
              });
            },{key:'value',ref,disabled,class:action+' holo-lineup-value',
              'aria-label':`Edit ${label} – ${display}`}),
            automatic?button([icon('x')],()=>this.change(key,null),{
              class:'holo-encore-clear rounded bg-gray-700 hover:bg-gray-600',disabled:disabled||stored==null,
              'aria-label':`Reset ${label}`,title:automatic,
            }):null,
            h('input',{type:'range',min,max,value,disabled,'aria-label':label,'aria-valuetext':display,
              style:{'--lineup-progress':100*(value-min)/(max-min)+'%'},
              onChange:event=>this.change(key,Number(event.target.value))}),
          ]),
        ]);
      };
      const lineupAssumptions=()=>[
        h('div',{class:'holo-lineup-assumptions'},[
          lineupRange('customLevel','Assumed Level',1,80,{
            fallback:this.useOwned?1:80,automatic:this.useOwned?'No assumption':'Max',
            format:value=>`Lv. ${count(value)}`,
          }),
          lineupRange('customBloom','Assumed Bloom',0,5,{
            fallback:this.useOwned?0:5,automatic:this.useOwned?'No assumption':'Max',
          }),
        ]),
        this.effectivePool==='ownedCustom'?h('div',{class:'holo-lineup-flags'},[
          flag('keepHigherLevel','Keep higher levels'),
          flag('keepHigherBloom','Keep higher Bloom'),
        ]):null,
      ];
      const nextCardAssumptions=()=>h('div',{class:'holo-lineup-next'},[
        this.useOwned?h('div',{class:'holo-lineup-assumptions'},[
          lineupRange('nextLevel','New card Level',1,80,{fallback:80,automatic:'Max'}),
          lineupRange('nextBloom','New card Bloom',0,5),
        ]):null,
        number('nextCount','Upgrades per team',1,29),
        h('div',{class:'holo-lineup-flags'},[
          flag('nextBlooms','Include Bloom upgrades'),
        ]),
      ]);
      const choices = (key,label,items,unavailable=()=>false,selected=this[key],className='') => h('div',{
        class:`holo-team-options holo-encore-segments ${className}`,role:'group','aria-label':label},
        items.map(([value,name])=>button(name,()=>this.change(key,value),{
          key:value,disabled:disabled || unavailable(value),'aria-pressed':selected===value,
        })));
      const buildChoices = () => h('div',{class:'holo-encore-build-choices',role:'group','aria-label':'Search mode'},
        modes.map(([value,name])=>{
          const [glyph,description]=modeDescriptions[value];
          return button([icon(glyph),h('span',{},[h('strong',{},name),h('small',{},description)]),
            this.mode===value?icon('check','holo-encore-selected'):null],()=>this.change('mode',value),{
            key:value,class:'holo-encore-build-option',
            'aria-label':name,'aria-pressed':this.mode===value,
            disabled:disabled||this.catalog?.goals&&!this.catalog.goals.includes(value),
          });
        }));
      const caption = text => h('p',{class:'text-xs text-gray-400'},text);
      const objectiveChoices = () => h('div',{class:'holo-encore-target'},[
        h('div',{class:'holo-encore-objectives',role:'group','aria-label':'Objective'},objectives.map(([value,name])=>
          button([icon(objectiveDescriptions[value][0]),h('strong',{},name)],()=>this.change('objective',value),{
            key:value,class:'holo-encore-choice holo-encore-objective','aria-pressed':this.objective===value,
            disabled:disabled||!this.supportedObjectives.has(value),
          }))),
        caption(objectiveDescriptions[this.objective]?.[1]),
      ]);
      const portrait = (id,size=32) => image(memberIcon(id),'holo-team-member-icon',size,size);
      const itemIcon = (item,size=22) => image(resourceImage(item.key),'holo-encore-material-icon',size,size);
      const cardFace = (id,entry,isLeader=false)=>{
        const card = this.catalog.cardDetails[id];
        return h('div',{class:'holo-team-face'},[
          image(cardPortrait(id),'holo-team-face-art',192,272),
          card?.rarity ? h('span',{class:'holo-team-face-frame','data-rarity':card.rarity,'aria-hidden':'true'}) : null,
          card?.attributeIcon ? image(`/assets/ui/${card.attributeIcon}.webp`,'holo-team-face-attr',28,28) : null,
          card?.groups.length ? h('div',{class:'holo-team-face-groups'},card.groups.map(group=>h('span',{
            key:group.name,style:{'--group-accent':`#${group.color2}`},
          },group.name))) : null,
          card?.rarity ? h('div',{class:'holo-team-face-stars',role:'img','aria-label':`${card.rarity} stars`},
            Array.from({length:card.rarity},()=>image('/assets/ui/rarity-star.webp','',18,18))) : null,
          entry?.bloom>0 ? h('span',{class:'holo-team-face-bloom','aria-label':`Bloom ${entry.bloom}`},[
            image('/assets/ui/bloom-flower.webp','',24,24),h('span',{},String(entry.bloom)),
          ]) : null,
          Number.isFinite(entry?.level) ? h('span',{class:'holo-team-face-level','aria-label':`Level ${entry.level}`},[
            h('small',{},'Lv'),h('strong',{},String(entry.level)),
          ]) : null,
          isLeader ? h('span',{class:'holo-team-face-leader',title:'Leader','aria-label':'Leader'},'★') : null,
        ]);
      };
      const cardLabels = id=>[
        h('span',{class:'holo-team-card-name',title:this.cardName(id)},this.cardName(id)),
        h('span',{class:'holo-team-card-member text-gray-400',title:this.catalog.cardDetails[id]?.member},this.catalog.cardDetails[id]?.member),
      ];
      const cardTile = ({id,row})=>{
        const selected=this.lockedCardIds;
        const locked = selected.includes(id);
        const outfit=this.activeOutfitAssumption;
        return button([
          cardFace(id,id===outfit?.cardId?outfit:row&&{level:row.level,bloom:row.potentialUpgradeCount}),...cardLabels(id),
        ],()=>this.toggleCard(id),{
          key:id,class:`${action} holo-team-card`,'aria-pressed':locked,
          disabled:!locked && (selected.length===5 || selected.some(card=>this.cardMember(card)===this.cardMember(id))),
        });
      };
      const pickerTitles = {chart:'Choose a chart',event:'Choose an event',eventSong:this.objective==='event'?'Choose an event song':'Choose a song',
        cards:'Lock cards',leader:this.ratingMode?'Choose a Holomem':'Choose a leader',outfit:'Choose an outfit',
        ratingSongs:'Additional unlocked songs',boardProtection:'Protect Boards',
        preview:this.previewCard && this.cardName(this.previewCard.id),
        team:'Preview details','plan-team':'Plan this team',
        'saved-lineups':'Saved lineups','saved-lineup':this.savedLineup?.name??'Saved lineup'};
      const pickerLabels = {chart:'Search songs and difficulty',eventSong:'Search songs',
        cards:'Search cards',leader:this.ratingMode?'Search Holomems':'Search leaders',outfit:'Search outfits',ratingSongs:'Search songs',
        boardProtection:'Search Holomems'};
      const protectedBoards=Object.keys(this.boardProtection).length;
      const protectionChoices=(owner,unavailable=disabled)=>boardProtectionModes.map(([mode,label])=>
        button(label,()=>this.protectBoard(owner,mode),{
          key:mode,'aria-pressed':(this.boardProtection[owner]??'flexible')===mode,disabled:unavailable,
        }));
      const multiSelectPicker = ['cards','ratingSongs','boardProtection'].includes(this.picker);
      const detailPicker = ['team','plan-team','saved-lineups','saved-lineup'].includes(this.picker);
      const pickerContentClass = this.picker==='outfit'?'holo-team-outfit-content':
        this.picker==='preview'?'holo-team-preview-content':
        detailPicker?'holo-team-detail-content':'holo-team-picker-content';
      const pickerClear = (label,clear) => button(label,event=>{
        const done=event.currentTarget.nextElementSibling;
        clear();
        done?.focus({preventScroll:true});
      });
      const pickerOptions = ()=>{
        if(this.picker==='chart')return button('Any song',()=>this.choose('chartKey',''),{'aria-pressed':!chart});
        if(this.picker==='boardProtection')return h('div',{class:'holo-team-picker-actions'},[
          caption('Preserves saved layouts, or imported Boards if no plan is saved. No resets still allows additions.'),
          h('div',{class:'holo-team-options'},[
            protectedBoards?pickerClear('Clear protections',()=>this.change('boardProtection',{})):null,
            button('Done',()=>this.closePicker(),{class:primary}),
          ]),
        ]);
        if(this.picker==='eventSong')return this.objective==='eventPoints'&&this.eventSong?
          button('Clear song',()=>this.chooseEventSong('')):null;
        if(this.picker==='cards')return h('div',{class:'holo-team-picker-actions'},[
          caption(`${this.lockedCardIds.length} / 5 locked · One card per Holomem`),
          h('div',{class:'holo-team-options'},[
            this.lockedCardIds.length?pickerClear('Clear locked cards',()=>this.change('lockedCardIds',[])):null,
            button('Done',()=>this.closePicker(),{class:primary}),
          ]),
        ]);
        if(this.picker==='ratingSongs')return h('div',{class:'holo-team-picker-actions'},[
          caption('Quest and invitation unlocks are included automatically.'),
          h('div',{class:'holo-team-options'},[
            this.ratingSongs.some(song=>this.ratingExtraSongs.includes(song.id))?pickerClear('Clear selections',this.clearRatingSongs):null,
            button('Done',()=>this.closePicker(),{class:primary}),
          ]),
        ]);
        return h('div',{class:'holo-team-options'},[
          check('Invited only',this.pickerInvitedOnly,value=>{
            this.change(this.ratingMode?'ratingInvitedOnly':'leaderPickerInvitedOnly',value);
            if(this.$refs.pickerList)this.$refs.pickerList.scrollTop=0;
          }),
          button(this.ratingMode?'No Holomem':this.allLeaders?'Any leader':'Any invited Holomem',()=>this.chooseLeader(''),
            {'aria-pressed':!this.activeLeaderId}),
        ]);
      };
      const pickerBody = ()=>{
        if(this.picker==='boardProtection'){
          const imported=this.currentBoardLayouts;
          const names=new Map(this.availableLeaders.map(({id,name})=>[id,name]));
          const supported=new Set([...Object.keys(imported),...this.members.map(member=>member.characterId)]);
          const who=[...supported].map(id=>({id,name:names.get(id)??id}))
            .filter(({name})=>contains(name,this.queryText))
            .sort((a,b)=>(boardRosterOrder.get(a.id)?.index??Infinity)-(boardRosterOrder.get(b.id)?.index??Infinity)||
              (boardRosterOrder.get(a.id)?.order??0)-(boardRosterOrder.get(b.id)?.order??0)||a.name.localeCompare(b.name));
          return who.length?who.map(({id,name})=>h('div',{key:id,class:'holo-board-protect-row'},[
            h('span',{class:'holo-encore-fact-person'},[portrait(id,28),name]),
            h('div',{class:'holo-team-options holo-encore-segments',role:'group','aria-label':name},
              protectionChoices(id)),
          ])):caption(this.queryText?'No matching Holomems.':'Record Boards in Progress to protect them.');
        }
        if(this.picker==='eventSong')return [this.visibleEventSongs.length?
          h('div',{class:'holo-team-person-grid'},this.visibleEventSongs.map(song=>button([
            image(songJacket(song.id),'holo-team-jacket',40,40),h('span',{},song.title),
          ],()=>this.chooseEventSong(song.id),{key:song.id,class:`${action} holo-team-person`,'aria-pressed':this.eventSong?.id===song.id}))) :
          caption('No matching songs.')];
        if(this.picker==='ratingSongs')return [
          this.visibleRatingSongs.length ? h('div',{class:'holo-team-person-grid'},this.visibleRatingSongs.map(song=>{
            const automatic=this.automaticSongs.has(song.id);
            return button([image(songJacket(song.id),'holo-team-jacket',36,36),h('span',{},song.title)],()=>this.toggleRatingSong(song.id),{
              key:song.id,class:`${action} holo-team-person`,disabled:automatic,title:automatic?'Automatically unlocked':song.title,
              'aria-pressed':automatic||this.ratingExtraSongs.includes(song.id),
            });
          })) : caption('No matching songs.'),
        ];
        if(this.picker==='chart')return [
          this.visibleSongs.length ? h('div',{class:'holo-team-song-grid'},this.visibleSongs.map(song=>h('div',{key:song.id,class:'holo-team-song bg-gray-700/50 rounded'},[
            image(songJacket(song.id),'holo-team-jacket',52,52),
            h('div',{class:'holo-team-song-info'},[h('h3',{class:'text-sm font-semibold'},song.title),
            h('div',{class:'holo-team-options'},song.charts.map(chart=>button(chartName(chart),()=>{
              this.chooseScoringChart('chartKey',chart);
              this.closePicker();
            },{
              key:chart.key,'aria-label':`${song.title}, ${chartName(chart)}`,
              'aria-pressed':this.chartKey===chart.key,
              class:`${action} holo-team-difficulty`, 'data-difficulty':chart.difficulty,
            }))) ]),
          ]))) : caption('No matching charts.'),
        ];
        if(this.picker==='cards')return [
          this.visibleCards.length ? h('div',{class:'holo-team-card-grid'},this.visibleCards.map(cardTile)) : caption('No matching cards.'),
        ];
        return [
          this.visibleLeaders.length ? h('div',{class:'holo-team-person-grid'},this.visibleLeaders.map(leader=>button([
            portrait(leader.id),h('span',{},leader.name),
          ],()=>this.chooseLeader(leader.id),{
            key:leader.id,class:`${action} holo-team-person`,'aria-pressed':this.activeLeaderId===leader.id,
          }))) : caption(this.pickerInvitedOnly&&!this.queryText?'No invited Holomems. Turn off Invited only to browse all leaders.':'No matching leaders.'),
        ];
      };
      const outfitCarousel=()=>{
        const outfits=this.visibleOutfits, outfit=this.previewOutfit;
        const position=outfits.indexOf(outfit);
        const member=outfit&&this.availableLeaders.find(leader=>leader.id===outfit.characterId)?.name;
        const asset=outfit?.id.slice(4);
        const media=asset&&this.outfitMedia[asset];
        const memberAsset=this.activeLeaderId?.slice(4);
        const room=this.outfitMedia.rooms?.[memberAsset];
        const current=outfit?.id===this.activeOutfitId;
        const selectable=outfit&&this.canSelectOutfit(outfit);
        const assumption=this.isAssumableOutfit(outfit)?this.outfitScenario(outfit,this.previewOutfitTraining):null;
        const assumptions=()=>{
          const {maxLevel,maxBloom}=this.catalog.cardDetails[assumption.cardId];
          return h('div',{class:'holo-outfit-assumptions','aria-label':'Outfit card assumptions',role:'group'},[
            h('div',{class:'holo-outfit-assumption-label'},[
              h('strong',{},'Assume card owned'),
              h('span',{},this.cardName(assumption.cardId)),
            ]),
            trainingSelect('Outfit card Level',1,maxLevel,assumption.level,value=>this.setOutfitTraining('level',value)),
            trainingSelect('Outfit card Bloom',0,maxBloom,assumption.bloom,value=>this.setOutfitTraining('bloom',value)),
          ]);
        };
        const actions=()=>h('div',{class:'holo-outfit-actions'},[
            button('Best owned',()=>this.chooseOutfit(null,'auto'),{'aria-label':'Best the leader owns','aria-pressed':this.activeLeaderMode==='auto'}),
            this.mode==='holomem'?button('From locked cards',()=>this.chooseOutfit(null,'holomem'),
              {class:action,'aria-pressed':this.activeLeaderMode==='holomem'}):null,
            outfit?button(assumption?'Use assumed outfit':current?'Keep outfit':'Select outfit',()=>this.chooseOutfit(outfit.id),{class:primary,disabled:!selectable}):null,
        ]);
        const toolbar=()=>h('div',{class:'holo-outfit-toolbar'},[
            h('div',{ref:'pickerSearch',class:'holo-team-picker-search'},[
              vnode(Search,{label:'Search outfits',clearLabel:'Clear search',search:this.query,'onUpdate:search':this.searchPicker}),
            ]),
        ]);
        return [
          h('div',{class:'holo-outfit-carousel',role:'group','aria-label':'Outfit previews',onKeydown:event=>{
            const row=event.target.closest('.holo-outfit-thumbnail');
            const previous=event.key==='ArrowLeft'||row&&event.key==='ArrowUp';
            const next=event.key==='ArrowRight'||row&&event.key==='ArrowDown';
            if((!previous&&!next)||outfits.length<2)return;
            if(event.target.matches('input, select'))return;
            event.preventDefault();
            this.moveOutfitPreview(previous?-1:1,!!row);
          }},[
            h('div',{class:'holo-outfit-preview'},[h('div',{class:'holo-outfit-stage',role:'group',
              'aria-label':'Live outfit preview','aria-keyshortcuts':'ArrowLeft ArrowRight',
              'data-swipeable':outfits.length>1?'':undefined,tabindex:outfits.length>1?0:undefined,
              onPointerdown:this.startOutfitSwipe,onPointermove:this.trackOutfitSwipe,
              onPointerup:this.finishOutfitSwipe,onPointercancel:this.finishOutfitSwipe,
              onPointerleave:this.finishOutfitSwipe,onLostpointercapture:this.finishOutfitSwipe,
            },[
              room?h('img',{class:'holo-outfit-room',src:room,alt:'',decoding:'async'}):null,
              this.outfitStageReady&&this.pickerVisible&&media?vnode(OutfitPreview,{key:this.outfitMedia.updated?.[asset]??asset,
                asset:this.outfitMedia.updated?.[asset]??asset,costume:asset,updated:!!this.outfitMedia.updated?.[asset],
                atlases:media,reactions:this.outfitMedia.reactions?.[asset]}):null,
            ]),
              outfit?h('div',{class:'holo-outfit-caption','aria-live':'polite'},[
                h('div',{},[member?h('p',{class:'holo-outfit-member'},member):null,
                  h('h3',{},outfit.name)]),
                h('span',{class:'holo-outfit-count','aria-label':`Outfit ${position+1} of ${outfits.length}`},`${count(position+1)} / ${count(outfits.length)}`),
              ]):null,
            ]),
            h('div',{class:'holo-outfit-options'},[
              toolbar(),
              !outfit?h('div',{class:'holo-outfit-empty'},[caption(this.queryText?'No matching outfits.':'Choose a leader to browse outfits.')]):
                h('div',{ref:'outfitList',class:'holo-outfit-thumbnails',role:'group','aria-label':'Jump to outfit'},outfits.map(option=>{
                const id=option.artworkCardId;
                const cardName=id&&this.catalog.cardDetails[id]?.name;
                const unowned=!this.ownsOutfit(option);
                const artwork=(id&&(game.cardImage(id,'landscape')||this.catalog?.gameArtwork?.[id]||cardPortrait(id)))||
                  this.outfitMedia.thumbnails?.[option.id.slice(4)];
                return button([
                  h('span',{class:'holo-outfit-row-art'},artwork?[h('img',{src:artwork,alt:'',decoding:'async'})]:[]),
                  h('span',{class:'holo-outfit-tile-label'},[
                    h('strong',{},option.name),
                    cardName?h('small',{title:cardName},cardName):null,
                  ]),
                  h('span',{class:'holo-outfit-row-status','aria-hidden':'true'},[
                    h('small',{class:'holo-outfit-unowned'},'Unowned'),
                    h('span',{class:'holo-outfit-row-mark'},'✓'),
                  ]),
                ],()=>{this.outfitPreviewId=option.id;},{
                  key:option.id,class:action+' holo-outfit-thumbnail','aria-label':option.name,
                  'data-outfit-unowned':unowned?'true':undefined,
                  'aria-description':unowned?'Unowned':undefined,
                  'aria-pressed':option.id===outfit.id,
                });
              })),
              assumption?assumptions():null,
              actions(),
            ]),
          ]),
        ];
      };
      const eventMeta=event=>{
        const status=eventStatus(event,this.eventClock);
        const dates=[eventDateRange(event),status==='Live'||status==='Upcoming'?status:'',
          event.metadataOnly?'Scoring rules unavailable':''].filter(Boolean).join(' · ');
        return h('span',{class:'holo-encore-event-meta'},[h('strong',{},event.name),dates?h('small',{},dates):null]);
      };
      const eventBanner=(event,className,width,height)=>vnode(EventBanner,{
        bundled:event.art,hash:event.bannerHash,eventId:event.id,releaseId:event.gameReleaseId,class:className,width,height,
      });
      const eventDialog=()=>[
        this.eventId? h('div',{class:'holo-team-options'},[
          button('Use automatic event',()=>this.choose('eventId','')),
        ]):null,
        h('div',{ref:'pickerList',class:'holo-team-picker-list'},[
          h('div',{class:'holo-encore-event-grid'},this.visibleEvents.map(event=>button([
            event.art||event.bannerHash||event.gameReleaseId?eventBanner(event,'holo-encore-event-banner',320,180):null,eventMeta(event),
          ],()=>this.choose('eventId',event.id),{key:event.id,class:`${action} holo-encore-event-card`,
            'aria-pressed':this.event?.id===event.id}))),
        ]),
        this.eventPageCount>1?h('div',{class:'holo-encore-event-pager'},[
          button('Previous',()=>{this.eventPage=this.eventPageIndex-1;this.$refs.pickerList?.scrollTo(0,0);},{disabled:this.eventPageIndex===0}),
          h('span',{class:'text-xs text-gray-300','aria-live':'polite'},`Page ${this.eventPageIndex+1} of ${this.eventPageCount}`),
          button('Next',()=>{this.eventPage=this.eventPageIndex+1;this.$refs.pickerList?.scrollTo(0,0);},{disabled:this.eventPageIndex+1===this.eventPageCount}),
        ]):null,
      ];
      const metric = (label,value) => Number.isFinite(value) ? h('div',{},[
        h('dt',{class:'text-xs text-gray-300'},label),h('dd',{class:'font-semibold'},count(value)),
      ]) : null;
      const summaryMetric = (label,value) => Number.isFinite(value) ? h('span',{class:'holo-team-summary-metric'},[
        h('strong',{class:'font-semibold'},count(value)),h('span',{class:'text-xs text-gray-300'},label),
      ]) : null;
      const breakdown = team => {
        const values = Object.entries(breakdownLabels).filter(([key])=>Number.isFinite(team.breakdown?.[key]));
        return values.length ? h('dl',{class:'holo-team-breakdown'},values.map(([key,label])=>h('div',{key},[
          h('dt',{class:'text-gray-400'},label),h('dd',{class:'font-semibold'},['active','special','songBonus','eventBonus'].includes(key) ?
            percent(team.breakdown[key]) : count(team.breakdown[key])),
        ]))) : null;
      };
      const upgrades = team => {
        const changes=team.pulls??team.upgrades;
        if(!changes?.length)return null;
        const balances=this.snapshot?.balances;
        const observedAt=balances?.gachaPointsObservedAt??this.snapshot?.capturedAt;
        const quoted=quoteCardAcquisitions(changes,this.gachaPoints,this.eventClock,this.optimizerSource?.exchangeCatalog);
        const status=(price,limitReached=false)=>h('span',{
          class:['holo-encore-acquisition-status',price.short==null?'text-gray-400':'',
            !limitReached&&price.short===0n?'holo-encore-acquisition-covered':''],
          title:price.balance==null?'Enter a balance in Lineup or import game data.':
            `${formatNumber(price.balance)} Pt${Object.hasOwn(this.profile?.gachaPointEdits??{},price.point)?' recorded manually':observedAt?' · '+formatDateTime(observedAt):''}`,
        },limitReached?'Exceeds exchange limit':price.short==null?'Balance unknown':
          price.short>0n?`${formatNumber(price.short)} Pt short`:'Points covered');
        return h('div',{class:'holo-encore-acquisition text-xs text-gray-300'},[
          h('ul',{class:'holo-encore-acquisition-list'},quoted.cards.map(({id,isNew,copies,offers},index)=>{
            const character=this.cardMember(id);
            return h('li',{key:`${id}-${index}`,class:'holo-encore-upgrade'},[
              character?portrait(character,20):null,
              h('div',{class:'holo-encore-acquisition-card'},[
                h('span',{},[h('strong',{},this.cardName(id)),` · ${isNew?'New card':`Bloom +${copies}`}`]),
                ...offers.map(offer=>h('div',{key:offer.id,class:'holo-encore-acquisition-offer'},[
                  h('span',{class:'text-gray-400',title:offer.endTime?`Closes ${formatDateTime(offer.endTime)}`:undefined},offer.route),
                  h('span',{class:'holo-encore-acquisition-price',title:`${formatNumber(offer.price)} Pt per copy · Check remaining exchange allowance in game`},
                    `${formatNumber(offer.cost)} ${offer.costLabel}`),
                  status(offer,copies>offer.limit),
                ])),
                offers.length?null:h('span',{class:'text-gray-400'},'No current source verified'),
              ]),
            ]);
          })),
          ...quoted.shared.map(pool=>h('div',{key:pool.point,class:'holo-encore-acquisition-offer holo-encore-acquisition-total'},[
            h('strong',{},`${pool.currency} total`),h('span',{class:'holo-encore-acquisition-price'},`${formatNumber(pool.cost)} Pt`),status(pool),
          ])),
        ]);
      };
      const boardPlan = team => {
        const node=(type,props,children)=>vnode(type,props,Array.isArray(children)?children.filter(child=>child!=null):children);
        const plan=team.plan;
        if(!plan)return null;
        const sort=this.resultContext?.sortBy;
        const objective=this.resultContext?.objective;
        const scoreLabel=objective==='unitScore'?'Unit Score':objective==='holomemLb'?'Holomem Rating':
          objective==='eventPoints'?(sort==='max'?'Maximum event points':'Average event points'):
          sort==='max'?'Estimated maximum score':'Estimated average song score';
        const score=row=>objective==='unitScore'?row?.displayUnitScore:objective==='holomemLb'?row?.rating:
          objective==='eventPoints'?(sort==='max'?row?.eventPointsMax:row?.eventPointsAvg):
          sort==='max'?(row?.reviewedScore?.maximum??row?.maxScore):(row?.reviewedScore?.average??row?.score);
        const before=score(plan.presentationBefore??plan.before),after=score(plan.presentationAfter??plan.after)??score(team);
        const fallbackScore=row=>sort==='max'?(row?.reviewedScore?.maximum??row?.maxScore):(row?.reviewedScore?.average??row?.score);
        const showSongScore=objective==='holomemLb'&&!Number.isFinite(before)||
          objective==='eventPoints'&&!Number.isFinite(before)&&Number.isFinite(plan.before?.reviewedScore?.average);
        const current=showSongScore?fallbackScore(plan.before):before;
        const projected=showSongScore?fallbackScore(plan.after):after;
        const gain=current>0&&Number.isFinite(projected)?1000*(projected-current)/current:null;
        const material=(id,quantity)=>{
          const item=boardItems.find(item=>item.id===id);
          const key=item?.key??(id==='hologold'?'hologold':null);
          const label=item?.label??(key==='hologold'?'Hologold':this.catalog.boardItems?.find(item=>item.id===id)?.name??id);
          return node('span',{class:'holo-team-material',key:id,title:label},[
            key?node('img',{src:resourceImage(key),alt:label,width:18,height:18}):label,count(quantity),
          ]);
        };
        const materials=(label,items)=>{
          const entries=Object.entries(items??{}).filter(([,quantity])=>quantity!==0);
          return entries.length?node('div',{class:'holo-team-board-cost-row'},[
            node('span',{},label),...entries.map(([id,quantity])=>material(id,quantity)),
          ]):null;
        };
        const chip=(label,kind)=>node('span',{class:'holo-team-board-chip','data-plan-change':kind},label);
        const memberName=id=>this.catalog.leaders.find(member=>member.id===id)?.name??id;
        const renderPlan=state=>{
          const header=node('summary',{class:'holo-team-board-summary'},[
            icon('chevron-right','holo-team-board-chevron'),node('strong',{},'Board plan'),
            node('span',{class:'holo-team-board-score',title:showSongScore?
              (sort==='max'?'Estimated maximum score':'Estimated average song score'):scoreLabel},[
              summaryMetric(plan.ignoredExisting?'Starting board':'Current boards',current),
              Number.isFinite(current)&&Number.isFinite(projected)?node('span',{'aria-hidden':'true'},'→'):null,
              summaryMetric('Optimized',projected),gain!==null&&Math.abs(gain)>=.05?node('strong',{
                class:gain>0?'text-green-400':'text-red-400',
              },percent(gain)):null,
            ]),
          ]);
          const toggle=event=>{state.open=event.currentTarget.open;};
          if(!state.open)return node('details',{class:'holo-team-board-plan',onToggle:toggle},[header]);
          const context=this.resultContext;
          const budget=context?.boardBudget;
          const original=context?.boardPlanBase??{};
          const saved=context?.boardPlanSaved??{};
          const base={...original,...saved};
          const protection={protection:context?.boardProtection};
          const pinnedCards=new Set(Object.keys(protection.protection??{}).flatMap(owner=>Object.values(original[owner]?.cards??{})));
          const reported=new Map((plan.changes??[]).map(row=>[row.owner,row]));
          const cleared=plan.ignoredExisting?Object.keys(budget?.imported??{}).filter(owner=>
            boardProtection(protection,owner)==='flexible'):[];
          const changes=[...new Set([...reported.keys(),...Object.keys(plan.saves??{}),...cleared])].flatMap(owner=>{
            if(boardProtection(protection,owner)==='locked')return [];
            const board=plan.saves?.[owner]??(cleared.includes(owner)?{nodes:[],cards:{}}:null);
            if(!board||!boardChanges(original[owner],board).length)return [];
            const picks=remainingBoardChanges(original[owner],board,saved[owner],state.connectOverrides[owner]);
            const rank=plan.ranks?.[owner]??this.members.find(member=>member.characterId===owner)?.level??1;
            const change=reported.get(owner)??{owner,ptsBudget:boardPointsForMemberLevel(owner,rank),
              ptsSpent:projectBoardSelection(owner,board,[],[],Infinity).points};
            return [{...change,picks,buys:picks.filter(pick=>pick.kind==='buy').map(pick=>pick.id),
              resets:picks.filter(pick=>pick.kind==='reset').map(pick=>pick.id),
              connects:picks.filter(pick=>pick.kind==='connect').map(pick=>({socket:pick.id,cardId:pick.card}))}];
          });
          const members=this.boardSortHolomems?[...changes].sort((a,b)=>{
            const left=boardRosterOrder.get(a.owner),right=boardRosterOrder.get(b.owner);
            return (left?.index??boardRosterGroups.length)-(right?.index??boardRosterGroups.length)||
              (left?.order??0)-(right?.order??0);
          }):changes;
          const selection=change=>{
            const selected=state.selected[change.owner];
            return change.picks.map(pick=>pick.key).filter(key=>!selected||selected.includes(key));
          };
          const project=change=>{
            const result=projectBoardSelection(change.owner,base[change.owner],change.picks,selection(change),change.ptsBudget);
            if(!preservesBoard(protection,change.owner,original[change.owner],result.board))
              return {...result,error:'This change would alter a protected node or Connect card.'};
            return result;
          };
          const editorStatus=changes.map(change=>[change,project(change)]);
          const changed=editorStatus.filter(([change,result])=>boardChanges(base[change.owner],result.board).length);
          const reservedTargets={...budget?.protectedPlans,...saved};
          const billFor=rows=>boardBill(budget.imported,{
            ...reservedTargets,...Object.fromEntries(rows.map(([change,result])=>[change.owner,result.board])),
          },budget.refundResets);
          const budgetFor=rows=>{
            if(!budget)return null;
            try{
              const bill=billFor(rows);
              return {bill,...quoteBoardBudget(bill,{...budget.limits,stock:this.boardStock})};
            }catch(error){return {error:error.message,fits:false};}
          };
          const reserved=budgetFor([]);
          const selectedBudget=changed.length?budgetFor(changed):reserved;
          const difference=(after,before)=>Object.fromEntries([...new Set([...Object.keys(after),...Object.keys(before)])]
            .map(key=>[key,(after[key]??0)-(before[key]??0)]));
          const itemIds=Object.fromEntries(boardItems.map(item=>[item.key,item.id]));
          const budgetItems=(items,hologold)=>({
            ...Object.fromEntries(Object.entries(items).map(([key,quantity])=>[itemIds[key]??key,quantity])),
            ...(hologold?{hologold}:{}),
          });
          const save=async rows=>{
            if(state.pending||!rows.length)return;
            state.error='';state.message='';state.pending=true;
            try{
              const updates=Object.fromEntries(rows.map(([change,result])=>{
                if(result.error)throw Error(memberName(change.owner)+' · '+result.error);
                return [change.owner,result.board];
              }));
              const quote=budgetFor(rows);
              if(quote&&!quote.fits)throw Error(quote.error||'These changes exceed the shared Board budget.');
              await window.__holodoriDesktop.saveBoardPlans(context?.profileId,updates,
                {...(context?.boardPlanExisting??original),...saved},protection);
              for(const [owner,board] of Object.entries(updates)){
                saved[owner]=board;
                delete state.selected[owner];
                delete state.editing[owner];
              }
              state.message=rows.length===1?'Board plan saved.':count(rows.length)+' Board plans saved.';
            }catch(error){state.error=error?.message??'Could not save Board plans.';}
            finally{state.pending=false;}
          };
          const saveAll=button(state.pending?'Saving…':'Save all Boards',()=>save(changed),
            {class:primary,disabled:state.pending||!changed.length||selectedBudget?.fits===false||changed.some(([,result])=>!!result.error)});
          const sortMembers=check('Sort by Holomems',this.boardSortHolomems,value=>{
            this.boardSortHolomems=!!value;
            this.saveOptions();
          });
          const total=selectedBudget?.bill,reservedBill=reserved?.bill;
          const costs=budget?node('div',{class:'holo-team-board-costs','aria-label':'Shared Board budget','aria-live':'polite'},[
            reservedBill?materials('Reserved',budgetItems(reservedBill.bought,resetGold(reservedBill.resets))):null,
            total&&reservedBill?materials('Selected changes',budgetItems(difference(total.bought,reservedBill.bought),
              resetGold(total.resets-reservedBill.resets))):null,
            total?materials('Refunded by resets',budgetItems(total.refunded)):null,
            total?.resets?node('div',{class:'holo-team-board-cost-row'},[
              node('span',{},'Resets'),
              node('strong',{},count(total.resets)+(budget.limits.maxResets===null?'':' / '+count(budget.limits.maxResets))),
              reservedBill.resets?node('span',{},`(${count(reservedBill.resets)} reserved)`):null,
              selectedBudget.overResets?node('span',{class:'text-red-400'},`${count(selectedBudget.overResets)} over limit`):null,
            ]):null,
            selectedBudget?.short?materials('Short',budgetItems(selectedBudget.short)):null,
            selectedBudget?.error?node('p',{class:'text-xs text-red-400'},selectedBudget.error):null,
          ]):null;
          const planBody=!changes.length?
            node('div',{class:'holo-team-board-plan-body'},[
              costs,node('p',{class:'text-sm text-gray-300'},'No Board changes for this team.'),
            ]):
              node('div',{class:'holo-team-board-plan-body'},[
                node('div',{class:'holo-team-board-toolbar'},[
                  node('div',{class:'holo-team-board-toggles'},[
                    sortMembers,
                  ]),
                  saveAll,
                ]),
                state.message?node('p',{role:'status',class:'text-xs text-gray-300'},state.message):null,
                state.error?node('p',{role:'alert',class:'text-xs text-red-400'},state.error):null,
                costs,
                node('div',{class:'holo-team-board-members'},members.flatMap((change,index)=>{
                  const group=this.boardSortHolomems?boardRosterOrder.get(change.owner)?.group:null;
                  const previousGroup=boardRosterOrder.get(members[index-1]?.owner)?.group;
                  const open=state.expanded[change.owner];
                  const preview=open?this.boardPlanPreview(team,change,base[change.owner],state.connectOverrides[change.owner]):null;
                  const picked=new Set(selection(change));
                  const result=editorStatus.find(([row])=>row===change)[1];
                  const pointsLeft=result.points===null?null:change.ptsBudget-result.points;
                  const isSaved=!!saved[change.owner]&&!change.picks.length;
                  const hasChanges=boardChanges(base[change.owner],result.board).length;
                  const editing=!isSaved&&!!state.editing[change.owner];
                  const noResets=boardProtection(protection,change.owner)==='noResets';
                  const pinnedSlot=slot=>noResets&&Object.hasOwn(original[change.owner]?.cards??{},slot);
                  const togglePick=key=>{
                    if(!editing||state.pending)return;
                    if(picked.has(key))picked.delete(key);else picked.add(key);
                    state.selected[change.owner]=[...picked];
                    state.error='';state.message='';
                  };
                  const changeConnect=(slot,card)=>{
                    if(!editing||state.pending)return;
                    if(pinnedSlot(slot)||card&&pinnedCards.has(card))return;
                    state.connectOverrides[change.owner]={...state.connectOverrides[change.owner],[slot]:card};
                    state.selected[change.owner]=[...new Set([...picked,'connect:'+slot])];
                    state.error='';state.message='';
                  };
                  const connectChoices=()=>Object.entries({...this.resultContext?.connectPool,...team.boardCards,
                    ...Object.fromEntries(team.cardIds.map((id,index)=>[id,team.lineup[index].bloom]))}).flatMap(([id,bloom])=>{
                    if(pinnedCards.has(id))return [];
                    const card=connectCard({cardId:id,potentialUpgradeCount:bloom},id);
                    return card.effect?[{...card,name:this.cardName(id),member:this.catalog.cardDetails[id]?.member??card.member}]:[];
                  }).sort((a,b)=>a.member.localeCompare(b.member)||a.name.localeCompare(b.name));
                  const pickButton=(key,id)=>node('button',{
                    type:'button',onClick:()=>togglePick(key),'aria-label':'Select '+id,'aria-pressed':picked.has(key),
                    disabled:state.pending,class:'holo-team-board-pick',
                  });
                  const nodes=open?new Map(resolveBoardNodes(change.owner).map(node=>[node.groupId,node])):null;
                  const nodeChanges=change.picks.filter(pick=>pick.kind!=='connect');
                  const memberHeading=[
                      icon('chevron-right','holo-team-board-chevron'),portrait(change.owner,26),
                      node('strong',{class:'holo-team-board-member-name'},[
                        memberName(change.owner),
                        this.boardProtection[change.owner]?node('span',{class:'holo-team-board-protect-mark',
                          title:this.boardProtection[change.owner]==='locked'?'Lock Board':'No resets'},[
                          image('/assets/boards/ui_999_ico_lock.webp','',12,12),
                        ]):null,
                      ]),
                      node('span',{class:'holo-team-board-counts'},[
                        change.buys.length?chip(count(change.buys.length)+(change.buys.length===1?' unlock':' unlocks'),'add'):null,
                        change.resets.length?chip(count(change.resets.length)+(change.resets.length===1?' reset':' resets'),'reset'):null,
                        change.connects.length?chip(count(change.connects.length)+' Connect','connect'):null,
                      ]),
                      node('span',{class:'holo-team-board-points'},[
                        isSaved?node('span',{class:'sr-only'},'Saved Board'):null,
                        node('strong',{class:pointsLeft<0?'text-red-400':''},
                          pointsLeft<0?`${count(-pointsLeft)} Board Pt over`:`${count(pointsLeft)} Board Pt available`),
                        node('span',{},`${count(result.points)} / ${count(change.ptsBudget)} used`),
                      ]),
                  ];
                  const memberAccordion=body=>[
                    group&&group!==previousGroup?node('h5',{key:'group-'+group.id,class:'holo-team-board-group'},group.name):null,
                    node('details',{key:change.owner,class:'holo-team-board-member','data-saved':isSaved?'true':undefined,open:!!open,
                      onToggle:event=>{
                        state.expanded[change.owner]=event.currentTarget.open;
                      }},[node('summary',{},memberHeading),body]),
                  ];
                  if(!preview)return memberAccordion(null);
                  const rowBudget=!isSaved&&hasChanges?budgetFor([[change,result]]):null;
                  const editToolbar=node('div',{class:'holo-team-board-toolbar holo-team-board-edit'},[
                        node('div',{class:'holo-team-options holo-encore-segments holo-team-board-protection',role:'group',
                          'aria-label':`Board protection for ${memberName(change.owner)}`,
                          title:'Keeps the saved layout on your next search, or the imported Board if there is no saved plan.'},[
                          node('span',{},'Protect on next search'),
                          ...protectionChoices(change.owner,disabled||state.pending),
                        ]),
                        isSaved?null:node('div',{class:'holo-team-board-edit-actions'},[
                          node('div',{class:'holo-team-board-toggles'},[
                            check('Edit plan',editing,value=>{state.editing[change.owner]=!!value;},state.pending),
                            editing?node('div',{class:'holo-team-board-selection-actions','aria-label':'Change selection',role:'group'},[
                              button('Select all',()=>{state.selected[change.owner]=change.picks.map(pick=>pick.key);},
                                {disabled:state.pending||picked.size===change.picks.length}),
                              button('Clear selection',()=>{state.selected[change.owner]=[];},{disabled:state.pending||!picked.size}),
                            ]):null,
                          ]),
                          button(editing?'Save selected ('+count(picked.size)+')':'Save Board',
                            ()=>save([[change,result]]),{class:primary,
                              disabled:state.pending||!hasChanges||!!result.error||rowBudget?.fits===false,
                              title:rowBudget?.fits===false?(selectedBudget?.fits?
                                'Use Save all Boards to include the other selected changes and refunds.':'This Board exceeds the shared budget.'):undefined}),
                        ]),
                      ]);
                  const error=result.error?node('p',{class:'text-xs text-red-400',role:'status'},result.error):null;
                  const caption=node('div',{class:'holo-team-board-map-caption'},[
                        node('div',{class:'holo-team-board-legend'},[['add','New unlock'],['kept','Already active'],['inactive','Inactive'],['reset','Reset'],['connect','Connect change']]
                          .map(([key,label])=>node('span',{key,'data-plan-change':key},[
                            key==='add'||key==='reset'?boardChangeBadge(h,key):null,label,
                          ]))),
                        editing?node('span',{},'Click to select · Right-click a Connect slot to edit'):null,
                      ]);
                  const changeRows=change.picks.length?node('ul',{class:'holo-team-board-change-rows'},[
                          ...nodeChanges.map(({id,key,kind})=>node('li',{key},[
                            chip(kind==='buy'?'Unlock':'Reset',kind==='buy'?'add':'reset'),
                            node('span',{class:'holo-team-board-change-name'},nodes.has(id)?boardNodeLabel(nodes.get(id)):id),
                            node('small',{},id),
                            editing?pickButton(key,id):null,
                          ])),
                          ...change.connects.map(({socket,cardId})=>{
                            const from=preview.oldCards[socket];
                            const cardLabel=id=>node('span',{class:'holo-team-board-connect-card'},[
                              id?image(game.cardImage(id,'grid'),null,32,18):null,node('span',{},id?this.cardName(id):'Empty'),
                            ]);
                            return node('li',{key:'connect:'+socket},[
                              chip('Connect','connect'),
                              node('span',{class:'holo-team-board-change-name holo-team-board-connect-diff'},[
                                cardLabel(from),node('span',{'aria-hidden':'true'},'→'),cardLabel(cardId),
                              ]),
                              node('small',{},socket),
                              editing?pickButton('connect:'+socket,socket):null,
                            ]);
                          }),
                        ]):null;
                  const map=vnode(Board,{snapshot:preview.snapshot,plan:preview,
                    planSelection:editing?picked:null,planNodes:editing?result.board.nodes:undefined,onPlanChange:togglePick,
                    planConnectChoices:editing&&!state.pending?connectChoices:null,planConnectProtected:pinnedSlot,planConnectCards:result.board.cards,
                    onPlanConnect:changeConnect});
                  return memberAccordion(node('div',{class:'holo-team-board-map-body'},[
                    editToolbar,error,map,caption,changeRows?node('details',{class:'holo-team-board-change-list'},[
                      node('summary',{},[icon('chevron-right','holo-team-board-chevron'),'Changes']),changeRows,
                    ]):null,
                  ]));
                })),
              ]);
          return node('details',{class:'holo-team-board-plan',onToggle:toggle},[header,planBody]);
        };
        return vnode(BoardPlanView,{view:renderPlan});
      };
      const scoreOf = team => team.reviewedScore?.average ?? team.score;
      const maxOf = team => team.reviewedScore ? team.reviewedScore.maximum : team.maxScore;
      const teamMetrics = team => [
        ['Average score',scoreOf(team)],[team.reviewedScore?.chartCount?'Average chart maximum':'Maximum score',maxOf(team)],
        ['Unit Score',team.displayUnitScore],
        ['Average event points',team.eventPointsAvg],['Maximum event points',team.eventPointsMax],['Holomem Rating',team.rating],
      ];
      const eventDetails = team => Number.isFinite(team.epPermil) ? h('section',{class:'holo-team-section'},[
        h('h3',{class:'font-semibold'},'Event points'),
        h('dl',{class:'holo-team-breakdown'},[
          h('div',{},[h('dt',{},'Team bonus'),h('dd',{},percent(team.epPermil))]),
          h('div',{},[h('dt',{},'Song length bonus'),h('dd',{},`+${team.eventLengthBonus}%`)]),
          h('div',{},[h('dt',{},'Live Boost'),h('dd',{},`×${team.eventBoostMultiplier}`)]),
          h('div',{},[h('dt',{},'HoloPassport'),h('dd',{},`×${team.eventPassportMultiplier}`)]),
        ]),
        team.eventCardBonuses?h('ul',{class:'text-xs'},team.cardIds.map((id,index)=>
          h('li',{key:id},`${this.cardName(id)} · ${percent(team.eventCardBonuses[index])}`))):null,
      ]):null;
      const previewNode=(type,props,children)=>vnode(type,props,Array.isArray(children)?children.filter(child=>child!=null):children);
      const detailSwitch=(label,options,current,choose)=>previewNode('div',{class:'holo-team-preview-tabs',role:'group','aria-label':label},
        options.map(([id,name])=>button(name,()=>choose(id),{'aria-pressed':current===id})));
      const previewStats=(title,total,rows,grade)=>previewNode('section',{class:'holo-team-preview-stats'},[
        previewNode('h4',{},[previewNode('span',{},[title,grade]),previewNode('strong',{},total)]),
        previewNode('dl',{},rows.map(([label,value])=>previewNode('div',{key:label},[previewNode('dt',{},label),previewNode('dd',{},value)]))),
      ]);
      const distribution = (report,state,simulation) => {
        const running=simulation?.running;
        const remaining=running?Math.max(0,Math.ceil((simulation.durationMs-simulation.elapsedMs)/1000)):0;
        const currentRuns=running?simulation.runs:report?.runs;
        const runLabel=count(currentRuns??0)+' runs'+(running?' · '+remaining+'s left':'');
        if(!report?.histogram?.length)return previewNode('section',{class:'holo-team-preview-distribution'},[
          previewNode('h3',{class:'font-semibold'},'Score distribution'),
          previewNode('p',{role:'status',class:'text-xs text-gray-300'},running?'Simulating runs… · '+runLabel:
            simulation?'No simulation runs completed.':'Choose a song to see its score distribution.'),
          running&&this.stopPreviewSimulation?button('Stop early',()=>this.stopPreviewSimulation()):null,
        ]);
        const bins=report.histogram,runs=report.runs||bins.reduce((sum,bin)=>sum+bin.count,0)||1;
        const midpoint=bin=>(bin.from+bin.to)/2;
        const common=bins.reduce((a,b)=>b.count>a.count?b:a,bins[0]);
        const average=report.average??bins.reduce((sum,bin)=>sum+midpoint(bin)*bin.count,0)/runs;
        const std=report.stdDev??report.standardDeviation??
          Math.sqrt(bins.reduce((sum,bin)=>sum+((midpoint(bin)-average)**2)*bin.count,0)/runs);
        const rate=value=>formatNumber(value*100,{maximumFractionDigits:2})+'%';
        const above=report.aboveAverage!=null?report.aboveAverage/100:
          report.atLeastAverage??bins.reduce((sum,bin)=>sum+(bin.to>=average?bin.count:0),0)/runs;
        const percentile=fraction=>{
          let n=0;
          for(const bin of bins){
            if(n+bin.count>=runs*fraction&&bin.count)return bin.from+(bin.to-bin.from)*(runs*fraction-n)/bin.count;
            n+=bin.count;
          }
          return report.maximum;
        };
        const list=[
          ['Average',count(average)],['Median',count(report.percentiles?.p50??percentile(.5))],
          ['Most common',count(report.mode??midpoint(common))],['Std deviation',count(std)],
          ['Variation',rate(average?std/average:0)],['Lowest',count(report.minimum)],['Highest',count(report.maximum)],
          ['Spread',count(report.maximum-report.minimum)],
          ...[5,25,75,95].map(p=>[p+'th percentile',count(report.percentiles?.['p'+p]??percentile(p/100))]),
          ['At or above average',rate(above)],
        ];
        const hover=bins[state.histogramBin],width=600/bins.length,peak=Math.max(1,common.count);
        const meanPosition=600*Math.max(0,Math.min(1,(average-bins[0].from)/(bins.at(-1).to-bins[0].from||1)));
        const graph=()=>previewNode('div',{class:'holo-team-preview-histogram'},[
          previewNode('div',{},list.filter(([name])=>['Lowest','Most common','Average','Median','Highest'].includes(name))
            .map(([name,value])=>previewNode('span',{key:name},[previewNode('strong',{},value),' '+name]))),
          previewNode('svg',{class:'holo-team-chart',viewBox:'0 0 600 128',preserveAspectRatio:'none',
            role:'img','aria-label':'Simulated score distribution',
            onPointermove:event=>{
              const bounds=event.currentTarget.getBoundingClientRect();
              const local=(event.clientX-bounds.left)/bounds.width;
              state.histogramBin=Math.max(0,Math.min(bins.length-1,Math.floor(local*bins.length)));
            },onPointerleave:()=>{state.histogramBin=null;},
            onKeydown:event=>{
              if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
              event.preventDefault();
              state.histogramBin=Math.max(0,Math.min(bins.length-1,(state.histogramBin??0)+(event.key==='ArrowLeft'?-1:1)));
            },tabindex:0,
          },[
            ...bins.map((bin,index)=>{
              const height=112*bin.count/peak;
              return previewNode('rect',{key:index,x:index*width,y:122-height,width:Math.max(.5,width-1),height,
                class:index===state.histogramBin?'is-hovered':undefined,fill:'currentColor'});
            }),
            previewNode('line',{x1:meanPosition,x2:meanPosition,y1:9,y2:122,class:'holo-team-dist-mean'}),
          ]),
          previewNode('div',{},[count(report.minimum),count(report.maximum)]),
          previewNode('p',{class:'holo-team-dist-hover',role:'status'},hover?
            '~'+count(midpoint(hover))+' · '+rate(hover.count/runs)+' of runs · '+
            rate(bins.slice(state.histogramBin).reduce((sum,bin)=>sum+bin.count,0)/runs)+' score at least this':''),
        ]);
        return previewNode('section',{class:'holo-team-preview-distribution','aria-label':'Score distribution'},[
          previewNode('div',{class:'holo-team-preview-section-head'},[previewNode('h3',{class:'font-semibold'},'Score distribution'),
            detailSwitch('Distribution view',[['stats','Stats'],['graph','Graph']],state.distribution,value=>{state.distribution=value;}),
          ]),
          state.distribution==='graph'?previewNode('div',{key:'histogram',class:state.histogramExpanded?'holo-team-dist-expanded':undefined},[
            graph(),button(state.histogramExpanded?'Collapse graph':'Expand graph',()=>{state.histogramExpanded=!state.histogramExpanded;},
              {'aria-pressed':state.histogramExpanded}),
          ]):previewNode('dl',{class:'holo-team-preview-distribution-stats',key:'statistics'},list.map(([name,value])=>
            previewNode('div',{key:name},[previewNode('dt',{},name),previewNode('dd',{},value)]))),
          previewNode('div',{class:'holo-team-preview-section-head'},[
            previewNode('div',{class:'holo-team-preview-tabs'},[
              this.runPreviewSimulation?button('Rerun',()=>this.runPreviewSimulation('rerun',10),{disabled:running}):null,
              this.runPreviewSimulation?button('Continue',()=>{state.continueOpen=!state.continueOpen;},
                {disabled:running,'aria-expanded':state.continueOpen}):null,
              running&&this.stopPreviewSimulation?button('Stop early',()=>this.stopPreviewSimulation()):null,
            ]),
            caption(runLabel),
          ]),
          state.continueOpen&&!running?previewNode('div',{class:'holo-team-preview-tabs'},[
            ...[5,10,30,60,120,300].map(seconds=>button(seconds+'s',()=>{state.continueSeconds=seconds;},
              {'aria-pressed':seconds===state.continueSeconds})),
            button('Cancel',()=>{state.continueOpen=false;}),
            button('Continue simulation',()=>{state.continueOpen=false;this.runPreviewSimulation('continue',state.continueSeconds);},{class:primary}),
          ]):null,
        ]);
      };
      const chartTimeline = (team,chart,report,state) => {
        if(!chart?.seconds)return null;
        const position=seconds=>Math.max(0,Math.min(100,100*seconds/chart.seconds));
        const colors=['#52b9ac','#f49367','#a797e8','#e478b6','#a3ce66'];
        const lane=(name,windows,kind,art)=>previewNode('div',{class:'holo-team-timeline-row',key:name},[
          previewNode('span',{title:name},[art?image(art,null,28,18):null,name]),
          previewNode('div',{class:'holo-team-timeline-track','aria-label':name,onPointermove:event=>{
            const box=event.currentTarget.getBoundingClientRect();
            state.timelineCursor=(event.clientX-box.left)/box.width*chart.seconds;
          },onPointerleave:()=>{state.timelineCursor=null;}},[
            ...windows.map((window,index)=>{
            const left=position(window.s),width=position(window.e)-left;
            const id=name+'-'+index;
            const time=formatNumber(window.s,{maximumFractionDigits:1})+'–'+formatNumber(window.e,{maximumFractionDigits:1})+' s';
            const chance=kind==='active'&&Number.isFinite(window.p)?formatNumber(window.p*100,{maximumFractionDigits:1})+'% chance':null;
            const effect=window.raw??(window.sup!=null?window.sup*100:null);
            const boost=Number.isFinite(effect)?'+'+formatNumber(effect,{maximumFractionDigits:1})+'%':null;
            const label=[name,time,boost,chance].filter(Boolean).join(' · ');
            return previewNode('button',{key:index,type:'button','data-window':kind,
              'aria-label':label,'aria-pressed':state.skillWindow?.id===id,style:{left:left+'%',width:width+'%',background:colors[window.slot]},
              title:label,onClick:()=>{state.skillWindow=state.skillWindow?.id===id?null:{id,label,window};}});
          }),
          state.timelineCursor!=null?previewNode('span',{class:'holo-team-timeline-cursor',
            style:{left:position(state.timelineCursor)+'%'},'aria-hidden':'true'}):null,
          ]),
        ]);
        const tick=seconds=>formatNumber(seconds,{maximumFractionDigits:1})+'s';
        const last=report?.timeline?.at(-1);
        const samples=Array.from({length:Math.ceil(chart.seconds)},(_,i)=>{
          const overlaps=chart.active.filter(window=>window.s<=i+.5&&window.e>i+.5);
          return {width:Math.min(1,chart.seconds-i)/chart.seconds*100,
            note:(chart.countCurve[i+1]??chart.notes)-(chart.countCurve[i]??chart.notes),
            overlap:overlaps.length,
            active:overlaps.sort((a,b)=>b.raw-a.raw)[0]?.slot};
        });
        const band=(label,color)=>previewNode('div',{class:'holo-team-timeline-row'},[
          previewNode('span',{},label),previewNode('div',{class:'holo-team-timeline-band'},samples.map((sample,i)=>previewNode('span',{key:i,
            style:{width:sample.width+'%',background:color(sample)}}))),
        ]);
        return previewNode('section',{class:'holo-team-preview-timeline'},[
          previewNode('h3',{class:'font-semibold'},'Timeline Graph'),
          previewNode('div',{class:'holo-team-timeline-axis','aria-hidden':'true'},[
            previewNode('span'),previewNode('div',{},Array.from({length:6},(_,i)=>previewNode('span',{key:i},tick(chart.seconds*i/5)))),
          ]),
          ...team.cardIds.map((id,slot)=>lane(this.catalog.cardDetails[id]?.member??this.cardName(id),
            chart.active.filter(window=>window.slot===slot),'active',game.cardImage(id,'grid'))),
          lane('Special',chart.special,'special'),
          chart.countCurve.length?band('Notes',sample=>'rgb(57 194 207 / '+Math.min(1,Math.max(.08,sample.note/16))+')'):null,
          band('Active',sample=>colors[sample.active]),
          band('Overlap',sample=>'rgb(190 177 237 / '+Math.min(1,.08+sample.overlap/5)+')'),
          last?.score>0?previewNode('div',{class:'holo-team-timeline-row'},[
            previewNode('span',{},'Score'),previewNode('svg',{class:'holo-team-chart',viewBox:'0 0 300 44',preserveAspectRatio:'none',
              role:'img','aria-label':'Cumulative expected score'},[
              previewNode('polyline',{fill:'none',stroke:'currentColor','stroke-width':1.5,points:report.timeline.map(point=>
                position(point.seconds)*3+','+(42-point.score/last.score*39)).join(' ')}),
            ]),
          ]):null,
          state.timelineCursor!=null?previewNode('p',{class:'text-xs text-gray-300'},tick(state.timelineCursor)+' · '+
            count(chart.countCurve[Math.floor(state.timelineCursor)]??chart.notes)+' combo'):null,
          state.skillWindow?previewNode('div',{class:'holo-team-preview-section-head holo-team-skill-selection',role:'status'},[
            previewNode('span',{},state.skillWindow.label),button('Close skill details',()=>{state.skillWindow=null;}),
          ]):null,
        ]);
      };
      const chartDetail=(chart,song,state,report,team)=>{
        if(!chart?.seconds)return null;
        const span=Math.min(state.chartSpan,chart.seconds),limit=Math.max(0,chart.seconds-span);
        const start=Math.max(0,Math.min(state.chartStart,limit)),end=Math.min(chart.seconds,start+span);
        const points=[start,...Array.from({length:Math.max(0,Math.ceil(end)-Math.floor(start)-1)},(_,i)=>Math.floor(start)+i+1),end];
        const countAt=seconds=>{
          const times=chart.events?.times;
          if(times?.length){
            let left=0,right=times.length;
            while(left<right){
              const mid=(left+right)>>>1;
              if(times[mid]<=seconds*1_000_000)left=mid+1;else right=mid;
            }
            return left;
          }
          const curve=chart.countCurve;
          if(!curve.length)return chart.notes*seconds/chart.seconds;
          const i=Math.floor(seconds);
          return (curve[i]??chart.notes)+((curve[i+1]??chart.notes)-(curve[i]??chart.notes))*(seconds-i);
        };
        const base=countAt(start),notes=Math.max(1,countAt(end)-base);
        const eventMarks=new Map();
        const duration=end-start;
        const viewX=seconds=>300*(seconds-start)/duration;
        const laneMode=state.lanes?.length===chart.events?.times.length&&state.lanes?.length>0;
        const viewTime=seconds=>laneMode?300-viewX(seconds):viewX(seconds);
        const playhead=Math.min(chart.seconds,state.trackTime);
        const timeLabel=seconds=>{
          const whole=Math.floor(seconds);
          return Math.floor(whole/60)+':'+String(whole%60).padStart(2,'0');
        };
        const player=previewNode('div',{class:'holo-team-chart-player'},[
          state.trackUrl?previewNode('audio',{key:state.trackUrl,ref:'soundtrack',src:state.trackUrl,preload:'metadata',
            loop:state.trackLoop,
            onLoadedmetadata:event=>{
              const audio=event.currentTarget;
              audio.volume=state.trackVolume;
              audio.playbackRate=state.trackRate;
              state.trackDuration=Number.isFinite(audio.duration)?audio.duration:0;
              state.updatePlayhead();
            },
            onPlay:state.onPlaybackStart,onPause:state.onPlaybackStop,onEnded:state.onPlaybackStop,
            onTimeupdate:state.updatePlayhead,onSeeked:state.updatePlayhead,
            onError:()=>{state.trackStatus='error';state.onPlaybackStop();},
          }):null,
          state.trackStatus==='ready'?[
            previewNode('div',{class:'holo-team-chart-transport'},[
              button(state.trackPlaying?'Pause':'Play',state.toggleSoundtrack,{'aria-label':state.trackPlaying?'Pause soundtrack':'Play soundtrack'}),
              previewNode('span',{},timeLabel(state.trackTime)),
              previewNode('input',{type:'range',class:'holo-lineup-slider',min:0,max:state.trackDuration||1,
                step:.01,value:state.trackTime,disabled:!state.trackDuration,'aria-label':'Soundtrack position',
                onInput:event=>state.seekSoundtrack(Number(event.target.value))}),
              previewNode('span',{},timeLabel(state.trackDuration)),
            ]),
            previewNode('div',{class:'holo-team-options'},[
              check('Follow',state.follow,state.setFollow),
              caption('Combo '+count(countAt(playhead))),
              previewNode('details',{class:'holo-team-chart-audio-options'},[
                previewNode('summary',{},'Playback settings'),
                previewNode('div',{class:'holo-team-options'},[
                  previewNode('label',{class:'holo-team-chart-volume'},['Music volume',previewNode('input',{
                    type:'range',class:'holo-lineup-slider',min:0,max:1,step:.02,value:state.trackVolume,'aria-label':'Soundtrack volume',
                    onInput:event=>{state.trackVolume=Number(event.target.value);state.$refs.soundtrack.volume=state.trackVolume;},
                  })]),
                  previewNode('select',{class:inputClass,'aria-label':'Playback speed',value:state.trackRate,
                    onChange:event=>{state.trackRate=Number(event.target.value);state.$refs.soundtrack.playbackRate=state.trackRate;},
              },[.25,.5,.75,1,1.5,2,2.5,3].map(rate=>previewNode('option',{key:rate,value:rate},formatNumber(rate)+'×'))),
                  check('Loop',state.trackLoop,value=>{state.trackLoop=!!value;}),
                  button('Choose soundtrack file',()=>state.$refs.soundtrackFile.click()),
                ]),
                previewNode('div',{class:'holo-team-options'},[
                  previewNode('label',{class:'holo-team-chart-volume'},['Hit volume',previewNode('input',{
                    type:'range',class:'holo-lineup-slider',min:0,max:1,step:.02,value:state.hitVolume,'aria-label':'Chart hit volume',
                    onInput:event=>state.setHitVolume(Number(event.target.value)),
                  })]),
                  previewNode('select',{class:inputClass,'aria-label':'Chart hit sound set',value:state.hitType,
                    onChange:event=>state.setHitType(event.target.value),
                  },state.hitTypes.map(type=>previewNode('option',{key:type,value:type},'Hit sounds '+type.slice(4)))),
                  state.hitUnavailable?caption('Hit sounds unavailable for this chart.'):null,
                ]),
              ]),
            ]),
          ]:previewNode('div',{class:'holo-team-options'},[
            caption(state.trackStatus==='loading'?'Loading local soundtrack…':state.trackStatus==='error'?
              state.trackError||'The local soundtrack could not play.':'Soundtrack unavailable offline for this song.'),
            state.trackStatus!=='loading'?button('Choose soundtrack file',()=>state.$refs.soundtrackFile.click()):null,
          ]),
          previewNode('input',{type:'file',ref:'soundtrackFile',accept:'audio/*,.mp3,.ogg,.opus,.m4a,.wav,.flac,.webm',hidden:true,
            onChange:state.addSoundtrack}),
        ]);
        const colors=['#52b9ac','#f49367','#a797e8','#e478b6','#a3ce66'];
        const groups=new Map();
        for(const window of chart.active){
          if(!groups.has(window.slot))groups.set(window.slot,[]);
          groups.get(window.slot).push(window);
        }
        const overlays=[...groups].map(([slot,windows])=>({slot,
          name:this.catalog.cardDetails[team?.cardIds?.[slot]]?.member??'Card '+(slot+1),windows,color:colors[slot]}));
        if(chart.special.length)overlays.push({slot:'special',name:'Specials',color:'#63a9d9',windows:chart.special});
        const expected=chart.averageScore??report?.average;
        const maximum=chart.maxScore??report?.maximum;
        const std=report?.stdDev??report?.standardDeviation;
        const grades=[['C',150000],['B',300000],['A',600000],['S',1000000],
          ...[1200000,1500000,2000000,2500000,3000000,3500000,4000000,4500000,5000000].map((value,i)=>['S+'+(i+1),value])];
        const target=Number(state.targetScore.toString().replace(/[^0-9]/g,''));
        const z=({1:2.32635,5:1.64485,10:1.28155,20:.84162,30:.5244,50:0})[state.chance];
        const scoreCurve=report?.timeline;
        const pace=seconds=>{
          const weights=chart.weightCurve;
          if(weights?.length&&weights.at(-1)>0){
            const index=Math.floor(seconds);
            const a=weights[index]??weights.at(-1),b=weights[index+1]??a;
            return (a+(b-a)*(seconds-index))/weights.at(-1);
          }
          if(!scoreCurve?.length||!scoreCurve.at(-1).score)return countAt(seconds)/Math.max(1,chart.notes);
          let left=0,right=scoreCurve.length;
          while(left<right){
            const mid=(left+right)>>>1;
            if(scoreCurve[mid].seconds<=seconds)left=mid+1;else right=mid;
          }
          const a=scoreCurve[left-1]??{seconds:0,score:0},b=scoreCurve[left]??a;
          return (a.score+(b.score-a.score)*(seconds-a.seconds)/(b.seconds-a.seconds||1))/scoreCurve.at(-1).score;
        };
        const reach=(score,value)=>{
          if(value(chart.seconds)<score)return null;
          let a=0,b=chart.seconds;
          for(let i=0;i<16;i++){const mid=(a+b)/2;if(value(mid)<score)a=mid;else b=mid;}
          return b;
        };
        const thresholds=expected>0?grades.flatMap(([grade,score])=>{
          const time=reach(score,s=>expected*pace(s));
          const must=target>0&&std!=null?reach(score,s=>{
            const remaining=Math.max(0,1-pace(s));
            return target-expected*remaining-z*std*Math.sqrt(remaining);
          }):undefined;
          return grade.startsWith('S+')&&time==null?[]:[{grade,time,must}];
        }):[];
        const markerText=seconds=>seconds==null?'—':formatNumber(seconds,{maximumFractionDigits:1})+'s ('+count(Math.floor(countAt(seconds)))+')';
        const windowLabel=window=>formatNumber(window.s,{maximumFractionDigits:1})+'–'+formatNumber(window.e,{maximumFractionDigits:1})+'s';
        if(!state.artwork&&chart.events&&duration>0){
          const {times,types}=chart.events;
          for(let i=Math.max(0,countAt(start)-1);i<times.length;i++){
            const seconds=times[i]/1_000_000;
            if(seconds<start)continue;
            if(seconds>end)break;
            const type=types[i];
            if(laneMode){
              if(type===5)continue;
              const lane=(state.lanes[i]>>>4)-2,width=state.lanes[i]&15;
              const y=viewTime(seconds);
              eventMarks.set(type,(eventMarks.get(type)??'')+`M${(16+lane*17).toFixed(2)} ${y.toFixed(2)}h${Math.max(1,width*17-1)}`);
            }else eventMarks.set(type,(eventMarks.get(type)??'')+`M${viewX(seconds).toFixed(2)} 72v8`);
          }
        }
        const artwork=state.artwork;
        const artLayout=artwork?.layout;
        const selected=state.selectedOverlay;
        const selectedWindowArt=artLayout&&selected?chartArtworkCrop(artLayout,selected.window.s,selected.window.e):null;
        const skillEffect=selected?.window.raw??(selected?.window.sup!=null?selected.window.sup*100:null);
        const selectionLabel=selected?[selected.name,Number.isFinite(skillEffect)?'+'+formatNumber(skillEffect,
          {maximumFractionDigits:1})+'%':null,windowLabel(selected.window)].filter(Boolean).join(' · '):'';
        const showPlayhead=state.trackUrl&&playhead>=start&&playhead<=end;
        const moveChart=by=>{
          const next=Math.max(Math.min(3,chart.seconds),Math.min(chart.seconds,span*by));
          const anchor=state.follow?Math.max(0,Math.min(1,(playhead-start)/span)):.5;
          state.chartStart=Math.max(0,Math.min(chart.seconds-next,start+(span-next)*anchor));
          state.chartSpan=next;
        };
        const artImage=()=>previewNode('image',{href:artwork.url,width:artLayout.totalW,height:artLayout.totalH,
          onError:state.onArtworkError});
        const printViewport=artLayout?previewNode('div',{class:'holo-team-chart-artwork-layout'},[
          selectedWindowArt?previewNode('div',{class:'holo-team-chart-selection'},[
            previewNode('div',{class:'holo-team-preview-section-head holo-team-skill-selection'},[
              previewNode('span',{role:'status'},selectionLabel),
              button('Clear window',()=>{state.selectedOverlay=null;}),
            ]),
            previewNode(SkillCropView,{key:JSON.stringify([selected.slot,selected.window.s,selected.window.e]),
              artwork,crop:selectedWindowArt,onArtworkError:state.onArtworkError}),
          ]):null,
          previewNode('svg',{class:'holo-team-chart holo-team-note-chart is-artwork-chart',
            viewBox:chartArtworkViewBox(artLayout,start,end,state.follow&&state.trackUrl?playhead:null),
            preserveAspectRatio:'xMidYMid meet',role:'img','aria-label':'Rendered song chart',
            onWheel:event=>{
              if(!event.cancelable)return;
              event.preventDefault();
              moveChart(event.deltaY<0 ? .8 : 1.25);
            },
            onPointerdown:event=>{
              if(event.button!==0||event.target.closest('.holo-team-chart-overlay'))return;
              state.chartDrag={id:event.pointerId,x:event.clientX,y:event.clientY,start};
              event.currentTarget.setPointerCapture(event.pointerId);
            },
            onPointermove:event=>{
              const drag=state.chartDrag;
              if(drag?.id!==event.pointerId||state.follow&&state.trackUrl)return;
              const bounds=event.currentTarget.getBoundingClientRect();
              const dx=(drag.x-event.clientX)/bounds.width,dy=(event.clientY-drag.y)/bounds.height;
              state.chartStart=Math.max(0,Math.min(limit,drag.start+(Math.abs(dx)>Math.abs(dy)?dx:dy)*span));
            },
            onLostpointercapture:()=>{state.chartDrag=null;},
          },[
            artImage(),
            ...overlays.filter(group=>!state.hiddenSkills.includes(group.slot)).flatMap(group=>group.windows.flatMap((window,i)=>
              chartArtworkWindows(artLayout,window.s,window.e).map(({column,x,y,width,height})=>
                previewNode('rect',{key:group.slot+'-'+i+'-'+column,
                  class:['holo-team-chart-overlay',{'is-selected':selected?.slot===group.slot&&selected.window===window}],
                  x,y,width,height,fill:group.color,stroke:selected?.slot===group.slot&&selected.window===window?group.color:undefined,
                  onClick:event=>{
                    event.stopPropagation();
                    const current=state.selectedOverlay;
                    state.selectedOverlay=current?.slot===group.slot&&current.window===window?
                      null:{slot:group.slot,name:group.name,window};
                  }},[
                  previewNode('title',{},group.name+' · '+windowLabel(window)),
                ])))),
            ...thresholds.flatMap(({grade,time,must})=>[[time,'expected'],[must,'target']].filter(([s])=>s!=null)
              .map(([s,kind])=>{
                const point=chartArtworkPoint(artLayout,s);
                return previewNode('line',{key:grade+kind,x1:point.x,x2:point.x+point.width,y1:point.y,y2:point.y,
                  class:'holo-team-chart-grade '+kind});
              })),
            showPlayhead?(()=>{
              const point=chartArtworkPoint(artLayout,playhead);
              return previewNode('line',{class:'holo-team-chart-playhead',x1:point.x,x2:point.x+point.width,y1:point.y,y2:point.y});
            })():null,
          ]),
        ]):null;
        return previewNode('section',{class:'holo-team-preview-chart'},[
          previewNode('h3',{class:'font-semibold'},'Chart'),
          previewNode('div',{class:'holo-team-preview-section-head'},[
            previewNode('div',{class:'holo-team-preview-song'},[
              song?.songId?image(songJacket(song.songId),'holo-team-jacket',40,40):null,
              previewNode('span',{},[previewNode('strong',{},song?.title??'Selected chart'),
                caption([song?.difficulty?capitalize(song.difficulty):null,'Lv. '+count(chart.level),count(chart.notes)+' notes'].filter(Boolean).join(' · '))]),
            ]),
            detailSwitch('Chart time range',[[15,'15s'],[30,'30s'],[Infinity,'Full chart']],state.chartSpan,
              value=>{state.chartSpan=value;}),
            artwork?previewNode('div',{class:'holo-team-options','aria-label':'Chart zoom'},[
              button('−',()=>moveChart(1.25),{'aria-label':'Zoom out chart'}),
              button('+',()=>moveChart(.8),{'aria-label':'Zoom in chart'}),
            ]):null,
          ]),
          overlays.length?previewNode('div',{class:'holo-team-preview-tabs',role:'group','aria-label':'Chart skill overlays'},
            overlays.map(group=>button([previewNode('span',{class:'holo-team-chart-swatch',style:{background:group.color}}),group.name],()=>{
              state.hiddenSkills=state.hiddenSkills.includes(group.slot)?state.hiddenSkills.filter(id=>id!==group.slot):[...state.hiddenSkills,group.slot];
              if(state.selectedOverlay?.slot===group.slot)state.selectedOverlay=null;
            },{key:group.slot,'aria-pressed':!state.hiddenSkills.includes(group.slot)}))):null,
          thresholds.length?previewNode('div',{class:'holo-team-chart-pace'},[
            previewNode('label',{},['Target score',previewNode('input',{class:inputClass,inputmode:'numeric',
              placeholder:'0',value:state.targetScore,onInput:event=>{
                const text=event.target.value.replace(/[^0-9]/g,'');
                state.targetScore=maximum>0&&Number(text)>maximum?String(Math.floor(maximum)):text;
                event.target.value=state.targetScore;
              }})]),
            previewNode('label',{},['Chance',previewNode('select',{class:inputClass,value:state.chance,
              onChange:event=>{state.chance=Number(event.target.value);}},
              [1,5,10,20,30,50].map(chance=>previewNode('option',{key:chance,value:chance},chance+'%')))]),
            caption('Expected · time (combo)'+(target>0&&std!=null?' · ★ Must reach by':'')),
          ]):null,
          thresholds.length?previewNode('div',{class:'holo-team-chart-grades'},thresholds.map(({grade,time,must})=>
            previewNode('span',{key:grade},[previewNode('strong',{},grade),' '+markerText(time),must!==undefined?' · ★ '+markerText(must):null]))):null,
          printViewport??previewNode('svg',{class:'holo-team-chart holo-team-note-chart'+(laneMode?' is-lane-chart':''),viewBox:laneMode?'0 0 236 300':'0 0 300 84',
            preserveAspectRatio:laneMode?'xMidYMid meet':'none',role:'img',
            'aria-label':'Chart note timing and skill windows',
            onWheel:event=>{
              if(!event.cancelable)return;
              event.preventDefault();
              const bounds=event.currentTarget.getBoundingClientRect();
              const rawAnchor=laneMode?1-(event.clientY-bounds.top)/bounds.height:(event.clientX-bounds.left)/bounds.width;
              const anchor=Math.max(0,Math.min(1,rawAnchor));
              const next=Math.max(Math.min(5,chart.seconds),Math.min(chart.seconds,span*(event.deltaY<0 ? .8 : 1.25)));
              state.chartStart=Math.max(0,Math.min(chart.seconds-next,start+(span-next)*anchor));
              state.chartSpan=next;
            },
            onPointerdown:event=>{
              if(event.button!==0||event.target.closest('.holo-team-chart-overlay'))return;
              state.chartDrag={id:event.pointerId,position:laneMode?event.clientY:event.clientX,start};
              event.currentTarget.setPointerCapture(event.pointerId);
            },
            onPointermove:event=>{
              const drag=state.chartDrag;
              if(drag?.id!==event.pointerId)return;
              const bounds=event.currentTarget.getBoundingClientRect();
              const delta=laneMode?(event.clientY-drag.position)/bounds.height:(drag.position-event.clientX)/bounds.width;
              state.chartStart=Math.max(0,Math.min(limit,drag.start+delta*span));
            },
            onLostpointercapture:()=>{state.chartDrag=null;},
          },[
            ...Array.from({length:laneMode?13:0},(_,lane)=>previewNode('line',{key:'lane-'+lane,
              x1:16+lane*17,x2:16+lane*17,y1:0,y2:300,class:'holo-team-chart-lane'})),
            ...overlays.filter(group=>!state.hiddenSkills.includes(group.slot)).flatMap(group=>group.windows.filter(window=>window.e>=start&&window.s<=end).map((window,i)=>{
              const left=Math.max(0,viewX(window.s)),right=Math.min(300,viewX(window.e)),length=Math.max(.5,right-left);
              return previewNode('rect',{key:group.slot+'-'+i,class:'holo-team-chart-overlay',
                x:laneMode?16:left,y:laneMode?300-right:6,width:laneMode?204:length,height:laneMode?length:64,fill:group.color,onClick:event=>{
                  event.stopPropagation();
                  const current=state.selectedOverlay;
                  state.selectedOverlay=current?.slot===group.slot&&current.window===window?
                    null:{slot:group.slot,name:group.name,window};
                }},[
                previewNode('title',{},group.name+' · '+windowLabel(window)),
              ]);
            })),
            previewNode('path',{key:'slots',d:chart.slots.filter(time=>time!=null&&time>=start&&time<=end)
              .map(time=>laneMode?`M16 ${viewTime(time).toFixed(2)}h204`:`M${viewX(time).toFixed(2)} 0v82`).join(''),
              stroke:'#58c7e2','stroke-dasharray':'3 2'}),
            !laneMode?previewNode('polyline',{key:'curve',fill:'none',stroke:'currentColor','stroke-width':1.5,points:points.map(time=>
              viewX(time)+','+(71-(countAt(time)-base)/notes*65)).join(' ')}):null,
            ...Array.from({length:7},(_,i)=>previewNode('path',{key:'note-type-'+i,d:eventMarks.get(i+1)??'',
              stroke:['#9daffc','#ff8ec9','#50d2da','#50d2da','#ff8ec9','#9e86ef','#9e86ef'][i],
              'stroke-width':laneMode?2.5:1,fill:'none'})),
            ...thresholds.flatMap(({grade,time,must})=>[[time,'expected'],[must,'target']].filter(([s])=>s!=null&&s>=start&&s<=end)
              .map(([s,kind])=>previewNode('line',{key:grade+kind,x1:laneMode?12:viewX(s),x2:laneMode?224:viewX(s),
                y1:laneMode?viewTime(s):0,y2:laneMode?viewTime(s):72,class:'holo-team-chart-grade '+kind}))),
            showPlayhead?previewNode('line',{class:'holo-team-chart-playhead',x1:laneMode?16:viewX(playhead),
              x2:laneMode?220:viewX(playhead),y1:laneMode?viewTime(playhead):0,y2:laneMode?viewTime(playhead):82}):null,
          ]),
          selected&&!selectedWindowArt?previewNode('div',{class:'holo-team-preview-section-head holo-team-skill-selection',role:'status'},[
            previewNode('span',{},selectionLabel),
            button('Clear window',()=>{state.selectedOverlay=null;}),
          ]):null,
          previewNode('div',{class:'holo-team-preview-chart-range'},[
            previewNode('span',{},formatNumber(Math.floor(start))+'s'),previewNode('input',{type:'range',class:'holo-lineup-slider',
              hidden:!limit,disabled:!limit,min:0,max:limit,step:.1,value:start,
              'aria-label':'Chart start time',onInput:event=>{state.chartStart=Number(event.target.value);}}),
            previewNode('span',{},formatNumber(Math.ceil(end))+'s'),
          ]),
          player,
        ]);
      };
      const teamDetails = (team,state,preview) => {
        const view=state.unit==='song'&&preview?.thisSong?preview.thisSong:preview?.overall;
        const rank=key=>{
          const value=view?.ranks?.[key];
          return value?previewNode('span',{class:'holo-team-preview-rank',title:'Grade'},value.type+
            (value.plus>0?'+'+(value.type==='S'?count(value.plus):''):'')):null;
        };
        const songKey=this.previewChartKey;
        const previewSongs=[...this.releasedSongs,...(this.catalog.previewSongs??[]).filter(song=>song.startTime<=this.eventClock)];
        const selectedSong=songKey?previewSongs.find(song=>song.id===songKey.split('_')[0]):null;
        const song=selectedSong?{songId:selectedSong.id,title:selectedSong.title,difficulty:songKey.split('_')[1]}:null;
        const charts=selectedSong?.charts.filter(chart=>chart.seconds>0)??[];
        const id=team.cardIds[this.previewSlot],entry=team.lineup[this.previewSlot],card=this.catalog.cardDetails[id];
        const edit=(section,index)=>{
          this.previewSection=section;this.previewQuery='';
          if(index!==undefined)this.previewSlot=index;
          this.$nextTick(()=>this.$refs.previewPickerSearch?.querySelector('input')?.focus({preventScroll:true}));
        };
        const chooseChart=(key,mobileOnly=false)=>{
          if(this.previewChartKey===key)return;
          if(mobileOnly)this.previewPc=false;
          this.previewChartKey=key;this.refreshTeamPreview();
        };
        if(this.previewSection){
          const section=this.previewSection,query=this.previewQuery.trim().toLocaleLowerCase();
          const match=value=>contains(value,query);
          const choice=(id,label,art,choose,selected)=>button([art,label],()=>{choose();edit(null);},
            {key:id,class:action+' holo-team-person','aria-pressed':selected});
          let options;
          if(section==='Song'){
            options=previewSongs.filter(row=>match(row.title)).sort((a,b)=>a.title.localeCompare(b.title)).map(row=>{
              const playable=row.charts.filter(chart=>chart.seconds>0);
              const chart=playable.find(chart=>chart.difficulty===song?.difficulty)??playable[0];
              return choice(row.id,row.title,image(songJacket(row.id),'holo-team-jacket',36,36),
                ()=>chooseChart(chart.key,chart.gameOnly&&!chart.pcEstimate),row.id===selectedSong?.id);
            });
          }else if(section==='Card'){
            const members=new Set(team.cardIds.filter((id,index)=>id&&index!==this.previewSlot).map(id=>this.cardMember(id)));
            options=Object.keys(this.catalog.cardDetails).filter(id=>!members.has(this.cardMember(id))&&
              match(this.cardName(id)+' '+(this.catalog.cardDetails[id].member??''))).map(candidate=>
              choice(candidate,this.cardName(candidate),image(game.cardImage(candidate,'grid'),'holo-team-preview-pick-art',48,27),
                ()=>this.patchPreviewCard(this.previewSlot,candidate),candidate===id));
          }else if(section==='Leader'){
            options=this.availableLeaders.filter(row=>match(row.name)).map(row=>choice(row.id,row.name,portrait(row.id),()=>{
              const outfit=this.catalog.costumes.find(outfit=>outfit.characterId===row.id&&outfit.isDefault);
              const same=team.leaderChar===row.id;
              this.patchPreviewTeam({leaderChar:row.id,leaderName:row.name,...(same?{}:{
                outfitId:outfit?.id??null,outfitName:outfit?.name,outfitDescription:outfit?.description,
              })});
            },row.id===team.leaderChar));
          }else if(section==='Outfit'){
            options=this.catalog.costumes.filter(row=>row.characterId===team.leaderChar&&match(row.name)).map(row=>
              choice(row.id,row.name,null,()=>this.changePreviewOutfit(row.id),row.id===team.outfitId));
          }else{
            return previewNode('section',{class:'holo-team-detail-stack','aria-label':'Send team to tool'},[
              previewNode('div',{class:'holo-team-options'},[
                button('Back',()=>edit(null)),
                button('Build around cards',()=>this.sendPreviewToOptimizer('holomem')),
                button('Next upgrades',()=>this.sendPreviewToOptimizer('next')),
              ]),
            ]);
          }
          return previewNode('section',{class:'holo-team-detail-stack','aria-label':'Choose '+section.toLowerCase()},[
            previewNode('div',{class:'holo-team-picker-toolbar'},[
              button('Back',()=>edit(null)),
              previewNode('div',{ref:'previewPickerSearch',class:'holo-team-picker-search'},[
                vnode(Search,{label:'Search '+section.toLowerCase()+'s',search:this.previewQuery,
                  'onUpdate:search':value=>{this.previewQuery=value;}}),
              ]),
              section==='Song'?button('Any song',()=>{chooseChart('');edit(null);}):null,
              section==='Card'&&id?button('Clear slot',()=>{this.patchPreviewCard(this.previewSlot,null);edit(null);}):null,
            ]),
            options.length?previewNode('div',{class:'holo-team-person-grid'},options):caption('No matches.'),
          ]);
        }
        const complete=team.cardIds.length===5&&team.cardIds.every(Boolean)&&team.leaderChar&&team.outfitId;
        return previewNode('div',{class:'holo-team-detail-stack'},[
          previewNode('section',{class:'holo-team-preview-setup'},[
            previewNode('h3',{class:'font-semibold'},'Song'),
            previewNode('div',{class:'holo-team-preview-song'},[
              song?image(songJacket(song.songId),'holo-team-jacket',40,40):null,
              previewNode('strong',{},song?.title??'Any song'),
              button('Change',()=>edit('Song'),{'aria-label':'Change preview song'}),
            ]),
            song?detailSwitch('Difficulty',charts.map(chart=>[chart.key,chartName(chart)]),songKey,key=>
              chooseChart(key,charts.some(chart=>chart.key===key&&chart.gameOnly&&!chart.pcEstimate))):null,
            detailSwitch('Platform',charts.some(chart=>chart.key===songKey&&chart.gameOnly&&!chart.pcEstimate)?
              [[false,'Mobile']]:[[false,'Mobile'],[true,'PC']],this.previewPc,value=>{
              if(this.previewPc!==value){this.previewPc=value;this.refreshTeamPreview();}
            }),
          ]),
          previewNode('div',{class:'holo-team-preview-section-head'},[
            previewNode('h3',{class:'font-semibold'},'Team'),
            previewNode('div',{class:'holo-team-options'},[button('Send to tool',()=>edit('Send'),{disabled:!team.cardIds.some(Boolean)}),
            button('Save lineup',()=>{
              const previewTeam={...team,scoringCharts:song?[song]:[],ratingSongs:undefined};
              this.saveResultLineup(previewTeam,null,{pc:this.previewPc});
            },{disabled:!complete||preview?.chartOnly})]),
          ]),
          previewNode('div',{class:'holo-team-preview-lineup'},[
            ...team.cardIds.map((id,index)=>button([
              id?cardFace(id,team.lineup[index],this.cardMember(id)===team.leaderChar):null,
              previewNode('strong',{},id?this.cardName(id):'Choose card'),
            ],()=>{if(!id)edit('Card',index);else this.previewSlot=this.previewSlot===index?null:index;},
            {key:index,class:action+' holo-team-preview-member','aria-pressed':this.previewSlot===index,
              'aria-label':id?'Select '+this.cardName(id):'Choose card for slot '+(index+1)})),
          ]),
          card&&entry?previewNode('div',{class:'holo-team-options'},[
            trainingSelect('Level',1,card.maxLevel,entry.level,level=>this.patchPreviewCard(this.previewSlot,id,{level})),
            trainingSelect('Bloom',0,card.maxBloom,entry.bloom,bloom=>this.patchPreviewCard(this.previewSlot,id,{bloom})),
            button('Change card',()=>edit('Card')),
            button('Clear slot',()=>this.patchPreviewCard(this.previewSlot,null)),
          ]):null,
          previewNode('div',{class:'holo-team-identity text-xs'},[
            button(['Leader',team.leaderChar?portrait(team.leaderChar,24):null,team.leaderName??'Choose leader'],
              ()=>edit('Leader'),{class:action+' holo-team-preview-choice','aria-label':'Change preview leader'}),
            button(['Outfit',team.outfitName??'Choose outfit'],()=>edit('Outfit'),
              {class:action+' holo-team-preview-choice','aria-label':'Change preview outfit',disabled:!team.leaderChar}),
          ]),
          team.outfitDescription?previewNode('div',{class:'holo-team-outfit-skill bg-gray-700/50 rounded text-xs'},[
            previewNode('strong',{},'Outfit skill'),previewNode('p',{},team.outfitDescription.replace(/\[\/?attribute(?:=[^\]]+)?\]/g,'')),
          ]):null,
          previewNode('h3',{class:'font-semibold'},'Information'),
          preview?.backend==='game-pc-estimate'?caption('PC estimate from game chart data.'):null,
          !complete?caption('Choose five cards, a leader and an outfit to calculate details.'):null,
          complete&&preview?previewNode('div',{class:'holo-team-preview-scorebar'},teamMetrics({
            score:preview.score,maxScore:preview.maxScore,eventPointsAvg:preview.eventPointsAvg,eventPointsMax:preview.eventPointsMax,
          }).filter(([label])=>label!=='Unit Score').map(([label,value])=>summaryMetric(label,value))):null,
          complete?previewNode('section',{class:'holo-team-preview-unit'},[
            previewNode('div',{class:'holo-team-preview-section-head'},[
              previewNode('h3',{},['Unit Score ',previewNode('strong',{},count(view?.unitScore)),rank('unit')]),
              preview?.thisSong?detailSwitch('Unit Score view',[['overall','Overall'],['song','This Song']],state.unit,
                value=>{state.unit=value;}):null,
            ]),
            view?previewNode('div',{class:'holo-team-preview-breakdowns'},[
              previewStats('Overall Power',count(view.power),['parameters','board','passive','memory','powerUp','leader']
                .map(key=>[breakdownLabels[key],count(view.breakdown[key])]),rank('power')),
              previewStats('Score Bonus',percent(view.bonuses.total),[
                ['Active Skill','active'],['Outfit Skill','outfit'],['Passive Skill','passive'],
                ['Holomem Board Bonus','board'],['Special Skill','special'],
              ].map(([name,key])=>[name,percent(view.bonuses[key])]),rank('bonus')),
            ]):preview?.error?caption(preview.error):previewNode('p',{role:'status',class:'text-sm text-gray-300'},'Calculating details…'),
          ]):null,
          complete&&preview&&!preview.error?distribution(preview.details,state,preview.simulation):null,
          preview?eventDetails({...team,...preview}):null,
          chartTimeline(team,preview?.chart??preview?.genericChart,preview?.details,state),
          preview?.chartOnly?caption('Team scoring is unavailable for this chart.'):null,
          preview?.chart?vnode(ChartDetailsView,{key:preview.chart.key,chart:preview.chart,
            view:range=>chartDetail(preview.chart,song,range,preview?.details,team)}):null,
          preview?.overall&&!preview.chart?caption('Choose a specific chart to see its score distribution and timeline.'):null,
        ]);
      };
      const amounts=(current,target)=>current===target?count(target):`${current} → ${target}`;
      const trainingTable = rows => h('table',{class:'holo-team-plan-table'},[
        h('thead',{},[h('tr',{},['Card','Level','SP','Bloom'].map(label=>h('th',{scope:'col',key:label},label)))]),
        h('tbody',{},rows.map(row=>h('tr',{key:row.id,'data-card-id':row.id},[
          h('th',{scope:'row'},[h('div',{class:'holo-team-plan-card'},[
            image(game.cardImage(row.id,'grid'),null,44,25),
            h('span',{},[this.cardName(row.id),row.available&&(row.unowned||row.hidden)?
              h('small',{class:'text-gray-300'},[row.unowned?'Card needed':null,row.hidden?'Hidden from materials':null].filter(Boolean).join(' · ')):null]),
          ])]),
          ...(row.available?[amounts(row.currentLevel,row.targetLevel),amounts(row.currentSP,row.targetSP),
            amounts(row.currentBloom,row.targetBloom)].map((value,index)=>h('td',{key:index},value)):
            [h('td',{colspan:3,class:'text-gray-300'},'Unavailable in Planner')]),
        ]))),
      ]);
      const renderTeamPlan = plan => {
        const shortage=(key,label,value)=>h('li',{key:label,class:'holo-team-plan-shortage rounded bg-gray-700/50'},[
          image(resourceImage(key),null,20,20),h('span',{},label),h('strong',{},count(value)),
        ]);
        const hasShortages=plan.missing.length||plan.blooms.length;
        return [h('div',{class:'holo-team-plan'},[
          trainingTable(plan.rows),
          !plan.changed?caption('These targets are already planned or reached.'):null,
          h('section',{class:'holo-team-plan-materials','aria-label':'Missing materials'},[
            h('h3',{class:'font-semibold'},'Missing materials'),
            caption('Includes your existing goals, recorded stock, jars and affordable exchanges.'),
            hasShortages?h('ul',{class:'holo-team-plan-shortages'},[
              ...plan.missing.map(item=>shortage(item.item,game.resourceLabels[item.item],item.missing)),
              ...plan.blooms.map(item=>shortage('bloomPoints',`${this.cardName(item.id)} Bloom Pts`,item.remaining)),
            ]):caption('All planned materials are covered.'),
          ]),
          this.planError?h('p',{role:'alert',class:'text-sm text-amber-300'},this.planError):null,
        ]),h('div',{class:'holo-team-options holo-team-plan-actions'},[
          button('Cancel',this.closePicker),
          button('Add to Planner',this.addTeamPlan,{class:primary,disabled:!plan.changed}),
        ])];
      };
      const lineupContext = row => {
        const [chart]=row.charts;
        const title=chart&&(this.catalog?.songs.find(song=>song.id===chart.songId)?.title??chart.songId);
        if(row.charts.length>1)return `${count(row.charts.length)} rating songs`;
        return title?`${title} · ${capitalize(chart.difficulty)}`:row.objective==='unitScore'?'Unit Score':'Any song';
      };
      const lineupLibrary = () => this.savedLineups.length?h('ul',{class:'holo-saved-lineups'},this.savedLineups.map(row=>h('li',{key:row.id},[
        button([
          h('span',{class:'holo-saved-lineup-art','aria-hidden':'true'},row.cardIds.map(id=>image(game.cardImage(id,'grid'),null,26,15))),
          h('span',{class:'holo-saved-lineup-name'},[h('strong',{},row.name),h('small',{class:'text-gray-300'},lineupContext(row))]),
          icon('chevron-right'),
        ],()=>this.openSavedLineup(row.id),{class:`${action} holo-saved-lineup-row`,'aria-label':`Open ${row.name}`}),
      ]))):caption('Save a team from your optimizer results to find it here.');
      const lineupDetail = row => {
        const leader=this.catalog?.leaders.find(leader=>leader.id===row.leaderChar)?.name??row.leaderChar;
        const outfit=this.catalog?.costumes.find(outfit=>outfit.id===row.outfitId)?.name;
        const reached=row.cardIds.filter((id,index)=>{
          const card=this.ownedById.get(id),target=row.lineup[index];
          return card&&card.level>=target.level&&card.potentialUpgradeCount>=target.bloom;
        }).length;
        const score=this.lineupScore;
        return [
          h('div',{class:'holo-team-options holo-saved-lineup-toolbar'},[
            button('Back to saved lineups',()=>this.openSavedLineup(null),{ref:'savedLineupBack'}),
            button('Rename',()=>{
              this.lineupDeleting=false;this.lineupNameDraft=row.name;
              this.$nextTick(()=>{this.$refs.lineupName?.focus();this.$refs.lineupName?.select();});
            }),
            button('Delete',()=>{this.lineupNameDraft=null;this.lineupDeleting=true;}),
          ]),
          this.lineupNameDraft!==null?h('form',{class:'holo-team-options holo-saved-lineup-edit',onSubmit:event=>{event.preventDefault();this.renameLineup();}},[
            h('input',{ref:'lineupName',class:inputClass,value:this.lineupNameDraft,maxlength:80,'aria-label':'Lineup name',
              onInput:event=>{this.lineupNameDraft=event.target.value;}}),
            h('button',{type:'submit',class:primary,disabled:!this.lineupNameDraft.trim()},'Save name'),
            button('Cancel',()=>{this.lineupNameDraft=null;}),
          ]):null,
          this.lineupDeleting?h('div',{class:'holo-team-options holo-saved-lineup-edit'},[
            h('span',{class:'text-sm'},`Delete ${row.name}?`),
            button('Delete lineup',this.deleteLineup,{class:`${action} text-red-300`}),
            button('Cancel',()=>{this.lineupDeleting=false;}),
          ]):null,
          h('div',{class:'holo-team-identity text-xs'},[
            h('span',{},[portrait(row.leaderChar,24),h('strong',{},leader)]),
            outfit?h('span',{},outfit):null,
            h('span',{},lineupContext(row)),
            h('span',{class:'text-gray-300'},row.boardMode==='none'?'Boards ignored':'Saved Board setup'),
          ]),
          outfitAssumptionSummary(row.outfitAssumption),
          h('ol',{class:'holo-team-lineup holo-saved-lineup-cards','aria-label':'Saved card order'},row.cardIds.map((id,index)=>h('li',{
            key:id,class:'holo-team-slot',
          },[cardFace(id,row.lineup[index],this.cardMember(id)===row.leaderChar),...cardLabels(id)]))),
          this.snapshot?caption(`${reached} / 5 card targets reached · ${this.missingLineupCards.length?`${this.missingLineupCards.length} cards to acquire`:'All cards owned'}`):null,
          h('div',{class:'holo-team-options holo-saved-lineup-edit'},[
            button(this.lineupScoring?'Recalculating…':'Recalculate',this.recalculateLineup,
              {disabled:this.lineupScoring||!this.canRecalculateLineup}),
            button('Plan this team',()=>{this.clearLineupScore();this.openTeamPlan(row);},{class:primary}),
          ]),
          !this.canRecalculateLineup?caption('Add to your owned roster in Characters or import your account.'):null,
          this.lineupError?h('p',{role:'alert',class:'text-sm text-amber-300'},this.lineupError):null,
          score?h('div',{class:'holo-team-estimates holo-saved-lineup-edit','aria-label':'Recalculated scores',role:'status'},[
            summaryMetric('Unit Score',score.displayUnitScore),summaryMetric('Estimated average song score',score.score),
            summaryMetric('Est. max score',score.maxScore),summaryMetric('Avg. event points',score.eventPointsAvg),
            summaryMetric('Max event points',score.eventPointsMax),summaryMetric('Holomem rating',score.rating),
          ]):null,
        ];
      };
      const planResult = team => this.openTeamPlan(team);
      const resultMode=this.resultContext?.mode??this.mode;
      const resultObjective=this.resultContext?.objective??this.objective;
      const resultBaseline=resultMode==='next'&&resultObjective==='score'&&
        (!this.resultContext?.charts.length||this.resultContext?.sortBy==='avg')&&Number.isFinite(this.result?.baseline);
      const renderRows = (teams,openFirst=true,group=null)=>teams.map((team,index)=>h('details',{
        key:`${index}-${team.cardIds.join(',')}`,class:'holo-team-result rounded bg-gray-800',open:openFirst&&index===0,
      },[
        h('summary',{class:'holo-team-result-head'},[
          h('span',{class:'holo-team-result-rank font-semibold'},`#${index+1}`),
          h('span',{class:'holo-team-estimates'},[
            summaryMetric('Estimated average song score',scoreOf(team)),
            summaryMetric(team.reviewedScore?.chartCount?'Avg. chart max':'Est. max score',maxOf(team)),
            summaryMetric('Unit Score',team.displayUnitScore),summaryMetric('Avg. event points',team.eventPointsAvg),
            summaryMetric('Max event points',team.eventPointsMax),summaryMetric('Holomem rating',team.rating),
          ]),
          icon('chevron-right','holo-team-result-chevron'),
        ]),
        h('div',{class:'holo-team-result-body'},[
          h('div',{class:'holo-team-options'},[
            button('Preview details',()=>this.openTeam(team,group),{'aria-haspopup':'dialog'}),
            button('Plan this team',()=>planResult(team),
              {'aria-haspopup':'dialog'}),
            button('Save lineup',()=>this.saveResultLineup(team,group),{'aria-haspopup':'dialog'}),
          ]),
          h('ol',{class:'holo-team-lineup','aria-label':'Ordered lineup'},team.cardIds.map((id,position)=>h('li',{key:id,class:'holo-team-slot'},[
            button([cardFace(id,team.lineup?.[position],this.cardMember(id)===team.leaderChar),...cardLabels(id)],()=>{
              this.previewCard = {id,entry:team.lineup?.[position]};
              this.openPicker('preview');
            },{class:'holo-team-slot-card rounded','aria-label':`Preview ${this.cardName(id)}`,'aria-haspopup':'dialog'}),
          ]))),
          team.leaderName || team.outfitName ? h('div',{class:'holo-team-identity text-xs'},[
            team.leaderName ? h('span',{},[h('span',{class:'text-gray-400'},'Leader'),
              team.leaderChar ? portrait(team.leaderChar,28) : null,h('strong',{},team.leaderName)]) : null,
            team.outfitName ? h('span',{},[h('span',{class:'text-gray-400'},'Outfit'),h('strong',{},team.outfitName)]) : null,
          ]) : null,
          outfitAssumptionSummary(this.resultContext?.outfitAssumption?.outfitId===team.outfitId?this.resultContext.outfitAssumption:null),
          team.outfitDescription ? h('div',{class:'holo-team-outfit-skill bg-gray-700/50 rounded text-xs'},[
            h('span',{class:'holo-encore-label-icon font-semibold text-gray-300'},[icon('star'),'Outfit skill']),
            h('p',{},team.outfitDescription.replace(/\[\/?attribute(?:=[^\]]+)?\]/g,'')),
          ]) : null,
          team.ratingSongs?.length ? h('div',{class:'holo-team-rating-songs'},team.ratingSongs.map(song=>h('div',{key:song.songId,class:'holo-team-rating-song'},[
            image(songJacket(song.songId),'holo-team-jacket',28,28),
            h('span',{},[h('strong',{},song.title),h('small',{class:'text-gray-400'},capitalize(song.difficulty))]),
            h('span',{},[h('strong',{},count(song.rating)),h('small',{class:'text-gray-400'},count(Math.floor(song.score)))]),
          ]))) : null,
          Number.isFinite(team.unitScore) || team.breakdown ? details('Score breakdown',[
            Number.isFinite(team.unitScore) ? h('dl',{class:'holo-team-breakdown'},[metric('Chart base score',team.unitScore)]) : null,
            breakdown(team),
          ]) : null,
          resultBaseline ?
            caption(Math.abs(scoreOf(team)-this.result.baseline)<.5?'Matches the current best':
              `${count(Math.abs(scoreOf(team)-this.result.baseline))} points ${scoreOf(team)>this.result.baseline?'above':'below'} current best`):null,
          upgrades(team),boardPlan(team),
        ]),
      ]));
      const rows=renderRows(this.result?.results??[]);
      const ratingGroups = (this.result?.ratingGroups??[]).map((group,index)=>h('details',{
        key:group.songId,class:'holo-team-result holo-team-rating-group rounded bg-gray-800',open:index===0,
      },[
        h('summary',{class:'holo-team-rating-song'},[
          icon('chevron-right','holo-team-result-chevron'),
          image(songJacket(group.songId),'holo-team-jacket',34,34),
          h('span',{},[h('strong',{},group.title),h('small',{class:'text-gray-400'},capitalize(group.difficulty))]),
          h('span',{},[h('strong',{},`${count(group.rating)} rating`),h('small',{class:'text-gray-400'},count(Math.floor(group.best)))]),
        ]),
        h('div',{class:'holo-team-rating-teams'},[
          ...renderRows(group.results,true,group),
        ]),
      ]));
      const bonusTargets=this.catalog?.boardKeepTargets??[];
      const boardBonusControls=boardBonusGroups.map(([name,art,keys,keepOnly])=>{
        const targets=Array.isArray(keys)?keys.map(id=>bonusTargets.find(target=>target.id===id)).filter(Boolean):
          bonusTargets.filter(({id})=>id.split(':')[0]===keys).sort((a,b)=>a.id.localeCompare(b.id));
        if(!targets.length)return null;
        return h('section',{key:name,class:'holo-board-bonus-group','aria-label':name},[
          h('h4',{class:'holo-board-bonus-heading'},[
            image(`/assets/boards/effects/img_skill_icon_tree_${art}.webp`,null,20,20),
            h('strong',{},name),keepOnly?h('small',{class:'holo-board-keep-only',title:'Preserves existing unlocks only'},'Keep only'):null,
          ]),
          ...targets.map(({id,name:original})=>{
            const variant=id.split(':')[1];
            const label=boardBonusLabels[variant??id]??(variant?original.split(' · ').at(-1):targets.length===1?'':original);
            const value=this.boardKeep[id];
            const policy=value===undefined?'off':value===null?'always':'limit';
            const fieldName=label?`${name} · ${label}`:name;
            const onlyKeep=!keepOnly&&(id==='leaderExp'||id==='leaderGold');
            return h('div',{key:id,class:'holo-board-bonus-row'},[
              h('span',{class:'holo-board-bonus-label'},[label,onlyKeep?h('small',{class:'holo-board-keep-only'},'Keep only'):null]),
              h('div',{class:'holo-board-bonus-policy',role:'group','aria-label':fieldName},[
                h('div',{class:'holo-team-options holo-encore-segments'},[
                  ...[['off','Off',undefined],['always','Always target',null],['limit','Score loss limit',10000]].map(([mode,text,next])=>
                    button(text,()=>{if(policy!==mode)this.setBoardKeep(id,next);},{key:mode,disabled,'aria-pressed':policy===mode,
                      title:mode==='limit'?'Target only if the score loss stays under the limit':undefined})),
                ]),
                policy==='limit'?number(id,null,0,999999999,value,next=>this.setBoardKeep(id,next),`${fieldName} score loss limit`):null,
              ]),
            ]);
          }),
        ]);
      });
      const setupBudget=this.boardBudget;
      const setupBudgetRow=(label,values,extra)=> {
        const entries=Object.entries(values??{}).filter(([,amount])=>amount>0);
        if(!entries.length&&!extra)return null;
        return h('div',{class:'holo-team-board-cost-row'},[
          h('span',{},label),
          ...entries.map(([key,amount])=>{
            const item=boardItems.find(item=>item.key===key)??{key,label:'Hologold'};
            return h('span',{key,class:'holo-team-material',title:item.label},[itemIcon(item,16),count(amount)]);
          }),
          extra?h('span',{},extra):null,
        ]);
      };
      const boardControls = [
        h('div',{class:'holo-board-mode'},[
          choices('boardMode','Holomem Boards',this.hasSavedBoards?boardChoices:boardChoices.filter(([mode])=>mode!=='saved'),
            mode=>mode==='imported'&&!this.hasBoards||mode==='optimize'&&this.catalog?.boardOptimization===false,
            this.effectiveBoards),
          caption(boardDescriptions[this.effectiveBoards]),
        ]),
        this.effectiveBoards==='optimize'?button([
          h('span',{class:'holo-board-protect-icon'},[
            image('/assets/boards/ui_999_ico_lock.webp','',16,16),
          ]),
          h('span',{class:'holo-board-protect-copy'},[
            h('strong',{},'Protect Boards'),
            h('small',{id:'holo-board-protect-hint'},'Keep selected Holomems’ unlocks and Connect cards in place.'),
          ]),
          protectedBoards?h('span',{id:'holo-board-protect-count',class:'holo-board-protect-count'},`${count(protectedBoards)} protected`):null,
          icon('chevron-right','holo-team-choice-arrow'),
        ],()=>this.openPicker('boardProtection'),{
          class:`${action} holo-team-choice holo-board-protect-trigger`,disabled,'aria-haspopup':'dialog',
          'aria-label':'Protect Boards','aria-describedby':protectedBoards?'holo-board-protect-hint holo-board-protect-count':'holo-board-protect-hint',
        }):null,
        this.effectiveBoards==='optimize' ? h('section',{class:'holo-board-settings','aria-label':'Board planning options'},[
          h('h4',{class:'holo-board-section-title'},'Board planning options'),
          h('div',{class:'holo-board-flags holo-team-options'},[
            flag('boardIgnoreExisting','Start from an empty Board'),
            this.boardIgnoreExisting?flag('boardNoRefund','Exclude refunded materials'):null,
            flag('boardUnlimited','Assume infinite cubes and hexas'),
            flag('boardMaxPoints','Assume max Board Points'),
            flag('boardAllInvited','Assume all Holomems invited'),
          ]),
          h('div',{class:'holo-encore-board-controls'},[
            h('div',{class:'holo-encore-board-field',role:'group','aria-label':'Board branches'},[
              h('span',{class:'holo-team-label font-semibold'},'Branches'),
              ...colors.map(([color],index)=>button([itemIcon(boardItems[index*2],18)],()=>{
                this.change('boardBranches',this.boardBranches.includes(color)?this.boardBranches.filter(branch=>branch!==color):[...this.boardBranches,color]);
              },{key:color,class:action+' holo-encore-branch',title:`${capitalize(color)} branch`,'aria-label':`${capitalize(color)} branch`,
                disabled:disabled||this.boardBranches.length===1&&this.boardBranches.includes(color),
                'aria-pressed':this.boardBranches.includes(color)})),
            ]),
            h('div',{class:'holo-encore-board-field',role:'group','aria-label':'Board resets'},[
              h('span',{class:'holo-team-label font-semibold'},'Max resets'),
              h('div',{class:'holo-team-options holo-encore-segments'},[
                button('∞',()=>this.change('boardMaxResets',null),{'aria-label':'Unlimited resets',title:'Unlimited resets',
                  'aria-pressed':this.boardMaxResets===null,disabled}),
                button('Limit',()=>this.change('boardMaxResets',this.boardResetLimit),{'aria-pressed':this.boardMaxResets!==null,disabled}),
              ]),
              this.boardMaxResets!==null?number('boardMaxResets',null,0,9999,this.boardMaxResets,undefined,'Max resets'):null,
            ]),
          ]),
          !this.boardUnlimited ? h('div',{class:'holo-board-materials'},[
            h('div',{class:'holo-board-materials-heading'},[
              h('h5',{class:'holo-board-section-title'},'Available materials'),
              Object.keys(this.boardMaterials).length?button('Use inventory amounts',()=>this.change('boardMaterials',{}),
                {class:action,disabled}):null,
            ]),
            h('div',{class:'holo-encore-material-grid',role:'group','aria-label':'Available Board materials'},
              boardItems.map(item=>number(item.id,[itemIcon(item),h('span',{class:'holo-encore-visually-hidden'},item.label)],0,99999999,
                this.boardStock[item.key],
                value=>this.change('boardMaterials',{...this.boardMaterials,[item.id]:value}),item.label))),
          ]) : null,
          setupBudget?.quote?setupBudgetRow('Reserved for protected Boards',{
            ...setupBudget.reserved.bought,hologold:resetGold(setupBudget.reserved.resets),
          },setupBudget.reserved.resets?`${count(setupBudget.reserved.resets)} resets`:null):null,
          setupBudget?.quote&&setupBudget.startingBill.resets>setupBudget.reserved.resets?setupBudgetRow('Full reset',{
            hologold:resetGold(setupBudget.startingBill.resets-setupBudget.reserved.resets),
          },`${count(setupBudget.startingBill.resets-setupBudget.reserved.resets)} resets`):null,
          setupBudget?.quote?setupBudgetRow('Starting shortfall',setupBudget.quote.short,
            setupBudget.quote.overResets?`${count(setupBudget.quote.overResets)} resets over limit`:null):null,
        ]) : null,
        this.effectiveBoards==='optimize'&&bonusTargets.length ? h('details',{class:'holo-board-bonuses'},[
          h('summary',{class:'holo-board-section-title'},[
            icon('chevron-right','holo-team-result-chevron'),
            h('span',{},'Keep Board bonuses'),
            Object.keys(this.boardKeep).length?h('small',{},`${Object.keys(this.boardKeep).length} active`):null,
          ]),
          caption(this.unitMode?'Keep-only bonuses preserve existing unlocks. Limits use estimated song score.':
            'Keep-only bonuses preserve existing unlocks. Limits use the estimated score.'),
          ...boardBonusControls,
        ]) : null,
      ];
      const chartArtwork=this.ratingMode&&leader?memberIcon(leader.id):chart&&songJacket(chart.songId);
      const chartTitle=this.unitMode?'Unit Score':this.ratingMode?(leader?.name??'Choose a Holomem'):
        (chart?.title??this.eventSong?.title??(this.needsChart?'Choose a song':'Any song'));
      const targetDetail=this.unitMode?'Team power and skill bonuses':this.ratingMode?'Mobile · Holomem Rating':
        `${this.pc?'PC':'Mobile'} · ${chart?chartName(chart):'Chart average'}`;
      const poolOptions=this.rosterSource==='planned'?plannedPools:pools;
      const poolTitle=poolOptions.find(([id])=>id===this.effectivePool)?.[1];
      const boardTitle=boardChoices.find(([id])=>id===this.effectiveBoards)?.[1];
      const modeTitle=modes.find(([id])=>id===this.mode)?.[1];
      const objectiveTitle=objectives.find(([id])=>id===this.objective)?.[1];
      const jacketTile = (className='') => h('span',{class:`holo-encore-jacket ${className}`},[
        chartArtwork?image(chartArtwork,'holo-team-jacket',64,64):icon(this.unitMode||this.ratingMode?'star':'flag'),
      ]);
      const rangeActive=this.difficultyMode==='types'?this.difficultyTypes.length!==difficulties.length:
        this.diffMin!==null||this.diffMax!==null;
      const ratingSongCount=this.ratingMode?this.ratingSongs.filter(song=>this.ratingExtraSongs.includes(song.id)).length:0;
      const eventChapterField=()=>h('div',{class:'holo-team-field'},[
        h('div',{class:'holo-encore-event-pager'},[
          h('span',{class:'holo-team-label font-semibold'},'Chapter'),
          this.eventChapterEventId===this.event.id?button('Use automatic chapter',()=>this.change('eventChapter',null),{disabled}):null,
        ]),
        h('div',{class:'holo-team-options holo-encore-chapters',role:'group','aria-label':'Event chapter'},this.eventChapters.map(chapter=>{
          const member=this.catalog.leaders.find(leader=>leader.id===chapter.characterId);
          const status=eventStatus(this.event,this.eventClock)==='Live'?
            (chapter.number===this.defaultChapter?'Live':chapter.number>this.defaultChapter?'Upcoming':''):'';
          return button([member?portrait(member.id,20):null,h('span',{},`Ch. ${chapter.number}${member?` · ${member.name}`:''}`),
            status?h('small',{class:'text-gray-300'},status):null],()=>this.change('eventChapter',chapter.number),{
            key:chapter.number,class:`${action} holo-encore-chip`,'aria-pressed':chapter.number===this.currentChapter,disabled,
          });
        })),
      ]);
      const eventTarget=()=>this.event?[
        h('div',{class:'holo-team-field'},[
          h('span',{class:'holo-team-label font-semibold'},'Event'),
          button([this.event.art||this.event.bannerHash||this.event.gameReleaseId?eventBanner(this.event,'holo-encore-event-thumb',56,32):icon('calendar'),eventMeta(this.event),
            icon('chevron-right','holo-team-choice-arrow')],()=>this.openPicker('event'),{
            class:`${action} holo-team-choice holo-encore-event-trigger`,disabled,'aria-label':'Choose an event','aria-haspopup':'dialog',
          }),
        ]),
        this.event.metadataOnly?h('ul',{class:'holo-team-notes text-xs text-gray-300'},(this.event.gameChapters??[]).map(chapter=>
          h('li',{key:chapter.number},`${formatDate(chapter.startTime)} · ${chapter.characterName??chapter.title}${chapter.songTitle?' · '+chapter.songTitle:''}`))):null,
        this.objective==='eventPoints'&&this.eventChapters.length>1?eventChapterField():null,
        this.event.metadataOnly?null:button([h('span',{class:'holo-encore-jacket'},[
          this.eventSong&&songJacket(this.eventSong.id)?image(songJacket(this.eventSong.id),'',46,46):icon('flag'),
        ]),h('span',{},[h('strong',{},chartTitle),h('small',{},'Song')]),icon('chevron-right')],()=>this.openPicker('eventSong'),{
          class:'holo-encore-chart','aria-label':this.objective==='event'?'Choose an event song':'Choose a song','aria-haspopup':'dialog',disabled,
        }),
        !this.event.metadataOnly&&this.eventSongCharts.length?h('div',{class:'holo-team-options',role:'group','aria-label':'Song difficulty'},this.eventSongCharts.map(option=>
          button(chartName(option),()=>{
            const prefix=this.objective==='event'?'eventScore':'eventPoints';
            this[`${prefix}SongId`]=this.eventSong.id;
            this.chooseScoringChart(`${prefix}ChartKey`,option);
          },{key:option.key,class:`${action} holo-team-difficulty`,'data-difficulty':option.difficulty,
            'aria-pressed':chart?.key===option.key,disabled}))):null,
      ]:[caption(this.catalog?'No eligible events are available in this catalog.':'Loading events…')];
      const panels={
        build:[
              choices('rosterSource','Card source',[['owned','Use Owned Cards'],['planned','Use Planned Cards']]),
              buildChoices(),
        ],
        target:[
              objectiveChoices(),
              ...(this.eventMode?eventTarget():[]),
              this.unitMode||this.eventMode ? null : this.ratingMode ? h('div',{class:'holo-encore-inline-fields holo-encore-rating-fields'},[
                field('Rating leader',searchChoice('leader','Choose a Holomem',chartTitle,false,leader&&memberIcon(leader.id)),
                  {label:'Clear Rating leader',clear:()=>this.chooseLeader('',false),show:!!this.activeLeaderId}),
                number('ratingMaxDifficulty','Max difficulty',this.difficultyBounds[0],this.difficultyBounds[1],this.ratingDifficulty,undefined,undefined,
                  {label:'Reset max difficulty',clear:()=>this.change('ratingMaxDifficulty',null),show:this.ratingMaxDifficulty!==null}),
              ]) : clearable(button([jacketTile(),h('span',{},[h('strong',{},chartTitle),
                h('small',{},chart?chartName(chart):this.needsChart?'Select an event song and difficulty':'Average across a selection of charts')]),
                icon('chevron-right')],()=>this.openPicker('chart'),{class:'holo-encore-chart','aria-label':'Choose a chart',
                'aria-haspopup':'dialog',disabled}),
                {label:this.needsChart?'Clear chart':'Use any song',clear:()=>this.change('chartKey',''),show:!!chart},true),
              !this.ratingMode&&!this.unitMode ? h('div',{class:'holo-team-options'},[
                choices('pc','Platform',[[false,'Mobile'],[true,'PC']],value=>value&&chart?.gameOnly&&!chart.pcEstimate),
                !chart&&!this.needsChart?choices('difficultyMode','Average charts by',[['levels','Level range'],['types','Difficulty']]):null,
              ]) : null,
              !this.ratingMode && !this.unitMode && !chart && !this.needsChart ? h('div',{class:'holo-team-range'},[
                this.difficultyMode==='types'?h('div',{class:'holo-team-options','aria-label':'Chart difficulties',role:'group'},
                  difficulties.map(type=>{
                    const selected=this.difficultyTypes.includes(type);
                    return button(capitalize(type),()=>this.change('difficultyTypes',selected?
                      this.difficultyTypes.filter(value=>value!==type):[...this.difficultyTypes,type]),
                    {key:type,'aria-pressed':selected,disabled:disabled||selected&&this.difficultyTypes.length===1});
                  })):null,
                this.difficultyMode==='levels'?number('diffMin','Difficulty minimum',this.difficultyBounds[0],this.upperDifficulty,this.lowerDifficulty):null,
                this.difficultyMode==='levels'?number('diffMax','Difficulty maximum',this.lowerDifficulty,this.difficultyBounds[1],this.upperDifficulty):null,
                h('div',{class:'holo-team-options holo-encore-range-actions'},[
                  caption(`Averaging ${count(this.rangeCharts)} charts`),
                  rangeActive?button('Reset range',this.resetDifficultyRange,{disabled}):null,
                ]),
              ]) : null,
              this.ratingMode ? h('div',{class:'holo-team-options'},[
                flag('ratingAllSongs','Include locked songs'),
                !this.ratingAllSongs ? searchChoice('ratingSongs','Additional unlocked songs',
                  ratingSongCount?`Additional songs · ${ratingSongCount}`:'Additional unlocked songs',!leader) : null,
              ]) : null,
              this.objective==='eventPoints' ? h('div',{class:'holo-encore-inline-fields holo-encore-event-options'},[
                number('liveBoost','Live Boost',1,10),
                h('div',{class:'holo-team-options'},[
                  check('HoloPassport',this.passport,value=>this.change('passportOverride',value)),
                  this.passportOverride!==null?button('Use profile HoloPassport',()=>this.change('passportOverride',null),
                    {class:action+' holo-encore-inline-reset',disabled}):null,
                ]),
              ]) : null,
        ],
        lineup:[
              h('div',{class:'holo-lineup-pool'},[
                select(this.poolKey,'Card pool',poolOptions),
                this.rosterSource==='planned'&&this.useOwned?caption(count(this.plannedCards.length)+' active Planner cards'):
                  caption(poolHints[this.effectivePool]),
                ...(this.customPool?lineupAssumptions():[]),
                this.mode==='next'?h('div',{class:'holo-lineup-next'},[
                  h('span',{class:'holo-team-label font-semibold'},'Acquisition'),
                  choices('nextAcquisition','Acquisition',nextAcquisitionChoices),
                  details('Exchange balances',[h('div',{class:'holo-encore-inline-fields'},
                    activeGachaCurrencies(this.eventClock,this.optimizerSource?.exchangeCatalog).map(([point,currency])=>{
                      const amount=this.gachaPoints[point];
                      return field(currency,h('input',{class:inputClass,type:'text',inputmode:'numeric','aria-label':currency,
                        value:amount==null?'':formatNumber(BigInt(amount)),placeholder:'Unknown',disabled,
                        onChange:event=>this.updateGachaBalance(point,event)}));
                    })),this.gachaError?h('p',{class:'text-red-400',role:'alert'},this.gachaError):null]),
                ]):null,
                this.mode==='next'&&(this.effectivePool!=='allMaxed'||this.activeOutfitAssumption)?nextCardAssumptions():null,
              ]),
              this.mode==='best' ? null : h('div',{class:'holo-team-options'},[
                searchChoice('cards','Lock cards',`Lock cards · ${this.lockedCardIds.length} / 5`,!this.candidates.length),
                ...this.lockedCardIds.map(id=>button([this.cardMember(id)?portrait(this.cardMember(id),18):null,this.cardName(id),icon('x')],
                  ()=>this.toggleCard(id),{key:id,class:action+' holo-encore-chip',disabled,'aria-label':`Unlock ${this.cardName(id)}`})),
              ]),
              h('div',{class:'holo-encore-inline-fields holo-encore-lineup-fields'},[
                this.ratingMode?null:h('div',{class:'holo-lineup-leader'},[field('Leader',searchChoice('leader','Choose a leader',
                  leader?.name??(this.allLeaders?'Any Holomem':'Any invited Holomem'),false,leader&&memberIcon(leader.id)),
                  {label:'Use any leader',clear:()=>this.chooseLeader('',false),show:!!this.activeLeaderId}),
                  flag('allLeaders','All Holomems',!!leader),
                ]),
                h('div',{class:'holo-lineup-leader'},[
                  field('Outfit',searchChoice('outfit','Choose an outfit',
                    outfit?.name??(this.activeLeaderMode==='holomem'?'From a locked card':'Best the leader owns'),
                    !leader&&this.mode!=='holomem',outfit?.cardId?cardPortrait(outfit.cardId):outfit?.characterId?memberIcon(outfit.characterId):null),
                    {label:'Use automatic outfit',clear:()=>this.chooseOutfit(null,'auto',false),show:this.activeLeaderMode!=='auto'}),
                  outfitAssumptionSummary(this.activeOutfitAssumption),
                ]),
              ]),
        ],
        boards:boardControls,
        run:[
              this.ratingMode?flag('ratingMerge','Use one team across songs'):null,
              h('div',{class:'holo-encore-run-fields'},[
                !this.ratingMode||this.ratingMerge ? number('topN','Teams to show',1,25) : null,
                !this.unitMode?h('div',{class:'holo-team-field'},[
                  h('span',{class:'holo-team-label font-semibold'},'Search sorting'),
                  choices('sortBy','Search sorting',[['avg','Average score'],['max','Max score']],
                    value=>value==='max'&&!chart&&!this.ratingMode,chart||this.ratingMode?this.sortBy:'avg','holo-encore-sort'),
                ]):null,
                this.ratingMode?number('ratingSongCount','Suggested songs',1,10):null,
                this.ratingMode&&!this.ratingMerge?number('ratingTeamsPerSong','Teams per song',1,5):null,
              ]),
        ],
      };
      const blocker=this.searchBlocker;
      const runAction=disabled?button('Cancel',this.stopWorker):
        button('Find best teams',this.searchTeams,{class:primary,disabled:!this.canSearch});
      const stepNotes={
        build:modeTitle,
        target:this.unitMode?objectiveTitle:`${objectiveTitle} · ${chartTitle}`,
        lineup:`${this.lockedCardIds.length&&this.mode!=='best'?`${this.lockedCardIds.length} locked · `:''}${poolTitle}`,
        boards:boardTitle,
        run:disabled?'Searching':this.resultsChanged?'Setup changed':this.result?'Results ready':this.ratingMode&&!this.ratingMerge?
          `${this.ratingSongCount} songs`:`${this.topN} teams`,
      };
      const workflow = h('div',{class:'holo-team-settings holo-encore-steps','aria-label':'Search setup'},steps.map(([id,label],index)=>{
        const open=this.activeStep===id;
        const headId='holo-encore-'+id;
        return h('section',{key:id,class:'holo-encore-step','data-open':open?'true':undefined},[
          h('h2',{},[button([
            h('span',{class:'holo-encore-step-number','aria-hidden':'true'},String(index+1).padStart(2,'0')),
            h('span',{class:'holo-encore-step-title'},label),
            !open?h('span',{id:headId+'-summary',class:'holo-encore-step-summary'},stepNotes[id]):null,
            icon('chevron-down','holo-encore-chevron'),
          ],()=>this.goToStep(open?null:id),{id:headId,ref:'encore-'+id,class:'holo-encore-step-button',
            'aria-label':label,'aria-expanded':String(open),'aria-controls':headId+'-panel',
            'aria-describedby':open?undefined:headId+'-summary'})]),
          h('div',{id:headId+'-panel',class:'holo-encore-step-body',hidden:!open,role:'region','aria-labelledby':headId},[
            ...panels[id],
            id==='run'&&blocker&&!disabled?h('div',{class:'holo-encore-notice'},[
              icon('information-circle'),h('span',{},blocker[1]),
              button('Review '+steps.find(([key])=>key===blocker[0])[1],()=>this.goToStep(blocker[0],true)),
              this.rosterSource==='planned'&&this.useOwned&&blocker[0]==='lineup'?button('Open Planner',()=>this.$router.push('/planner')):
                this.rosterSource==='owned'&&!this.ownedCards.length&&this.useOwned?button('Open Characters',()=>this.$router.push('/characters')):null,
            ]):null,
            id==='run'&&this.error?h('div',{class:'holo-encore-notice',role:'alert'},[icon('exclamation-circle'),h('span',{},this.error),
              this.gpuError?button('Open Settings',()=>this.$router.push('/settings')):null,
            ]):null,
            h('div',{class:'holo-encore-step-actions'},[
              index>0?button('Back',()=>this.goToStep(steps[index-1][0],true)):null,
              id==='run'&&this.result?button('View results',this.showResults):null,
              id==='run'?runAction:button('Continue',()=>this.goToStep(steps[index+1][0],true),{class:primary}),
            ]),
          ]),
        ]);
      }));
      const inputList = entries => h('dl',{class:'holo-encore-facts'},entries.filter(Boolean).map(([label,value])=>
        h('div',{key:label},[h('dt',{},label),h('dd',{},[value])])));
      const briefChoices=[
        ['Build',modeTitle],this.unitMode?null:['Objective',objectiveTitle],['Lineup',stepNotes.lineup],
        this.mode==='next'&&this.nextAcquisition!=='any'?
          ['Acquisition',nextAcquisitionChoices.find(([id])=>id===this.nextAcquisition)?.[1]]:null,
        ['Leader',leader?h('span',{class:'holo-encore-fact-person'},[portrait(leader.id,18),leader.name]):
          this.ratingMode?'Not selected':'Automatic'],['Boards',boardTitle],
      ];
      const brief = h('aside',{class:'holo-encore-brief','aria-label':'Search brief'},[
        h('div',{class:'holo-encore-brief-heading'},[jacketTile(),h('div',{},[
          h('h2',{class:'font-semibold'},'Search brief'),
          h('strong',{},chartTitle),h('small',{},targetDetail),
        ])]),
        this.result?null:inputList(briefChoices),
        details('Inputs used',[inputList([
          ...(this.result?briefChoices:[]),
          ['Search processor',this.result||this.searching ?
            (this.searchBackend==='gpu'?'GPU':this.searchBackend==='cpu'?'CPU':this.useGpu?'Starting GPU':'CPU') :
            (this.useGpu?'GPU enabled':'CPU')],
          this.result?.scoringModel?['Scoring model',this.result.scoringModel==='mobile'?'Mobile game model':
            this.result.scoringModel==='steam'?'Steam game model':
            this.result.scoringModel==='game-pc-estimate'?'PC estimate from game charts':'Score estimate']:null,
          this.rosterSource==='planned'?['Planned cards',count(this.plannedCards.length)]:this.useOwned?['Owned cards',count(this.ownedCards.length)]:null,
          ['Invited Holomems',count(this.members.length)],
          ['Outfit',outfit?h('span',{class:'holo-encore-fact-person'},[
            outfit.cardId?image(cardPortrait(outfit.cardId),'holo-team-outfit-icon',16,20):portrait(outfit.characterId,18),outfit.name,
          ]):(this.activeLeaderMode==='holomem'?'From a locked card':'Automatic')],
          ['Memory bonus',this.profile?.account?.memoryBonusPermil!==undefined?'Current bonus':'From Memory count'],
          ['Member Power-Up',h('select',{class:inputClass+' holo-encore-power-up','aria-label':'Member Power-Up preset',
            disabled:disabled||!this.catalog,value:this.powerUpPreset,onChange:event=>this.change('powerUpPreset',event.target.value)},
          this.powerUpChoices.map(([id,label])=>h('option',{key:id,value:id},label)))],
          this.effectiveBoards==='optimize'?['Board Points',this.boardMaxPoints?'Maximum assumed':
            !this.boardIgnoreExisting&&this.snapshot?.tables.boardPoints?.length?'Checked against import':'From rank and unlocks']:null,
          this.effectiveBoards==='optimize'&&protectedBoards?['Protected Boards',count(protectedBoards)]:null,
          this.ratingMode?['Song access',this.ratingAllSongs?'All eligible songs assumed':
            `${this.automaticSongs.size} automatic · ${this.ratingExtraSongs.length} manual`]:null,
        ])]),
      ]);
      const rankOverrides=this.result?.boardRankOverrides??[];
      const progressFraction=Number.isFinite(this.progress?.fraction)?Math.max(0,Math.min(.99,this.progress.fraction)):0;
      const ranksToSync=rankOverrides.filter(({characterId,planned,rank})=>{
        const bounds=this.profile?.account&&accountProgressRank(this.profile.account,characterId,rank);
        return bounds&&rank>=bounds.min&&rank<=bounds.max&&planned!==rank;
      }).map(row=>row.characterId);
      return h('section',{class:'holo-team','aria-label':'Team Optimizer'},[
        h('header',{class:`${headingClass} holo-encore-header`},[
          h('h1',{class:titleClass},'Team Optimizer'),
          h('div',{class:'holo-saved-lineup-toolbar'},[
            this.catalog?h('div',{class:'holo-encore-progress','aria-hidden':'true'},steps.map(([id])=>
              h('span',{key:id,'data-visited':this.visitedSteps.includes(id)?'true':undefined,'data-current':this.activeStep===id?'true':undefined}))):null,
            this.catalog?button('Saved lineups',()=>this.openSavedLineup(null),{'aria-haspopup':'dialog'}):null,
          ]),
        ]),
        !this.catalog ? h('p',{class:'mt-4 text-sm text-gray-300',role:'status'},[
          this.error||'The local optimizer catalog could not open.',' ',
          button('Retry',this.loadCatalog,{disabled:this.catalogLoading}),
        ]) : [
          h('div',{class:'holo-team-workspace'},[
          workflow,
          brief,
          h('section',{ref:'encoreResults',tabindex:-1,class:'holo-team-results','aria-label':'Team search results'},this.result ? [
            h('div',{class:'holo-team-results-heading'},[
              h('h2',{class:'font-semibold'},resultObjective==='unitScore'?'Best Unit Score teams':resultObjective==='holomemLb'?'Holomem Rating':resultMode==='next'?'Best next cards':'Your best teams'),
              button('Clear Results',this.clearResult),
            ]),
            this.resultsChanged?h('p',{class:'text-xs text-gray-400',role:'status'},'These results use your previous search setup. Run again to apply changes.'):null,
            this.result.scoringModel==='game-pc-estimate'?caption('PC estimate from game chart data.'):null,
            resultObjective==='holomemLb'?h('p',{class:'text-xs text-gray-400',role:'status'},
              `${count(this.result.ratingTotal)} ${this.result.byMax?'max rating':'rating'}`):null,
            this.result.excluded?caption(`${count(this.result.excluded)} cards excluded`):null,
            this.result.boardWarnings?.length?h('div',{class:'holo-encore-notice',role:'status'},[
              icon('information-circle'),
              h('ul',{class:'holo-team-board-warnings'},this.result.boardWarnings.map(warning=>h('li',{key:warning},warning))),
            ]):null,
            rankOverrides.length?h('div',{class:'holo-encore-notice'},[
              icon('information-circle'),
              h('span',{},`Board Points use your planner ranks: ${rankOverrides
                .map(({name,planned,rank})=>`${name} ${planned} (imported ${rank})`).join(', ')}.`),
              ranksToSync.length?button('Use imported ranks',()=>window.__holodoriDesktop.setAccountProgress(this.profileId,{
                kind:'use-imported-ranks',characterIds:ranksToSync,
              })):button('Review ranks',()=>this.$router.push('/progress')),
            ]):null,
            resultBaseline ?
              caption(`Current best · ${count(this.result.baseline)} estimated average song score`) : null,
            ...rows,
            ...ratingGroups,
            !rows.length&&!ratingGroups.length ? caption(resultMode==='next'&&this.resultContext?.nextAcquisition!=='any'?
              'No upgrade team matched this acquisition filter.':'No supported team matched these options.') : null,
          ] : [h('div',{class:'holo-team-result-placeholder bg-gray-800 rounded'},[
            h('h2',{class:'font-semibold'},this.resultsChanged&&!disabled?'Setup changed':'Results'),
            this.searching?h('div',{class:'holo-encore-search-progress'},[
              h('div',{class:'holo-encore-search-status text-sm text-gray-400'},[
                h('span',{role:'status'},this.progress?.phase?`${this.progress.phase}…`:'Searching teams…'),
                h('span',{class:'holo-encore-search-percent','aria-hidden':'true'},formatNumber(progressFraction,{style:'percent'})),
              ]),
              h('progress',{class:'holo-encore-meter',max:1,value:progressFraction,'aria-label':'Team search progress'}),
            ]):h('p',{class:'text-sm text-gray-400',role:'status'},this.resultsChanged?
              'Run again to see teams for your new choices.':'Your ranked teams will appear here.'),
            this.activeStep!=='run'?button(disabled?'View search':'Go to Run',()=>this.goToStep('run',true)):null,
          ])]),
          ]),
          vnode(Dialog,{visible:this.pickerVisible,'onUpdate:visible':visible=>{if(!visible)this.closePicker();},
            onShow:this.focusPickerSearch,onAfterHide:this.finishPicker,
            header:pickerTitles[this.picker],modal:true,draggable:false,dismissableMask:true,position:'top',
            class:this.picker==='outfit'?'holo-team-dialog holo-outfit-dialog':'holo-team-dialog',contentClass:pickerContentClass,
            style:{width:this.picker==='preview'?'320px':this.picker==='team'?'1040px':this.picker==='outfit'?'880px':'650px',
              maxWidth:'calc(100vw - 24px)',maxHeight:'calc(100dvh - 24px)'},
          },{default:()=>this.picker==='preview' && this.previewCard ? [h('div',{class:'holo-team-card-preview'},[
            cardFace(this.previewCard.id,this.previewCard.entry),
            caption(this.catalog.cardDetails[this.previewCard.id]?.member ?? ''),
          ])] : this.picker==='team'&&this.previewTeam ? [vnode(TeamDetailsView,{
            report:this.reviewDetails,
            view:(state,report)=>teamDetails(this.previewTeam,state,report),
          })] :
            this.picker==='plan-team' ? this.teamPlan&&renderTeamPlan(this.teamPlan) :
            this.picker==='saved-lineups'?lineupLibrary():
            this.picker==='saved-lineup'&&this.savedLineup?lineupDetail(this.savedLineup):
            this.picker==='event'?eventDialog():this.picker==='outfit'?outfitCarousel():this.picker ? [
            h('div',{class:multiSelectPicker?'holo-team-picker-toolbar holo-team-picker-toolbar-stacked':'holo-team-picker-toolbar'},[
              h('div',{ref:'pickerSearch',class:'holo-team-picker-search'},[
                vnode(Search,{label:pickerLabels[this.picker],clearLabel:'Clear search',search:this.query,'onUpdate:search':this.searchPicker}),
              ]),
              pickerOptions(),
            ]),
            h('div',{ref:'pickerList',class:'holo-team-picker-list'},pickerBody()),
          ] : []}),
        ],
      ]);
    },
  };
}
