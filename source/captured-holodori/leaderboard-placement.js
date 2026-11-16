import {formatNumber} from './regional-formats.js';

export const leaderboardRegions={global:'Global',japan:'Japan',asia:'Asia'};
export const leaderboardRegionKey='holomemLeaderboardRegion';

export function selectedLeaderboardRegion(storage) {
  const region=storage.getItem(leaderboardRegionKey);
  return Object.hasOwn(leaderboardRegions,region)?region:'global';
}

export function ratingWithChart(contributors,songId,rating) {
  if(!contributors?.length||!songId||!Number.isFinite(rating)||rating<0)return null;
  const ratings=contributors.filter(chart=>chart.songId!==songId).map(chart=>chart.rating);
  return [...ratings,rating].sort((left,right)=>right-left).slice(0,3).reduce((total,value)=>total+value,0);
}

export function projectedLeaderboardPlace(rows,rating) {
  if(!rows?.length||!Number.isFinite(rating)||rating<=0)return null;
  let first=1,last=1;
  for(const [rank,score] of rows){
    if(score>rating)first=Math.max(first,rank+1);
    if(score>=rating)last=Math.max(last,rank+1);
  }
  return {first,last};
}
export function formatLeaderboardPlace({first,last}) {
  return first>100?'100+':`#${formatNumber(first)}${last>first?`–${formatNumber(last)}`:''}`;
}
