import {accountRosterBranches} from '../hololive/vendor/shared/account-data';
import {formatDateTime,formatNumber} from './regional-formats';
import {leaderboardRegions as regions,leaderboardRegionKey,selectedLeaderboardRegion,
  projectedLeaderboardPlace,formatLeaderboardPlace,leaderboardStandingsUpdated} from './leaderboard-placement';
import {renderPickerChoice,renderHolomemChoices} from './optimizer-picker-controls';

const members=accountRosterBranches.flatMap(branch=>branch.generations.flatMap(group=>group.characters));
const memberIds=[...new Set(members.map(member=>member.id))];
const storageKey='holomemLeaderboardMember';
const refreshInterval=15*60*1000;
let artwork;
let gameRefresh;

function projectionFromQuery({holomem,region,rating}) {
  if(!members.some(member=>member.id===holomem)||typeof region!=='string'||!Object.hasOwn(regions,region)||
    typeof rating!=='string'||!/^\d+$/.test(rating))return null;
  const value=Number(rating);
  return Number.isSafeInteger(value)&&value>0?{memberId:holomem,region,rating:value}:null;
}

async function loadArtwork() {
  if(artwork)return artwork;
  const response=await fetch('/assets/leaderboards/index.json');
  if(response.ok)artwork=Object.freeze(await response.json());
  return artwork;
}

export function createHolomemLeaderboards({h,reactive,vnode,resolve,Search,Dialog,headingClass,titleClass}) {
  const portrait=(assetId,size,className)=>h('img',{class:className,src:`/assets/members/${assetId}.webp`,
    width:size,height:size,alt:'',loading:'lazy',decoding:'async',draggable:false});
  return {
    data() {
      const saved=sessionStorage.getItem(storageKey);
      const projection=projectionFromQuery(this.$route.query);
      return {memberId:projection?.memberId??members.find(member=>member.id===saved)?.id??members[0].id,
        region:projection?.region??selectedLeaderboardRegion(sessionStorage),board:null,available:null,
        syncing:false,refreshJob:null,refreshError:'',active:true,boardRequest:0,feedRequest:0,timer:null,artwork:null,revealedProjection:null,
        pickerVisible:false,pickerQuery:''};
    },
    computed:{
      profile(){return window.__seelieApp?.account??'main';},
      refreshing(){return this.refreshJob!==null;},
      member(){return members.find(member=>member.id===this.memberId);},
      matchingMembers(){
        const query=this.pickerQuery.trim().toLocaleLowerCase();
        return members.filter(member=>member.name.toLocaleLowerCase().includes(query));
      },
      boardSelection(){return [this.profile,this.memberId,this.region];},
      projection(){return projectionFromQuery(this.$route.query);},
      projectedPlacement(){
        const target=this.projection;
        if(!target||!this.board||target.memberId!==this.memberId||target.region!==this.region)return null;
        const rows=this.board.rows.slice(0,100);
        const place=projectedLeaderboardPlace(rows.map(({rank,rating})=>[rank,rating]),target.rating);
        if(!place)return null;
        const next=rows.findIndex(row=>row.rating<target.rating);
        return {label:formatLeaderboardPlace(place),index:next<0?rows.length:next,rating:target.rating};
      },
    },
    watch:{
      boardSelection(){this.refreshError='';this.readBoard();},
      region(){
        this.available=null;
        this.sync();
      },
      projection(target){
        this.revealedProjection=null;
        if(target){
          this.memberId=target.memberId;
          this.region=target.region;
        }
      },
      projectedPlacement(place){
        const route=this.$route.fullPath;
        if(!place||this.revealedProjection===route)return;
        this.$nextTick(()=>{
          const row=this.$refs.projectedRow;
          if(!row?.isConnected||this.$route.fullPath!==route)return;
          this.revealedProjection=route;
          row.scrollIntoView({block:'center'});
          row.focus({preventScroll:true});
        });
      },
    },
    mounted(){
      loadArtwork().then(assets=>{this.artwork=assets;}).catch(()=>{});
      this.readBoard();
      this.sync();
      if(gameRefresh)void this.followGameRefresh(gameRefresh);
      this.timer=setInterval(()=>{if(!this.syncing&&!this.refreshing)this.sync(true);},refreshInterval);
    },
    beforeUnmount(){this.active=false;clearInterval(this.timer);this.boardRequest++;this.feedRequest++;},
    methods:{
      openMemberPicker(){
        this.pickerQuery='';
        this.pickerVisible=true;
      },
      searchMembers(query){
        this.pickerQuery=query;
        if(this.$refs.memberChoices)this.$refs.memberChoices.scrollTop=0;
      },
      focusMemberSearch(){
        this.$nextTick(()=>{
          if(!this.pickerVisible)return;
          const input=this.$refs.memberSearch?.querySelector('input');
          input?.setAttribute('autofocus','');
          input?.focus({preventScroll:true});
        });
      },
      selectMember(id){
        this.chooseBoard('memberId',id);
        this.pickerVisible=false;
      },
      chooseBoard(key,value){
        if(this[key]===value)return;
        this[key]=value;
        sessionStorage.setItem(key==='memberId'?storageKey:leaderboardRegionKey,value);
        if(this.projection)void this.$router.replace('/leaderboards');
      },
      backToResults(){
        const previous=this.$router.options.history.state.back;
        if(previous&&this.$router.resolve(previous).path==='/team-optimizer')this.$router.back();
        else void this.$router.push('/team-optimizer');
      },
      async readBoard(clear=true){
        const request=++this.boardRequest;
        if(clear)this.board=null;
        try {
          const board=await window.__TAURI__.core.invoke('desktop_holomem_leaderboard',{
            profile:this.profile,character:this.memberId,region:this.region,
          });
          if(request===this.boardRequest)this.board=board;
        } catch {
          if(clear&&request===this.boardRequest)this.board=null;
        }
      },
      async refreshFromGame(){
        if(gameRefresh||this.refreshing)return;
        this.refreshError='';
        const job=reactive({region:this.region,completed:0});
        job.promise=Promise.resolve().then(()=>{
          const {Channel,invoke}=window.__TAURI__.core;
          const onProgress=new Channel();
          onProgress.onmessage=completed=>{job.completed=completed;};
          return invoke('desktop_refresh_holomem_from_game',{members:memberIds,region:job.region,onProgress});
        }).then(()=>window.dispatchEvent(new CustomEvent(leaderboardStandingsUpdated,{detail:job.region})));
        gameRefresh=job;
        try{
          await this.followGameRefresh(job);
        }finally{
          gameRefresh=null;
        }
      },
      async followGameRefresh(job){
        const selected=()=>this.active&&job.region===this.region;
        this.refreshJob=job;
        try{
          await job.promise;
          if(selected()){
            this.available=true;
            await this.readBoard(false);
          }
        }catch(error){
          if(selected())this.refreshError=String(error?.message??error??'Could not refresh from the game.')
            .replace('before importing.','before refreshing.');
        }finally{
          this.refreshJob=null;
        }
      },
      async sync(force=false){
        const request=++this.feedRequest;
        this.syncing=true;
        try {
          const available=await window.__TAURI__.core.invoke('desktop_refresh_holomem_rankings',{region:this.region,force});
          if(request!==this.feedRequest)return;
          this.available=available;
          if(available)await this.readBoard(false);
        } catch {
          if(request===this.feedRequest)this.available=false;
        } finally {
          if(request===this.feedRequest)this.syncing=false;
        }
      },
    },
    render() {
      const job=this.refreshJob;
      const caption=job?`Refreshing ${regions[job.region]} rankings · ${formatNumber(job.completed)} / ${formatNumber(memberIds.length)}`:
        this.board?(this.available===false?'Last saved ':'Captured ')+formatDateTime(this.board.capturedAt):
          this.syncing?'Loading standings…':'';
      const graphic=(asset,kind)=>asset?h('img',{
        key:asset.file,class:'holo-leaderboards-'+kind,src:'/assets/'+asset.file,
        width:asset.width,height:asset.height,alt:asset.label||'',title:asset.label||undefined,
        loading:'lazy',decoding:'async',
      }):null;
      const player=row=>{
        const fanMark=this.artwork?.fanMarks?.[row.fanMarkId];
        const emblems=(row.emblems??[]).map(id=>this.artwork?.emblems?.[id]).filter(Boolean);
        return h('div',{class:'holo-leaderboards-player'},[
          h('span',{class:'holo-leaderboards-identity'},[
            h('bdi',{title:row.name||undefined},row.name||'—'),graphic(fanMark,'fan-mark'),
          ]),
          emblems.length?h('span',{class:'holo-leaderboards-emblems'},emblems.map((asset,index)=>
            h('span',{key:index},[graphic(asset,'emblem')]))):null,
        ]);
      };
      const rows=this.board?.rows.map((row,index)=>h('tr',{key:index},[
        h('td',null,formatNumber(row.rank)),
        h('td',null,[player(row)]),
        h('td',null,formatNumber(row.rating)),
      ]));
      const placement=this.projectedPlacement;
      if(placement)rows.splice(placement.index,0,h('tr',{key:'projection',ref:'projectedRow',
        tabindex:-1,class:'holo-leaderboards-projection'},[
        h('td',null,placement.label),
        h('th',{scope:'row'},'Your optimized rating'),
        h('td',null,formatNumber(placement.rating)),
      ]));
      return h('section',{class:'holo-leaderboards','aria-label':'Holomem Leaderboards'},[
        h('header',{class:headingClass},[h('h1',{class:titleClass},'Holomem Leaderboards')]),
        h('div',{class:'holo-leaderboards-toolbar'+(this.projection?' holo-leaderboards-toolbar-projecting':'')},[
          this.projection?h('button',{type:'button',class:'h-8 rounded bg-gray-700 px-3 text-sm font-semibold hover:bg-gray-600',
            onClick:this.backToResults},'Back to results'):null,
          renderPickerChoice(h,{value:this.member.name,media:portrait(this.member.assetId,24,'holo-team-choice-icon'),
            arrow:vnode(resolve('chevron-right-icon'),{class:'holo-team-choice-arrow','aria-hidden':'true'}),
            label:`Choose a Holomem, ${this.member.name} selected`,onClick:this.openMemberPicker,expanded:this.pickerVisible,
          }),
          h('div',{class:'holo-leaderboards-regions',role:'group','aria-label':'Region'},Object.entries(regions).map(([id,label])=>
            h('button',{key:id,type:'button','aria-pressed':this.region===id,
              onClick:()=>this.chooseBoard('region',id)},label))),
          h('button',{type:'button',class:'h-8 rounded bg-gray-700 px-3 text-sm font-semibold hover:bg-gray-600',
            disabled:this.refreshing,'aria-busy':this.refreshing||undefined,onClick:this.refreshFromGame},'Refresh'),
          h('span',{class:'text-xs text-gray-400','aria-live':'polite'},caption),
        ]),
        this.refreshError?h('p',{class:'text-sm text-red-400 mb-2',role:'alert'},this.refreshError):null,
        rows?.length?h('table',{class:'holo-leaderboards-table'+(placement?' holo-leaderboards-table-projecting':''),
          'aria-label':this.member.name+' rankings'},[
          h('thead',null,[h('tr',null,['Rank','Player','Rating'].map(label=>h('th',{scope:'col'},label)))]),
          h('tbody',null,rows),
        ]):h('p',{class:'text-sm text-gray-400',role:'status'},this.board?'No ranked players for this Holomem.':
          this.syncing||this.refreshing?'':'No standings available for this region yet.'),
        vnode(Dialog,{visible:this.pickerVisible,'onUpdate:visible':visible=>{this.pickerVisible=visible;},
          onShow:this.focusMemberSearch,header:'Choose a Holomem',modal:true,draggable:false,dismissableMask:true,
          position:'top',class:'holo-team-dialog',contentClass:'holo-team-picker-content',
          style:{width:'650px',maxWidth:'calc(100vw - 24px)',maxHeight:'calc(100dvh - 24px)'},
        },{default:()=>[
          h('div',{class:'holo-team-picker-toolbar'},[
            h('div',{ref:'memberSearch',class:'holo-team-picker-search'},[
              vnode(Search,{label:'Search Holomems',clearLabel:'Clear search',search:this.pickerQuery,'onUpdate:search':this.searchMembers}),
            ]),
          ]),
          h('div',{ref:'memberChoices',class:'holo-team-picker-list'},[
            renderHolomemChoices(h,{members:this.matchingMembers,
              portrait:({assetId})=>portrait(assetId,32,'holo-team-member-icon'),onSelect:this.selectMember,
              isSelected:id=>this.memberId===id,emptyMessage:'No matching Holomems.',
            }),
          ]),
        ]}),
      ]);
    },
  };
}
