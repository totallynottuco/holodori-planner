import type { SeelieGoal } from './game';

export type PlannedOptimizerCard = {cardId:string;level:number;potentialUpgradeCount:number;levelLimitBreakCount?:number};

export function plannedOptimizerCards(goals:SeelieGoal[],inactive:Record<string,boolean>,
  owned:ReadonlyMap<string,PlannedOptimizerCard>,details:Record<string,{maxLevel:number;maxBloom:number;levelLimits:number[]}>) {
  const stages=new Map(goals.filter(goal=>goal.type==='trace').map(goal=>[goal.character,goal.sp?.goal??0]));
  return goals.flatMap(goal=>{
    if(goal.type!=='character'||!goal.character||inactive[goal.character])return [];
    const cardId=goal.character,card=details[cardId];
    if(!card)return [];
    const existing=owned.get(cardId);
    const level=Math.min(card.maxLevel,Math.max(goal.current.level,goal.goal.level,existing?.level??1));
    const minimum=card.levelLimits.findIndex(cap=>level<=cap);
    return [{cardId,level,levelLimitBreakCount:Math.min(card.levelLimits.length-1,
      Math.max(minimum,goal.current.asc,goal.goal.asc,stages.get(cardId)??0,existing?.levelLimitBreakCount??0)),
      potentialUpgradeCount:Math.min(card.maxBloom,Math.max(goal.eidolon??0,goal.goalBloom??0,existing?.potentialUpgradeCount??0))}];
  });
}
