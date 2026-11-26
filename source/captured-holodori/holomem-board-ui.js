import {formatNumber as format} from './regional-formats.js';
import {accountRosterBranches,boardNodeEffectAssetName,connectedBoardNodeIds,quoteBoardReset} from '../hololive/vendor/shared/account-data';
import {resourceImage,resourceLabels} from './game';
import {boardConnectCandidates,boardConnectRange,boardNodeLabel,connectCard,previewBoardPath,projectHolomemBoard} from './holomem-board';
import {currentBoards,currentBoardPoints,currentOwnedCards,currentDreamRank} from './current-account';
import {optimizerBoards} from './saved-lineups';

const assets = '/assets/boards/';
const home = 'S-001';
const unit = 31;
const linkSize = unit * 16 / 200;
let nextBoardId=0;
const padding = 21;
const defaultZoom = 1.8;
const palettes = {
  leader:['#ff386e','#ff983d'], card:['#3866ff','#3dcbff'],
  support:['#00cd7b','#7ef9b7'], content:['#ff9e2d','#ffc941'],
};
const arrows = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};
const portrait = member => '/assets/achievements/portraits/img_chr_icon_normal_' + member.assetId + '.webp';
const action = 'holo-board-action bg-gray-700 hover:bg-gray-600 rounded font-semibold';
const emptyLayout={nodes:[],cards:{}};
const noNodes=new Set();
const currentView={added:noNodes,removed:noNodes,connects:noNodes};
const rankGate=cell=>Math.max(cell.viewPlayerLevel??0,cell.unlockPlayerLevel??0);

export function boardChangeBadge(h,kind,props={}){
  return h('svg',{class:'holo-board-change-mark is-'+kind,viewBox:'0 0 16 16','aria-hidden':'true',...props},[
    h('circle',{cx:8,cy:8,r:7.5,fill:'var(--badge-fill)'}),
    h('path',{d:kind==='add'?'M4.25 8h7.5 M8 4.25v7.5':'M4.25 8h7.5',
      fill:'none',stroke:'currentColor','stroke-width':2.35,'stroke-linecap':'round'}),
  ]);
}

export function boardConnectArtwork(h,thumbnail,rarity){
  const image=(src,className)=>h('img',{class:className,src,alt:'',decoding:'async',draggable:false});
  return [
    image(thumbnail,'socket-card-art'),
    [3,4,5].includes(rarity)?image(assets+'ui_999_thm_card_rarity_r'+rarity+'_s.webp','socket-ribbon'):null,
  ];
}

export function createHolomemBoard({h,vnode,Search,Dialog,Toggle}) {
  const art = (file,cls) => h('img',{class:cls,src:assets+file,alt:'',decoding:'async',draggable:false});
  const texture = (file,cls) => h('span',{class:'holo-board-layer holo-board-texture '+cls,'aria-hidden':'true',
    style:{'--art':'url('+assets+file+')'}});
  const mask = (file,cls) => h('span',{class:'holo-board-layer holo-board-mask '+cls,'aria-hidden':'true',
    style:{'--art':'url('+assets+file+')'}});
  const cardArt = (url,cls,loading) => url ? h('img',{class:cls,src:url,alt:'',loading,decoding:'async',draggable:false}) : null;

  return {
    name:'HolodoriBoard',
    props:{snapshot:Object,inventory:Object,profile:Object,goals:Array,saveBoard:Function,plan:Object,planSelection:Set,planNodes:Array,
      planConnectChoices:Function,planConnectProtected:Function,planConnectCards:Object},
    emits:['plan-change','plan-connect'],
    data(){return {linkId:'holo-board-path-mark-'+(++nextBoardId),memberId:null,nodeId:home,dialog:null,search:'',
      connectSlot:null,connectOptions:[],previewId:null,showPath:false,presetNumber:null,
      leftPurchase:true,rightReset:true,boardError:''};},
    created(){
      this.camera={zoom:1,x:0,y:0,frame:0,input:[]};
    },
    computed:{
      presets(){return this.profile?.gameProgress?.boardPresets?.filter(row=>row.characterId===this.member?.id)??[];},
      selectedPreset(){return this.presets.find(row=>row.number===this.presetNumber)??null;},
      editableSave(){return this.selectedPreset?null:this.saveBoard;},
      memberBranches(){
        const ids=new Set(this.snapshot?.tables.boards?.map(row=>row.characterId));
        return accountRosterBranches.map(branch=>({
          ...branch,members:branch.generations.flatMap(group=>group.characters).filter(member=>this.profile||ids.has(member.id)),
        })).filter(branch=>branch.members.length);
      },
      member(){
        return this.memberBranches.flatMap(branch=>branch.members).find(member=>member.id===this.memberId) ??
          this.memberBranches[0]?.members[0] ?? null;
      },
      currentLayouts(){return this.profile?currentBoards(this.profile):optimizerBoards(this.snapshot?.tables.boards);},
      cards(){return this.profile?currentOwnedCards(this.profile,this.goals):this.snapshot?.tables.cards??[];},
      visualPlan(){return this.plan??(this.profile?currentView:null);},
      currentLayout(){const p=this.selectedPreset;return p?{nodes:p.releasedSkillTreeNodeGroupIds,cards:Object.fromEntries(p.connectedSkillTreeNodeGroupIds.map((id,i)=>[id,p.connectedSkillTreeNodeCardIds[i]]))}:this.currentLayouts[this.member?.id]??emptyLayout;},
      board(){
        if(!this.member)return null;
        const id=this.member.id;
        if(this.profile){
          const points=currentBoardPoints(this.profile,id,this.currentLayout);
          const projected=projectHolomemBoard(this.snapshot,id,{layout:this.currentLayout,rank:points.rank,cards:this.cards,
            dreamRank:currentDreamRank(this.profile),available:points.available});
          return this.selectedPreset?{...projected,available:null,reconciled:false}:projected;
        }
        const board=projectHolomemBoard(this.snapshot,id);
        return board&&this.plan ? {...board,available:this.plan.available} : board;
      },
      layout(){
        const board=this.board;
        if(!board)return null;
        const nodes=board.nodes.filter(node=>this.visualPlan?.removed.has(node.groupId)||board.active.has(node.groupId)||
          board.dreamRank===null||!node.viewPlayerLevel||node.viewPlayerLevel<=board.dreamRank);
        if(!nodes.length)return null;
        const minX=Math.min(...nodes.map(node=>node.x)),maxY=Math.max(...nodes.map(node=>node.y));
        const points=new Map(nodes.map(node=>[node.groupId,[(node.x-minX)*unit+padding,(maxY-node.y)*unit+padding]]));
        return {
          nodes,points,edges:board.edges.filter(([a,b])=>points.has(a)&&points.has(b)),
          width:Math.max(...nodes.map(node=>node.x-minX))*unit+2*padding,
          height:Math.max(...nodes.map(node=>maxY-node.y))*unit+2*padding,
        };
      },
      selected(){
        if(!this.layout)return null;
        return this.layout.nodes.find(node=>node.groupId===this.nodeId) ??
          this.layout.nodes.find(node=>node.groupId===home) ?? this.layout.nodes[0];
      },
      actualConnect(){return this.board?.assignments.get(this.selected?.groupId) ?? null;},
      candidates(){return boardConnectCandidates(this.cards,this.currentLayouts);},
      previewCard(){return this.previewId ? this.candidates.find(card=>card.id===this.previewId) ?? null : null;},
      connectCard(){return this.previewCard ?? this.actualConnect;},
      range(){return this.connectCard?.effect ? boardConnectRange(this.board,this.selected.groupId,this.connectCard) : noNodes;},
      path(){return this.selected ? previewBoardPath(this.board,this.selected) : null;},
      pathIds(){return this.showPath&&this.path ? new Set(this.path.nodeIds) : noNodes;},
      planActive(){
        return this.visualPlan&&this.board ? connectedBoardNodeIds(this.board.nodes,this.planNodes??this.board.purchased) : null;
      },
      mapNodeArt(){
        const {board,layout,visualPlan,previewCard,range}=this;
        if(!layout)return null;
        const previewSlot=previewCard&&this.selected.groupId;
        return new Map(layout.nodes.map(cell=>{
          const id=cell.groupId,removed=visualPlan?.removed.has(id),showActiveArt=board.active.has(id)||removed;
          const preview=id===previewSlot?previewCard:null;
          const shownCard=preview??board.assignments.get(id)??this.removedConnectCard(id);
          const inRange=range.has(id);
          return [id,{showActiveArt,preview,shownCard,inRange,layers:this.cellLayers(cell,removed,showActiveArt,shownCard,inRange)}];
        }));
      },
      mapNodes(){
        const {board,layout,selected,visualPlan,planSelection,pathIds,mapNodeArt}=this;
        if(!layout)return [];
        return layout.nodes.map(cell=>{
          const id=cell.groupId,[x,y]=layout.points.get(id);
          const {showActiveArt,preview,shownCard,inRange,layers}=mapNodeArt.get(id);
          const colors=palettes[cell.type]??palettes.support;
          const classes='holo-board-node'+(cell.type==='connect'?' is-connect':'')+(shownCard?.thumbnail?' has-connect-card':'')+
            (cell.grade>=3?' grade-three':cell.grade===2?' grade-two':'')+(!showActiveArt?' is-locked':'')+(inRange?' is-in-range':'')+(pathIds.has(id)?' is-on-path':'');
          const key=this.planChangeKey(id),selectable=planSelection&&key,checked=selectable&&planSelection.has(key);
          const inspected=id===selected.groupId;
          return h('button',{key:id,type:'button','data-board-node':id,'data-plan-change':
            visualPlan?.removed.has(id)?'reset':visualPlan?.connects.has(id)?'connect':visualPlan?.added.has(id)?'add':undefined,
            'data-plan-selected':selectable?String(checked):undefined,'data-inspected':inspected?'true':undefined,class:classes,
            style:{left:x+'px',top:y+'px','--node-from':colors[0],'--node-to':colors[1]},
            tabindex:inspected?0:-1,'aria-pressed':selectable?checked:inspected,
            'aria-keyshortcuts':this.canContextNode(cell)?'Shift+F10':undefined,
            'aria-label':boardNodeLabel(cell)+(cell.description?', '+cell.description:'')+', '+
              (preview?'Preview, '+preview.name:this.nodeStatus(cell)+(shownCard?', '+shownCard.name:'')),
          },layers);
        });
      },
      mapEdges(){
        const {board,layout,visualPlan,planActive,pathIds}=this;
        if(!layout)return [];
        const pathEdges=new Set();
        if(pathIds.size){
          const route=this.path.routeNodeIds;
          for(let i=1;i<route.length;i++){
            pathEdges.add(route[i-1]+':'+route[i]);
            pathEdges.add(route[i]+':'+route[i-1]);
          }
        }
        const active=planActive??board.active;
        return layout.edges.map(([a,b])=>{
          const [x1,y1]=layout.points.get(a),[x2,y2]=layout.points.get(b);
          const key=a+b,mark={key,href:'#'+this.linkId,x:(x1+x2-linkSize)/2,y:(y1+y2-linkSize)/2};
          const projected=pathEdges.has(a+':'+b);
          if(!planActive){
            const rankLocked=this.isRankLocked(board.byId.get(a))||this.isRankLocked(board.byId.get(b));
            return h('use',{...mark,class:projected?'is-on-path':rankLocked?'is-rank-locked':undefined});
          }
          if(!projected&&(!active.has(a)||!active.has(b)))return h('use',{...mark,class:'is-plan-inactive'});
          const added=projected||visualPlan.added.has(a)||visualPlan.added.has(b);
          const dx=Math.sign(x2-x1),dy=Math.sign(y2-y1);
          const start=this.linkInset(a),end=this.linkInset(b);
          return h('line',{key,class:added?'is-plan-add':'is-plan-active',
            x1:x1+dx*start,y1:y1+dy*start,x2:x2-dx*end,y2:y2-dy*end});
        });
      },
      mapBadges(){
        if(!this.plan||!this.layout)return [];
        return this.layout.nodes.flatMap(cell=>{
          const id=cell.groupId;
          const removed=this.plan.removed.has(id);
          if(!removed&&!this.plan.added.has(id))return [];
          const [x,y]=this.layout.points.get(id);
          const connect=cell.type==='connect';
          const shell=unit*(connect ? .8 : cell.grade>=2 ? .92 : .64);
          const offset=shell*(connect ? .5 : .445);
          return [boardChangeBadge(h,removed?'reset':'add',{
            key:id,'data-badge-node':id,
            'data-plan-selected':this.planSelection?String(this.planSelection.has(this.planChangeKey(id))):undefined,
            style:{left:(x+offset)+'px',top:(y-offset)+'px','--badge-shell':shell+'px'},
          })];
        });
      },
      filteredBranches(){
        const query=this.search.trim().toLocaleLowerCase();
        return this.memberBranches.map(branch=>({...branch,members:branch.members.filter(member=>
          (member.name+' '+member.shortName).toLocaleLowerCase().includes(query),
        )})).filter(branch=>branch.members.length);
      },
      filteredCards(){
        const query=this.search.trim().toLocaleLowerCase();
        return this.candidates.filter(card=>(card.name+' '+card.member).toLocaleLowerCase().includes(query));
      },
    },
    mounted(){
      this.boardObserver=new ResizeObserver(()=>this.updateViewport());
      this.observeViewport();
    },
    beforeUnmount(){
      this.boardObserver?.disconnect();
      cancelAnimationFrame(this.camera.frame);
    },
    watch:{
      snapshot(){this.previewId=null;this.showPath=false;this.dialog=null;this.boardError='';},
      layout(next,previous){this.$nextTick(()=>{
        if(this.$refs.map!==this.observedMap)this.observeViewport();
        else if(next?.width!==previous?.width||next?.height!==previous?.height){
          this.visualPlan?this.fit():this.center();
        }
      });},
    },
    methods:{
      observeViewport(){
        this.boardObserver?.disconnect();
        this.observedMap=this.$refs.map;
        if(this.observedMap)this.boardObserver?.observe(this.observedMap);
        this.updateViewport();
      },
      updateViewport(){
        const view=this.viewGeometry();
        if(!view)return;
        if(!this.cameraReady){
          this.cameraReady=true;
          this.visualPlan?this.fit():this.center();
        }else this.updateTransform(view);
      },
      viewGeometry(){
        const map=this.$refs.map,layout=this.layout;
        if(!map||!layout)return null;
        const width=map.clientWidth,height=map.clientHeight;
        if(!width||!height)return null;
        const inset=this.visualPlan?Math.min(12,width*.03,height*.03):0;
        return {map,layout,width,height,fit:Math.min((width-2*inset)/layout.width,(height-2*inset)/layout.height)};
      },
      clampCamera({layout,fit,width,height}){
        const camera=this.camera,scale=fit*camera.zoom;
        const limitX=Math.max(layout.width/2-width/2/scale,0)+width/4/scale;
        const limitY=Math.max(layout.height/2-height/2/scale,0)+height/4/scale;
        camera.x=Math.max(-limitX,Math.min(limitX,camera.x));
        camera.y=Math.max(-limitY,Math.min(limitY,camera.y));
      },
      updateTransform(view=this.viewGeometry()){
        const world=this.$refs.world;
        if(!view||!world)return;
        const {map,layout,fit,width,height}=view;
        const camera=this.camera,scale=fit*camera.zoom;
        this.clampCamera(view);
        const x=width/2-(layout.width/2+camera.x)*scale;
        const y=height/2-(layout.height/2+camera.y)*scale;
        world.style.transform='translate3d('+x+'px,'+y+'px,0) scale('+scale+')';
        if(this.plan&&world.style.getPropertyValue('--board-fit')!==String(fit)){
          world.style.setProperty('--board-fit',String(fit));
        }
        if(map.dataset.zoom!==String(camera.zoom)){
          map.dataset.zoom=String(camera.zoom);
          this.$refs.zoomOut.disabled=camera.zoom<=.6;
          this.$refs.zoomIn.disabled=camera.zoom>=5;
        }
        if(map.dataset.scale!==String(scale)){
          map.dataset.scale=String(scale);
          map.toggleAttribute('data-compact-cells',unit*scale<18);
          this.$refs.links.style.setProperty('--board-inverse-scale',String(1/scale));
        }
      },
      fit(){
        this.cancelCameraInput();
        Object.assign(this.camera,{zoom:1,x:0,y:0});
        this.updateTransform();
      },
      center(){
        this.cancelCameraInput();
        const view=this.viewGeometry();
        if(!view)return;
        const origin=view.layout.points.get(home)??[view.layout.width/2,view.layout.height/2];
        Object.assign(this.camera,{zoom:defaultZoom,x:origin[0]-view.layout.width/2,y:origin[1]-view.layout.height/2});
        this.updateTransform(view);
      },
      cancelCameraInput(){
        cancelAnimationFrame(this.camera.frame);
        this.camera.frame=0;
        this.camera.input=[];
      },
      queueCameraInput(input){
        const camera=this.camera;
        camera.input.push(input);
        if(!camera.frame)camera.frame=requestAnimationFrame(()=>this.applyCameraInput());
      },
      applyCameraInput(immediate){
        const camera=this.camera,input=camera.input;
        this.cancelCameraInput();
        if(immediate)input.push(immediate);
        if(!input.length)return;
        const view=this.viewGeometry();
        if(!view)return;
        const {map,width,height,fit}=view;
        let pointer;
        for(const move of input){
          if(move.pan){
            camera.x-=move.x/(fit*camera.zoom);
            camera.y-=move.y/(fit*camera.zoom);
          }else{
            const delta=move.delta===undefined?0:Math.max(-300,Math.min(300,move.delta*(move.mode===1?16:move.mode===2?height:1)));
            const zoom=Math.max(.6,Math.min(5,camera.zoom*(move.factor??Math.exp(-delta*.0015))));
            if(zoom===camera.zoom)continue;
            if(move.x!==undefined){
              if(!pointer){
                const bounds=map.getBoundingClientRect();
                pointer={left:bounds.left,top:bounds.top,scaleX:map.offsetWidth/bounds.width,scaleY:map.offsetHeight/bounds.height,
                  centerX:map.clientLeft+width/2,centerY:map.clientTop+height/2};
              }
              const x=(move.x-pointer.left)*pointer.scaleX-pointer.centerX;
              const y=(move.y-pointer.top)*pointer.scaleY-pointer.centerY;
              const shift=1/(fit*camera.zoom)-1/(fit*zoom);
              camera.x+=x*shift;
              camera.y+=y*shift;
            }
            camera.zoom=zoom;
          }
          this.clampCamera(view);
        }
        this.updateTransform(view);
      },
      zoomBy(factor){this.applyCameraInput({factor});},
      wheelZoom(event){
        event.preventDefault();
        this.queueCameraInput({delta:event.deltaY,mode:event.deltaMode,x:event.clientX,y:event.clientY});
      },
      pan(x,y){this.applyCameraInput({pan:true,x,y});},
      mapKeys(event){
        const cell=this.board.byId.get(event.target.closest('[data-board-node]')?.dataset.boardNode);
        if(cell){
          if(this.canContextNode(cell)&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){
            event.preventDefault();
            if(!event.repeat)this.contextNode(cell.groupId);
            return;
          }
          this.nodeKeys(event,cell);
        }
        if(event.altKey||event.ctrlKey||event.metaKey)return;
        if(event.key==='+'||event.key==='='){event.preventDefault();this.zoomBy(1.28);}
        else if(event.key==='-'){event.preventDefault();this.zoomBy(1/1.28);}
        else if(event.key==='Home'){event.preventDefault();this.center();}
        else if(event.key.toLowerCase()==='f'){event.preventDefault();this.fit();}
        else if(arrows[event.key]&&event.target===event.currentTarget){
          event.preventDefault();
          const [x,y]=arrows[event.key];
          this.pan(-x*64,y*64);
        }
      },
      startDrag(event){
        if(this.boardDrag||![0,1].includes(event.button)||event.target.closest('.holo-board-controls,.holo-board-navigation'))return;
        event.preventDefault();
        this.boardDrag={id:event.pointerId,startX:event.clientX,startY:event.clientY,
          x:event.clientX,y:event.clientY,
          nodeId:event.button===0 ? event.target.closest('[data-board-node]')?.dataset.boardNode : null,moved:false};
        if(!this.boardDrag.nodeId)event.currentTarget.focus({preventScroll:true});
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      moveDrag(event){
        const drag=this.boardDrag;
        if(drag?.id!==event.pointerId)return;
        if(!drag.moved){
          if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<4)return;
          drag.moved=true;
          event.currentTarget.classList.add('is-panning');
        }
        this.queueCameraInput({pan:true,x:event.clientX-drag.x,y:event.clientY-drag.y});
        drag.x=event.clientX;
        drag.y=event.clientY;
      },
      stopDrag(event){
        const drag=this.boardDrag;
        if(drag?.id!==event.pointerId)return;
        this.boardDrag=null;
        event.currentTarget.classList.remove('is-panning');
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
        if(drag.moved){
          this.applyCameraInput();
          this.suppressBoardClickUntil=performance.now()+250;
        }
        else if(event.type==='pointerup'&&drag.nodeId){
          this.activateNode(drag.nodeId);
          this.suppressBoardClickUntil=performance.now()+50;
          this.$refs.world?.querySelector('[data-board-node="'+drag.nodeId+'"]')?.focus({preventScroll:true});
        }
      },
      planChangeKey(id){
        if(this.plan?.removed.has(id))return 'reset:'+id;
        if(this.plan?.connects.has(id))return 'connect:'+id;
        if(this.plan?.added.has(id))return 'buy:'+id;
        return null;
      },
      isRankLocked(cell){
        return !this.board.active.has(cell.groupId)&&this.board.dreamRank!==null&&this.board.dreamRank<rankGate(cell);
      },
      cellLayers(cell,removed,showActiveArt,shownCard,inRange){
        const glyph=boardNodeEffectAssetName(cell),shadow=glyph?.replace('.webp','_shadow.webp');
        let layers;
        if(cell.type==='connect'&&shownCard?.thumbnail)layers=[
          h('span',{class:'holo-board-layer socket-card-shadow','aria-hidden':'true'}),
          h('span',{class:'holo-board-layer socket-card','aria-hidden':'true'},boardConnectArtwork(h,shownCard.thumbnail,shownCard.rarity)),
          h('span',{class:'holo-board-layer socket-card-frame','aria-hidden':'true'}),
        ];
        else if(cell.type==='connect')layers=[
          h('span',{class:'holo-board-layer socket-empty-shadow','aria-hidden':'true'}),
          mask('ui_999_thm_base_wh_9s.webp','socket socket-base'),
          texture('ui_999_inwht_b35_a55_9s.webp','socket socket-inset'),
          texture('ui_999_thm_action_line.webp','socket-circle'),
          h('span',{class:'holo-board-layer socket-card-frame socket-rim','aria-hidden':'true'}),
          texture(shownCard?'ui_999_ico_potential.webp':showActiveArt?'ui_999_ico_plus.webp':'ui_999_ico_lock.webp',
            'socket-mark'+(!showActiveArt&&!shownCard?' socket-lock':'')),
        ];
        else if(!removed&&this.isRankLocked(cell))layers=[
          h('span',{class:'holo-board-rank-lock','aria-hidden':'true'},[
            art('ui_999_ico_lock.webp','rank-lock-icon'),
            h('span',{class:'rank-condition'},[
              h('img',{src:'/assets/achievements/ui/ui_999_ico_crown.webp',alt:'',draggable:false}),
              String(rankGate(cell)),
            ]),
          ]),
        ];
        else layers=[
          texture('ui_999_shadow_b8_a35_r92_9s.webp','node-shadow'),
          mask('ui_999_base_r96_9s.webp','node-base'),mask('ui_999_base_r96_9s.webp','node-tint'),
          texture('ui_999_inwht_b35_a35_9s.webp','node-inset'),
          showActiveArt ? mask('ui_999_base_r80_9s.webp','node-fill') : null,
          !showActiveArt&&cell.grade<3 ? mask('ui_999_outline_w6_r80_9s.webp','node-ring') : null,
          cell.grade>=3?texture('ui_710_ico_grade_3_base_outline.webp','node-grade-three-base'):null,
          cell.grade>=3?mask('ui_710_ico_grade_3_main_outline.webp','node-grade-three-main'):mask('ui_999_outline_w6_r104_9s.webp','node-outline'),
          shadow&&!shadow.includes('livedeckleaderactiveskilladdition') ? texture('effects/'+shadow,'node-symbol node-symbol-shadow') : null,
          glyph ? texture('effects/'+glyph,'node-symbol') : null,
          h('span',{class:'holo-board-grade','aria-hidden':'true'},Array.from({length:cell.grade},(_,i)=>h('img',{key:i,src:assets+'ui_710_img_star.webp',alt:''}))),
          inRange ? h('span',{class:'holo-board-range','aria-hidden':'true'},[
            texture('ui_999_ico_arrow_change_outline.webp','range-arrow-outline'),
            mask('ui_999_ico_arrow_change_base.webp','range-arrow-fill'),
            texture('ui_999_ico_arrow_change_outline.webp','range-arrow-outline range-arrow-next'),
            mask('ui_999_ico_arrow_change_base.webp','range-arrow-fill range-arrow-next'),
          ]) : null,
        ];
        return layers;
      },
      nodeStatus(cell){
        const {board,visualPlan}=this,id=cell.groupId;
        if(visualPlan?.removed.has(id))return 'Reset in plan';
        if(visualPlan?.connects.has(id))return 'Connect changed in plan';
        if(visualPlan?.added.has(id))return 'Unlock in plan';
        if(board.assignments.has(id))return 'Connected';
        if(board.active.has(id))return cell.type==='connect'?'Empty slot':'Unlocked';
        const gate=rankGate(cell);
        return gate&&(board.dreamRank===null||board.dreamRank<gate)?'Requires Dream Rank '+gate:'Locked';
      },
      linkInset(id){
        const cell=this.board.byId.get(id);
        return (cell.type==='connect' ? .4 : cell.grade>=2 ? .46 : .32)*unit;
      },
      canContextNode(cell){
        const id=cell.groupId;
        if(cell.type==='connect')return this.editableSave?this.board.assignments.has(id):!!this.planConnectChoices&&
          !this.planConnectProtected?.(id)&&!this.isRankLocked(cell);
        return !!this.editableSave&&this.rightReset&&this.board.purchased.has(id)&&this.board.knownTopology;
      },
      clickMap(event){
        if(event.detail&&performance.now()<this.suppressBoardClickUntil)return;
        const id=event.target.closest('[data-board-node]')?.dataset.boardNode;
        if(id)this.activateNode(id);
      },
      contextMap(event){
        const id=event.target.closest('[data-board-node]')?.dataset.boardNode;
        if(!id||!this.editableSave&&!this.canContextNode(this.board.byId.get(id)))return;
        event.preventDefault();
        this.contextNode(id);
      },
      removedConnectCard(id){
        const cardId=this.visualPlan?.removed.has(id)?this.visualPlan.oldCards?.[id]:null;
        return cardId?connectCard(undefined,cardId):null;
      },
      activateNode(id){
        this.selectNode(id);
        if(this.editableSave){
          const node=this.board.byId.get(id);
          if(this.board.active.has(id)){
            if(node.type==='connect')this.openPlanConnect(id);
          }else if(this.leftPurchase)this.purchaseNode(node);
          return;
        }
        const key=this.planChangeKey(id);
        if(this.planSelection&&key)this.$emit('plan-change',key);
      },
      contextNode(id){
        if(!this.editableSave){this.openPlanConnect(id);return;}
        this.selectNode(id);
        const node=this.board.byId.get(id);
        if(node.type==='connect'){
          if(this.currentLayout.cards[id])this.recordConnect(id,null);
        }else if(this.rightReset&&node.boardPointCost&&this.board.purchased.has(id)&&this.board.knownTopology){
          const before=this.currentLayout;
          const {removedNodeIds}=quoteBoardReset(this.member.id,before.nodes,[id]);
          const removed=new Set(removedNodeIds);
          this.recordBoard(before,{
            nodes:before.nodes.filter(key=>!removed.has(key)),
            cards:Object.fromEntries(Object.entries(before.cards).filter(([key])=>!removed.has(key))),
          });
        }
      },
      async purchaseNode(node){
        const path=previewBoardPath(this.board,node);
        if(!path){
          if(this.board.knownTopology)this.boardError='Raise your Dream Rank to unlock a path to this node.';
          return;
        }
        if(path.boardPointCost>this.board.available){
          this.boardError='Need '+format(path.boardPointCost-this.board.available)+' more Board Pt.';
          return;
        }
        const before=this.currentLayout,owner=this.member.id;
        const saved=await this.recordBoard(before,{...before,nodes:[...before.nodes,...path.nodeIds]});
        if(saved&&node.type==='connect'&&this.member.id===owner&&this.selected?.groupId===node.groupId)
          this.openPlanConnect(node.groupId);
      },
      async recordBoard(before,layout){
        if(!this.editableSave)return false;
        const owner=this.member.id;
        this.boardError='';this.previewId=null;this.showPath=false;
        try{
          await this.editableSave(owner,layout,before);
          return true;
        }catch(error){
          if(this.member.id===owner)this.boardError=error.message;
          return false;
        }
      },
      recordConnect(slot,cardId){
        const before=this.currentLayout;
        if((before.cards[slot]??null)===cardId)return;
        const cards=Object.fromEntries(Object.entries(before.cards).filter(([key,id])=>key!==slot&&id!==cardId));
        if(cardId)cards[slot]=cardId;
        this.recordBoard(before,{...before,cards});
      },
      openDialog(kind){this.search='';this.dialog=kind;},
      openPlanConnect(id){
        if(this.editableSave?!this.board.active.has(id):!this.planConnectChoices||this.planConnectProtected?.(id))return;
        this.selectNode(id);
        this.previewId=null;
        this.connectSlot=id;
        this.connectOptions=this.editableSave?this.candidates:this.planConnectChoices();
        this.openDialog('plan-connect');
      },
      setPlanConnect(cardId){
        const slot=this.connectSlot;
        this.dialog=null;
        if(this.editableSave)this.recordConnect(slot,cardId);
        else this.$emit('plan-connect',slot,cardId);
        this.$nextTick(()=>this.$refs.world?.querySelector('[data-board-node="'+slot+'"]')?.focus({preventScroll:true}));
      },
      selectMember(id){
        this.presetNumber=null;
        this.memberId=id;
        this.nodeId=home;
        this.showPath=false;
        this.previewId=null;
        this.dialog=null;
        this.boardError='';
        this.$nextTick(this.visualPlan?this.fit:this.center);
      },
      selectPreset(number){
        this.presetNumber=number;
        this.previewId=null;
        this.showPath=false;
        this.boardError='';
      },
      selectNode(id){
        if(id===this.selected?.groupId)return;
        this.nodeId=id;
        this.showPath=false;
        this.previewId=null;
        this.boardError='';
      },
      nodeKeys(event,node){
        const direction=arrows[event.key];
        if(!direction)return;
        event.preventDefault();
        event.stopPropagation();
        const [dx,dy]=direction;
        const next=this.layout.nodes.filter(other=>dx ? (other.x-node.x)*dx>0 : (other.y-node.y)*dy>0)
          .sort((a,b)=>this.nodeDistance(node,a,dx)-this.nodeDistance(node,b,dx))[0];
        if(!next)return;
        this.selectNode(next.groupId);
        this.$nextTick(()=>{
          const button=this.$refs.world?.querySelector('[data-board-node="'+next.groupId+'"]');
          if(!button)return;
          button.focus({preventScroll:true});
          const rect=button.getBoundingClientRect(),bounds=this.$refs.map.getBoundingClientRect();
          if(rect.left<bounds.left||rect.right>bounds.right||rect.top<bounds.top||rect.bottom>bounds.bottom){
            this.pan(bounds.left+bounds.width/2-rect.left-rect.width/2,bounds.top+bounds.height/2-rect.top-rect.height/2);
          }
        });
      },
      nodeDistance(origin,target,horizontal){
        const x=Math.abs(target.x-origin.x),y=Math.abs(target.y-origin.y);
        return horizontal ? x+y*3 : y+x*3;
      },
    },
    render(){
      const board=this.board,layout=this.layout,node=this.selected;
      if(!board||!layout||!node)return h('section',{class:'holo-board-empty bg-gray-800 rounded p-4','aria-label':'Holomem Board'},[
        h('p',{class:'text-sm text-gray-300'},'No Board is available for this Holomem.'),
      ]);
      const visual=this.visualPlan;
      const selectedCard=this.connectCard??this.removedConnectCard(node.groupId);
      const actualCard=this.actualConnect;
      let pointsLabel='Board Pt unavailable';
      if(this.selectedPreset){
        if(board.spent!==null)pointsLabel=format(board.spent)+' Board Pt used in preset';
      }else if(board.available!==null){
        if(!this.profile)pointsLabel=format(board.available)+' Board Pt';
        else if(board.knownTopology)pointsLabel=format(board.spent)+' / '+format(board.earned)+' used · '+format(board.available)+' Board Pt left';
      }
      const path=this.showPath ? this.path : null;
      const button=(label,click,props={})=>h('button',{class:action,type:'button',onClick:click,...props},label);
      const cost=path??{boardPointCost:node.boardPointCost,costs:node.costs};
      const costs=[
        cost.boardPointCost ? h('span',{class:'holo-board-cost bg-gray-700 rounded-full',title:'Required Board Points'},[
          art('img_resource_thumb_skilltreepoint-cmn.webp',''),format(cost.boardPointCost)+' Board Pt',
        ]) : null,
        ...cost.costs.map(({resource,quantity})=>h('span',{key:resource,class:'holo-board-cost bg-gray-700 rounded-full',
          title:this.inventory?.[resource]===undefined?resourceLabels[resource]:format(this.inventory[resource])+' in Inventory',
        },[h('img',{src:resourceImage(resource),alt:''}),format(quantity)+' '+resourceLabels[resource]])),
      ];
      const inspectorStatus=this.previewCard ? 'Preview'+(this.previewCard.bloom===null?'':' · Bloom '+this.previewCard.bloom) :
        this.nodeStatus(node)+(actualCard?.bloom!=null?' · Bloom '+actualCard.bloom:'');
      const dialogTitle=this.dialog==='connect'?'Preview Connect card':'Select Holomem';
      const editingConnect=this.dialog==='plan-connect';
      const currentPlanCard=(this.editableSave?this.currentLayout.cards:this.planConnectCards)?.[this.connectSlot];
      const visibleConnectCards=editingConnect?this.connectOptions.filter(card=>
        (card.name+' '+card.member).toLocaleLowerCase().includes(this.search.trim().toLocaleLowerCase())):[];
      const hasCosts=cost.boardPointCost>0||cost.costs.length>0;
      const zoomControls=h('div',{class:'holo-board-controls','aria-label':'Map controls'},[
        button('−',()=>this.zoomBy(1/1.28),{ref:'zoomOut','aria-label':'Zoom out'}),
        button('+',()=>this.zoomBy(1.28),{ref:'zoomIn','aria-label':'Zoom in'}),
        button('Fit',this.fit,{'aria-label':'Fit board',title:'Fit the entire Board (F)'}),
      ]);
      return h('section',{class:'holo-board'+(visual?' holo-board-in-plan':'')+(this.profile?' holo-board-current':''),'aria-label':'Holomem Board'},[
        h('div',{class:'holo-board-frame bg-gray-800 border border-gray-600 rounded'},[
          h('div',{class:'holo-board-toolbar'},[
            this.plan?h('span',{class:'holo-board-member'},[h('img',{src:portrait(this.member),class:'holo-board-portrait',alt:''}),this.member.name]):
            button([h('img',{src:portrait(this.member),class:'holo-board-portrait',alt:''}),
              this.member.name,art('ui_999_ico_sync.webp','holo-board-switch')],()=>this.openDialog('member'),
              {class:action+' holo-board-member','aria-label':'Select Holomem, '+this.member.name,'aria-haspopup':'dialog'}),
            this.presets.length?h('div',{class:'flex flex-wrap gap-1',role:'group','aria-label':'Board presets'},[
              button('Equipped',()=>this.selectPreset(null),{'aria-pressed':!this.selectedPreset}),
              ...this.presets.map(p=>button(p.name||'Preset '+p.number,()=>this.selectPreset(p.number),{key:p.number,'aria-pressed':p.number===this.presetNumber,title:p.userMemo||'Saved Board preview'})),
            ]):null,
            this.selectedPreset?h('span',{class:'text-xs text-gray-400'},'Preset preview · '+(this.selectedPreset.userMemo||'Read only')):null,
            board.rank===null?null:h('span',{class:'holo-board-summary text-gray-300'},'Rank '+board.rank),
            h('span',{class:'holo-board-summary holo-board-points',
              title:board.reconciled?format(board.earned)+' earned · '+format(board.spent)+' spent':undefined,
            },[art('img_resource_thumb_skilltreepoint-cmn.webp',''),pointsLabel]),
            h('span',{class:'holo-board-summary text-gray-300'},board.purchased.size+' / '+board.nodes.length+' unlocked'),
            this.editableSave?h('div',{class:'holo-board-click-controls',role:'group','aria-label':'Board click actions'},[
              vnode(Toggle,{label:'Left click to purchase node',small:true,modelValue:this.leftPurchase,
                'onUpdate:modelValue':value=>{this.leftPurchase=value;this.boardError='';}}),
              vnode(Toggle,{label:'Right click to reset node',small:true,modelValue:this.rightReset,
                'onUpdate:modelValue':value=>{this.rightReset=value;this.boardError='';}}),
            ]):null,
          ]),
          h('div',{class:'holo-board-layout'},[
            h('div',{ref:'map',class:'holo-board-map','aria-label':'Board map','aria-description':'Scroll to zoom. Drag to move.',tabindex:0,
              onWheel:this.wheelZoom,onKeydown:this.mapKeys,onClick:this.clickMap,onContextmenu:this.contextMap,
              onDblclick:visual?event=>{if(!event.target.closest('button'))this.center();}:undefined,
              onPointerdown:this.startDrag,onPointermove:this.moveDrag,onPointerup:this.stopDrag,
              onLostpointercapture:this.stopDrag,onPointercancel:this.stopDrag,
            },[
              h('div',{ref:'world',class:'holo-board-world',style:{width:layout.width+'px',height:layout.height+'px',
                '--board-cell':unit+'px','--board-inset':padding+'px'}},[
                h('svg',{ref:'links',class:'holo-board-links',width:layout.width,height:layout.height,'aria-hidden':'true'},[
                  h('defs',null,[h('image',{id:this.linkId,href:assets+'ui_710_img_kira.webp',width:linkSize,height:linkSize})]),...this.mapEdges,
                ]),...this.mapNodes,
                this.plan?h('div',{class:'holo-board-badges','aria-hidden':'true'},this.mapBadges):null,
              ]),
              zoomControls,
              h('div',{class:'holo-board-navigation','aria-label':'Board navigation'},[
                button('↑',()=>this.pan(0,64),{'aria-label':'Move view up'}),
                button('←',()=>this.pan(64,0),{'aria-label':'Move view left'}),
                button([art('ui_999_ico_potential.webp','')],this.center,{'aria-label':'Center board',title:'Center board'}),
                button('→',()=>this.pan(-64,0),{'aria-label':'Move view right'}),
                button('↓',()=>this.pan(0,-64),{'aria-label':'Move view down'}),
              ]),
            ]),
            h('aside',{class:'holo-board-inspector','aria-label':'Selected node','aria-live':'polite'},[
              h('div',{class:'holo-board-inspector-heading'},[h('h2',{class:'text-sm font-semibold'},boardNodeLabel(node)),
                h('div',{class:'text-xs text-gray-400'},inspectorStatus)]),
              selectedCard?h('div',{class:selectedCard.art?'holo-board-card':undefined},
                [cardArt(selectedCard.art,'holo-board-card-art'),h('div',null,[h('div',{class:'font-semibold'},selectedCard.name),h('div',{class:'text-gray-400'},selectedCard.member)])],
              ):h('p',null,node.description||(node.type==='connect'?'Connect a card to boost nearby nodes.':'')),
              this.connectCard?.effect?h('p',{class:'holo-board-connect-effect'},[
                h('span',null,'+'+format(this.connectCard.effect.effectPermilUp/10)+'% Board effect'),
                h('span',null,format(this.range.size)+' in range'),
              ]):
                this.connectCard?h('p',{class:'text-gray-400'},'Connect effect unavailable'):null,
              this.previewCard?.placement && this.previewCard.id!==actualCard?.id?h('p',{class:'text-gray-400'},
                'Currently on '+this.previewCard.placement.member+'’s Board.'):null,
              hasCosts&&!selectedCard&&!board.active.has(node.groupId)?h('div',{class:'holo-board-costs'},costs):null,
              path?h('p',{class:'text-gray-400'},path.nodeIds.length+' new '+(path.nodeIds.length===1?'node':'nodes')):null,
              !this.plan&&this.path?button(this.showPath?'Hide unlock path':'Preview unlock path',()=>{this.showPath=!this.showPath;},{'aria-pressed':this.showPath}):null,
              this.boardError?h('p',{class:'text-red-400',role:'alert'},this.boardError):null,
              !this.plan&&board.active.has(node.groupId)&&node.type==='connect'?button(this.previewCard?'Clear preview':'Preview Connect',()=>{
                if(this.previewCard)this.previewId=null;
                else this.openDialog('connect');
              }):null,
              this.planConnectChoices&&node.type==='connect'&&!this.planConnectProtected?.(node.groupId)&&!this.isRankLocked(node)?
                button('Change Connect card',()=>this.openPlanConnect(node.groupId)):null,
            ]),
          ]),
        ]),
        !board.knownTopology?h('p',{class:'mt-2 text-xs text-gray-400'},'Some imported nodes are missing from the local catalog.'):null,
        vnode(Dialog,{visible:!!this.dialog,'onUpdate:visible':visible=>{if(!visible)this.dialog=null;},
          header:editingConnect?'Choose Connect card':dialogTitle,modal:true,draggable:false,dismissableMask:true,position:'top',
          class:editingConnect?'holo-team-dialog holo-board-connect-dialog':undefined,
          style:{width:'650px',maxWidth:'calc(100vw - 32px)',maxHeight:'calc(100dvh - 24px)'},
        },{default:()=>editingConnect?[
          vnode('div',{class:'holo-board-connect-toolbar'},[
            vnode(Search,{label:'Search Connect cards',search:this.search,'onUpdate:search':value=>{this.search=value;}}),
            button('Clear slot',()=>this.setPlanConnect(null),{disabled:!currentPlanCard,class:action+' holo-board-clear-slot'}),
          ]),
          vnode('div',{class:'holo-board-card-grid'},visibleConnectCards.map(card=>button([
            cardArt(card.art,'holo-board-picker-art','lazy'),vnode('span',{class:'holo-board-picker-name'},card.name),
            vnode('span',{class:'holo-board-picker-meta text-gray-400'},card.member+' · Bloom '+format(card.bloom)+
              (this.editableSave&&card.placement&&currentPlanCard!==card.id?' · Move from '+card.placement.member:'')),
          ],()=>this.setPlanConnect(card.id),{key:card.id,class:action+' holo-board-card-option',
            'aria-pressed':currentPlanCard===card.id,'aria-label':card.name}))),
          visibleConnectCards.length?null:vnode('p',{class:'text-sm text-gray-400'},'No matching Connect cards.'),
        ]:this.dialog ? [
          vnode(Search,{label:this.dialog==='member'?'Search members':'Search cards',search:this.search,'onUpdate:search':value=>{this.search=value;}}),
          this.dialog==='member'?h('div',{class:'holo-board-member-groups'},this.filteredBranches.length?this.filteredBranches.map(branch=>
            h('section',{key:branch.id},[h('h3',{class:'holo-progress-branch-title font-semibold'},branch.name),
              h('div',{class:'holo-board-member-grid'},branch.members.map(member=>button(
                [h('img',{src:portrait(member),alt:''}),member.name],()=>this.selectMember(member.id),
                {key:member.id,class:action+' holo-board-member-option','aria-pressed':member.id===this.member.id},
              ))),
            ]),
          ):[h('p',{class:'text-sm text-gray-400'},'No members found')]):h('div',{class:'holo-board-card-grid'},this.filteredCards.length?
            this.filteredCards.map(card=>button([cardArt(card.art,'holo-board-picker-art','lazy'),
              h('span',{class:'holo-board-picker-name'},card.name),h('span',{class:'holo-board-picker-meta text-gray-400'},
                'Bloom '+card.bloom+(card.placement?' · '+card.placement.member:'')),
            ],()=>{this.previewId=card.id;this.dialog=null;},{key:card.id,class:action+' holo-board-card-option'})):
            [h('p',{class:'text-sm text-gray-400'},'Mark an eligible card as owned in Characters to preview its Connect effect.')]),
        ]:[]}),
      ]);
    },
  };
}
