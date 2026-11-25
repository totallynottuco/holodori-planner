import {boardPlanningBaseline} from './board-protection';
import {createFinalistContext} from './finalist-context';
import {finalistOrders,finalistSetups} from './finalist-orders';
import {mobileChartEvaluator} from './mobile-chart-average';
import {mergeReferenceResults} from './reference-team-solver';
import {eligibleTeamOutfits,isTeamCardEligible} from './team-card-pool';
import {challengeBonusPermil} from './challenge-score';
import {referenceMobileEffectWarnings} from './reference-rating-math';

export function challengeChartChoices(data,stage,difficulties,resources){
  const filters=difficulties&&new Set(difficulties);
  const songs=new Map(data.songs.map(song=>[song.id,song]));
  const mobile=new Map(resources.songs.map(song=>[song.id,song]));
  return stage.songIds.flatMap(id=>{
    const song=songs.get(id),official=mobile.get(id);
    if(!song||!official?.charts.length)throw Error('A Challenge Live stage song is missing from the Mobile catalog: '+id);
    return official.charts.filter(chart=>!filters||filters.has(chart.difficulty)).map(summary=>{
      const match=song.difficulties.find(chart=>chart.type===summary.difficulty&&chart.seconds>0);
      if(!match||match.level!==summary.difficultyLevel||match.notes!==summary.totalNotes)
        throw Error('The optimizer chart differs from the Mobile chart for '+song.title+' ('+summary.difficulty+').');
      return {songId:id,difficulty:summary.difficulty};
    });
  });
}

// Enumerate small rosters outright. Larger rosters use the same CPU/GPU
// formation search and Board budgets as the song optimizer.
function smallStageSetups(data,payload){
  const {account,options}=payload;
  const cards=data.cards.filter(card=>account.owned[card.id]?.owned&&isTeamCardEligible(card,options));
  const locked=new Set(options.focusCardIds);
  const fixed=cards.filter(card=>locked.has(card.id));
  if(locked.size>5||fixed.length!==locked.size||new Set(fixed.map(card=>card.characterId)).size!==fixed.length||
    new Set(cards.map(card=>card.characterId)).size<5)return [];
  const outfits=eligibleTeamOutfits(data,payload);
  const limit=32,rows=[],used=new Set(fixed.map(card=>card.characterId));
  function choose(chosen,start){
    if(chosen.length===5){
      for(const [outfitId,outfit] of outfits){
        if(options.leaderNoOverlap&&used.has(outfit.characterId))continue;
        rows.push({order:chosen.map(card=>card.id),outfitId,leaderChar:outfit.characterId});
        if(rows.length>limit)break;
      }
      return;
    }
    for(let i=start;i<=cards.length-(5-chosen.length);i++){
      const card=cards[i];
      if(used.has(card.characterId))continue;
      used.add(card.characterId);
      choose([...chosen,card],i+1);
      used.delete(card.characterId);
      if(rows.length>limit)break;
    }
  }
  if(outfits.length)choose(fixed,0);
  return rows.length<=limit?rows:null;
}

/** Score the actual chart in every order. Keep the equipped Boards as a
 * competing setup when the proposed Board plan changes the modeled winner. */
function scoreStageSetup(data,query,seed,entry,resources,byId){
  const {options,account}=query,stage=options.challengeStage;
  const field=options.sortBy==='max'?'maxScore':'score';
  const context=createFinalistContext(data,query,seed,byId);
  const cards=seed.order.map(id=>byId.get(id));
  const bonus=challengeBonusPermil(stage,cards);
  const evaluate=mobileChartEvaluator(context,[entry],resources,bonus);
  let best;
  for(const order of finalistOrders(cards)){
    const trial=evaluate(order,seed.outfitId,seed.leaderChar);
    if(!trial.rangeCoverage?.perNote)throw Error('Mobile note scoring is unavailable for '+entry.song.title+' ('+entry.chart.type+').');
    if(!best||trial[field]>best[field])best=trial;
  }
  const order=best.order.map(id=>byId.get(id));
  const ordinary=bonus?mobileChartEvaluator(context,[entry],resources)(order,seed.outfitId,seed.leaderChar):best;
  const row={...seed,...best,...(query.boardOpt?.ignoreExisting&&!seed.plan?{boards:boardPlanningBaseline(account.boards,query.boardOpt)}:{}),
    challengeBonusPermil:bonus,challengeStageId:stage.id,songScore:ordinary.score,songMaxScore:ordinary.maxScore,
    effectWarnings:referenceMobileEffectWarnings(context,order,seed.outfitId,seed.leaderChar),
    scoringCharts:[{songId:entry.song.id,difficulty:entry.chart.type}]};
  if(seed.plan){
    const beforeContext=createFinalistContext(data,query,seed,byId,options,boardPlanningBaseline(account.boards,query.boardOpt),account.ranks);
    const before=mobileChartEvaluator(beforeContext,[entry],resources,bonus)(order,seed.outfitId,seed.leaderChar);
    row.plan={...seed.plan,before:{...seed.plan.before,...before},after:{...seed.plan.after,...best},orderExhaustive:true};
  }
  return row;
}

export async function searchChallengeSong(data,payload,songId,difficulties,resources,solver,progress){
  const song=data.songs.find(row=>row.id===songId),byId=new Map(data.cards.map(card=>[card.id,card]));
  const outputs=[],small=smallStageSetups(data,payload);
  for(const difficulty of difficulties){
    const chart=song.difficulties.find(row=>row.type===difficulty);
    const options={...payload.options,scoringMode:'chart',songId,difficulty};
    const field=options.sortBy==='max'?'maxScore':'score';
    const query={...payload,options,reviewedFinals:true};
    const seeds=small??(await solver.solve(query)).results;
    const limit=Math.max(6,options.topN);
    const initial=small??finalistSetups(seeds.slice().sort((a,b)=>b[field]-a[field]),limit);
    // A lineup projected to gain from affordable nodes can be weaker on the
    // equipped Boards. Carry both rankings through real Board planning.
    if(!small&&query.boardOpt){
      const projected=finalistSetups(seeds.slice().sort((a,b)=>(b.potential??b[field])-(a.potential??a[field])),limit);
      for(const seed of projected)if(!initial.includes(seed))initial.push(seed);
    }
    const entry={song,chart};
    let rows=initial.map(seed=>scoreStageSetup(data,query,seed,entry,resources,byId));
    if(query.boardOpt){
      for(const row of rows.slice()){
        const {plan}=await solver.plan({account:query.account,options:{...options,leaderMode:'fixed',outfitId:row.outfitId,
          leaderChar:row.leaderChar},team:row.order,leaderChar:row.leaderChar,outfitId:row.outfitId,boardOpt:query.boardOpt});
        if(plan)rows.push(scoreStageSetup(data,query,{...row,plan},entry,resources,byId));
      }
    }
    rows=mergeReferenceResults([{results:rows}],options).results;
    if(!rows.length)throw Error('No eligible five-member team fits the Challenge Live lineup settings.');
    outputs.push({songId,difficulty,rows});
    progress(outputs.length,difficulties.length);
  }
  return outputs;
}
