import {game} from './game';

// Level choices represent numbers; SP upgrades remain in their existing tab.
const levelOptions=id=>game.levelStates(id).filter((value,index,list)=>!index||value.level!==list[index-1].level);

function refreshState() {
  if(this.section==='level') {
    this.ascended=game.ascendedLevels(this.selected);
    this.levelOptions=levelOptions(this.selected);
  }
  const record=this.characterGoal;
  this.current=record?.current?{...record.current}:null;
  this.goal=record?.goal?{...record.goal}:null;
}

/** Adapts the actual captured Ih options object. Its qh renderer, Ke picker,
 * PrimeVue OverlayPanel, IndividualCosts, watchers and event flow remain live.
 */
export function configureCharacterEditor(original) {
  original.props = {...original.props,section:{type:String,default:'level'}};
  original.data = function(){return {ascended:game.ascendedLevels(this.selected),levelOptions:levelOptions(this.selected),current:null,goal:null};};
  original.computed.fates = ()=>0;
  original.mounted=refreshState;
  original.watch={...original.watch,selected:refreshState,characterGoal:{handler:refreshState}};
  original.methods={...original.methods,
    selectedCharacterCurrent(value){
      this.$refs.characterCurrent.hide();
      const previous=this.current;
      this.current={...value,asc:Math.max(value.asc??0,previous?.asc??0)};
      if(previous?.level===value.level&&previous.expIntoLevel!=null)this.current.expIntoLevel=previous.expIntoLevel;
      this.goal={...(this.goal||this.current),level:Math.max(this.goal?.level??value.level,value.level),asc:Math.max(this.goal?.asc??0,this.current.asc)};
      this.addOrUpdateCharacter();
    }
  };
  return original;
}
export function createTrainingEditor(original) {
  const component={...original,name:'HolodoriSPUsingCapturedLevel',
    props:{...original.props,section:{type:String,default:'sp'}},
    data(){return {ascended:{},levelOptions:game.trainingStates().map(({level})=>({level})),current:null,goal:null};},
    computed:{...original.computed,
      characterGoal(){
        const record=this.goals.find(goal=>goal.character===this.selected&&goal.type==='trace');
        if(!record)return undefined;
        return {...record,current:{level:record.sp.current},goal:{level:record.sp.goal}};
      },fates(){return 0;}
    },
    methods:{...original.methods,
      selectedCharacterCurrent(value){
        this.$refs.characterCurrent.hide();
        this.current={...value};
        this.goal={level:Math.max(value.level,this.goal?.level??value.level)};
        this.addOrUpdateCharacter();
      },
      addOrUpdateCharacter(){
        this.addGoal({type:'trace',character:this.selected,sp:{current:this.current?.level??0,goal:this.goal?.level??this.current?.level??0},bonus:{}});
      }
    }
  };
  return component;
}
export function createBloomEditor(original) {
  return {...original,name:'HolodoriBloomUsingCapturedLevel',
    props:{...original.props,section:{type:String,default:'bloom'}},
    data(){return {ascended:{},levelOptions:Array.from({length:6},(_,level)=>({level})),current:null,goal:null};},
    computed:{...original.computed,
      characterGoal(){
        const record=this.goals.find(goal=>goal.character===this.selected&&goal.type==='character');
        return {type:'character',character:this.selected,current:{level:record?.eidolon||0},goal:{level:record?.goalBloom??record?.eidolon??0}};
      },fates(){return 0;}
    },methods:{...original.methods,
      selectedCharacterCurrent(value){
        this.$refs.characterCurrent.hide();
        const old=this.goals.find(goal=>goal.character===this.selected&&goal.type==='character');
        this.addGoal(old?{...old,eidolon:value.level}:{type:'character',character:this.selected,current:{level:1,asc:0},goal:{level:1,asc:0},eidolon:value.level});
      },
      selectedCharacterGoal(value){
        this.$refs.characterGoal.hide();
        const old=this.goals.find(goal=>goal.character===this.selected&&goal.type==='character');
        this.addGoal(old?{...old,goalBloom:value.level}:{type:'character',character:this.selected,current:{level:1,asc:0},goal:{level:1,asc:0},eidolon:0,goalBloom:value.level});
      }
    }
  };
}
export function configureGoalTabs(original) {
  original.inject=['openArtwork'];
  original.computed.anyTraceGoal=function(){const goal=this.traceGoal;return !!goal&&goal.sp.goal>goal.sp.current;};
  original.computed.characterGoal=function(){const goal=this.goals.find(goal=>goal.type==='character'&&goal.character===this.selected);return !!goal&&goal.goal.level>goal.current.level;};
  original.computed.coneGoal=()=>false;
  original.computed.relicsGoal=()=>false;
  return original;
}
/** The captured Dialog opens before an existing card's content is populated.
 * Focus its rendered controls after that original update, using the Dialog's
 * own container so Tab does not start on cards behind the modal. */
export function configureCardDialog(original) {
  const show=original.methods.show;
  original.methods.show=function(){
    show.call(this);
    this.$nextTick(()=>{
      const dialog=this.$refs.characterDialog?.container;
      if(!this.isVisible||!dialog||dialog.contains(document.activeElement))return;
      dialog.querySelector('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])')?.focus({preventScroll:true});
    });
  };
  return original;
}
export function configureStore(original) {
  const before=original.data;
  original.data=function(){return {...before.call(this),...game.data()};};
  return original;
}
