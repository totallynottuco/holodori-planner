export function isTeamCardEligible(card,options){
  return !(card?.rarity===3&&options.excludeThreeStars||card?.rarity===4&&options.excludeFourStars);
}
export const teamRarityFilter=({excludeThreeStars,excludeFourStars})=>Number(!!excludeThreeStars)+2*Number(!!excludeFourStars);

export function eligibleTeamOutfits(data,{account,options},leader=options.leaderChar){
  return Object.entries(data.costumes).filter(([id,outfit])=>
    (!leader||outfit.characterId===leader)&&
    (!options.leaderInvitedOnly||options.leaderAllHolomems||Object.hasOwn(account.ranks,outfit.characterId))&&
    (options.leaderMode==='fixed'?id===options.outfitId:
      options.leaderMode==='holomem'?(options.focusCardIds??[]).includes(outfit.cardId):
      outfit.isDefault||account.owned[outfit.cardId]?.owned||account.ownedCostumeIds?.includes(id)));
}
