import {formatNumber} from './regional-formats.js';

export const leaderboardRegions={global:'Global',japan:'Japan',asia:'Asia'};
export const leaderboardRegionKey='holomemLeaderboardRegion';
export const leaderboardStandingsUpdated='holodori-leaderboard-standings-updated';

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

export function compareLeaderboardPlaces(left,right,direction=1) {
  if(!left||!right)return Number(!left)-Number(!right);
  return direction*(left.first-right.first||left.last-right.last);
}

export function rankedRatingLeaders(rows,standings,field,reversed) {
  const entries=rows.map(row=>({row,place:projectedLeaderboardPlace(standings[row.leaderId]?.rows,row.ratingTotal)}));
  const byPlacement=field==='placement'&&entries.some(entry=>entry.place);
  const compare=(a,b,direction=1)=>(byPlacement?compareLeaderboardPlaces(a.place,b.place,direction):0)||
    direction*(b.row.ratingTotal-a.row.ratingTotal);
  const byName=(a,b)=>a.row.name.localeCompare(b.row.name);
  entries.sort((a,b)=>compare(a,b)||byName(a,b));
  let rank=0;
  for(const [index,entry] of entries.entries()){
    const sameAsPrevious=index>0&&compare(entry,entries[index-1])===0;
    if(!sameAsPrevious)rank=index+1;
    entry.rank=rank;
    entry.tied=sameAsPrevious||index+1<entries.length&&compare(entry,entries[index+1])===0;
  }
  if(reversed)entries.sort((a,b)=>compare(a,b,-1)||byName(a,b));
  return entries;
}
