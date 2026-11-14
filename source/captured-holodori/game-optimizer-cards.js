const attributes={cute:1,pure:2,happy:3};
const statEffects={PERFORMANCE_UP_PERMIL_UP:'performance',TECHNIQUE_UP_PERMIL_UP:'technique',
  SENSE_UP_PERMIL_UP:'sense',ALL_PARAMETER_UP_PERMIL_UP:'all',LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP:null};
const triggerKinds={DECK_CARD_ATTRIBUTE:'ATTRIBUTE',DECK_CARD_CHARACTER_GROUPING:'GROUPING',
  COMBO_GTE:'COMBO',LIFE_GTE:'LIFE_GTE',LIFE_LTE:'LIFE_LTE'};
const harmlessInPerfectPlay=new Set(['LIFE_RECOVERY','JUDGEMENT_ENHANCE']);

function triggers(data,branch){
  return branch.triggerGroupId?data.triggers[branch.triggerGroupId]:[];
}

function compactTrigger(data,branch){
  const conditions=triggers(data,branch);
  if(!conditions||conditions.length>1)return undefined;
  const entry=conditions[0];
  if(entry&&!Object.hasOwn(triggerKinds,entry.type))return undefined;
  return {type:entry?triggerKinds[entry.type]:null,threshold:entry?.threshold??0,
    attribute:attributes[entry?.attribute]??null,group:entry?.groupId??null};
}

function activeLevel(data,level,special){
  const [primary,additional]=level.branches;
  const main=data.activeEffects[primary.effectGroupId];
  const baseType=special?'SCORE_UP_EFFECT_UP_PERMIL_UP':'SCORE_UP_PERMIL_UP';
  if(triggers(data,primary)?.length!==0||main?.length!==1||
    main[0].type!==baseType&&!harmlessInPerfectPlay.has(main[0].type))return null;
  let value=0,condition={type:null,threshold:0,attribute:null,group:null};
  if(additional){
    const effects=data.activeEffects[additional.effectGroupId];
    if(effects?.length!==1)return null;
    const more=effects[0];
    const extraType=special?'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP':baseType;
    if(more.type===extraType){
      condition=compactTrigger(data,additional);
      if(!condition)return null;
      value=more.value/10;
    }else if(!harmlessInPerfectPlay.has(more.type))return null;
  }
  const scoreUp=main[0].type===baseType?main[0].value/10:0;
  const duration=level.durationMilliseconds/1000;
  if(special)return {scoreUp,duration,actRateUp:value,actRateUpType:condition.type,
    actRateUpThreshold:condition.threshold,actRateUpAttr:condition.attribute,actRateUpGrouping:condition.group};
  return {scoreUp,duration,prob:level.activationProbabilityPermil/10,cooldown:level.cooldownMilliseconds/1000,
    upScoreUp:value,upType:condition.type,upThreshold:condition.threshold,upAttr:condition.attribute,
    upGrouping:condition.group};
}

function passiveLevel(data,level){
  if(level.branches.length!==1)return null;
  const [branch]=level.branches;
  const effects=data.passiveEffects[branch.effectGroupId];
  if(effects?.length!==1)return null;
  const effect=effects[0];
  const condition=compactTrigger(data,branch);
  const target=data.targets[effect.targetId];
  if(!condition||!target||!Object.hasOwn(statEffects,effect.type)||
    condition.type&&!['ATTRIBUTE','GROUPING'].includes(condition.type))return null;
  return {value:effect.value/10,stat:statEffects[effect.type],targetType:target.type,targetCount:target.targetCount,
    targetAttr:attributes[target.attribute]??null,targetGrouping:target.groupId,gateType:condition.type,
    gateThreshold:condition.threshold,gateAttr:condition.attribute,gateGrouping:condition.group};
}

function cardSkill(skill,blooms,kind,convert){
  if(!skill?.levels.length)return null;
  const bloomUnlock=blooms.find(row=>row.type===kind)?.bloomStage??0;
  const levels=skill.levels.map(convert);
  return levels.every(Boolean)&&(levels.length===1||bloomUnlock>0)?{levels,bloomUnlock}:null;
}

function outfitSkill(data,skill){
  if(skill?.levels.length!==1)return null;
  const [level]=skill.levels;
  const effects=[],conditions=[];
  let commonGate;
  for(const branch of level.branches){
    const gate=triggers(data,branch);
    const branchEffects=data.passiveEffects[branch.effectGroupId];
    if(!gate||!branchEffects?.length||gate.some(row=>
      !['DECK_CARD_ATTRIBUTE','DECK_CARD_CHARACTER_GROUPING'].includes(row.type)))return null;
    // The compact solver has a single outfit gate. Every effect must use it.
    const identity=JSON.stringify(gate.map(row=>[row.type,row.threshold,row.attribute,row.groupId]));
    if(commonGate!==undefined&&commonGate!==identity)return null;
    commonGate=identity;
    for(const row of gate)conditions.push({type:row.type,count:row.threshold,attr:attributes[row.attribute]??0,
      grouping:row.groupId,characterId:null});
    for(const effect of branchEffects){
      const target=data.targets[effect.targetId];
      if(!target||!Object.hasOwn(statEffects,effect.type))return null;
      effects.push({type:effect.type,permil:effect.value,targetType:target.type,targetCount:target.targetCount,
        targetAttr:attributes[target.attribute]??0,targetGrouping:target.groupId});
    }
  }
  return {id:skill.id,description:level.description,effects,triggers:conditions};
}

function cardConnect(account,id,blooms){
  const effect=account.connectEffects[account.cardConnectEffectIds[id]];
  const extent=effect&&account.connectExtents[effect.extentGroupId];
  if(!effect||!extent?.length)return null;
  return {extent:extent.map(({x,y})=>[x,y]).sort(([ax,ay],[bx,by])=>ax-bx||ay-by),
    levels:effect.levels.map(({effectPermilUp,description})=>
    ({permil:effectPermilUp,description})),
    level2Bloom:blooms.find(row=>row.type==='SKILL_TREE_CONNECT_EFFECT_LEVEL_UP')?.bloomStage??0};
}

/** Project verified game records onto the planner's compact solver schema. */
export function overlayGameOptimizerCards(reference,{data,account}={},metadata={}){
  if(!data?.cards||!account?.cardParameterProfiles)return reference;
  const recorded=metadata.cards??{};
  const known=new Map(Array.isArray(recorded)?recorded.map(row=>[row.id,row]):Object.entries(recorded));
  const cards=new Map(reference.cards.map(card=>[card.id,card]));
  const members=new Map(account.characters.map(member=>[member.id,member]));
  const groupNames=new Map(account.groups.map(row=>[row.id,row.name]));
  const groupAppearance=new Map(reference.cards.flatMap(card=>(card.groups??[]).map(group=>[group.name,group])));
  const groupings={...Object.fromEntries(Object.values(data.groups).map(row=>[row.id,row.characterIds])),
    ...reference.groupings};
  const powerUpLadder={...reference.powerUpLadder};
  const connects={...reference.connects};
  const costumes={...reference.costumes};
  for(const row of Object.values(data.cards)){
    const {id,characterId,levelGroupId,potentialGroupId}=row;
    if(cards.has(id))continue;
    const info=known.get(id);
    const member=members.get(characterId);
    const parameters=account.cardParameterProfiles[id];
    const bases=account.cardLevelBases[levelGroupId];
    const blooms=data.bloomEffects[potentialGroupId];
    const name=info?.cardName??info?.name;
    const rarity=info?.rarity;
    const maxLevel=bases?.length;
    const attribute=attributes[parameters?.attribute];
    if(!member||!attribute||!name||![3,4,5].includes(rarity)||!maxLevel||!blooms?.length)continue;
    const rarityLimits=metadata.rarities?.[rarity];
    const levelLimits=info?.levelLimits??(rarityLimits?[rarityLimits.initialLevelCap,
      ...rarityLimits.trainingStages.map(stage=>stage.levelCap)]:null);
    if(!levelLimits?.length||levelLimits.at(-1)!==maxLevel)continue;
    const active=cardSkill(data.activeSkills[row.activeSkillId],blooms,'ACTIVE_SKILL_LEVEL_UP',
      level=>activeLevel(data,level,false));
    const special=cardSkill(data.specialSkills[row.specialSkillId],blooms,'SPECIAL_SKILL_LEVEL_UP',
      level=>activeLevel(data,level,true));
    const passive=cardSkill(data.passiveSkills[row.passiveSkillId],blooms,'PASSIVE_SKILL_LEVEL_UP',
      level=>passiveLevel(data,level));
    if(!active||!special||!passive)continue;
    const connect=cardConnect(account,id,blooms);
    if(account.cardConnectEffectIds[id]&&!connect)continue;
    const groupingIds=member.groupIds.slice().sort();
    const groups=groupingIds.map(id=>{
      const name=groupNames.get(id)??id;
      return groupAppearance.get(name)??{name};
    });
    const maxBloom=blooms.at(-1).bloomStage;
    const bonusByStage=new Map(blooms.filter(row=>row.type==='ALL_PARAMETER_UP_PERMIL_UP')
      .map(({bloomStage,value})=>[bloomStage,value]));
    const bloomBoosts=[0];
    for(let stage=1;stage<=maxBloom;stage++)bloomBoosts.push(bloomBoosts.at(-1)+(bonusByStage.get(stage)??0));
    cards.set(id,{id,name,character:member.name,characterId,rarity,attribute,
      attributeIcon:'attr-'+parameters.attribute,group:groups[0]??null,groups,groupingIds,
      maxLevel,maxBloom,baseTotals:bases.map(row=>row.parameterBaseValue),weights:parameters.parameterPermil,
      bloomBoosts,levelLimits,cardLevelGroupId:levelGroupId,active,special,passive});
    if(connect&&!Object.hasOwn(connects,id))connects[id]=connect;
    powerUpLadder[levelGroupId]??=data.levelBonuses[levelGroupId].filter(row=>row.liveDeckPowerPermyriadUp>0)
      .map(({level,liveDeckPowerPermyriadUp})=>[level,liveDeckPowerPermyriadUp]);
  }
  for(const row of account.costumes){
    if(Object.hasOwn(costumes,row.id))continue;
    const skill=outfitSkill(data,data.leaderSkills[row.leaderSkillId]);
    if(!skill||!members.has(row.characterId)||(!row.isDefault&&!cards.has(row.sourceCardId)))continue;
    costumes[row.id]={...skill,characterId:row.characterId,name:row.isDefault?'Default':row.name,
      cardId:row.isDefault?null:row.sourceCardId,isDefault:row.isDefault,rarity:row.rarity};
  }
  return {...reference,cards:[...cards.values()],costumes,connects,powerUpLadder,groupings};
}
