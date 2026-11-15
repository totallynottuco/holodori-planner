import {cardFilters,load,save} from './card-filters';
import {getCard,rulesFor} from './game';
import {currentOwnership} from './current-account';
import catalogOrder from './card-catalog-order.json';

function sortPickerCards(cards,sort){
  const order=card=>getCard(card.key)?.catalogOrder??catalogOrder[card.key];
  return cards.sort((a,b)=>{
    const byName=a.name.localeCompare(b.name)||a.key.localeCompare(b.key);
    if(sort==='nameDescending')return -byName;
    if(sort==='rarity'||sort==='rarityAscending')return (sort==='rarity'?b.tier-a.tier:a.tier-b.tier)||byName;
    if(sort==='newest'||sort==='oldest'){
      const first=order(a),second=order(b);
      if(first==null||second==null)return Number(first==null)-Number(second==null)||byName;
      return (sort==='newest'?second-first:first-second)||byName;
    }
    return byName;
  });
}

/** Retain the captured filters and their renderers; only selection and the
 * per-profile storage boundary change. Loading a profile never writes it. */
export function configureCardFilters(original,collection=false) {
  const scope=collection?'collection':'picker';
  return {...original,
    data(){return {...original.data.call(this),cardFilterOwner:null,...(collection?{}:{refineOpen:false})};},
    created(){original.created?.call(this);this.restoreCardFilters(this.account);},
    watch:{...original.watch,
      account:{flush:'sync',handler(id){this.restoreCardFilters(id);}},
      filters:{deep:true,flush:'sync',handler(filters){if(this.cardFilterOwner===this.account)save(localStorage,this.cardFilterOwner,scope,filters);}},
    },
    computed:{...original.computed,
      cardOwnershipSet(){return currentOwnership(window.__seelieApp?.data?.[`${this.account}-holodori`]);},
      ownershipAvailable(){return this.cardOwnershipSet!==null;},
      filteredCharacters(){
        const maxed=new Set();
        if(collection&&this.filters.hideMaxed){
          for(const goal of this.goals){
            if(goal.type!=='character')continue;
            const card=getCard(goal.character);
            if(!card)continue;
            const rules=rulesFor(card.rarity);
            if(goal.current?.level>=rules.maxLevel&&goal.current.asc>=rules.trainingStages.length)maxed.add(goal.character);
          }
        }
        const cards=original.computed.filteredCharacters.call(this).filter(card=>{
          const id=typeof card==='string'?card:card.key;
          return !maxed.has(id)&&cardFilters.matchesOwnership(id,this.filters.ownership,this.cardOwnershipSet);
        });
        return collection?cards:sortPickerCards(cards,this.filters.sort);
      },
      ...(collection?{anyFilter(){return cardFilters.active(this.filters,this.ownershipAvailable);}}:{
        refineChips(){
          const stat={performance:'Performance',technique:'Technique',sense:'Sense'};
          const groups=[
            ['type',this.filters.type.map(value=>[value,value[0].toUpperCase()+value.slice(1)])],
            ['path',this.filters.path.map(value=>[value,stat[value]])],
            ['tier',this.filters.tier.map(value=>[value,`${value}★`])],
            ['ownership',this.ownershipAvailable?this.filters.ownership.map(value=>[value,value==='owned'?'Owned':'Unowned']):[]],
          ];
          const chips=groups.flatMap(([group,items])=>items.map(([value,label])=>({group,value,label})));
          if(!this.replacing&&this.showAdded)chips.push({group:'added',value:true,label:'Show added'});
          return chips;
        },
      }),
    },
    methods:{...original.methods,
      restoreCardFilters(id){this.cardFilterOwner=null;this.filters=load(localStorage,id,scope);this.cardFilterOwner=id;},
      toggleMaxed(){this.filters.hideMaxed=!this.filters.hideMaxed;},
      removeRefinement(chip){if(chip.group==='added')this.showAdded=false;else this.filter(chip.group,chip.value);},
      filter(group,value){if(group==='ownership'&&!this.ownershipAvailable)return;this.filters[group]=cardFilters.toggle(this.filters[group],value);},
    },
  };
}

/** A saved search uses the existing expanded search field on restoration. */
export function configureFilterSearch(original) {
  return {...original,data(){return {...original.data.call(this),showSearchField:!!this.modelValue?.trim()};},
    watch:{...original.watch,modelValue(value){if(value?.trim())this.showSearchField=true;}},
  };
}
