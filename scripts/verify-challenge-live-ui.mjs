import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {capturedTest,root} from './captured-test-harness.mjs';

const fixture=await build({stdin:{resolveDir:root,contents:`
  export {freshProfile} from './source/captured-holodori/profile-codec';
  export {createDefaultCardState} from './source/hololive/vendor/shared/profile';
`},bundle:true,format:'esm',platform:'node',write:false});
const {freshProfile,createDefaultCardState}=await import('data:text/javascript;base64,'+
  Buffer.from(fixture.outputFiles[0].contents).toString('base64'));
const profile=freshProfile(),tower='live_tower-default-001';
const cards=['card-06002-5-uniq-0058-00','card-06003-5-uniq-0059-00',
  'card-06004-5-uniq-0060-00','card-06005-5-uniq-0061-00','card-00001-5-uniq-0000-00',
  'card-03003-5-uniq-0035-00','card-00005-5-uniq-0006-00'];
profile.cardOwnership=Object.fromEntries(cards.map(id=>[id,true]));
profile.cards=Object.fromEntries(cards.map(id=>{
  const state=createDefaultCardState(id,id);
  state.level=state.goal.targetLevel=40;
  return [id,state];
}));
profile.account.unlockedCharacterIds=cards.map(id=>'chr-'+id.split('-')[1]);
profile.account.ownedCostumeIds=['cos-00001-nrml-0000-00'];
profile.gameProgress={challengeLive:[{liveTowerId:tower,clearedStageNumber:54,lastPlayedMusicDifficultyType:4}]};

const preferences={main:{boardMode:'none',topN:3,leaderMode:'fixed',
  leaderCharacterId:'chr-00001',outfitId:'cos-00001-nrml-0000-00',pc:true,chartKey:'m0001_easy'}};
await capturedTest(async({page,events})=>{
  // Observe the real solver output and every preview input, including slot order and Boards.
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker;
    window.challengeSearches=[];
    window.Worker=class extends NativeWorker {
      constructor(...args){
        super(...args);
        this.addEventListener('message',({data})=>{
          if(data.type==='result'&&data.challengeCharts)window.challengeSearches.push({charts:data.challengeCharts,songs:data.challengeSongs});
        });
      }
      postMessage(message,...rest){
        if(message.type==='review-details')window.challengePreviewRequest=message;
        return super.postMessage(message,...rest);
      }
    };
  });
  await page.goto('/team-optimizer');
  const opt=page.getByRole('region',{name:'Team Optimizer',exact:true});
  await opt.getByRole('button',{name:'Target',exact:true}).click();
  await opt.getByRole('button',{name:'Challenge Live',exact:true}).click();
  assert.equal(await opt.getByRole('group',{name:'Platform'}).count(),0);
  const jump=n=>opt.getByRole('button',{name:'Choose stage, Stage '+n,exact:true});
  const dialog=page.getByRole('dialog');
  await jump(55).click();
  await dialog.getByRole('button',{name:'Stage 55 Current',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Stage 54 Cleared',exact:true}).waitFor();
  const search=dialog.getByRole('textbox');
  await search.fill('100');
  await dialog.getByRole('button',{name:'Stage 100',exact:true}).click();
  assert.ok(await opt.getByRole('button',{name:'Next stage'}).isDisabled());
  await opt.getByRole('button',{name:'Previous stage'}).click();
  await jump(99).click();
  await search.fill('Stage 1');
  await dialog.getByRole('button',{name:'Stage 1 Cleared',exact:true}).click();
  assert.ok(await opt.getByRole('button',{name:'Previous stage'}).isDisabled());
  await opt.getByRole('button',{name:'Next stage'}).click();
  await jump(2).click();
  await dialog.getByRole('button',{name:'Use current stage'}).click();
  await jump(55).waitFor();
  assert.match(await opt.innerText(),/1,780,000/);
  assert.equal(await opt.locator('.holo-challenge-member[title="Todoroki Hajime"]').innerText(),'Hajime');
  assert.match(await opt.locator('.holo-challenge-target').innerText(),/\+15% each/);
  const difficulties=opt.getByRole('group',{name:'Stage difficulties'});
  for(const label of ['Easy','Normal','Hard'])await difficulties.getByRole('button',{name:label,exact:true}).click();
  assert.ok(await difficulties.getByRole('button',{name:'Expert'}).isDisabled());
  for(const label of ['Easy','Normal','Hard'])await difficulties.getByRole('button',{name:label,exact:true}).click();
  const results=opt.getByRole('region',{name:'Team search results'});
  const songChoices=results.getByRole('group',{name:'Stage songs'});
  const songButtons=songChoices.getByRole('button');
  const rows=results.locator('.holo-team-result');
  const titles=new Map([['m0131','KANADE'],['m0187','Cherry Pop'],['m0133','PI PIKASO'],['m0071','Countach']]);
  await opt.getByRole('button',{name:'Run & results',exact:true}).click();
  for(const [run,metric] of ['score','maxScore'].entries()){
    const average=metric==='score';
    await opt.getByRole('button',{name:average?'Average score':'Max score',exact:true}).click();
    await opt.getByRole('button',{name:'Find best teams',exact:true}).click();
    await page.waitForFunction(n=>window.challengeSearches.length>n,run,{timeout:120000});
    const {charts,songs}=await page.evaluate(n=>window.challengeSearches[n],run);
    assert.equal(charts.length,16);
    const winners=Array.from(titles.keys(),id=>charts.filter(c=>c.songId===id)
      .sort((a,b)=>b[metric]-a[metric])[0]).sort((a,b)=>b[metric]-a[metric]);
    await results.getByRole('heading',{name:'Your best teams',exact:true}).waitFor();
    assert.equal(await songButtons.count(),winners.length);
    assert.equal(await songButtons.first().getAttribute('aria-pressed'),'true');
    if(!average)await page.setViewportSize({width:760,height:800});
    assert.ok(await songChoices.evaluate(el=>el.getBoundingClientRect().right<=document.documentElement.clientWidth));
    for(const [i,chart] of winners.entries()){
      const choice=songButtons.nth(i),title=titles.get(chart.songId),difficulty=chart.difficulty[0].toUpperCase()+chart.difficulty.slice(1);
      assert.equal(await choice.locator('.holo-rating-chart-name strong').innerText(),title);
      assert.equal(await choice.locator('.holo-rating-chart-name small').innerText(),difficulty);
      const score=await choice.locator('.holo-rating-chart-score strong').innerText();
      assert.equal(Number(score.replaceAll(',','')),Math.round(chart[metric]));
      if(i>0)await choice.press('Enter');
      assert.equal(await choice.getAttribute('aria-pressed'),'true');
      assert.ok(await rows.first().getByRole('list',{name:'Ordered lineup'}).isVisible());
      assert.equal(await rows.first().locator('xpath=ancestor::details').count(),0);
      const group=songs[i];
      assert.equal(group.songId,chart.songId);
      assert.equal(group.difficulty,chart.difficulty);
      assert.deepEqual(group.results[0],chart.team);
      assert.equal(group.results.length,3);
      assert.equal(await rows.count(),group.results.length);
      for(const [rank,team] of group.results.entries()){
        const row=rows.nth(rank);
        if(rank>0)await row.locator(':scope > summary').click();
        const slots=row.getByRole('list',{name:'Ordered lineup'}).getByRole('listitem');
        assert.equal(await slots.count(),5);
        await page.evaluate(()=>window.challengePreviewRequest=null);
        await row.getByRole('button',{name:'Preview details',exact:true}).click();
        await dialog.getByRole('heading',{name:'Stage 55'}).waitFor();
        assert.equal(await dialog.locator('.holo-team-preview-setup .holo-team-preview-song strong').innerText(),title);
        const request=await page.evaluate(()=>window.challengePreviewRequest);
        assert.equal(request.chartKey,chart.songId+'_'+chart.difficulty);
        assert.deepEqual(JSON.parse(JSON.stringify(request.team)),JSON.parse(JSON.stringify(team)));
        const displayed=dialog.locator('.holo-team-preview-scorebar .holo-team-summary-metric')
          .filter({hasText:average?'Average stage score':'Maximum stage score'}).locator('strong');
        await displayed.waitFor();
        const previewScore=await displayed.innerText();
        assert.equal(Number(previewScore.replaceAll(',','')),Math.round(team[metric]));
        if(!average&&i===winners.length-1&&rank===2){
          await dialog.getByRole('button',{name:'Change preview song'}).click();
          assert.equal(await dialog.getByRole('button',{name:'Any song',exact:true}).count(),0);
          await dialog.getByRole('button',{name:'Back',exact:true}).click();
          await dialog.getByRole('button',{name:'Save lineup',exact:true}).click();
          await dialog.getByText(`Stage 55 · ${title} · ${difficulty}`,{exact:true}).waitFor();
          await dialog.getByRole('button',{name:'Recalculate',exact:true}).click();
          const savedScores=dialog.getByRole('status',{name:'Recalculated scores'});
          await savedScores.waitFor({timeout:30000});
          assert.ok((await savedScores.innerText()).includes(previewScore));
        }
        await page.keyboard.press('Escape');
        await dialog.waitFor({state:'hidden'});
      }
    }
    assert.equal(await page.evaluate(()=>window.challengeSearches.length),run+1);
  }
  assert.deepEqual(events.failed,[]);
  assert.deepEqual(events.errors.filter(message=>!message.startsWith('[hd]')),[]);
  console.log('PASS stage picker, limits, current stage, responsive ranking, all 16 charts under both metrics, direct song switching, three ranked teams per song, exact lineups and scores for all 24 previews, saved recalculation');
},{values:{'main-holodori':JSON.stringify(profile),optimizer_preferences:JSON.stringify(preferences)}});
