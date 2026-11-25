import {boardResourceIds} from './board-resource-ids.ts';

const effectPrefix='SkillTreeEffectType_SKILL_TREE_EFFECT_TYPE_';
const triggerPrefix='SkillTreeEffectCharacterTriggerType_SKILL_TREE_EFFECT_CHARACTER_TRIGGER_TYPE_';
const effectKinds={
  ALL_PARAMETER_UP:'param', PERFORMANCE_UP:'performance', TECHNIQUE_UP:'technique', SENSE_UP:'sense',
  ALL_PARAMETER_UP_PERMIL_UP:'paramPermil', PERFORMANCE_UP_PERMIL_UP:'performancePermil',
  TECHNIQUE_UP_PERMIL_UP:'techniquePermil', SENSE_UP_PERMIL_UP:'sensePermil',
  ALL_PARAMETER_UP_FOR_CHARACTER_GROUPING:'paramGroup', LIFE_UP:'life',
  LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP:'activeEffect',
  LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP:'activeChance',
  LIVE_ACTIVE_SKILL_COOL_TIME_SHORTEN_PERMIL_UP:'activeFreq',
  LIVE_DECK_LEADER_ACTIVE_SKILL_ADDITION:'leaderActiveAdd', LIVE_DECK_LEADER_ACTIVE_SKILL_LEVEL_UP:'leaderActiveLevel',
  LIVE_SCORE_BONUS_ADD_PERMIL_UP_BY_MUSIC_SKILL_TREE_CHARACTER_AND_MUSIC_SINGER_TYPE:'songBonus',
  LIVE_REWARD_QUANTITY_UP_PERMIL_UP:'rewardQty', LIVE_REWARD_CARD_EXP_QUANTITY_UP_PERMIL_UP:'rewardExp',
  WORK_REWARD_QUANTITY_UP_PERMIL_UP:'workReward', MINI_GAME_REWARD_QUANTITY_UP_PERMIL_UP:'miniGameReward',
};
const branches={leader:'red',card:'blue',content:'yellow',support:'green',connect:null};
const targets={all:'ALL',self:'SKILL_TREE_CHARACTER',group:'CHARACTER_GROUPING',attribute:'ATTRIBUTE',character:'CHARACTER'};
const triggers={'song-group':'MUSIC_CHARACTER_GROUPING','song-character':'MUSIC_CHARACTER',
  'owner-singer-type':'MUSIC_SKILL_TREE_CHARACTER_AND_MUSIC_SINGER_TYPE','owner-song':'MUSIC_SKILL_TREE_CHARACTER'};
const attributes={cute:1,pure:2,happy:3};
const leaderSkills=new Map(['judgement_enhance','life_recovery'].map(name=>['live_active_skill-skill_tree-'+name,name]));
const unhandled=(subject,value)=>{throw Error(`The optimizer cannot model ${subject} (${value}) in this game catalog.`);};
const lookup=(options,value,subject)=>Object.hasOwn(options,value)?options[value]:unhandled(subject,value);

function renderDescription(existing,text){
  return existing?.replaceAll('[highlight]','').replaceAll('[/highlight]','')===text?existing:text;
}

function nodeVariant(kind,record,raw){
  if(kind==='leaderActiveAdd'||kind==='leaderActiveLevel')
    return leaderSkills.get(record.liveActiveSkillId)??unhandled('a Board leader skill',record.liveActiveSkillId);
  if(kind==='miniGameReward')return record.miniGameTypes.map(type=>type.replace('MiniGameType_MINI_GAME_TYPE_','').toLowerCase()).join(',');
  if(kind==='workReward'){
    const item=raw?.resourceIds?.[0]??'';
    if(item==='item-card_level_up')return 'lesson';
    if(item.startsWith('item-skill_tree_'))return 'cube';
    if(item.startsWith('item-card_limit_break-'))return 'training';
    return item;
  }
  return null;
}

function projectNode(member,position,variant,previous,account){
  const {effect}=variant;
  const branch=lookup(branches,variant.type,'a Board branch');
  const kind=effect?lookup(effectKinds,effect.type.replace(effectPrefix,''),'a Board effect'):null;
  const target=effect?.target, condition=effect?.passiveCondition;
  const charTrigger=effect?.characterTriggerType.replace(triggerPrefix,'')??'ALWAYS';
  if(!['ALWAYS','SET_LIVE_LEADER','WORK'].includes(charTrigger))unhandled('a Board activation condition',charTrigger);
  if(!kind&&variant.type!=='connect')unhandled('a Board node without an effect',variant.id);
  if(condition?.singerType&&!['solo','group','all'].includes(condition.singerType))unhandled('a Board singer condition',condition.singerType);
  return {...previous,id:position.nodeGroupId,x:position.x,y:position.y,branch,kind,socket:variant.type==='connect',
    variant:nodeVariant(kind,effect,account.effects[variant.effectId]),value:effect?.value??0,charTrigger,
    targetType:target?lookup(targets,target.kind,'a Board target'):'',
    targetAttr:target?.attribute?lookup(attributes,target.attribute,'a Board attribute'):null,
    targetGrouping:target?.groupId??null,targetCharacter:target?.characterId??null,
    songTrigger:condition?{type:lookup(triggers,condition.kind,'a Board song condition'),
      characterIds:condition.characterIds,grouping:condition.groupId,singerType:condition.singerType?.toUpperCase()??null}:null,
    hide:variant.viewPlayerLevel,lock:variant.unlockPlayerLevel,pts:variant.boardPointCost,
    items:variant.costs.map(({resource,quantity})=>({id:lookup(boardResourceIds,resource,'a Board material'),qty:quantity})),
    description:renderDescription(previous?.description,variant.description.replaceAll('this holomem',member.name))};
}

function projectConnect(account,cardId,blooms,previous){
  const id=account.cardConnectEffectIds[cardId],effect=account.connectEffects[id];
  const extent=effect&&account.connectExtents[effect.extentGroupId];
  if(!extent?.length||!effect.levels.length||effect.levels.length>2)unhandled('a Board Connect effect',id);
  const unlocks=blooms.filter(row=>row.type==='SKILL_TREE_CONNECT_EFFECT_LEVEL_UP');
  if(unlocks.length>1||unlocks.some(row=>row.value!==2||row.bloomStage<=0)||unlocks.length&&effect.levels.length!==2)
    unhandled('a Board Connect level unlock',cardId);
  return {...previous,extent:extent.map(({x,y})=>[x,y]).sort(([ax,ay],[bx,by])=>ax-bx||ay-by),
    level2Bloom:unlocks[0]?.bloomStage??0,
    levels:effect.levels.map(({level,effectPermilUp,description},index)=>{
      if(level!==index+1)unhandled('a Board Connect level',level);
      const existing=previous?.levels[index];
      return {...existing,permil:effectPermilUp,description:existing?.permil===effectPermilUp?existing.description:description};
    })};
}

export function overlayGameOptimizerBoards(reference,data,account){
  const templates=new Map(account.templates.map(template=>[template.id,template]));
  const boards={...reference.boards}, connects={...reference.connects};
  let boardPointLadder;
  const ladders=new Set();
  for(const member of account.characters){
    if(!ladders.has(member.levelGroupId)){
      const levels=account.memberLevelGroups[member.levelGroupId];
      if(!levels?.length)unhandled('a Board point rank group',member.levelGroupId);
      const earned=[0,...levels.map(row=>row.boardPointsEarned)];
      if(boardPointLadder&&(earned.length!==boardPointLadder.length||earned.some((n,i)=>n!==boardPointLadder[i])))
        unhandled('different Board point ladders for individual members',member.levelGroupId);
      boardPointLadder=earned;
      ladders.add(member.levelGroupId);
    }
    const template=templates.get(member.boardTemplateId);
    if(!template)unhandled('a missing Board template',member.boardTemplateId);
    const previous=new Map((boards[member.id]??[]).map(node=>[node.id,node]));
    const projected=new Map();
    for(const position of template.nodes){
      const variants=account.nodeGroups[position.nodeGroupId]?.variants??[];
      const variant=variants.find(row=>row.characterIds.includes(member.id))??variants.find(row=>!row.characterIds.length);
      if(!variant)unhandled('a missing Board node',member.id+'/'+position.nodeGroupId);
      projected.set(position.nodeGroupId,projectNode(member,position,variant,previous.get(position.nodeGroupId),account));
    }
    // Compact search uses node order to break ties between equally valuable purchases.
    const ids=new Set([...previous.keys(),...projected.keys()]);
    boards[member.id]=[...ids].filter(id=>projected.has(id)).map(id=>projected.get(id));
  }
  const cards=new Set(reference.cards.map(card=>card.id));
  for(const [id,profile] of Object.entries(account.cardParameterProfiles)){
    if(!cards.has(id)||!account.cardConnectEffectIds[id]){delete connects[id];continue;}
    const blooms=data.bloomEffects[profile.potentialGroupId];
    if(!blooms)unhandled('a missing Board Connect Bloom group',profile.potentialGroupId);
    connects[id]=projectConnect(account,id,blooms,connects[id]);
  }
  const boardLimits={};
  for(const [type,limit] of Object.entries(account.effectValueLimits)){
    const key=effectKinds[type.replace(effectPrefix,'')];
    if(key!=='paramGroup'&&key!=='songBonus')unhandled('a Board effect cap',type);
    boardLimits[key]=limit;
  }
  return {...reference,boards,connects,boardPointLadder,boardLimits,
    resetGold:{...reference.resetGold,perReset:account.boardReset.hologoldCostPerRemovedNode}};
}
