import {formatNumber,formatDateTime,numberParts} from './regional-formats.js';
import {cardStats,statNames} from './card-stats';
import {createCardPreview} from './card-preview';
import {currentOwnership} from './current-account';

/** Approved Seelie Fusion presentation inside the captured card Dialog. */
export function createCardStats({h,vnode,resolve,withDirectives,vShow}){
  const Preview=createCardPreview(h);
  return {name:'CardStats',props:{cardId:String,goals:Array,account:String,active:{type:Boolean,default:true}},
    data(){return {breakdownOpen:false,ownershipError:''};},
    computed:{
      profile(){return window.__seelieApp?.data?.[`${this.account}-holodori`];},
      owned(){return currentOwnership(this.profile)?.has(this.cardId)??false;},
      stats(){
        const goal=this.goals?.find(value=>value.type==='character'&&value.character===this.cardId);
        const blooms=new Map((this.goals||[]).filter(value=>value.type==='character').map(value=>[value.character,value.eidolon||0]));
        return cardStats(this.cardId,goal?.current?.level||1,goal?.eidolon||0,this.profile?.gameAccountImport,blooms,this.profile);
      },
    },
    render(){
      const stats=this.stats,number=value=>value==null?'—':formatNumber(value);
      if(!stats)return h('p',{class:'text-xs text-gray-400 mt-3','data-card-stats':''},'Stats are unavailable for this card.');
      const source=stats.reason==='no-import'?'Record Holomem Boards in Progress to include Board bonuses.':stats.reason==='boards-unavailable'?'Board bonuses are unavailable for the current layout.':
        this.profile?.boardEdits&&Object.keys(this.profile.boardEdits).length?'Uses your current Holomem Boards.':stats.importedAt?
          `Boards from last import · ${formatDateTime(stats.importedAt)}.`:'Uses your current Holomem Boards.';
      const digits=value=>{
        if(value==null)return [h('span',{},'—')];
        const text=String(value),padding=Math.max(0,6-text.length);
        const digit=(value,zero=false)=>h('span',{class:zero?'holo-stat-digit holo-stat-zero':'holo-stat-digit'},value);
        return [...Array.from({length:padding},()=>digit('0',true)),...numberParts(value).flatMap(part=>
          part.type==='group'?h('span',{class:'holo-stat-separator'},part.value):Array.from(part.value,value=>digit(value)))];
      };
      const row=(label,value,key)=>h('div',{class:'holo-stat-row'+(key==='total'?' holo-stat-total border-b border-gray-600':''),'data-stat':key},[
        key==='total'?h('span',{class:'holo-stat-note text-gray-400','aria-hidden':'true'},'♫'):h('span',{class:`holo-stat-badge holo-stat-${key}`,'aria-hidden':'true'},[h('img',{src:`/assets/ui/stat-${key}.webp`,alt:'',width:20,height:20,decoding:'async'})]),
        h('span',{class:'holo-stat-label font-semibold'},label),
        h('span',{class:'holo-stat-number','aria-hidden':'true'},digits(value)),
        h('span',{class:'sr-only'},number(value)),
      ]);
      const bonus=value=>value==null?'—':`${value>=0?'+':''}${number(value)}`;
      const cell=(tag,value,classes='')=>h(tag,{class:'py-1 px-2 '+classes,...(tag==='th'?{scope:'col'}:{})},value);
      const Chevron=resolve('chevron-right-icon'),breakdownId=`holo-card-breakdown-${this.$.uid}`;
      return h('section',{class:'holo-card-stats mt-3 text-xs','data-card-stats':'','aria-label':'Card stats'},[
        h('div',{class:'holo-card-stats-grid'},[
          vnode(Preview,{cardId:this.cardId,account:this.account,goals:this.goals,active:this.active}),
          h('div',{class:'holo-card-stats-panel bg-gray-600/50 border border-gray-600 rounded text-gray-200',title:source},[
            row(stats.total?'Total':'Card total',stats.totalPower??stats.cardTotal,'total'),
            ...Object.entries(statNames).map(([key,label])=>row(label,(stats.total||stats.card)[key],key)),
          ]),
        ]),
        h('div',{class:'holo-card-stats-breakdown'},[
          h('div',{class:'holo-card-stats-actions'},[
            h('button',{type:'button',class:'flex w-full items-center py-2 px-3 rounded bg-gray-600/50 hover:bg-gray-600 transition-colors','aria-expanded':this.breakdownOpen,'aria-controls':breakdownId,title:source,onClick:()=>{this.breakdownOpen=!this.breakdownOpen;}},[
              h('span',{class:'flex items-center font-semibold'},[vnode(Chevron,{class:'w-4 transition-all mr-1'+(this.breakdownOpen?' rotate-90':'')}),'Card and board breakdown']),
            ]),
            h('button',{type:'button','aria-pressed':this.owned,'aria-label':'Owned card',title:'Include this card in your owned roster',
              class:'holo-card-ownership rounded bg-gray-600/50 hover:bg-gray-600 font-semibold',onClick:()=>{
                this.ownershipError='';
                try{window.__holodoriDesktop.setCardOwnership(this.account,this.cardId,!this.owned);}
                catch(error){this.ownershipError=error.message;}
              }},this.owned?'Owned':'Unowned'),
          ]),
          this.ownershipError?h('p',{class:'text-red-400',role:'alert'},this.ownershipError):null,
          withDirectives(h('div',{id:breakdownId,class:'holo-card-stats-table bg-gray-600/20 rounded mt-2'},[
            h('table',{class:'w-full text-right',style:{fontVariantNumeric:'tabular-nums'},'aria-label':'Card and board breakdown'},[
              h('colgroup',{},[h('col',{style:{width:'40%'}}),h('col',{style:{width:'20%'}}),h('col',{style:{width:'20%'}}),h('col',{style:{width:'20%'}})]),
              h('thead',{class:'text-gray-400'},[h('tr',{},[cell('th','Stat','text-left font-normal'),cell('th','Card','text-right font-normal'),cell('th','Boards','text-right font-normal'),cell('th','Total','text-right font-normal')])]),
              h('tbody',{},[...Object.entries(statNames).map(([key,label])=>h('tr',{},[h('th',{scope:'row',class:'text-left font-normal py-1 px-2'},label),cell('td',number(stats.card[key])),cell('td',bonus(stats.total?stats.total[key]-stats.card[key]:null),'text-gray-400'),cell('td',number(stats.total?.[key]),'font-semibold')])),
                h('tr',{class:'border-t border-gray-600 font-semibold'},[h('th',{scope:'row',class:'text-left py-1 px-2'},'Power'),cell('td',number(stats.cardTotal)),cell('td',bonus(stats.totalPower===null?null:stats.totalPower-stats.cardTotal),'text-gray-400'),cell('td',number(stats.totalPower))]),
              ]),
            ]),
            stats.reason?h('p',{class:'text-gray-400 mt-2 leading-tight px-2 pb-1'},source):null,
          ]),[[vShow,this.breakdownOpen]]),
        ]),
      ]);
    },
  };
}
