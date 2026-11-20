import {bloomRequirements,game,manifest,type CharacterGoal,type GameContext,type SeelieGoal,type TrainingGoal} from './game';
import {materialPlan} from './material-plan';
import {currentOwnedCards,currentOwnership} from './current-account';

type Lineup = {cardIds: string[]; lineup: {level: number; bloom: number; sp?: number}[]};

export function previewTeamPlan(team: Lineup, context: GameContext) {
  const goals = [...(context.goals ?? [])];
  const profile=context.$root?.data?.[`${context.account ?? 'main'}-holodori`];
  const owned=currentOwnership(profile);
  const records=new Map(currentOwnedCards(profile,goals).map(card=>[card.cardId,card]));
  const changedCards = new Set<string>();
  const rows = team.cardIds.map((id, position) => {
    const entry = team.lineup?.[position];
    const card = game.getCard(id);
    if (!card || !Number.isSafeInteger(entry?.level) || !Number.isSafeInteger(entry?.bloom))
      return {id, available: false as const};
    const levelIndex = goals.findIndex(goal => goal.character === id && goal.type === 'character');
    const trainingIndex = goals.findIndex(goal => goal.character === id && goal.type === 'trace');
    const level = goals[levelIndex] as CharacterGoal | undefined;
    const training = goals[trainingIndex] as TrainingGoal | undefined;
    const recorded=records.get(id);
    const maxLevel = game.rulesFor(id).maxLevel;
    const saved=profile?.cards[id];
    const currentLevel=level?.current.level??saved?.level??recorded?.level??1;
    const currentSP=Math.max(game.minimumStage(id,currentLevel),level?.current.asc??saved?.trainingStage??recorded?.levelLimitBreakCount??0,training?.sp.current??0);
    const currentBloom=level?.eidolon??saved?.bloomStage??recorded?.potentialUpgradeCount??0;
    const exp=level?.current.expIntoLevel??(currentLevel===saved?.level?saved.expIntoLevel:undefined);
    const previousLevel = Math.max(currentLevel, level?.goal.level ?? 1);
    const previousSP = Math.max(currentSP, game.minimumStage(id, previousLevel), level?.goal.asc ?? 0, training?.sp.goal ?? 0);
    const previousBloom = Math.max(currentBloom, level?.goalBloom ?? 0);
    const targetLevel = Math.max(previousLevel, Math.min(maxLevel, entry.level));
    const targetSP = Math.max(previousSP, game.minimumStage(id, targetLevel),
      Math.min(game.rulesFor(id).trainingStages.length,entry.sp??0));
    const targetBloom = Math.max(previousBloom, Math.min(manifest.bloom.maxStage, entry.bloom));
    const changed = targetLevel > previousLevel || targetSP > previousSP || targetBloom > previousBloom;
    if (changed) {
      changedCards.add(id);
      const nextLevel: CharacterGoal = {
        ...level, type: 'character', character: id, eidolon: currentBloom,
        current: {...level?.current, level: currentLevel, asc: currentSP, text: String(currentLevel),
          ...(exp!==undefined?{expIntoLevel:exp}:{})},
        goal: {...level?.goal, level: targetLevel, asc: targetSP, text: String(targetLevel)},
        ...(targetBloom > currentBloom || level?.goalBloom !== undefined ? {goalBloom: targetBloom} : {}),
      };
      const nextTraining: TrainingGoal = {...training, type: 'trace', character: id,
        sp: {...training?.sp, current: currentSP, goal: targetSP}};
      replaceGoal(goals, levelIndex, nextLevel);
      replaceGoal(goals, trainingIndex, nextTraining);
    }
    return {id, available: true as const, changed, unowned: owned!==null&&!owned.has(id), hidden: !!context.inactive?.[id],
      currentLevel, currentSP, currentBloom, targetLevel, targetSP, targetBloom};
  });
  const changed = changedCards.size > 0;
  const merged = {...context, goals: changed ? game.normalizeGoals(goals).flatMap((goal,index) =>
    goal.character && changedCards.has(goal.character) ? [goal] : goals[index] ? [goals[index]] : []) : goals};
  const supply = game.materialSupply.call(merged);
  merged.$root = {...context.$root, materialSupply: supply};
  const plan = materialPlan(merged);
  const missing = Object.values(plan.activities).flatMap(group => Object.values(group['']).flatMap(Object.values))
    .filter(item => item.missing > 0);
  const blooms = bloomRequirements(merged).filter(bloom => !bloom.usesStones && bloom.remaining > 0);
  return {rows, changed, goals: merged.goals, missing, blooms, supply};
}

function replaceGoal(goals: SeelieGoal[], index: number, goal: SeelieGoal) {
  if (index < 0) goals.push(goal);
  else goals[index] = goal;
}
