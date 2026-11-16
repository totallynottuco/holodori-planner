import {createReferenceScoreContext,evaluateReferenceTeam,isReferenceRatingSong,referenceComboAverage,withReferenceChart} from './reference-rating-math.js';
import {boardPlanningBaseline,hasBoardProtection} from './board-protection.js';

const ratingFor = score => Math.ceil(score/5000);
const sum = values => values.reduce((total,value)=>total+value,0);
const bounded = (value,fallback,min,max) => Math.min(max,Math.max(min,Math.trunc(value)||fallback));
const scoreMetric = (song,chart) => (chart.coefficient??0)*(chart.scoreMult??referenceComboAverage(song.comboCurve,chart.notes||1));
const rotations = cards => cards.map((_,position)=>cards.slice(position).concat(cards.slice(0,position)));
const rankKey = (song,chart) => `${song.id}:${chart.type}`;
const mobileKey = (song,chart) => `${song.id}_${chart.type}`;

function chartOptions(options,song,chart,overrides){
  return {...options,scoringMode:'chart',songId:song.id,difficulty:chart.type,...overrides};
}

function chartDescription(song,chart){
  return {songId:song.id,title:song.title,difficulty:chart.type,seconds:chart.seconds,notes:chart.notes||0};
}

export function referenceRatingCandidates(data,input,leader){
  const owned = new Set(input.ratingSongIds??[]);
  const now = input.ratingNow??Date.now();
  const maxDifficulty = input.ratingMaxDifficulty>0?input.ratingMaxDifficulty:Infinity;
  return data.songs.filter(song=>isReferenceRatingSong(song,leader,now)&&(input.ratingAllSongs||owned.has(song.id)))
    .flatMap(song=>{
      const charts = song.difficulties.filter(chart=>chart.seconds>0&&chart.level<=maxDifficulty);
      if(!charts.length)return [];
      const chart = [...charts].sort((a,b)=>scoreMetric(song,b)-scoreMetric(song,a))[0];
      return [{song,charts,chart,coefficient:scoreMetric(song,chart),referenceScore:0,songBonus:0}];
    }).sort((a,b)=>b.coefficient-a.coefficient);
}

function pullsFor(row){
  if(row.pulls?.length)return row.pulls;
  return row.candidateId?[{id:row.candidateId,new:true,copies:1,level:-1,bloom:-1}]:[];
}

function upgradeEntries(cards,owned,extras,row){
  if(!row)return owned;
  const pulls = pullsFor(row);
  if(!pulls.length)return owned;
  const {nextLevel,nextBloom}=extras;
  const next = {...owned};
  for(const pull of pulls){
    const card = cards.get(pull.id);
    next[pull.id] = pull.level>=0?{owned:true,level:pull.level,bloom:pull.bloom}:
      {owned:true,level:nextLevel>0?Math.min(nextLevel,card.maxLevel):card.maxLevel,bloom:Math.min(nextBloom??0,card.maxBloom)};
  }
  return next;
}

export async function forecastRating(data,payload,input,candidates,{solve,plan,mobile}){
  const {account,options,boardOpt}=payload;
  const byMax=options.sortBy==='max',key=byMax?'maxScore':'score';
  const boards=boardPlanningBaseline(account.boards,boardOpt);
  const next=options.goal==='next';
  const cards=new Map(data.cards.map(card=>[card.id,card]));
  const charts=candidates.map(({song,charts})=>({song,charts:[...charts].sort((a,b)=>scoreMetric(song,b)-scoreMetric(song,a)).slice(0,2)}));
  const existing=[],projected=[];
  const scoresAt=(rows,i)=>Math.max(...rows.map(row=>row[i]));
  async function screen({song,chart},alternate=false){
    const query={...payload,account:{...account,boards},boardOpt:null,ratingScout:true,limits:{...payload.limits,jointBoards:false},
      extras:next?{...payload.extras,nextCount:1}:payload.extras,
      options:chartOptions(options,song,chart,{topN:6,leaderInvitedOnly:false,leaderAllHolomems:false,pc:false})};
    const found=await solve(query);
    const seeds=(Array.isArray(found)?found:found?.results??[]).slice().sort((a,b)=>b[key]-a[key]);
    if(!seeds.length)return;
    const first=seeds[0];
    const second=seeds.find(row=>row.outfitId!==first.outfitId&&row[key]>=first[key]*.95)??seeds[1];
    for(const row of (alternate||!second?[first]:[first,second])){
      const owned=next?upgradeEntries(cards,account.owned,query.extras,row):account.owned;
      const score=activePlan=>{
        const team=activePlan?{...row,...activePlan.after,plan:activePlan}:{...row,boards};
        const lineup=team.order.map(id=>cards.get(id));
        const context=mobile?null:createReferenceScoreContext(data,owned,activePlan?.saves??boards,activePlan?.ranks??account.ranks,
          query.options,account.dreamRank);
        return charts.map(({song,charts})=>Math.max(...(mobile?
          mobile.score(team,charts.map(chart=>mobileKey(song,chart)),!byMax).map(value=>value[byMax?'maximum':'average']):
          charts.map(chart=>evaluateReferenceTeam(withReferenceChart(context,song,chart),lineup,team.outfitId,options.leaderChar)[key]))));
      };
      existing.push(score());
      if(boardOpt){
        const [layout]=await plan({...query,boardOpt,account:{...account,owned},options:{...query.options,cardPool:next?'owned':options.cardPool}},[row]);
        if(layout)projected.push(score(layout));
      }
    }
  }
  await screen(candidates[0]);
  if(!existing.length)return null;
  if(!next&&candidates.length>1){
    const firstPass=[...existing,...projected];
    let alternate=1;
    for(let i=2;i<candidates.length;i++)if(scoresAt(firstPass,i)>scoresAt(firstPass,alternate))alternate=i;
    await screen(candidates[alternate],true);
  }
  const rating=scores=>sum([...scores].sort((a,b)=>b-a).slice(0,3).map(ratingFor));
  const best=rows=>input.ratingMerge?Math.max(...rows.map(rating)):rating(charts.map((_,i)=>scoresAt(rows,i)));
  return {current:best(existing),potential:best([...existing,...projected])};
}

export function shortlistRatingLeaders(forecasts,limit){
  const viable=forecasts.filter(row=>row.forecast);
  const byPotential=viable.slice().sort((a,b)=>b.forecast.potential-a.forecast.potential||b.forecast.current-a.forecast.current);
  const byCurrent=viable.slice().sort((a,b)=>b.forecast.current-a.forecast.current);
  const depth=Math.ceil(limit*1.6)+3, reserve=Math.min(3,Math.ceil(limit/2));
  // Add coverage for strong current Boards without displacing leaders
  // whose strongest case is the affordable layout found by the screen.
  const chosen=new Set(byPotential.slice(0,depth));
  for(const row of byCurrent.slice(0,limit+reserve)){
    if(chosen.size>=depth+reserve)break;
    chosen.add(row);
  }
  const cutoff=byPotential[Math.min(byPotential.length,limit)-1]?.forecast.potential??0;
  for(const row of byPotential){
    if(chosen.size>=depth+reserve||row.forecast.potential<cutoff*.985)break;
    chosen.add(row);
  }
  // A viable chart without a scout lineup, for example a Next search that
  // needs several acquisitions, is still eligible for the full search.
  return [...byPotential.filter(row=>chosen.has(row)),...forecasts.filter(row=>!row.forecast)];
}

/** Replays the rating orchestration in the public optimizer, including chart screening and exact score reranking. */
export async function searchReferenceRating(data,payload,input,{solve,plan,refine,rankFundedTeams,prepareMobile,screenTeams=1,boardCandidates,candidateCharts,reusePlans=false,onProgress=()=>{}}){
  const leader = input.leaderCharacterId||payload.options.leaderChar;
  if(!leader)throw Error('Choose a Holomem to calculate rating.');
  const options = {...payload.options,leaderChar:leader,leaderInvitedOnly:false,leaderAllHolomems:false,pc:false};
  const scoreKey = options.sortBy==='max'?'maxScore':'score';
  const byMax = scoreKey==='maxScore';
  const nextMode = options.goal==='next';
  const merge = !!input.ratingMerge;
  const songCount = bounded(input.ratingSongCount,5,1,10);
  const teamsPerSong = bounded(input.ratingTeamsPerSong,3,1,5);
  const candidateCount = Math.max(songCount+3,10);
  const {account,boardOpt} = payload;
  const startingBoards=hasBoardProtection(boardOpt)?boardPlanningBaseline(account.boards,boardOpt):account.boards;
  const extras = {...payload.extras};
  if(nextMode){
    const maxLevel = Math.max(...data.cards.map(card=>card.maxLevel));
    const maxBloom = Math.max(...data.cards.map(card=>card.maxBloom));
    extras.nextLevel=extras.nextLevel>0?Math.min(extras.nextLevel,maxLevel):maxLevel;
    extras.nextBloom=Math.min(Math.max(extras.nextBloom??0,0),maxBloom);
  }
  const optimizeBoards = !!boardOpt;
  const cards = new Map(data.cards.map(card=>[card.id,card]));
  const candidates = candidateCharts??referenceRatingCandidates(data,input,leader);
  if(!candidates.length)throw Error('No eligible songs match the Holomem and difficulty.');
  const mobile = await prepareMobile?.(candidates.flatMap(({song,charts})=>charts.map(chart=>({
    key:mobileKey(song,chart),level:chart.level,notes:chart.notes,
  }))));
  const mobileMetric = byMax?'maximum':'average';
  const scoreOf = row => mobile?row.reviewedScore[mobileMetric]:row[scoreKey];
  const empty = {ratingTotal:0,ratingMerged:merge,ratingGroups:[],results:[],byMax};

  const chartPayload = (candidate,overrides)=>({...payload,extras,
    options:chartOptions(options,candidate.song,candidate.chart,overrides),
  });
  const runChart = async(candidate,phase,overrides={})=>{
    const query=chartPayload(candidate,{topN:merge?5:teamsPerSong,...overrides});
    if(mobile)return mobile.search(query,phase,[mobileKey(candidate.song,candidate.chart)],{optimize:!merge&&optimizeBoards});
    const result = await solve(query,phase,{rawJoint:true});
    if(result===null)throw Error('The Holomem Rating search did not finish.');
    return Array.isArray(result)?result:result.results;
  };
  const planChart = (candidate,rows,phase,overrides={},maxRows=96)=>
    plan(chartPayload(candidate,overrides),rows,phase,{maxRows,fullCount:Math.max(12,teamsPerSong)});
  const combinePlans = (rows,plans=[])=>rows.map((row,index)=>({row,plan:plans[index]??null}))
    .sort((a,b)=>(b.plan?.after?.[scoreKey]??b.row[scoreKey])-(a.plan?.after?.[scoreKey]??a.row[scoreKey]));
  const scoreContext = (candidate,boards=startingBoards,owned=account.owned,ranks=account.ranks)=>createReferenceScoreContext(data,
    owned,boards,ranks,chartOptions(options,candidate.song,candidate.chart),account.dreamRank);
  const screeningContext = (candidate,row)=>nextMode?scoreContext(candidate,
    row.plan?.saves??row.boards??boardPlanningBaseline(account.boards,boardOpt),
    upgradeEntries(cards,account.owned,extras,row),row.plan?.ranks):scoreContext(candidate);

  let work = Math.min(candidates.length,candidateCount),done = 0;
  const phase = label=> (evaluated,total,fraction)=>onProgress(evaluated,total,Math.min(1,(done+(fraction??0))/work),label);
  const seed = {...candidates[0]};
  const initial = await runChart(seed,phase(seed.song.title));
  if(!initial.length)return empty;
  const seeded = !mobile&&optimizeBoards&&!nextMode&&!merge?
    combinePlans(initial,await planChart(seed,initial,phase('Planning Boards'))):initial.map(row=>({row,plan:null}));
  done = 1;
  const screeningTeams = seeded.slice(0,screenTeams).map(({row})=>({
    row,context:screeningContext(seed,row),orders:rotations(row.order.map(id=>cards.get(id)).filter(Boolean)),
  }));
  if(reusePlans&&!mobile&&!nextMode)for(const {plan} of seeded.slice(0,2)){
    if(!plan?.orderExhaustive)continue;
    screeningTeams.push({row:plan.after,context:scoreContext(seed,plan.saves,account.owned,plan.ranks),
      orders:rotations(plan.after.order.map(id=>cards.get(id)))});
  }
  const screenScore = (song,chart,order,row,evaluated) => mobile?
    mobile.score({...row,...(!nextMode&&{plan:undefined}),order:order.map(card=>card.id)},[mobileKey(song,chart)],!byMax)[0][mobileMetric]:
    evaluated[scoreKey];
  onProgress(1,work,1/work,'Screening eligible charts');
  for(const candidate of candidates){
    for(const chart of candidate.charts){
      for(const {row,context,orders} of screeningTeams){
        const chartContext = withReferenceChart(context,candidate.song,chart);
        for(const order of orders){
          const evaluated = evaluateReferenceTeam(chartContext,order,row.outfitId,leader);
          const value=screenScore(candidate.song,chart,order,row,evaluated);
          if(value>candidate.referenceScore){
            candidate.referenceScore=value;
            candidate.songBonus=evaluated.breakdown.songBonus;
            candidate.chart=chart;
          }
        }
      }
    }
  }
  const screened = [];
  const songBonusLimit = data.boardLimits?.songBonus??100;
  for(const candidate of [...candidates].sort((a,b)=>b.referenceScore-a.referenceScore)){
    const threshold = screened[Math.min(songCount,screened.length)-1]?.referenceScore??0;
    const boardHeadroom = optimizeBoards?1+Math.max(0,songBonusLimit-candidate.songBonus)/1000:1;
    if(screened.length<candidateCount||candidate.referenceScore*1.03*boardHeadroom>=threshold)screened.push(candidate);
  }

  if(merge){
    const selected = screened.slice(0,Math.max(songCount,6));
    const lbCharts = selected.map(({song,chart})=>({songId:song.id,difficulty:chart.type}));
    work=2;
    if(mobile){
      const keys=selected.map(({song,chart})=>mobileKey(song,chart));
      const compareScores=(a,b)=>b.rating-a.rating||b.tieRating-a.tieRating||b.tieScore-a.tieScore;
      const summarize=scores=>{
        const ranked=scores.map((reviewedScore,index)=>{
          const {song,chart}=selected[index], score=reviewedScore[mobileMetric];
          return {...chartDescription(song,chart),key:keys[index],rating:ratingFor(score),score,reviewedScore};
        }).sort((a,b)=>b.score-a.score);
        return {...ranked[0].reviewedScore,chartKey:ranked[0].key,
          rating:sum(ranked.slice(0,3).map(chart=>chart.rating)),
          tieRating:sum(ranked.slice(0,songCount).map(chart=>chart.rating)),
          tieScore:sum(ranked.map(chart=>chart.score)),
          ratingSongs:ranked.slice(0,Math.max(3,songCount)).map(({reviewedScore,key,...chart})=>chart)};
      };
      const query=chartPayload(selected[0],{lbCharts});
      const ranked=await mobile.search(query,phase('Searching for the merged team'),keys,{optimize:optimizeBoards,summarize,compareScores});
      const results=ranked.map(row=>({...row,rating:row.reviewedScore.rating,ratingSongs:row.reviewedScore.ratingSongs.slice(0,songCount)}));
      return {...empty,ratingTotal:results[0]?.rating??0,ratingContributors:ranked[0]?.reviewedScore.ratingSongs.slice(0,3),results,scoringCharts:lbCharts};
    }
    const ranked = (await runChart(selected[0],phase('Searching for the merged team'),{
      lbCharts,topN:Math.max(options.topN,8),
    })).slice(0,boardCandidates??options.topN);
    if(!ranked.length)return empty;
    const plans = optimizeBoards&&!nextMode?await planChart(selected[0],ranked,phase('Planning Boards'),{lbCharts},ranked.length):[];
    const baseContexts = new Map();
    const chartContexts = (boards,owned,ranks)=>{
      const base = scoreContext(selected[0],boards,owned,ranks);
      return new Map(selected.map(({song,chart})=>[song.id,withReferenceChart(base,song,chart)]));
    };
    const baseline = (row,owned)=>{
      const key = nextMode?pullsFor(row).map(pull=>`${pull.id}:${pull.new?'n':'b'}${pull.copies}`).sort().join('|'):'';
      if(!baseContexts.has(key))baseContexts.set(key,chartContexts(startingBoards,owned));
      return baseContexts.get(key);
    };
    const rows = [];
    for(const [index,row] of ranked.entries()){
      const applied = plans[index]??(nextMode?row.plan:null);
      const owned = nextMode?upgradeEntries(cards,account.owned,extras,row):account.owned;
      const boards = applied?.saves??(nextMode&&row.boards?row.boards:startingBoards);
      const contexts = boards===startingBoards&&!applied?.ranks?
        baseline(row,owned):chartContexts(boards,owned,applied?.ranks);
      const order = (applied?.after.order??row.order).map(id=>cards.get(id));
      if(order.some(card=>!card))continue;
      const outfitId = applied?.outfitId??row.outfitId??null;
      const evaluated = selected.map(({song,chart})=>{
        const result = evaluateReferenceTeam(contexts.get(song.id),order,outfitId,leader);
        return {...chartDescription(song,chart),rating:ratingFor(result[scoreKey]),score:result[scoreKey],result};
      }).sort((a,b)=>b.score-a.score);
      const strongest = evaluated[0];
      const rating = sum(evaluated.slice(0,3).map(chart=>chart.rating));
      const result = {...strongest.result,rating,
        ratingSongs:evaluated.slice(0,songCount).map(({result,...chart})=>chart),
        ...(row.candidateId?{candidateId:row.candidateId}:{}),...(row.pulls?{pulls:row.pulls}:{}),
        ...(nextMode&&row.boards?{boards:row.boards}:{}),
      };
      if(applied){
        const prior = applied.ignoredExisting?
          chartContexts(boardPlanningBaseline(account.boards,boardOpt),owned):baseline(row,owned);
        result.plan={...applied,
          before:evaluateReferenceTeam(prior.get(strongest.songId),order,outfitId,leader),
          after:strongest.result,
        };
      }
      rows.push({result,contributors:evaluated.slice(0,3).map(({result,...chart})=>chart),tieRating:sum(evaluated.slice(0,songCount).map(chart=>chart.rating)),
        tieScore:sum(evaluated.map(chart=>chart.score))});
    }
    rows.sort((a,b)=>b.result.rating-a.result.rating||b.tieRating-a.tieRating||b.tieScore-a.tieScore);
    const results = rows.map(row=>row.result);
    return {...empty,ratingTotal:results[0]?.rating??0,ratingContributors:rows[0]?.contributors,results,scoringCharts:lbCharts};
  }

  const groups = new Map();
  const fundedPlans = new Map();
  function record(candidate,pairs){
    if(reusePlans&&!mobile&&!nextMode)fundedPlans.set(rankKey(candidate.song,candidate.chart),pairs
      .filter(({plan})=>plan?.orderExhaustive).map(({row,plan})=>({...row,...plan.after,plan})));
    const results = pairs.slice(0,teamsPerSong).map(({row,plan})=>{
      const scored = plan?{...row,...plan.after,plan}:row;
      return {...scored,rating:ratingFor(scoreOf(scored))};
    });
    const best = results.length?scoreOf(results[0]):0;
    const rating = ratingFor(best);
    const existing = groups.get(candidate.song.id);
    if(!existing||best>existing.best)groups.set(candidate.song.id,{
      ...chartDescription(candidate.song,candidate.chart),rating,best,results,
    });
  }
  function alternate(candidate,pairs){
    if(!pairs.length||candidate.charts.length<2)return null;
    const row = pairs[0].row;
    const team = row.order.map(id=>cards.get(id));
    if(team.some(card=>!card))return null;
    const orders = rotations(team);
    const context = screeningContext(candidate,row);
    const plan=reusePlans&&!mobile&&!nextMode?pairs[0].plan:null;
    const funded=plan?.orderExhaustive&&scoreContext(candidate,plan.saves,account.owned,plan.ranks);
    const fundedOrders=funded?rotations(plan.after.order.map(id=>cards.get(id))):[];
    const evaluate = chart=>{
      const chartContext = withReferenceChart(context,candidate.song,chart);
      const baseline=orders.map(order=>screenScore(candidate.song,chart,order,row,
        evaluateReferenceTeam(chartContext,order,row.outfitId,leader)));
      if(!funded)return Math.max(0,...baseline);
      const optimized=withReferenceChart(funded,candidate.song,chart);
      return Math.max(...baseline,...fundedOrders.map(order=>
        evaluateReferenceTeam(optimized,order,plan.outfitId,leader)[scoreKey]));
    };
    let minimum = evaluate(candidate.chart)*1.002;
    let alternate;
    for(const chart of candidate.charts){
      if(chart.type===candidate.chart.type)continue;
      const value = evaluate(chart);
      if(value>minimum){minimum=value;alternate=chart;}
    }
    return alternate?{...candidate,chart:alternate}:null;
  }

  record(seed,seeded);
  const seedKey = rankKey(seed.song,seed.chart);
  const queue = screened.filter(({song,chart})=>rankKey(song,chart)!==seedKey);
  const visited = new Set([seedKey]);
  const seedAlternate = alternate(seed,seeded);
  if(seedAlternate&&!queue.some(({song,chart})=>rankKey(song,chart)===rankKey(seedAlternate.song,seedAlternate.chart)))queue.push(seedAlternate);
  for(const candidate of queue){
    const key = rankKey(candidate.song,candidate.chart);
    if(visited.has(key))continue;
    visited.add(key);
    work=queue.length+1;
    const progress = phase(`${candidate.song.title} (${done+1}/${work})`);
    const rows = await runChart(candidate,progress);
    done++;
    const pairs = !mobile&&optimizeBoards&&!nextMode&&rows.length?
      combinePlans(rows,await planChart(candidate,rows,phase('Planning Boards'))):rows.map(row=>({row,plan:null}));
    record(candidate,pairs);
    const neighbor = alternate(candidate,pairs);
    if(neighbor&&!visited.has(rankKey(neighbor.song,neighbor.chart)))queue.push(neighbor);
  }
  if(reusePlans&&!mobile&&optimizeBoards&&!nextMode&&!Object.keys(boardOpt.keep?.targets??{}).length){
    // The same account and starting budget apply to every Rating chart.
    // Check completed layouts on other songs before returning the ranking.
    const byPlan=[...groups.values()].sort((a,b)=>b.best-a.best)
      .flatMap(group=>group.results.filter(row=>row.plan?.orderExhaustive).slice(0,2)).slice(0,12);
    const reusable=byPlan.map(row=>({row,orders:rotations(row.order.map(id=>cards.get(id))),
      context:scoreContext(seed,row.plan.saves,account.owned,row.plan.ranks)}));
    const baseline=scoreContext(seed,boardPlanningBaseline(account.boards,boardOpt));
    for(const candidate of candidates)for(const chart of candidate.charts){
      let existing=groups.get(candidate.song.id);
      for(const {row,orders,context} of reusable){
        const scorer=withReferenceChart(context,candidate.song,chart);
        let best=existing?.best??0,winner;
        for(const order of orders){
          const after=evaluateReferenceTeam(scorer,order,row.outfitId,leader);
          if(after[scoreKey]>best){best=after[scoreKey];winner={after,order};}
        }
        if(!winner)continue;
        const {after,order}=winner;
        const before=evaluateReferenceTeam(withReferenceChart(baseline,candidate.song,chart),order,row.outfitId,leader);
        const rating=ratingFor(after[scoreKey]);
        const result={...row,...after,rating,plan:{...row.plan,before,after}};
        const alternatives=existing?.difficulty===chart.type?existing.results.filter(item=>
          item.outfitId!==row.outfitId||item.order.join('|')!==after.order.join('|')):[];
        existing={...chartDescription(candidate.song,chart),rating,best:after[scoreKey],
          results:[result,...alternatives].slice(0,teamsPerSong)};
        groups.set(candidate.song.id,existing);
      }
    }
    async function rankFundedOrders(explorePairs=false){
      const runners=new Map();
      if(!rankFundedTeams)return runners;
      const leading=[...groups.values()].sort((a,b)=>b.best-a.best);
      const cutoff=leading[Math.min(3,leading.length)-1]?.best??0;
      const competitive=leading.slice(0,5).filter(group=>group.best>=cutoff*.96);
      const alternatives=[];
      const portfolio=new Set(competitive.flatMap(group=>group.results.filter(row=>row.plan?.orderExhaustive).slice(0,2)));
      for(const group of competitive){
        const available=fundedPlans.get(`${group.songId}:${group.difficulty}`)??[];
        const key=row=>row.outfitId+'|'+row.order.slice().sort().join('|');
        const known=new Set(group.results.map(key));
        const different=available.find(row=>row.outfitId!==group.results[0].outfitId&&!known.has(key(row)))??
          available.find(row=>!known.has(key(row)));
        if(different)alternatives.push(different);
      }
      const availableLayouts=[...alternatives,...portfolio];
      const layouts=(explorePairs?[...new Map(availableLayouts.map(row=>[row.plan.saves,row])).values()]:
        availableLayouts).slice(0,12);
      await Promise.all(competitive.map(async group=>{
        const candidate=candidates.find(({song})=>song.id===group.songId);
        const chart=candidate?.charts.find(chart=>chart.type===group.difficulty);
        if(!chart||!layouts.length)return;
        const query=chartPayload({...candidate,chart});
        const {best:picked,alternate,neighbors}=await rankFundedTeams(query,layouts,group.results,explorePairs);
        if(explorePairs){
          const winner=picked?.after[scoreKey]>group.best?picked.after:group.results[0];
          const key=row=>row.outfitId+'|'+row.order.slice().sort().join('|');
          const winnerKey=key(winner);
          const runner=neighbors.find(({after})=>after[scoreKey]>=winner[scoreKey]*.97&&key(after)!==winnerKey);
          const variants=[runner,alternate?.after[scoreKey]>=winner[scoreKey]*.99?alternate:null]
            .map(pick=>pick&&({...layouts[pick.index],...pick.after}));
          runners.set(group,variants);
        }
        if(!picked||picked.after[scoreKey]<=group.best)return;
        const {after}=picked,row=layouts[picked.index],order=after.order.map(id=>cards.get(id));
        const before=evaluateReferenceTeam(withReferenceChart(baseline,candidate.song,chart),order,after.outfitId,leader);
        group.best=after[scoreKey];
        group.rating=ratingFor(group.best);
        const otherTeams=group.results.filter(team=>team.outfitId!==after.outfitId||team.order.join('|')!==after.order.join('|'));
        const plan={...row.plan,before,after,outfitId:after.outfitId};
        group.results=[{...row,...after,rating:group.rating,plan},...otherTeams].slice(0,teamsPerSong);
      }));
      return runners;
    }
    async function refineFinalBoards(runners){
      if(!refine||!runners&&boardOpt.maxResets===0)return;
      const finalJobs=[];
      const ranked=[...groups.values()].sort((a,b)=>b.best-a.best);
      const cutoff=ranked[Math.min(3,ranked.length)-1]?.best??0;
      const leading=runners?ranked.slice(0,5).filter(group=>group.best>=cutoff*.985):ranked.slice(0,3);
      let triedAlternate=false;
      for(const group of leading){
        const row=group.results[0],song=candidates.find(choice=>choice.song.id===group.songId);
        const chart=song?.charts.find(chart=>chart.type===group.difficulty);
        if(!row.plan?.orderExhaustive||!chart)continue;
        const layouts=new Set([...group.results.slice(1),...leading.flatMap(other=>other===group?[]:other.results.slice(0,1))]
          .filter(team=>team.plan?.orderExhaustive).map(team=>team.plan.saves));
        const query=chartPayload({...song,chart});
        const [runner,alternate]=runners?.get(group)??[];
        const second=!triedAlternate&&alternate&&alternate.plan.saves!==row.plan.saves?alternate:null;
        if(second)triedAlternate=true;
        for(const candidate of [row,runner,second].filter(Boolean))
          finalJobs.push({group,row:candidate,query,
            donorLayouts:[...layouts].filter(layout=>layout!==candidate.plan.saves),quality:!!runners});
      }
      if(finalJobs.length)onProgress(done,work,0.99,'Refining final Board plans');
      const refined=finalJobs.length?await refine(finalJobs):[];
      for(const [index,updated] of refined.entries()){
        const {group,row}=finalJobs[index];
        if(!updated||updated.after[scoreKey]<=group.best)continue;
        group.best=updated.after[scoreKey];
        group.rating=ratingFor(group.best);
        const team={...row,...updated.after,rating:group.rating,plan:updated};
        if(runners){
          const others=group.results.filter(result=>result.outfitId!==team.outfitId||result.order.join('|')!==team.order.join('|'));
          group.results=[team,...others].slice(0,teamsPerSong);
        }else group.results[0]=team;
      }
    }
    await rankFundedOrders();
    await refineFinalBoards();
    const runners=await rankFundedOrders(true);
    await refineFinalBoards(runners);
  }
  const ranked = [...groups.values()].sort((a,b)=>b.best-a.best);
  return {...empty,ratingTotal:sum(ranked.slice(0,3).map(group=>group.rating)),
    ratingContributors:ranked.slice(0,3).map(({results,best,...chart})=>({...chart,score:best})),ratingGroups:ranked.slice(0,songCount)};
}
