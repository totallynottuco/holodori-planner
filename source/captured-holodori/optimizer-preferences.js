import {nextAcquisitionChoices} from './acquisition-exchanges.js';

const key='optimizer_preferences';
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const cardPools=['owned','ownedCustom','allMaxed','allCustom'];
export const ratingQuickCounts=[1,3,5,10,20];

export function optimizerDefaults(){
  return {
    mode:'best',objective:'score',eventId:'',eventChapter:null,eventChapterEventId:'',chartKey:'',
    challengeStageId:'',challengeDifficulties:['easy','normal','hard','expert'],
    eventScoreSongId:'',eventScoreChartKey:'',eventPointsSongId:'',eventPointsChartKey:'',pc:false,diffMin:null,diffMax:null,
    difficultyMode:'levels',difficultyTypes:['easy','normal','hard','expert'],
    pool:'owned',customLevel:null,customBloom:null,keepHigherLevel:true,keepHigherBloom:true,excludeThreeStars:false,excludeFourStars:false,
    rosterSource:'owned',plannedPool:'owned',
    lockedCardIds:[],leaderCharacterId:'',leaderMode:'auto',outfitId:null,outfitTraining:null,allLeaders:false,leaderPickerInvitedOnly:true,
    powerUpPreset:'auto',
    boardMode:'optimize',boardSortHolomems:false,boardIgnoreExisting:false,boardNoRefund:false,boardMaxResets:null,boardResetLimit:0,boardUnlimited:false,
    boardMaxPoints:false,boardAllInvited:false,boardBranches:['red','blue','yellow','green'],boardOptimizeConnectors:true,
    boardMaterials:{},boardKeep:{},boardProtection:{},
    topN:10,sortBy:'avg',nextLevel:null,nextBloom:0,nextCount:1,nextBlooms:true,nextAcquisition:'any',
    liveBoost:3,passportOverride:null,ratingCharacterId:'',ratingOutfitId:null,ratingOutfitTraining:null,ratingLeaderMode:'auto',ratingInvitedOnly:true,
    ratingScope:'single',ratingSelectedIds:[],ratingQuickCount:5,ratingBatchInvitedOnly:false,ratingRowsLimit:0,ratingRankBy:'rating',
    ratingAllSongs:false,ratingSongCount:5,ratingTeamsPerSong:3,ratingMaxDifficulty:null,ratingMerge:false,
  };
}
const choices={
  mode:['best','holomem','next'],objective:['score','event','eventPoints','holomemLb','unitScore','challengeLive'],difficultyMode:['levels','types'],
  rosterSource:['owned','planned'],
  nextAcquisition:nextAcquisitionChoices.map(([id])=>id),
  powerUpPreset:['auto','search','allMax','ownedMax','owned'],
  pool:cardPools,plannedPool:cardPools,leaderMode:['auto','fixed','holomem'],
  ratingScope:['single','selected','quick','all'],ratingQuickCount:ratingQuickCounts,ratingRowsLimit:[0,5,10,20],ratingRankBy:['rating','placement'],
  ratingLeaderMode:['auto','fixed','holomem'],boardMode:['optimize','imported','saved','none'],sortBy:['avg','max'],
};
function allProfiles(storage){
  try{return record(JSON.parse(storage.getItem(key)??'{}'));}catch{return {};}
}
export function loadOptimizerPreferences(storage,id){
  const all=allProfiles(storage);
  const stored=Object.hasOwn(all,id)?record(all[id]):{};
  const defaults=optimizerDefaults();
  for(const [name,value] of Object.entries(stored)){
    if(!Object.hasOwn(defaults,name)||value===undefined)continue;
    const fallback=defaults[name];
    if(choices[name]){if(choices[name].includes(value))defaults[name]=value;continue;}
    if(Array.isArray(fallback)){
      if(!Array.isArray(value))continue;
      const valid=[...new Set(value.filter(item=>typeof item==='string'&&(!fallback.length||fallback.includes(item))))];
      if(valid.length||!fallback.length)defaults[name]=valid;
      continue;
    }
    if(name==='boardMaterials'||name==='boardKeep'){
      defaults[name]=Object.fromEntries(Object.entries(record(value)).filter(([,entry])=>
        Number.isSafeInteger(entry)&&entry>=0||name==='boardKeep'&&entry===null));
      continue;
    }
    if(name==='boardProtection'){
      defaults[name]=Object.fromEntries(Object.entries(record(value)).filter(([id,mode])=>
        /^chr-\d+$/.test(id)&&['noResets','locked'].includes(mode)));
      continue;
    }
    if(name==='boardMaxResets'||name==='boardResetLimit'){
      if(Number.isInteger(value)&&value>=0&&value<=9999)defaults[name]=value;
      continue;
    }
    if(name==='outfitTraining'||name==='ratingOutfitTraining'){
      const {level,bloom}=record(value);
      const training={};
      if(Number.isInteger(level)&&level>=1&&level<=80)training.level=level;
      if(Number.isInteger(bloom)&&bloom>=0&&bloom<=5)training.bloom=bloom;
      if(Object.keys(training).length)defaults[name]=training;
      continue;
    }
    if(['customLevel','customBloom','nextLevel','nextBloom'].includes(name)){
      const [min,max]=name.endsWith('Bloom')?[0,5]:[1,80];
      if(Number.isInteger(value)&&value>=min&&value<=max)defaults[name]=value;
      continue;
    }
    const expected=fallback===null?(name.endsWith('OutfitId')||name==='outfitId'?'string':name==='passportOverride'?'boolean':'number'):typeof fallback;
    if(typeof value===expected&&(expected!=='number'||Number.isSafeInteger(value)))defaults[name]=value;
  }
  if(!Object.hasOwn(stored,'eventScoreChartKey')&&defaults.chartKey&&['event','eventPoints'].includes(defaults.objective)){
    const prefix=defaults.objective==='event'?'eventScore':'eventPoints';
    defaults[`${prefix}ChartKey`]=defaults.chartKey;
    defaults[`${prefix}SongId`]=defaults.chartKey.split('_')[0];
    defaults.chartKey='';
  }
  if(!Object.hasOwn(stored,'eventChapterEventId')&&defaults.eventChapter!==null)defaults.eventChapterEventId=defaults.eventId;
  return defaults;
}
export function saveOptimizerPreferences(storage,id,state){
  const all=allProfiles(storage);
  const options=Object.fromEntries(Object.keys(optimizerDefaults()).map(name=>[name,state[name]]));
  storage.setItem(key,JSON.stringify({...all,[id]:options}));
}
export function removeOptimizerPreferences(storage,id){
  const all=allProfiles(storage);
  if(!Object.hasOwn(all,id))return;
  delete all[id];
  if(Object.keys(all).length)storage.setItem(key,JSON.stringify(all));else storage.removeItem(key);
}
