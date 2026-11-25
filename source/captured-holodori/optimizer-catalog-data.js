import {loadReferenceData,prepareReferenceSearch,runReferenceJob} from './reference-team-solver';

let cachedSource,cachedPack;
export function optimizerPack(source){
  if(!source?.url)return Promise.resolve(null);
  if(cachedSource!==source.id){
    cachedSource=source.id;
    cachedPack=(async()=>{
      const response=await fetch(source.url);
      if(!response.ok)throw Error('The optimizer cache could not be read.');
      const bytes=await response.arrayBuffer();
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      if(hash!==source.id)throw Error('The optimizer cache checksum does not match.');
      const pack=JSON.parse(new TextDecoder().decode(bytes));
      if(pack.schema!==1)throw Error('Unsupported optimizer catalog format.');
      return pack;
    })();
  }
  return cachedPack;
}

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keyFor=(id,chart)=>id+'_'+chart.type;

export async function verifyOptimizerPack(source){
  const pack=await optimizerPack(source);
  const bundled=await loadReferenceData();
  const previous=(await optimizerPack(source.previous).catch(()=>null))?.data;
  const {data,events,unlocks,lengths}=pack;
  if(!object(data)||!Array.isArray(data.cards)||!Array.isArray(data.songs)||!object(unlocks)||!object(lengths)||
    !Array.isArray(events?.events)||!['boards','boardItems','costumes','connects','coefficients','powerUpLadder','noteWeights','noteWeightsPc'].every(key=>object(data[key]))||
    !['memoryEffects','boardPointLadder','deckRanks','deckPowerRanks','deckRankBonus'].every(key=>Array.isArray(data[key]))||
    Object.values(data.boards).some(nodes=>!Array.isArray(nodes)||nodes.some(node=>typeof node?.id!=='string'))||
    Object.values(data.costumes).some(outfit=>typeof outfit?.name!=='string'||typeof outfit.characterId!=='string')||
    events.events.some(event=>typeof event?.id!=='string'||typeof event.name!=='string'||!object(event.songs)||
      (event.epBonus!=null&&!Array.isArray(event.epBonus.chapters))))
    throw Error('The downloaded optimizer catalog is incomplete.');
  if(pack.eventDisplay!==undefined&&(!object(pack.eventDisplay)||Object.entries(pack.eventDisplay).some(([id,entry])=>
    !events.events.some(event=>event.id===id)||!object(entry)||
    (entry.title!==undefined&&(typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>240))||
    (entry.bannerHash!==undefined&&(typeof entry.bannerHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.bannerHash))))))
    throw Error('The downloaded optimizer event presentation data is invalid.');
  const cards=new Map();
  for(const card of data.cards){
    if(!/^card-[a-z0-9-]+$/.test(card?.id)||cards.has(card.id)||!/^chr-\d{5}$/.test(card.characterId)||
      typeof card.name!=='string'||!Number.isSafeInteger(card.maxLevel)||card.maxLevel<1||
      !Array.isArray(card.baseTotals)||card.baseTotals.length<card.maxLevel||
      !object(card.weights)||!Array.isArray(card.bloomBoosts))throw Error('Invalid optimizer card data.');
    cards.set(card.id,card);
  }
  const charts=new Set(),songs=new Set();
  for(const song of data.songs){
    const unlock=unlocks[song?.id];
    const quest=unlock?.mainQuestUnlock;
    if(!/^m\d{4}$/.test(song?.id)||songs.has(song.id)||typeof song.title!=='string'||
      !Array.isArray(song.difficulties)||!song.difficulties.length||typeof unlock?.autoGiven!=='boolean'||
      !(quest===null||Array.isArray(quest)&&quest.length===2&&quest.every(Number.isSafeInteger))||
      !(unlock.holomemUnlock===null||/^chr-\d{5}$/.test(unlock.holomemUnlock))||
      !Number.isFinite(lengths[song.id])||lengths[song.id]<=0)throw Error('Invalid optimizer song or unlock data.');
    songs.add(song.id);
    for(const chart of song.difficulties){
      const key=keyFor(song.id,chart);
      if(charts.has(key)||typeof chart.type!=='string'||!Number.isFinite(chart.level)||!Number.isFinite(chart.seconds)||
        !Number.isFinite(chart.coefficient)||!Number.isFinite(chart.notes))throw Error('Invalid optimizer chart data.');
      charts.add(key);
    }
  }
  if([bundled,previous].some(base=>base&&(base.cards.some(card=>!card.fromGameMaster&&!cards.has(card.id))||
    base.songs.some(song=>song.difficulties.some(chart=>!charts.has(keyFor(song.id,chart)))))))
    throw Error('The download is missing cards or charts from the verified catalog.');
  const sample=new Map();
  for(const card of cards.values()){
    if(!sample.has(card.characterId))sample.set(card.characterId,card);
    if(sample.size===5)break;
  }
  const input={
    cards:[...sample.values()].map(card=>({cardId:card.id,level:card.maxLevel,potentialUpgradeCount:0})),
    members:[...sample.keys()].map(characterId=>({characterId,level:1})),
    chartKey:'m0049_expert',dreamRank:1,resultLimit:1,useBoards:false,
  };
  const response=await runReferenceJob(data,'_hd_solve',prepareReferenceSearch(data,input));
  if(!response.results?.some(row=>row.order?.length===5&&Number.isFinite(row.score)&&row.score>0))
    throw Error('The bundled solver could not score a chart with this catalog.');
}
