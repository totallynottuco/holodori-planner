export function challengeBonusPermil(stage,order){
  // LiveTowerUtility checks each played deck position once.
  return order.reduce((bonus,card)=>bonus+(stage.bonusCharacterIds.includes(card.characterId)?stage.bonusPermil:0),0);
}

export function challengeUnitBonus(unitScore,permil){
  return Math.trunc(unitScore*permil/1000);
}

// Broad search and Board planning need a cheap stage-aware objective. Every
// finalist is rescored from the pre-ceiling subtotal of each individual note.
export function screenChallengeScore(row,stage,order){
  const factor=1+challengeBonusPermil(stage,order)/1000;
  return {...row,score:row.score*factor,maxScore:row.maxScore*factor};
}
