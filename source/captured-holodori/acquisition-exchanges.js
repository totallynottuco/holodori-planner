// Exact standard and Heartwarming Chill Time listings observed in the Steam client on 2026-11-12.
const standard='gacha_point-common-001';
const event='gacha_point-pickup-261106';
const eventStart=1793931033786;
const eventEnd=1794621600000;
const standardBanner='holodori Gacha';
const eventBanner='Heartwarming Chill Time Gacha';

function offer(id,cards,banner,point,startTime,endTime) {
  const costLabel=point===standard?'Standard Gacha Pt':'Gacha Pt';
  return {id,cards,route:'Gacha → '+banner+' → Points',point,
    costLabel,currency:point===standard?costLabel:`${banner} Pt`,price:200n,startTime,endTime,limit:10};
}

export const verifiedCardExchanges=[
  offer('fallback/standard',['card-00001-5-uniq-0000-00','card-00002-5-uniq-0001-00','card-00013-5-uniq-0002-00'],
    standardBanner,standard,null,null),
  offer('fallback/event',['card-03001-5-uniq-0114-00','card-03002-5-uniq-0113-00','card-03003-5-uniq-0115-00'],
    eventBanner,event,eventStart,eventEnd),
  // Bright Autumn Trip point pool and five exchange slots are in the game catalog.
  offer('bright-autumn-trip',[
    'card-00002-5-uniq-0104-00','card-00019-5-uniq-0108-00','card-04007-5-uniq-0106-00',
    'card-00031-5-uniq-0105-00','card-03006-5-uniq-0107-00',
  ],'Bright Autumn Trip Gacha','gacha_point-pickup-261114',
  Date.parse('2026-11-14T11:00:00+09:00'),Date.parse('2026-11-26T11:00:00+09:00')),
];

export const nextAcquisitionChoices=[['any','Any card'],['available','Available now'],['affordable','Affordable exchanges']];

function activeOffers(now,catalog){
  const pools=catalog?.pools??[];
  const refreshed=new Set(pools.map(pool=>pool.point));
  const offers=verifiedCardExchanges.filter(offer=>!refreshed.has(offer.point));
  for(const {point,banner,offers:rows} of pools){
    for(const {id,card,price,limit,startTime,endTime} of rows){
      offers.push({...offer(id,[card],banner,point,startTime,endTime),price:BigInt(price),limit});
    }
  }
  return offers.filter(offer=>(offer.startTime==null||offer.startTime<=now)&&(offer.endTime==null||now<offer.endTime));
}

export function activeGachaCurrencies(now,catalog){
  return [...new Map(activeOffers(now,catalog).map(({point,currency})=>[point,currency])).entries()];
}

function importedPoints(balances,point) {
  const value=balances?.[point];
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
  if(typeof value==='string'&&/^\d+$/.test(value))return BigInt(value);
  return null;
}

function quote(offer,cost,balances) {
  const balance=importedPoints(balances,offer.point);
  return {cost,balance,short:balance==null?null:cost>balance?cost-balance:0n};
}

export function quoteCardAcquisitions(upgrades,balances,now,catalog) {
  const active=activeOffers(now,catalog);
  const shared=new Map();
  const cards=upgrades.map(upgrade=>{
    const id=typeof upgrade==='string'?upgrade:upgrade.cardId??upgrade.id;
    const isNew=typeof upgrade==='string'||upgrade.new===true;
    const copies=Number.isSafeInteger(upgrade?.copies)&&upgrade.copies>0?upgrade.copies:1;
    const offers=active.filter(offer=>offer.cards.includes(id)).map(offer=>({
      ...offer,...quote(offer,offer.price*BigInt(copies),balances),
    }));
    if(offers.length===1&&copies<=offers[0].limit){
      const offer=offers[0];
      const pool=shared.get(offer.point)??{point:offer.point,currency:offer.currency,cost:0n,count:0};
      pool.cost+=offer.cost;
      pool.count++;
      shared.set(offer.point,pool);
    }
    return {id,isNew,copies,offers};
  });
  return {cards,shared:[...shared.values()].filter(pool=>pool.count>1).map(pool=>({...pool,...quote(pool,pool.cost,balances)}))};
}

export function nextAcquisitionFilter(filter) {
  if(!filter||!['available','affordable'].includes(filter.mode))return null;
  const affordable=filter.mode==='affordable';
  const offersByCard=new Map(),budgets=new Map();
  for(const offer of activeOffers(filter.at,filter.catalog)){
    if(affordable){
      const balance=importedPoints(filter.balances,offer.point);
      if(balance==null||balance<offer.price)continue;
      budgets.set(offer.point,balance);
    }
    for(const id of offer.cards){
      if(!offersByCard.has(id))offersByCard.set(id,[]);
      offersByCard.get(id).push(offer);
    }
  }
  return pulls=>{
    const spent=new Map();
    function fits(index){
      if(index===pulls.length)return true;
      const {id,copies}=pulls[index];
      for(const {limit,point,price} of offersByCard.get(id)??[]){
        if(copies>limit)continue;
        if(!affordable)return fits(index+1);
        const previous=spent.get(point)??0n;
        const cost=previous+price*BigInt(copies);
        if(cost>budgets.get(point))continue;
        spent.set(point,cost);
        if(fits(index+1))return true;
        spent.set(point,previous);
      }
      return false;
    }
    return fits(0);
  };
}
