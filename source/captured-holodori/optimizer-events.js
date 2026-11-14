export function eventStatus(event,now) {
  if(event.startTime>now)return 'Upcoming';
  if(event.endTime<now)return 'Past';
  if(event.metadataOnly&&event.archiveTime<=now)return 'Past';
  return Number.isFinite(event.startTime)&&Number.isFinite(event.endTime)?'Live':'Unavailable';
}

export function defaultEvent(events,now) {
  return events.find(event=>eventStatus(event,now)==='Live')??
    events.find(event=>eventStatus(event,now)==='Past')??events.at(-1);
}

export function eventChapters(chapters) {
  const byNumber=new Map();
  for(const chapter of chapters??[]){
    if(Number.isSafeInteger(chapter?.number)&&chapter.number>0&&!byNumber.has(chapter.number))byNumber.set(chapter.number,chapter);
  }
  return [...byNumber.values()].sort((a,b)=>a.number-b.number);
}

export function automaticChapter(chapters,now) {
  return chapters.find(chapter=>(chapter.endTime??Infinity)>=now)??chapters.at(-1);
}

export function normalizeOptimizerEvents(events) {
  const byId=new Map();
  for(const event of events){
    if(typeof event?.id!=='string'||!event.id||typeof event.name!=='string'||byId.has(event.id))continue;
    const chapters=eventChapters(event.epBonus?.chapters);
    byId.set(event.id,{...event,epBonus:event.epBonus?{...event.epBonus,chapters}:null});
  }
  const stamp=event=>event.startTime??(event.gameDate?Date.parse(event.gameDate):0);
  return [...byId.values()].sort((a,b)=>stamp(b)-stamp(a)||a.id.localeCompare(b.id));
}

export function overlayGameOptimizerEvents(events,resources) {
  const known=new Map(normalizeOptimizerEvents(events).map(event=>[event.id,event]));
  for(const event of resources?.gameEvents??[]){
    const previous=known.get(event.id);
    const songIds=[...new Set([...Object.keys(previous?.songs??{}),...event.songIds])];
    if(previous){
      known.set(event.id,{...previous,gameName:event.name,gameDate:event.dateLabel,gameChapters:event.chapters,archiveTime:event.archiveTime,songIds});
      continue;
    }
    known.set(event.id,{id:event.id,name:event.name,gameName:event.name,startTime:event.startTime,
      gameDate:event.dateLabel,archiveTime:event.archiveTime,gameChapters:event.chapters,songIds,songs:{},epBonus:null,metadataOnly:true});
  }
  return normalizeOptimizerEvents([...known.values()]);
}

export function referenceEventSongBonus(entries,order) {
  let bonus=0;
  for(const rule of entries){
    if(!rule.cardId||order.includes(rule.cardId))bonus=Math.max(bonus,rule.permil);
  }
  return bonus;
}

export function applyEventSongBonus(score,permil) {
  return permil>0?Math.ceil(score*(1+permil/1000)):score;
}

export function referenceEventCardBonuses(rules,cards,bloomOf) {
  const members=new Set();
  return cards.map(card=>{
    const bloom=bloomOf(card.id);
    const bonus=rules.blooms?.[String(card.rarity)];
    const member=members.has(card.characterId)?0:rules.holomems?.[card.characterId]??0;
    members.add(card.characterId);
    return (rules.members?.[card.id]??0)+member+(bonus&&bloom>=1?bonus[Math.min(bloom,bonus.length-1)]??0:0);
  });
}
