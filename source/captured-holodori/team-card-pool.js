export function isTeamCardEligible(card,options){
  return !(card?.rarity===3&&options.excludeThreeStars||card?.rarity===4&&options.excludeFourStars);
}
export const teamRarityFilter=({excludeThreeStars,excludeFourStars})=>Number(!!excludeThreeStars)+2*Number(!!excludeFourStars);
