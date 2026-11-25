import {formatNumber,parseNumber} from './regional-formats.js';
import {game} from './game';
import {upgradeRecipes,loungeRecipes,conversionRecipe,sodaPopCoin,manualQuote,maxManualBatches,applyManualConversion} from './conversions';
import {applyGameInventoryEdits,inventoryPlacement,loadGameItems,projectGameInventory} from './game-inventory';
import {ACCOUNT_RESOURCE_ITEM_IDS} from './account-import';
import {inventoryEventCurrency,inventoryEventTime} from './inventory-events';
export {clearGameInventory} from './game-inventory';
export {isGameInventoryId} from '../hololive/vendor/shared/types';

export const inventoryCategories=['all','training','construction','other'];
const previousTabs={level:'training',bloom:'training',park:'construction',currency:'other',consumables:'other',events:'other'};
const inventorySections=['members','board','construction','other','park','consumables','exchange','events','membership'];
const sectionLabels={
  members:'Members',board:'Holomem Board',construction:'Park',other:'Other Items',park:'Park Items',
  consumables:'Tickets & Boosts',exchange:'Exchange',events:'Event Currency',membership:'Membership Medals',
};
const pinnedStock=['hologold','harmonyGardenCoin','megaSphereCoin','item-mini_game_fishing_coin','lessonPoints','freeDiamonds','paidDiamonds'];
const pinnedStockOrder=new Map(pinnedStock.map((id,index)=>[id,index]));
const searchText=name=>name.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase();
const compactUnits=[[1e15,'Q'],[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];
const noGameItems=Object.freeze({});
export const inventoryQuantity=game.inventoryQuantity;
export function compactQuantity(value) {
  if(typeof value==='bigint'){
    for(const [unit,label]of compactUnits){
      const scale=BigInt(unit);
      if(value>=scale){
        const tenths=value*10n/scale;
        const fraction=Number(tenths%10n);
        const decimal=fraction?formatNumber(fraction/10,{maximumFractionDigits:1}).slice(1):'';
        return formatNumber(tenths/10n)+decimal+label;
      }
    }
    return formatNumber(value);
  }
  const amount=Number(value)||0;
  for(const [unit,label]of compactUnits)
    if(amount>=unit)return formatNumber(Math.floor(amount/unit*10)/10,{maximumFractionDigits:1})+label;
  return formatNumber(amount);
}
/** The original input remains the editor; only its unfocused display changes. */
export function configureInventoryQuantity(original) {
  return {...original,props:{...original.props,gameItem:Object},emits:['quantity-focus','quantity-blur'],data(){return {...original.data?.call(this),quantityEditing:false,quantityDraft:null};},
    computed:{...original.computed,
      quantityText(){
        if(this.gameItem?.unlimited)return '∞';
        const quantity=this.gameItem?this.gameItem.quantity:this.have;
        if(this.quantityEditing&&this.quantityDraft!==null)return this.quantityDraft;
        if(quantity==null)return this.quantityEditing?'':'—';
        return this.quantityEditing?formatNumber(quantity):compactQuantity(quantity);
      },
      ...(original.computed.creditValue?{
      creditValue:{
        get(){
          return this.quantityText;
        },
        set(value){this.writeQuantity(value);},
      },
    }:{
      have(){return this.gameItem?Number(this.gameItem.quantity??0):original.computed.have.call(this);},
    })},
    methods:{...original.methods,
      ...(original.methods?.keyPressed?{keyPressed(event,stepper){
        if(this.gameItem?.quantity>Number.MAX_SAFE_INTEGER&&['w','s'].includes(event.key.toLowerCase())){
          event.preventDefault();return;
        }
        if(!stepper&&!event.altKey&&!event.ctrlKey&&!event.shiftKey&&['w','s'].includes(event.key.toLowerCase())){
          event.preventDefault();
          const amount=parseNumber(event.target.value)||0;
          event.target.value=formatNumber(amount+(event.key.toLowerCase()==='w'?1:-1));
          return;
        }
        if(stepper&&['w','s'].includes(event.key.toLowerCase()))this.quantityDraft=null;
        original.methods.keyPressed.call(this,event,stepper);
      }}:{}),
      writeQuantity(text){
        if(this.gameItem?.unlimited)return;
        this.quantityDraft=text;
        const amount=text.trim()?parseNumber(text):0;
        if(Number.isFinite(amount))this.setInventory(this.type,this.item,this.tier,amount);
      },
      focusQuantity(event){if(this.gameItem?.unlimited){event.target.blur();return;}this.quantityDraft=null;this.quantityEditing=true;this.$emit('quantity-focus',this.item);this.$nextTick(()=>event.target.select());},
      blurQuantity(event){
        this.quantityEditing=false;this.quantityDraft=null;event.target.value=this.quantityText;
        this.$emit('quantity-blur',this.item);
      },
      ...(original.methods?.blurAddInput?{blurAddInput(event){
        const amount=parseNumber(event.target.value);
        if(Number.isFinite(amount)&&amount)this.setInventory(this.type,this.item,this.tier,this.have+amount);
        event.target.value='';
      }}:{}),
    },
  };
}
/** Keep the captured Jb/pC page, inputs, filters, keyboard and settings. */
export function configureInventory(original) {
  const before=original.data;
  return {...original,
    data(){const data=before.call(this);return {...data,filter:inventoryCategories.includes(data.filter)?data.filter:previousTabs[data.filter]??'all',options:{...data.options,hideEmptyNeed:true},gameItemCatalog:null,search:'',
      eventWindows:[],eventNow:Date.now(),eventTimer:null,inventoryMounted:false,focusedQuantity:null};},
    async mounted(){
      original.mounted.call(this);this.inventoryMounted=true;
      const [catalog,events]=await Promise.all([loadGameItems(),window.__holodoriDesktop.inventoryEventWindows()]);
      if(!this.inventoryMounted)return;
      this.eventWindows=events;this.gameItemCatalog=catalog;this.getItems();this.refreshEventClock();
    },
    beforeUnmount(){this.inventoryMounted=false;clearTimeout(this.eventTimer);original.beforeUnmount?.call(this);},
    computed:{...original.computed,
      hideZero:{
        get(){return this.settings.inventory_hide_zero===true;},
        set(value){this.setSetting('inventory_hide_zero',value===true);},
      },
      gameSnapshot(){return this.$root.data?.[this.account+'-holodori']?.gameAccountImport?.snapshot;},
      gameItemBase(){return this.gameItemCatalog?projectGameInventory(this.gameSnapshot,this.gameItemCatalog,compactQuantity,
        this.$root.data?.[this.account+'-holodori']?.gameInventory??{}):noGameItems;},
      gameItems(){return applyGameInventoryEdits(this.gameItemBase,this.inventory,compactQuantity);},
      plannerItems(){
        return Object.fromEntries(game.resourceKeys.map((key,index)=>{
          const id=ACCOUNT_RESOURCE_ITEM_IDS[key]??key,item=this.gameItemCatalog?.items[id];
          const category=item?.category??(['hologold','harmonyGardenCoin','megaSphereCoin',sodaPopCoin].includes(key)?'OTHER':'CARD_LEVELING');
          return [key,{...inventoryPlacement(id,category,item?.type),name:game.resourceLabels[key],order:item?.order??index}];
        }));
      },
      searchQuery(){return searchText(this.search.trim());},
      keepEventCurrency(){return inventoryEventCurrency(this.eventWindows,inventoryEventTime(this.gameSnapshot,this.eventNow));},
      visibleItems(){
        const materials=this.filteredItems.filter(id=>this.matchesSearch(this.plannerItems[id].name)&&this.showQuantity(id,this.getInventory(id,id,0)));
        const regular=this.show==='all'
          ? Object.keys(this.gameItems).filter(id=>{
            const tile=this.gameItems[id];
            return this.keepEventCurrency(id)&&this.matchesSearch(tile.name)&&this.showQuantity(id,tile.quantity)
              &&(this.filter==='all'?(!tile.hidden||!!this.searchQuery):tile.category===this.filter);
          })
          : [];
        return [...materials,...regular];
      },
      regularGridOptions(){
        return {...this.options,hideNeed:true,hideMissing:true,hideCraft:true};
      },
      displayItems(){
        const sortKey=id=>{
          const item=this.plannerItems[id]??this.gameItems[id];
          if(this.filter==='all'&&pinnedStockOrder.has(id))return [-1,pinnedStockOrder.get(id)];
          return [inventorySections.indexOf(item.section),item.order??Infinity];
        };
        return this.visibleItems.map(id=>[id,...sortKey(id)])
          .sort(([leftId,leftGroup,leftOrder],[rightId,rightGroup,rightOrder])=>
            leftGroup-rightGroup||leftOrder-rightOrder||leftId.localeCompare(rightId))
          .map(([id])=>id);
      },
      itemHeadings(){
        const boundaries={};
        if(this.filter==='all')return boundaries;
        let previousSection;
        for(const id of this.displayItems){
          const section=(this.plannerItems[id]??this.gameItems[id]).section;
          if(section!==previousSection)boundaries[id]=sectionLabels[section];
          previousSection=section;
        }
        return boundaries;
      },
    },
    watch:{...original.watch,account(){this.getItems();},goals:{deep:true,handler(){this.getItems();}},custom_items:{deep:true,handler(){this.getItems();}},inactive:{deep:true,handler(){this.getItems();}},
      gameSnapshot(){if(this.inventoryMounted)this.refreshEventClock();},
    },
    methods:{...original.methods,
    focusQuantityItem(id){this.focusedQuantity=id;},
    blurQuantityItem(id){if(this.focusedQuantity===id)this.focusedQuantity=null;},
    matchesSearch(name){return !this.searchQuery||searchText(name).includes(this.searchQuery);},
    showQuantity(id,quantity){return !this.hideZero||this.focusedQuantity===id||(quantity!==0&&quantity!==0n);},
    refreshEventClock(){
      clearTimeout(this.eventTimer);
      this.eventNow=Date.now();
      const time=inventoryEventTime(this.gameSnapshot,this.eventNow);
      const boundary=Math.min(...this.eventWindows.flatMap(event=>[event.startTime,event.endTime+1]).filter(value=>value>time));
      if(Number.isFinite(boundary))this.eventTimer=setTimeout(()=>this.refreshEventClock(),Math.min(2_147_483_647,boundary-time));
    },
    getItems(){this.filteredItems=game.resourceKeys.filter(key=>{
      if(this.filter!=='all'&&this.plannerItems[key].category!==this.filter)return false;
      if(this.show==='needed')return this.totalCosts.some(cost=>cost.item===key&&cost.need>0);
      if(this.show==='craftable')return this.getCraft(key,key,0)>0;
      return true;
    });}},
  };
}

/** Holodori-only conversion form, using the captured Dialog and ItemCost
 * renderer. It occupies the former foreign-inventory-import menu slot. */
export function createInventoryConversions({h,vnode,Dialog,Cost}) {
  const Spend={...Cost,name:'ConversionCost',props:{...Cost.props,conversionPreview:{type:Boolean,default:true}},computed:{...Cost.computed,
    needTotal(){return this.need;},
    haveSingular(){return this.getInventory(this.item.type,this.item.item,0);},
    haveTotal(){return this.haveSingular;},
    missingTotal(){return Math.max(0,this.need-this.haveSingular);},
  }};
  const Receive={...Spend,name:'ConversionOutput',computed:{...Spend.computed,missingTotal(){return 0;}}};
  const button='bg-gray-600 hover:bg-gray-500 shadow rounded-md py-2 px-3 transition-colors disabled:opacity-50 disabled:pointer-events-none';
  return {name:'InventoryConversions',props:{tippy:Object,buttonClass:String},emits:['converted'],
    data(){return {visible:false,recipeId:'cute',batches:1,busy:false,error:''};},
    computed:{
      stock(){return Object.fromEntries(game.resourceKeys.map(key=>[key,this.getInventory(key,key,0)]));},
      recipe(){return conversionRecipe(this.recipeId);},
      maximum(){return maxManualBatches(this.stock,this.recipeId);},
      quote(){try{return manualQuote(this.stock,this.recipeId,parseNumber(this.batches));}catch{return null;}},
    },
    methods:{
      open(){this.tippy?.hide();this.error='';this.batches=1;this.visible=true;},
      async convert(){
        if(this.busy)return;this.error='';let applied=false;
        try{
          const quote=manualQuote(this.stock,this.recipeId,parseNumber(this.batches));
          const next=applyManualConversion(this.stock,this.recipeId,quote.batches);
          this.busy=true;
          // All values are validated before any mutation. Synchronous captured
          // setters feed a single final inventory snapshot to native autosave.
          for(const key of [...quote.inputs.map(input=>input.key),quote.to,quote.feeKey])this.setInventory(key,key,0,next[key]);
          applied=true;await window.__holodoriDesktop.flush();
          this.visible=false;this.$emit('converted');
          this.setToast?.(`Converted ${formatNumber(quote.output)} ${game.resourceLabels[quote.to]}.`);
        }catch(error){
          if(applied){this.visible=false;this.$emit('converted');this.setToast?.('Conversion recorded. Retry saving in Settings.','error');}
          else this.error=String(error.message||error);
        }finally{this.busy=false;}
      },
    },
    render(){
      const recipe=this.recipe,quote=this.quote;
      const cost=(component,key,need)=>vnode(component,{item:{type:key,item:key,need},tier:0,release:game.items[key]});
      return h('div',{},[
        h('button',{type:'button',class:this.buttonClass,onClick:this.open},'Convert materials'),
        vnode(Dialog,{visible:this.visible,'onUpdate:visible':value=>{if(!this.busy)this.visible=value;},modal:true,draggable:false,position:'top',dismissableMask:!this.busy,closeOnEscape:!this.busy,closable:!this.busy,header:'Convert materials',style:{width:'420px'}},{default:()=>[
          h('form',{onSubmit:event=>{event.preventDefault();void this.convert();}},[
            h('label',{id:'conversion-recipe-label',for:'conversion-recipe',class:'block font-semibold text-sm'},'Materials'),
            h('select',{id:'conversion-recipe',class:'bg-gray-600 rounded mt-2 w-full',value:this.recipeId,disabled:this.busy,onChange:event=>{this.recipeId=event.target.value;this.batches=1;this.error='';}},[['Beads to Crystals',upgradeRecipes],['Ichijou VIP Lounge',loungeRecipes]].map(([label,recipes])=>h('optgroup',{label},recipes.map(item=>h('option',{value:item.id},`${item.inputs.map(input=>game.resourceLabels[input.key]).join(' + ')} → ${game.resourceLabels[item.to]}`))))),
            h('p',{class:'text-sm text-gray-300 mt-3'},`Each exchange uses ${recipe.inputs.map(({key,quantity})=>`${quantity} ${game.resourceLabels[key]}`).join(' + ')} and ${formatNumber(recipe.fee)} ${game.resourceLabels[recipe.feeKey]}s to make ${recipe.output} ${game.resourceLabels[recipe.to]}.`),
            h('label',{for:'conversion-batches',class:'block font-semibold text-sm mt-3'},'Exchanges'),
            h('div',{class:'flex items-center gap-2 mt-2'},[
              h('input',{id:'conversion-batches',type:'text',inputmode:'numeric',required:true,class:'bg-gray-700 rounded py-2 px-3 border border-gray-500 w-full',value:this.batches,disabled:this.busy,onInput:event=>{this.batches=event.target.value;this.error='';}}),
              h('button',{type:'button',class:button,disabled:this.busy||this.maximum<1,onClick:()=>{this.batches=formatNumber(this.maximum);this.error='';}},'Max'),
            ]),
            h('p',{class:'text-xs text-gray-400 mt-1'},`${formatNumber(this.maximum)} exchanges available`),
            quote?h('div',{class:'flex items-start justify-between mt-4'},[
              h('section',{},[h('p',{class:'font-semibold text-sm mb-2'},'Use'),h('div',{class:'flex gap-2'},[...quote.inputs.map(input=>cost(Spend,input.key,input.quantity)),cost(Spend,quote.feeKey,quote.fee)])]),
              h('section',{},[h('p',{class:'font-semibold text-sm mb-2'},'Receive'),cost(Receive,quote.to,quote.output)]),
            ]):null,
            this.error?h('p',{role:'alert',class:'text-sm text-red-400 mt-3'},this.error):!quote?h('p',{role:'status',class:'text-sm text-red-400 mt-3'},'Enter a positive whole number of exchanges.'):!quote.canApply?h('p',{role:'status',class:'text-sm text-red-400 mt-3'},'Not enough materials or coins, or the result exceeds the supported quantity.'):null,
            h('div',{class:'flex justify-end gap-2 mt-4'},[
              h('button',{type:'button',class:'bg-gray-700 shadow rounded-md py-2 px-3',disabled:this.busy,onClick:()=>{this.visible=false;}},'Cancel'),
              h('button',{type:'submit',class:'bg-purple-600 hover:bg-purple-500 shadow rounded-md py-2 px-3 font-semibold disabled:opacity-50 disabled:pointer-events-none',disabled:this.busy||!quote?.canApply},this.busy?'Converting…':'Convert'),
            ]),
          ]),
        ]}),
      ]);
    },
  };
}
