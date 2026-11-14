const shotsByType = {
  1: ['note-perfect','critical'],
  2: ['flick','critical-flick'],
  3: ['note-perfect','critical'],
  4: ['middle','middle'],
  6: ['note-perfect','critical'],
  7: ['flick','critical-flick'],
};
const empty = {shots:[],holds:[]};
let bundledProfiles;

export function decodeChartGeometry(value,events) {
  if(!Array.isArray(value))return null;
  const [nCols,bpms,bars,encodedHolds]=value;
  const segments=rows=>Array.isArray(rows)&&rows.length>0&&rows.length<=1024&&rows.every(row=>
    Array.isArray(row)&&row.length===3&&row.every(Number.isFinite)&&row[1]>0);
  if(!Number.isInteger(nCols)||nCols<1||nCols>128||!segments(bpms)||!segments(bars)||
    typeof encodedHolds!=='string'||encodedHolds.length>96*events.times.length)return null;
  const holds=[];
  try{
    const bytes=Uint8Array.from(atob(encodedHolds),character=>character.charCodeAt(0));
    const data=new DataView(bytes.buffer);
    for(let offset=0;offset<bytes.length;){
      const count=data.getUint16(offset,true);
      offset+=2;
      if(count<2||offset+count*5>bytes.length)return null;
      const points=[];
      let previous=0;
      for(let point=0;point<count;point++,offset+=5){
        const time=data.getUint32(offset,true),lane=bytes[offset+4]>>>4,width=bytes[offset+4]&15;
        if(time<previous||lane<2||lane>13||width<1||lane+width>14)return null;
        points.push([time/1e6,lane,width]);
        previous=time;
      }
      holds.push(points);
    }
  }catch{return null;}
  const profile=readProfile(events.hitProfile,events);
  if(!profile||holds.length!==profile.holds.length)return null;
  const critical=new Uint8Array(events.times.length);
  for(const index of profile.critical)critical[index]=1;
  return {layout:{measureHeight:440,timePadding:32,lanePadding:40,laneWidth:16,nLanes:12,sentenceLength:4,
    sentenceW:272,nCols,totalW:nCols*272+80,totalH:2144,bpms,bars},holds,critical};
}

function readProfile(profile, {times,types,officialHash}) {
  if(!Array.isArray(profile)||profile[0]!==officialHash)return null;
  const [,count,encoded]=profile;
  if(!Number.isInteger(count)||count<0||count>types.length||typeof encoded!=='string'||
    encoded.length>8*types.length)return null;
  let data;
  try{data=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));}catch{return null;}
  if(data.length<count*2||(data.length-count*2)%4)return null;
  const bytes=new DataView(data.buffer),critical=new Set(),holds=[],started=new Set(),ended=new Set();
  for(let offset=0;offset<count*2;offset+=2){
    const index=bytes.getUint16(offset,true);
    if(!shotsByType[types[index]]||critical.has(index))return null;
    critical.add(index);
  }
  for(let offset=count*2;offset<data.length;offset+=4){
    const start=bytes.getUint16(offset,true),end=bytes.getUint16(offset+2,true);
    if(types[start]!==3||(types[end]!==6&&types[end]!==7)||times[end]<=times[start]||
      started.has(start)||ended.has(end))return null;
    started.add(start);
    ended.add(end);
    holds.push({start:times[start]/1e6,end:times[end]/1e6,
      cue:critical.has(start)?'critical-long-loop':'note-long-loop'});
  }
  return {critical,holds:holds.sort((a,b)=>a.start-b.start)};
}

function fallbackHolds({times,types}) {
  const starts=[],holds=[];
  let next=0;
  types.forEach((type,index)=>{
    if(type===3)starts.push(times[index]);
    else if((type===6||type===7)&&next<starts.length&&starts[next]<times[index])
      holds.push({start:starts[next++]/1e6,end:times[index]/1e6,cue:'note-long-loop'});
  });
  return holds;
}

/** Uses verified timestamps, with optional critical cues and channel-matched loops from game SUS. */
export async function loadChartHitEvents(chart) {
  const events=chart?.events;
  if(!events?.times?.length||events.types?.length!==events.times.length)return empty;
  let profile=readProfile(events.hitProfile,events);
  if(!profile){
    bundledProfiles??=fetch('/assets/team-optimizer/optimizer-preview-hits.json')
      .then(response=>response.ok?response.json():null).catch(()=>null);
    profile=readProfile((await bundledProfiles)?.[chart.key],events);
  }
  const shots=[];
  events.types.forEach((type,index)=>{
    const cue=shotsByType[type]?.[profile?.critical.has(index)?1:0];
    if(cue)shots.push({t:events.times[index]/1e6,cue});
  });
  return {shots,holds:profile?.holds??fallbackHolds(events)};
}
