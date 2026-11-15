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
      {owned:true,level:Math.min(nextLevel,card?.maxLevel??nextLevel),bloom:Math.min(nextBloom,card?.maxBloom??nextBloom)};
  }
  return next;
}

/** Replays the rating orchestration in the public optimizer, including chart screening and exact score reranking. */
export async function searchReferenceRating(data,payload,input,{solve,plan,prepareMobile,screenTeams=1,boardCandidates,onProgress=()=>{}}){
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
  const candidates = referenceRatingCandidates(data,input,leader);
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
          ratingSongs:ranked.slice(0,songCount).map(({reviewedScore,key,...chart})=>chart)};
      };
      const query=chartPayload(selected[0],{lbCharts});
      const ranked=await mobile.search(query,phase('Searching for the merged team'),keys,{optimize:optimizeBoards,summarize,compareScores});
      const results=ranked.map(row=>({...row,rating:row.reviewedScore.rating,ratingSongs:row.reviewedScore.ratingSongs}));
      return {...empty,ratingTotal:results[0]?.rating??0,results,scoringCharts:lbCharts};
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
      rows.push({result,tieRating:sum(evaluated.slice(0,songCount).map(chart=>chart.rating)),
        tieScore:sum(evaluated.map(chart=>chart.score))});
    }
    rows.sort((a,b)=>b.result.rating-a.result.rating||b.tieRating-a.tieRating||b.tieScore-a.tieScore);
    const results = rows.map(row=>row.result);
    return {...empty,ratingTotal:results[0]?.rating??0,results,scoringCharts:lbCharts};
  }

  const groups = new Map();
  function record(candidate,pairs){
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
    const evaluate = chart=>{
      const chartContext = withReferenceChart(context,candidate.song,chart);
      return Math.max(0,...orders.map(order=>screenScore(candidate.song,chart,order,row,
        evaluateReferenceTeam(chartContext,order,row.outfitId,leader))));
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
  const ranked = [...groups.values()].sort((a,b)=>b.best-a.best);
  return {...empty,ratingTotal:sum(ranked.slice(0,3).map(group=>group.rating)),ratingGroups:ranked.slice(0,songCount)};
}
