import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {capturedTest,root} from './captured-test-harness.mjs';

const read=async name=>JSON.parse(await fs.readFile(root+'/hololive-dist/assets/team-optimizer/'+name,'utf8'));
const [data,events,unlocks,lengths]=await Promise.all(['solver-data.json','optimizer-events.json','song-unlocks.json','song-lengths.json'].map(read));
const card={...data.cards[0],id:'card-00001-5-test-9999-00',name:'Catalog test card'};
const song={...data.songs[0],id:'m9901',title:'Catalog test song'};
const pack={schema:1,data:{...data,cards:[...data.cards,card],songs:[...data.songs,song]},events,
  unlocks:{...unlocks,[song.id]:{autoGiven:false,mainQuestUnlock:[3,2],holomemUnlock:null}},
  lengths:{...lengths,[song.id]:lengths[data.songs[0].id]}};
await capturedTest(async({page,events})=>{
  await page.goto('/characters');
  const result=await page.evaluate(async({json,card,song})=>{
    const bytes=new TextEncoder().encode(json);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'}));
    const source={id:digest,url};
    const request=(type,source,input,cardIds)=>new Promise((resolve,reject)=>{
      const worker=new Worker('/app/team-optimizer-worker.js',{type:'module'});
      const timer=setTimeout(()=>{worker.terminate();reject(Error('Catalog worker timed out'));},15000);
      worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message));};
      worker.onmessage=({data})=>{
        if(data.type==='progress'||data.type==='search-backend')return;
        clearTimeout(timer);worker.terminate();resolve(data);
      };
      worker.postMessage({type,source,input,cardIds});
    });
    try {
      const verified=await request('validate-catalog',source);
      const updated=await request('catalog',source);
      const coverage=await request('catalog-coverage',source,undefined,[card,'card-00001-5-unavailable-0000-00']);
      const updatedData=JSON.parse(json).data;
      const newCard=updatedData.cards.find(row=>row.id===card);
      const roster=new Map([[newCard.characterId,newCard]]);
      for(const row of updatedData.cards){
        if(!roster.has(row.characterId))roster.set(row.characterId,row);
        if(roster.size===5)break;
      }
      const solved=await request('search',source,{
        cards:[...roster.values()].map(row=>({cardId:row.id,level:row.maxLevel,potentialUpgradeCount:0})),
        members:[...roster.keys()].map(characterId=>({characterId,level:1})),lockedCardIds:[card],
        chartKey:song+'_'+updatedData.songs.find(row=>row.id===song).difficulties[0].type,useBoards:false,resultLimit:1,
      });
      const bad=await request('validate-catalog',{...source,id:'0'.repeat(64)});
      const fallback=await request('catalog',{...source,id:'0'.repeat(64)});
      const removed=JSON.parse(json);
      delete removed.unlocks[song];
      const badBytes=new TextEncoder().encode(JSON.stringify(removed));
      const badHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',badBytes)),n=>n.toString(16).padStart(2,'0')).join('');
      const badUrl=URL.createObjectURL(new Blob([badBytes]));
      const incomplete=await request('validate-catalog',{id:badHash,url:badUrl});
      URL.revokeObjectURL(badUrl);
      const old=JSON.parse(json);
      old.data.songs=old.data.songs.filter(row=>row.id!==old.data.songs[0].id);
      const oldBytes=new TextEncoder().encode(JSON.stringify(old));
      const oldId=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',oldBytes)),n=>n.toString(16).padStart(2,'0')).join('');
      const oldUrl=URL.createObjectURL(new Blob([oldBytes]));
      let rollback;
      try{
        const oldCache={id:oldId,url:oldUrl};
        rollback=await request('validate-catalog',{...oldCache,previous:oldCache});
      }finally{URL.revokeObjectURL(oldUrl);}
      return {verified,bad,incomplete,rollback,coverage,solved:solved.results?.[0],newCard:updated.cardDetails?.[card],newSong:updated.songs?.find(row=>row.id===song),
        fallback:fallback.type==='catalog'&&!fallback.supportedCardIds.includes(card)};
    } finally { URL.revokeObjectURL(url); }
  },{json:JSON.stringify(pack),card:card.id,song:song.id});
  assert.equal(result.verified.type,'validated',result.verified.message);
  assert.equal(result.coverage.missing,1);
  assert.equal(result.newCard.name,card.name);
  assert.equal(result.newSong.charts.length,song.difficulties.length);
  assert.deepEqual(result.newSong.unlock,pack.unlocks[song.id]);
  assert.ok(result.solved?.score>0&&result.solved.order.includes(card.id));
  assert.match(result.bad.message,/checksum/);
  assert.match(result.incomplete.message,/unlock/);
  assert.match(result.rollback.message,/missing cards or charts/);
  assert.ok(result.fallback);
  assert.deepEqual(events.external,[]);
});
console.log('PASS verified optimizer updates, new cards/charts/unlocks, checksum rejection and offline fallback');
