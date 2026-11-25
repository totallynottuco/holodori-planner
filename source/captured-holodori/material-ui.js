import {sodaPopCoin} from './conversions';
import {formatNumber} from './regional-formats.js';
import {materialPlan} from './material-plan';
import {bloomRequirements,game} from './game';

const groups=['level','training','bloom','other'];
/** Adapt only the original rb controller. Mb/B6/vg/Rs remain the renderers. */
export function configureMaterialPlanner(original) {
  const before=original.data;
  const recalculate={deep:true,handler(){this.calculateCosts();}};
  return {...original,
    data(){const data=before.call(this);return {...data,filter:groups.includes(data.filter)?data.filter:'all'};},
    computed:{...original.computed,bloomPlans(){return bloomRequirements(this);},
      count(){
        const count=original.computed.count.call(this);
        return this.bloomPlans.length?{...count,bloom:count.bloom+1,total:count.total+1}:count;
      },
      hasPlannedRequirements(){return this.bloomPlans.length>0||this.totalCosts.some(cost=>cost.need>0);},
      jarActions(){
        const {jars,exchanges,pendingExchanges,exchangeCoinShortfall,sodaCoinShortfall}=game.materialSupplyFor(this);
        const targets=new Set([...Object.keys(jars),...exchanges.map(e=>e.to),...pendingExchanges.map(e=>e.to)]);
        return {exchangeCoinShortfall,sodaCoinShortfall,items:[...targets].map(item=>({
          item,uses:[],extra:0,...jars[item],exchanges:exchanges.filter(e=>e.to===item),
          pending:pendingExchanges.filter(e=>e.to===item),remaining:this.getMissing(item,item,0),
        }))};
      },
    },
    // Original Item quantities update live. Keep its panel mounted during an
    // inventory edit; the captured Refresh action removes completed panels.
    watch:{...original.watch,custom_items:recalculate,account(){this.calculateCosts();}},
    methods:{...original.methods,
      calculateCosts(){const plan=materialPlan(this);this.activities=plan.activities;this.estimations={};},
    },
  };
}

export function createBloomPlanSummary({h}) {
  const amount=(resource,value,label)=>h('span',{class:'inline-flex shrink-0 items-center gap-1 text-xs',title:label},[
    h('img',{src:game.resourceImage(resource),class:'h-4 w-4 object-contain',alt:label}),formatNumber(value),
  ]);
  return {props:{plans:Array},render(){
    if(!this.plans?.length)return null;
    return h('section',{class:'mb-3 rounded-md bg-gray-700/70 p-2','aria-label':'Bloom goals'},[
      h('h2',{class:'mb-1 text-sm font-semibold'},'Bloom goals'),
      h('ul',{class:'grid gap-1 sm:grid-cols-2'},this.plans.map(plan=>h('li',{key:plan.id,
        class:'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded bg-gray-800/70 px-2 py-1 text-xs'},[
        h('img',{src:game.cardImage(plan.id,'grid'),class:'w-10 shrink-0 rounded',loading:'lazy',alt:''}),
        h('span',{class:'min-w-0 flex-1 break-words'},game.getCard(plan.id)?.cardName),
        h('strong',{class:'shrink-0'},`${plan.current} → ${plan.target}`),
        plan.points?amount('bloomPoints',plan.points,'Recorded Member Bloom Pts'):null,
        plan.remaining?plan.usesStones?amount('bloomStones',plan.remaining,'Bloom Stones needed after recorded Member Bloom Pts'):
          h('span',{class:'text-amber-300'},[amount('bloomPoints',plan.remaining,'Member Bloom Pts'),' missing']):null,
      ]))),
    ]);
  }};
}
export function createMaterialJarSummary({h}) {
  const icon=(item,quantity)=>h('span',{class:'inline-flex shrink-0 items-center gap-1'},[
    h('img',{src:game.resourceImage(item),class:'h-4 w-4 object-contain',alt:game.resourceLabels[item]}),
    formatNumber(quantity),
  ]);
  const bundleRow=(jar,prefix='')=>h('div',{key:jar.id,class:'mt-1 flex items-center gap-2 text-xs'},[
    h('img',{src:jar.image,class:'h-5 w-5 shrink-0 object-contain',alt:''}),
    h('span',{class:'min-w-0'},`${prefix}${formatNumber(jar.quantity)} × ${jar.name} (+${formatNumber(BigInt(jar.quantity)*BigInt(jar.amount))})`),
  ]);
  return {
    props:{actions:Object},
    render(){
      if(!this.actions?.items.length)return null;
      const {items,exchangeCoinShortfall,sodaCoinShortfall}=this.actions;
      const quoteLine=e=>[...e.inputs.flatMap(({key,quantity})=>[icon(key,quantity),' + ']),icon(e.feeKey,e.fee),' → ',icon(e.to,e.output)];
      const title=exchangeCoinShortfall||sodaCoinShortfall||items.some(action=>action.exchanges.length)?'Material jars and exchanges':'Open material jars';
      return h('section',{class:'mt-3 rounded-md bg-gray-700/70 p-3','aria-label':title},[
        h('div',{class:'flex flex-wrap items-center justify-between gap-x-3 gap-y-1'},[
          h('h2',{class:'text-sm font-semibold'},title),
          exchangeCoinShortfall?h('p',{class:'inline-flex items-center gap-1 text-xs text-amber-300'},[
            icon('megaSphereCoin',exchangeCoinShortfall),' more Mega Sphere Coins needed',
          ]):null,
          sodaCoinShortfall?h('p',{class:'inline-flex items-center gap-1 text-xs text-amber-300'},[icon(sodaPopCoin,sodaCoinShortfall),' more Soda Pop Coins needed']):null,
        ]),
        h('div',{class:'mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3'},items.map(action=>{
          const {exchanges,forExchange=0}=action;
          const extra=action.extra-forExchange;
          return h('div',{key:action.item,class:'min-w-0 rounded bg-gray-800/70 p-2','data-material-jar':action.item},[
            h('div',{class:'flex items-center gap-2 text-sm font-semibold'},[
              h('img',{src:game.resourceImage(action.item),class:'h-6 w-6 shrink-0 object-contain',alt:''}),
              h('span',{},game.resourceLabels[action.item]),
            ]),
            ...action.uses.map(jar=>bundleRow(jar)),
            forExchange?h('p',{class:'mt-1 text-xs text-gray-300'},`${formatNumber(forExchange)} from jars or bundles for exchange`):null,
            ...exchanges.map(exchange=>h('div',{class:'mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs'},[
              h('span',{class:'font-semibold'},'Affordable now'),...quoteLine(exchange),
            ])),
            h('p',{class:`mt-2 text-xs ${action.remaining?'text-amber-300':'text-gray-300'}`},
              action.remaining?`Still needed: ${formatNumber(action.remaining)}`:
                extra?`${formatNumber(extra)} extra after ${forExchange?'exchange':'opening'}`:
                  exchanges.length?'Covered after exchange':forExchange?'All materials allocated':'Covered after opening'),
            ...action.pending.map(pending=>h('div',{class:'mt-2 border-t border-gray-600 pt-2 text-gray-300'},[
              h('p',{class:'text-xs'},[h('span',{class:'font-semibold text-amber-300'},'Once funded'),
                ` · ${formatNumber(pending.covered)} more covered`]),
              h('p',{class:'mt-1 flex flex-wrap items-center gap-1 text-xs'},quoteLine(pending)),
              ...pending.bundles.map(jar=>bundleRow(jar,'Open ')),
            ])),
          ]);
        })),
      ]);
    },
  };
}
/** Keep the captured custom-requirement dialog and its actual item inputs. */
export function configureExtraMaterials(original) {
  return {...original,computed:{...original.computed,
    categories(){return groups;},
    filteredItems(){return this.selectedCategory?game.resourceKeys.filter(key=>game.resourceGroups[key]===this.selectedCategory):false;},
  },methods:{...original.methods,
    clearCategory(){if(!this.selectedCategory)return;for(const item of this.custom_items.filter(item=>game.resourceGroups[item.item]===this.selectedCategory&&item.value))this.setCustomItem(item.type,item.item,item.tier,0);this.$emit('update');},
  }};
}
