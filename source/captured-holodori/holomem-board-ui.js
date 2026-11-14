import {formatNumber as format} from './regional-formats.js';
import {accountRosterBranches,boardNodeEffectAssetName,connectedBoardNodeIds} from '../hololive/vendor/shared/account-data';
import {resourceImage,resourceLabels} from './game';
import {boardConnectCandidates,boardConnectRange,boardNodeLabel,connectCard,previewBoardPath,projectHolomemBoard} from './holomem-board';

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

export function boardChangeBadge(h,kind,props={}){
  return h('svg',{class:'holo-board-change-mark is-'+kind,viewBox:'0 0 16 16','aria-hidden':'true',...props},[
    h('circle',{cx:8,cy:8,r:7.5,fill:'var(--badge-fill)'}),
    h('path',{d:kind==='add'?'M4.25 8h7.5 M8 4.25v7.5':'M4.25 8h7.5',
      fill:'none',stroke:'currentColor','stroke-width':2.35,'stroke-linecap':'round'}),
  ]);
}

export function createHolomemBoard({h,vnode,Search,Dialog}) {
  const art = (file,cls) => h('img',{class:cls,src:assets+file,alt:'',decoding:'async',draggable:false});
  const texture = (file,cls) => h('span',{class:'holo-board-layer holo-board-texture '+cls,'aria-hidden':'true',
    style:{'--art':'url('+assets+file+')'}});
  const mask = (file,cls) => h('span',{class:'holo-board-layer holo-board-mask '+cls,'aria-hidden':'true',
    style:{'--art':'url('+assets+file+')'}});
  const cardArt = (url,cls,loading) => url ? h('img',{class:cls,src:url,alt:'',loading,decoding:'async',draggable:false}) : null;

  return {
    name:'HolodoriBoard',
    props:{snapshot:Object,inventory:Object,plan:Object,planSelection:Set,planNodes:Array,
      planConnectChoices:Function,planConnectCards:Object},
    emits:['plan-change','plan-connect'],
    data(){return {linkId:'holo-board-path-mark-'+(++nextBoardId),memberId:null,nodeId:home,dialog:null,search:'',
      connectSlot:null,connectOptions:[],previewId:null,showPath:false,zoom:1,centerX:0,centerY:0};},
    computed:{
      memberBranches(){
        const ids=new Set(this.snapshot?.tables.boards?.map(row=>row.characterId));
        return accountRosterBranches.map(branch=>({
          ...branch,members:branch.generations.flatMap(group=>group.characters).filter(member=>ids.has(member.id)),
        })).filter(branch=>branch.members.length);
      },
      member(){
        return this.memberBranches.flatMap(branch=>branch.members).find(member=>member.id===this.memberId) ??
          this.memberBranches[0]?.members[0] ?? null;
      },
      board(){
        const board=this.member ? projectHolomemBoard(this.snapshot,this.member.id) : null;
        return board&&this.plan ? {...board,available:this.plan.available} : board;
      },
      layout(){
        const board=this.board;
        if(!board)return null;
        const nodes=board.nodes.filter(node=>this.plan?.removed.has(node.groupId)||board.active.has(node.groupId)||
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
      candidates(){return this.snapshot ? boardConnectCandidates(this.snapshot) : [];},
      previewCard(){return this.previewId ? this.candidates.find(card=>card.id===this.previewId) ?? null : null;},
      connectCard(){return this.previewCard ?? this.actualConnect;},
      range(){return this.selected ? boardConnectRange(this.board,this.selected.groupId,this.connectCard) : new Set();},
      path(){return this.selected ? previewBoardPath(this.board,this.selected) : null;},
      pathIds(){return new Set(this.showPath ? this.path?.nodeIds : []);},
      planActive(){
        return this.plan&&this.board ? connectedBoardNodeIds(this.board.nodes,this.planNodes??this.board.purchased) : null;
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
    updated(){if(this.plan)this.updateTransform();},
    beforeUnmount(){this.boardObserver?.disconnect();},
    watch:{
      snapshot(){this.previewId=null;this.showPath=false;this.dialog=null;},
      layout(next,previous){this.$nextTick(()=>{
        this.observeViewport();
        if(this.plan){
          if(next?.width!==previous?.width||next?.height!==previous?.height){
            this.fit();
          }
        }else this.center();
      });},
    },
    methods:{
      observeViewport(){
        this.boardObserver?.disconnect();
        if(this.$refs.map)this.boardObserver?.observe(this.$refs.map);
        this.updateViewport();
      },
      updateViewport(){
        if(!this.viewGeometry())return;
        if(!this.cameraReady){
          this.cameraReady=true;
          this.plan?this.fit():this.center();
        }else this.updateTransform();
      },
      viewGeometry(){
        const map=this.$refs.map,layout=this.layout;
        if(!map?.clientWidth||!map.clientHeight||!layout)return null;
        const inset=this.plan?Math.min(12,map.clientWidth*.03,map.clientHeight*.03):0;
        const fit=Math.min((map.clientWidth-2*inset)/layout.width,(map.clientHeight-2*inset)/layout.height);
        const scale=fit*this.zoom;
        return {map,layout,fit,scale,
          x:map.clientWidth/2-(layout.width/2+this.centerX)*scale,
          y:map.clientHeight/2-(layout.height/2+this.centerY)*scale};
      },
      updateTransform(){
        let view=this.viewGeometry();
        const world=this.$refs.world;
        if(!view||!world)return;
        const {map,layout,scale}=view;
        const limitX=Math.max(layout.width/2-map.clientWidth/2/scale,0)+map.clientWidth/4/scale;
        const limitY=Math.max(layout.height/2-map.clientHeight/2/scale,0)+map.clientHeight/4/scale;
        this.centerX=Math.max(-limitX,Math.min(limitX,this.centerX));
        this.centerY=Math.max(-limitY,Math.min(limitY,this.centerY));
        view=this.viewGeometry();
        world.style.transform='translate('+view.x+'px,'+view.y+'px) scale('+scale+')';
        if(this.plan){
          world.style.setProperty('--board-inverse-scale',String(1/scale));
          this.positionBadges(view);
        }
        map.dataset.zoom=String(this.zoom);
        map.dataset.scale=String(scale);
        map.toggleAttribute('data-compact-cells',unit*scale<18);
        if(this.$refs.zoomOut)this.$refs.zoomOut.disabled=this.zoom<=.6;
        if(this.$refs.zoomIn)this.$refs.zoomIn.disabled=this.zoom>=5;
      },
      fit(){this.zoom=1;this.centerX=0;this.centerY=0;this.updateTransform();},
      positionBadges({x,y,fit,scale,layout}){
        for(const badge of this.$refs.badges?.children??[]){
          const id=badge.dataset.badgeNode;
          const [nodeX,nodeY]=layout.points.get(id);
          const node=this.board.byId.get(id);
          const connect=node.type==='connect';
          const shell=unit*(connect ? .8 : node.grade>=2 ? .92 : .64);
          // Let the badge sit over the rim while leaving the effect glyph and card art clear.
          const size=Math.min(shell*.52,Math.max(shell*.42,7/fit))*scale;
          const offset=shell*scale*(connect ? .5 : .445);
          badge.style.left=Math.round(x+nodeX*scale+offset-size/2)+'px';
          badge.style.top=Math.round(y+nodeY*scale-offset-size/2)+'px';
          badge.style.width=badge.style.height=size+'px';
        }
      },
      center(){
        const view=this.viewGeometry();
        if(!view)return;
        this.zoom=defaultZoom;
        const origin=view.layout.points.get(home)??[view.layout.width/2,view.layout.height/2];
        this.centerX=origin[0]-view.layout.width/2;
        this.centerY=origin[1]-view.layout.height/2;
        this.updateTransform();
      },
      zoomBy(factor,clientX,clientY){
        const view=this.viewGeometry();
        if(!view||view.scale<=0)return;
        const bounds=view.map.getBoundingClientRect();
        const x=clientX===undefined?view.map.clientWidth/2:(clientX-bounds.left)*view.map.offsetWidth/bounds.width-view.map.clientLeft;
        const y=clientY===undefined?view.map.clientHeight/2:(clientY-bounds.top)*view.map.offsetHeight/bounds.height-view.map.clientTop;
        const zoom=Math.max(.6,Math.min(5,this.zoom*factor));
        if(zoom===this.zoom)return;
        this.zoom=zoom;
        const anchorShift=1/view.scale-1/(view.fit*zoom);
        this.centerX+=(x-view.map.clientWidth/2)*anchorShift;
        this.centerY+=(y-view.map.clientHeight/2)*anchorShift;
        this.updateTransform();
      },
      wheelZoom(event){
        event.preventDefault();
        const multiplier=event.deltaMode===1?16:event.deltaMode===2?this.$refs.map.clientHeight:1;
        const delta=Math.max(-300,Math.min(300,event.deltaY*multiplier));
        this.zoomBy(Math.exp(-delta*.0015),event.clientX,event.clientY);
      },
      pan(x,y){
        const view=this.viewGeometry();
        if(!view)return;
        this.centerX-=x/view.scale;
        this.centerY-=y/view.scale;
        this.updateTransform();
      },
      mapKeys(event){
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
        if(this.boardDrag?.id!==event.pointerId)return;
        if(!this.boardDrag.moved&&Math.hypot(event.clientX-this.boardDrag.startX,event.clientY-this.boardDrag.startY)<4)return;
        this.boardDrag.moved=true;
        event.currentTarget.classList.add('is-panning');
        this.pan(event.clientX-this.boardDrag.x,event.clientY-this.boardDrag.y);
        this.boardDrag.x=event.clientX;
        this.boardDrag.y=event.clientY;
      },
      stopDrag(event){
        const drag=this.boardDrag;
        if(drag?.id!==event.pointerId)return;
        this.boardDrag=null;
        event.currentTarget.classList.remove('is-panning');
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
        if(drag.moved)this.suppressBoardClickUntil=performance.now()+250;
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
      removedConnectCard(id){
        const cardId=this.plan?.removed.has(id)?this.plan.oldCards?.[id]:null;
        return cardId?connectCard(undefined,cardId):null;
      },
      activateNode(id){
        this.selectNode(id);
        const key=this.planChangeKey(id);
        if(this.planSelection&&key)this.$emit('plan-change',key);
      },
      openDialog(kind){this.search='';this.dialog=kind;},
      openPlanConnect(id){
        if(!this.planConnectChoices)return;
        this.selectNode(id);
        this.connectSlot=id;
        this.connectOptions=this.planConnectChoices();
        this.openDialog('plan-connect');
      },
      setPlanConnect(cardId){
        const slot=this.connectSlot;
        this.dialog=null;
        this.$emit('plan-connect',slot,cardId);
        this.$nextTick(()=>this.$refs.world?.querySelector('[data-board-node="'+slot+'"]')?.focus({preventScroll:true}));
      },
      selectMember(id){
        this.memberId=id;
        this.nodeId=home;
        this.showPath=false;
        this.previewId=null;
        this.dialog=null;
        this.$nextTick(this.center);
      },
      selectNode(id){
        if(id===this.selected?.groupId)return;
        this.nodeId=id;
        this.showPath=false;
        this.previewId=null;
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
        h('p',{class:'text-sm text-gray-300'},'Import your account in Settings to view Holomem Boards.'),
      ]);
      const selectedCard=this.connectCard??this.removedConnectCard(node.groupId);
      const actualCard=this.actualConnect;
      const path=this.showPath ? this.path : null;
      const rankGate=cell=>Math.max(cell.viewPlayerLevel??0,cell.unlockPlayerLevel??0);
      const isRankLocked=cell=>!board.active.has(cell.groupId)&&board.dreamRank!==null&&board.dreamRank<rankGate(cell);
      const nodeLabel=cell=>boardNodeLabel(cell)+(cell.description ? ', '+cell.description : '');
      const status=cell=>{
        if(this.plan?.removed.has(cell.groupId))return 'Reset in plan';
        if(this.plan?.connects.has(cell.groupId))return 'Connect changed in plan';
        if(this.plan?.added.has(cell.groupId))return 'Unlock in plan';
        const assigned=board.assignments.get(cell.groupId);
        if(assigned)return 'Connected';
        if(board.active.has(cell.groupId))return cell.type==='connect'?'Empty slot':'Unlocked';
        const gate=rankGate(cell);
        return gate && (board.dreamRank===null||board.dreamRank<gate) ? 'Requires Dream Rank '+gate : 'Locked';
      };
      const button=(label,click,props={})=>h('button',{class:action,type:'button',onClick:click,...props},label);
      const badges=[];
      const nodes=layout.nodes.map(cell=>{
        const id=cell.groupId,active=board.active.has(id),assigned=board.assignments.get(id),[x,y]=layout.points.get(id);
        const removed=this.plan?.removed.has(id);
        const showActiveArt=active||removed;
        const preview=id===node.groupId ? this.previewCard : null;
        const shownCard=preview??assigned??this.removedConnectCard(id);
        const inRange=this.range.has(id);
        const colors=palettes[cell.type] ?? palettes.support;
        const glyph=boardNodeEffectAssetName(cell),shadow=glyph?.replace('.webp','_shadow.webp');
        let layers;
        if(cell.type==='connect'&&shownCard?.thumbnail)layers=[
          h('span',{class:'holo-board-layer socket-card-shadow','aria-hidden':'true'}),
          h('span',{class:'holo-board-layer socket-card','aria-hidden':'true'},[
            cardArt(shownCard.thumbnail,'socket-card-art'),
            [3,4,5].includes(shownCard.rarity) ? art('ui_999_thm_card_rarity_r'+shownCard.rarity+'_s.webp','socket-ribbon') : null,
          ]),
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
        else if(!removed&&isRankLocked(cell))layers=[
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
          !showActiveArt ? mask('ui_999_outline_w6_r80_9s.webp','node-ring') : null,
          mask('ui_999_outline_w6_r104_9s.webp','node-outline'),
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
        const classes='holo-board-node'+(cell.type==='connect'?' is-connect':'')+(shownCard?.thumbnail?' has-connect-card':'')+
          (cell.grade>=2?' grade-two':'')+(!showActiveArt?' is-locked':'')+
          (inRange?' is-in-range':'')+(this.pathIds.has(id)?' is-on-path':'');
        const change=removed?'reset':this.plan?.connects.has(id)?'connect':this.plan?.added.has(id)?'add':undefined;
        const key=this.planChangeKey(id);
        const selectable=this.planSelection&&key;
        const editConnect=cell.type==='connect'&&!!this.planConnectChoices&&!isRankLocked(cell);
        const selected=selectable&&this.planSelection.has(key);
        if(removed||this.plan?.added.has(id)){
          badges.push(boardChangeBadge(h,removed?'reset':'add',{
            key:id,'data-badge-node':id,'data-plan-selected':selectable?String(selected):undefined,
          }));
        }
        return h('button',{key:id,type:'button','data-board-node':id,'data-plan-change':change,class:classes,
          'data-plan-selected':selectable?String(selected):undefined,
          'data-inspected':id===node.groupId?'true':undefined,
          style:{left:x+'px',top:y+'px','--node-from':colors[0],'--node-to':colors[1]},
          tabindex:id===node.groupId?0:-1,'aria-pressed':selectable?selected:id===node.groupId,
          'aria-keyshortcuts':editConnect?'Shift+F10':undefined,
          'aria-label':nodeLabel(cell)+', '+(preview?'Preview, '+preview.name:status(cell)+(shownCard?', '+shownCard.name:'')),
          onClick:()=>{
            if(performance.now()<this.suppressBoardClickUntil)return;
            this.activateNode(id);
          },
          onContextmenu:editConnect?event=>{event.preventDefault();this.openPlanConnect(id);}:undefined,
          onKeydown:event=>{
            if(editConnect&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){
              event.preventDefault();
              this.openPlanConnect(id);
            }else this.nodeKeys(event,cell);
          },
        },layers);
      });
      const planActive=this.planActive;
      const linkInset=id=>{
        const cell=board.byId.get(id);
        return (cell.type==='connect' ? .4 : cell.grade>=2 ? .46 : .32)*unit;
      };
      const edges=layout.edges.map(([a,b])=>{
        const [x1,y1]=layout.points.get(a),[x2,y2]=layout.points.get(b);
        const mark={href:'#'+this.linkId,x:(x1+x2-linkSize)/2,y:(y1+y2-linkSize)/2};
        if(planActive){
          if(!planActive.has(a)||!planActive.has(b))
            return h('use',{...mark,key:a+b,class:'is-plan-inactive'});
          const added=this.plan.added.has(a)||this.plan.added.has(b);
          const dx=Math.sign(x2-x1),dy=Math.sign(y2-y1);
          const start=linkInset(a),end=linkInset(b);
          return h('line',{key:a+b,class:added?'is-plan-add':'is-plan-active',
            x1:x1+dx*start,y1:y1+dy*start,x2:x2-dx*end,y2:y2-dy*end});
        }
        const initial=path?.nodeIds[0];
        const projected=this.pathIds.has(a)&&this.pathIds.has(b)||initial===a&&board.active.has(b)||initial===b&&board.active.has(a);
        const rankLocked=isRankLocked(board.byId.get(a))||isRankLocked(board.byId.get(b));
        return h('use',{...mark,key:a+b,class:projected?'is-on-path':rankLocked?'is-rank-locked':undefined});
      });
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
        status(node)+(actualCard?.bloom!=null?' · Bloom '+actualCard.bloom:'');
      const dialogTitle=this.dialog==='connect'?'Preview Connect card':'Select Holomem';
      const editingConnect=this.dialog==='plan-connect';
      const currentPlanCard=this.planConnectCards?.[this.connectSlot];
      const visibleConnectCards=editingConnect?this.connectOptions.filter(card=>
        (card.name+' '+card.member).toLocaleLowerCase().includes(this.search.trim().toLocaleLowerCase())):[];
      const hasCosts=cost.boardPointCost>0||cost.costs.length>0;
      const zoomControls=h('div',{class:'holo-board-controls','aria-label':'Map controls'},[
        button('−',()=>this.zoomBy(1/1.28),{ref:'zoomOut','aria-label':'Zoom out'}),
        button('+',()=>this.zoomBy(1.28),{ref:'zoomIn','aria-label':'Zoom in'}),
        button('Fit',this.fit,{'aria-label':'Fit board',title:'Fit the entire Board (F)'}),
      ]);
      return h('section',{class:'holo-board'+(this.plan?' holo-board-in-plan':''),'aria-label':'Holomem Board'},[
        h('div',{class:'holo-board-frame bg-gray-800 border border-gray-600 rounded'},[
          h('div',{class:'holo-board-toolbar'},[
            this.plan?h('span',{class:'holo-board-member'},[h('img',{src:portrait(this.member),class:'holo-board-portrait',alt:''}),this.member.name]):
            button([h('img',{src:portrait(this.member),class:'holo-board-portrait',alt:''}),
              this.member.name,art('ui_999_ico_sync.webp','holo-board-switch')],()=>this.openDialog('member'),
              {class:action+' holo-board-member','aria-label':'Select Holomem, '+this.member.name,'aria-haspopup':'dialog'}),
            board.rank===null?null:h('span',{class:'holo-board-summary text-gray-300'},'Rank '+board.rank),
            h('span',{class:'holo-board-summary holo-board-points',
              title:board.reconciled?format(board.earned)+' earned · '+format(board.spent)+' spent':undefined,
            },[art('img_resource_thumb_skilltreepoint-cmn.webp',''),board.available===null?'Board Pt unavailable':format(board.available)+' Board Pt']),
            h('span',{class:'holo-board-summary text-gray-300'},board.purchased.size+' / '+board.nodes.length+' unlocked'),
          ]),
          h('div',{class:'holo-board-layout'},[
            h('div',{ref:'map',class:'holo-board-map','aria-label':'Board map','aria-description':'Scroll to zoom. Drag to move.',tabindex:0,
              onWheel:this.wheelZoom,onKeydown:this.mapKeys,
              onDblclick:this.plan?event=>{if(!event.target.closest('button'))this.center();}:undefined,
              onPointerdown:this.startDrag,onPointermove:this.moveDrag,onPointerup:this.stopDrag,
              onLostpointercapture:this.stopDrag,onPointercancel:this.stopDrag,
            },[
              h('div',{ref:'world',class:'holo-board-world',style:{width:layout.width+'px',height:layout.height+'px',
                '--board-cell':unit+'px','--board-inset':padding+'px'}},[
                h('svg',{class:'holo-board-links',width:layout.width,height:layout.height,'aria-hidden':'true'},[
                  h('defs',null,[h('image',{id:this.linkId,href:assets+'ui_710_img_kira.webp',width:linkSize,height:linkSize})]),...edges,
                ]),...nodes,
              ]),
              this.plan?h('div',{ref:'badges',class:'holo-board-badges','aria-hidden':'true'},badges):null,
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
              !this.plan&&board.active.has(node.groupId)&&node.type==='connect'?button(this.previewCard?'Clear preview':'Preview Connect',()=>{
                if(this.previewCard)this.previewId=null;
                else this.openDialog('connect');
              }):null,
              this.planConnectChoices&&node.type==='connect'&&!isRankLocked(node)?
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
            vnode('span',{class:'holo-board-picker-meta text-gray-400'},card.member+' · Bloom '+format(card.bloom)),
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
            [h('p',{class:'text-sm text-gray-400'},'No eligible imported cards found')]),
        ]:[]}),
      ]);
    },
  };
}
