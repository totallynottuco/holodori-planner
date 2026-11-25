import assert from 'node:assert/strict';
import {capturedTest} from './captured-test-harness.mjs';

// Regression for the five-card roster where CPU search previously returned the runner-up.
const cards=['card-00028-5-uniq-0121-00','card-00015-5-uniq-0120-00','card-04003-5-uniq-0122-00',
  'card-04013-5-uniq-0123-00','card-00002-5-uniq-0001-00'];
const options={leaderMode:'fixed',outfitId:'cos-00028-nrml-0023-00',leaderChar:'chr-00028',pc:false};
const input={objective:'score',reviewedMobile:true,chartKey:'m0049_expert',dreamRank:30,memoryCount:0,
  useBoards:false,resultLimit:1,cards:cards.map(cardId=>({cardId,level:50,potentialUpgradeCount:0})),
  members:cards.map(id=>({characterId:'chr-'+id.split('-')[1],level:30})),options};
const saved={objective:'score',leaderChar:options.leaderChar,outfitId:options.outfitId,boardMode:'none',boards:{},
  charts:[{songId:'m0049',difficulty:'expert'}],lineup:cards.map(()=>({level:50,bloom:0})),pc:false,liveBoost:1};

await capturedTest(async({page})=>{
  await page.goto('/team-optimizer');
  const reports=await page.evaluate(async({cards,input,saved})=>{
    const worker=new Worker('/app/team-optimizer-worker.js',{type:'module'});
    const query=(message,type)=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Mobile optimizer timed out')),60000);
      worker.onmessage=({data})=>{
        if(data.type!==type&&data.type!=='error')return;
        clearTimeout(timer);
        if(data.error||data.type==='error')reject(Error(data.error??data.message));
        else resolve(data);
      };
      worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message));};
      worker.postMessage(message);
    });
    function* orders(available,chosen=[]){
      if(!available.length)yield chosen;
      for(const card of available)yield* orders(available.filter(id=>id!==card),[...chosen,card]);
    }
    const reports=[];
    try{
      for(const preferWebsiteMobile of [false,true]){
        const setup={...input,preferWebsiteMobile};
        const all=[];
        for(const cardIds of orders(cards)){
          const fixed=await query({type:'score-lineup',lineup:{...saved,cardIds},input:setup},'lineup-score');
          all.push({order:cardIds.join(','),avg:fixed.score.score,max:fixed.score.maxScore});
        }
        for(const useGpu of [false,true])for(const sortBy of ['avg','max']){
          const result=await query({type:'search',input:{...setup,useGpu,options:{...setup.options,sortBy}}},'result');
          const winner=result.results[0],match=all.find(row=>row.order===winner.cardIds.join(','));
          const reported=sortBy==='max'?winner.reviewedScore?.maximum??winner.maxScore:winner.reviewedScore?.average??winner.score;
          reports.push({preferWebsiteMobile,useGpu,sortBy,model:result.scoringModel,reported,fixed:match[sortBy],
            count:new Set(all.map(row=>row.order)).size,best:Math.max(...all.map(row=>row[sortBy])),order:winner.cardIds});
        }
      }
    }finally{worker.terminate();}
    return reports;
  },{cards,input,saved});
  for(const report of reports){
    assert.equal(report.count,120);
    assert.equal(report.model,report.preferWebsiteMobile?'website':'mobile');
    assert.equal(report.fixed,report.best,JSON.stringify(report));
    assert.equal(report.reported,report.best,JSON.stringify(report));
    console.log('PASS',report.model,report.useGpu?'GPU':'CPU',report.sortBy,report.reported,report.order.map(id=>cards.indexOf(id)).join(''));
  }
},{chromiumArgs:['--enable-unsafe-webgpu','--ignore-gpu-blocklist']});
