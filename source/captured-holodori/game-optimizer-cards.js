import {overlayGameOptimizerBoards} from './game-optimizer-boards.js';

const attributes={cute:1,pure:2,happy:3};
const statEffects={PERFORMANCE_UP_PERMIL_UP:'performance',TECHNIQUE_UP_PERMIL_UP:'technique',
  SENSE_UP_PERMIL_UP:'sense',ALL_PARAMETER_UP_PERMIL_UP:'all',LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP:null,
  LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP:'activeChance'};
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
  const baseType=special?'SCORE_UP_EFFECT_UP_PERMIL_UP':'SCORE_UP_PERMIL_UP';
  const result={scoreUp:0,duration:level.durationMilliseconds/1000,
    ...(special?{actRateUp:0,actRateUpType:null,actRateUpThreshold:0,actRateUpAttr:null,actRateUpGrouping:null}:
      {prob:level.activationProbabilityPermil/10,cooldown:level.cooldownMilliseconds/1000,
        upScoreUp:0,upType:null,upThreshold:0,upAttr:null,upGrouping:null})};
  for(const branch of level.branches){
    const effects=data.activeEffects[branch.effectGroupId];
    const gate=compactTrigger(data,branch);
    if(!effects?.length||!gate)return null;
    for(const effect of effects){
      if(harmlessInPerfectPlay.has(effect.type))continue;
      if(effect.type===baseType&&!gate.type){
        result.scoreUp=Math.max(result.scoreUp,effect.value/10);
        continue;
      }
      const chance=special&&effect.type==='LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP';
      if(!chance&&effect.type!==baseType)return null;
      const prefix=chance?'actRateUp':'up';
      const key=chance?'actRateUp':'upScoreUp';
      if(result[key])return null;
      Object.assign(result,{[key]:effect.value/10,[prefix+'Type']:gate.type,[prefix+'Threshold']:gate.threshold,
        [prefix+'Attr']:gate.attribute,[prefix+'Grouping']:gate.group});
    }
  }
  return result;
}

function passiveLevel(data,level){
  const modifiers=[];
  for(const branch of level.branches){
    const condition=compactTrigger(data,branch);
    const effects=data.passiveEffects[branch.effectGroupId];
    if(!effects?.length||!condition||condition.type&&!['ATTRIBUTE','GROUPING'].includes(condition.type))return null;
    for(const effect of effects){
      const target=data.targets[effect.targetId];
      if(!target||!Object.hasOwn(statEffects,effect.type))return null;
      modifiers.push({value:effect.value/10,stat:statEffects[effect.type],targetType:target.type,targetCount:target.targetCount,
        targetAttr:attributes[target.attribute]??null,targetGrouping:target.groupId,gateType:condition.type,
        gateThreshold:condition.threshold,gateAttr:condition.attribute,gateGrouping:condition.group});
    }
  }
  if(!modifiers.length)return null;
  const [first,...additionalEffects]=modifiers;
  return additionalEffects.length?{...first,additionalEffects}:first;
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
      // The compact outfit representation has one team-wide strength modifier and no outfit rate field.
      if(effect.type==='LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP'||
        (effect.type==='LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP'&&(target.type!=='ALL'||target.targetCount!=null))) return null;
      effects.push({type:effect.type,permil:effect.value,targetType:target.type,targetCount:target.targetCount,
        targetAttr:attributes[target.attribute]??0,targetGrouping:target.groupId});
    }
  }
  return {id:skill.id,description:level.description,effects,triggers:conditions};
}

function sameMechanics(left,right){
  if(left===right)return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object')return false;
  const keys=Object.keys(right);
  return Object.keys(left).length===keys.length&&keys.every(key=>sameMechanics(left[key],right[key]));
}

/** Preserve verified game additions when a separate reference feed has older coverage. */
export function mergeOptimizerReference(bundled,incoming){
  if(!incoming)return bundled;
  const mergeRows=(base,added)=>[...new Map([...base,...added].map(row=>[row.id,row])).values()];
  const boards={...bundled.boards};
  for(const [owner,nodes] of Object.entries(incoming.boards))boards[owner]=mergeRows(boards[owner]??[],nodes);
  const result={...bundled,...incoming,boards,cards:mergeRows(bundled.cards,incoming.cards),
    songs:mergeRows(bundled.songs,incoming.songs)};
  for(const key of ['connects','costumes','groupings','powerUpLadder','boardItems','boardLimits'])
    result[key]={...bundled[key],...incoming[key]};
  return result;
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
  const groupings={...reference.groupings,...Object.fromEntries(Object.values(data.groups).map(row=>[row.id,row.characterIds]))};
  const powerUpLadder={...reference.powerUpLadder};
  for(const [id,levels] of Object.entries(data.levelBonuses))
    powerUpLadder[id]=levels.filter(row=>row.liveDeckPowerPermyriadUp>0).map(({level,liveDeckPowerPermyriadUp})=>[level,liveDeckPowerPermyriadUp]);
  const groupFields=member=>{
    const groupingIds=member.groupIds.slice().sort();
    const groups=groupingIds.map(id=>{
      const name=groupNames.get(id)??id;
      return groupAppearance.get(name)??{name};
    });
    return {group:groups[0]??null,groups,groupingIds};
  };
  const costumes={...reference.costumes};
  for(const row of Object.values(data.cards)){
    const {id,characterId,levelGroupId,potentialGroupId}=row;
    const existing=cards.get(id);
    const member=members.get(characterId);
    if(existing){
      // A compact feed can retain an older value, gate or target for any card.
      const blooms=data.bloomEffects[potentialGroupId];
      if(!blooms)continue;
      const special=cardSkill(data.specialSkills[row.specialSkillId],blooms,'SPECIAL_SKILL_LEVEL_UP',
        level=>activeLevel(data,level,true));
      const passive=cardSkill(data.passiveSkills[row.passiveSkillId],blooms,'PASSIVE_SKILL_LEVEL_UP',
        level=>passiveLevel(data,level));
      const active=cardSkill(data.activeSkills[row.activeSkillId],blooms,'ACTIVE_SKILL_LEVEL_UP',
        level=>activeLevel(data,level,false));
      const projected={active,special,passive};
      const unreviewedSkills=Object.keys(projected).filter(key=>!projected[key]);
      const membership=member&&!sameMechanics(existing.groupingIds,member.groupIds.slice().sort())?groupFields(member):null;
      if(membership||unreviewedSkills.length||Object.entries(projected).some(([key,value])=>!sameMechanics(existing[key],value))){
        cards.set(id,{...existing,active:active??existing.active,special:special??existing.special,passive:passive??existing.passive,
          ...membership,...(unreviewedSkills.length?{unreviewedSkills}:{})});
      }
      continue;
    }
    const info=known.get(id);
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
    const maxBloom=blooms.at(-1).bloomStage;
    const bonusByStage=new Map(blooms.filter(row=>row.type==='ALL_PARAMETER_UP_PERMIL_UP')
      .map(({bloomStage,value})=>[bloomStage,value]));
    const bloomBoosts=[0];
    for(let stage=1;stage<=maxBloom;stage++)bloomBoosts.push(bloomBoosts.at(-1)+(bonusByStage.get(stage)??0));
    cards.set(id,{id,name,character:member.name,characterId,rarity,attribute,
      attributeIcon:'attr-'+parameters.attribute,...groupFields(member),
      maxLevel,maxBloom,baseTotals:bases.map(row=>row.parameterBaseValue),weights:parameters.parameterPermil,
      bloomBoosts,levelLimits,cardLevelGroupId:levelGroupId,active,special,passive});
  }
  for(const row of account.costumes){
    const skill=outfitSkill(data,data.leaderSkills[row.leaderSkillId]);
    const existing=costumes[row.id];
    if(existing){
      if(skill){
        if(!sameMechanics(existing.effects,skill.effects)||!sameMechanics(existing.triggers,skill.triggers))
          costumes[row.id]={...existing,...skill};
      }else if(data.leaderSkills[row.leaderSkillId])costumes[row.id]={...existing,unreviewedSkills:['outfit']};
      continue;
    }
    if(!skill||!members.has(row.characterId)||(!row.isDefault&&!cards.has(row.sourceCardId)))continue;
    costumes[row.id]={...skill,characterId:row.characterId,name:row.isDefault?'Default':row.name,
      cardId:row.isDefault?null:row.sourceCardId,isDefault:row.isDefault,rarity:row.rarity};
  }
  return overlayGameOptimizerBoards({...reference,cards:[...cards.values()],costumes,powerUpLadder,groupings},data,account);
}
