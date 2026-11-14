// Exact listings observed in the Steam client on 2026-11-12. Used before the first successful archive refresh.
const standard='gacha_point-common-001';
const event='gacha_point-pickup-261106';
const eventStart=1793931033786;
const eventEnd=1794621599000;
const standardBanner='holodori Gacha';
const eventBanner='Heartwarming Chill Time Gacha';

function offer(id,cards,banner,point,startTime,endTime) {
  const pull=(suffix,type,id,quantity,limit=0,reset=0)=>({
    id:suffix,banner,points:1,costs:[{type,id,quantity}],limit,reset,startTime,endTime,termHours:null,requirements:[],
  });
  const pulls=[pull('regular',1001,'',250),pull('daily',1002,'',90,1,1)];
  if(point===standard)pulls.push(pull('ticket',3,'item-gacha_ticket-cmn-01',1));
  return {id,cards,route:'Gacha → '+banner+' → Points',costs:[{type:18,id:point,quantity:200}],
    startTime,endTime,limit:10,description:null,requirements:[],pulls};
}

export const verifiedCardExchanges=[
  offer('fallback/standard',['card-00001-5-uniq-0000-00','card-00002-5-uniq-0001-00','card-00013-5-uniq-0002-00'],
    standardBanner,standard,null,null),
  offer('fallback/event',['card-03001-5-uniq-0114-00','card-03002-5-uniq-0113-00','card-03003-5-uniq-0115-00'],
    eventBanner,event,eventStart,eventEnd),
];
