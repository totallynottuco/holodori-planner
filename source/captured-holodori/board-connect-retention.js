import {boardReachability} from './unit-score-board-search';
import {createReferenceScoreContext,evaluateReferenceTeam,referenceBoardNodeValues,referenceBoardTargetMatches} from './reference-rating-math';

// Put an otherwise unused card back only in its own still-open slot. Place it
// before the optimizer's assignments so their overlapping coverage wins.
export function restoreUnusedConnects(data,account,boards,accept){
  const used=new Set(Object.values(boards).flatMap(board=>Object.values(board.cards)));
  for(const [owner,board] of Object.entries(account.boards))if(!Object.hasOwn(boards,owner))
    for(const id of Object.values(board.cards))used.add(id);
  let result=boards;
  for(const [owner,original] of Object.entries(account.boards)){
    let board=result[owner];
    if(!board||board===original||!data.boards[owner])continue;
    let reachable;
    for(const [slot,id] of Object.entries(original.cards)){
      if(!id||board.cards[slot]||used.has(id)||!data.connects[id])continue;
      reachable??=boardReachability(data.boards[owner],board,account.dreamRank)?.active??new Set();
      if(!reachable.has(slot))continue;
      const next={...board,cards:{[slot]:id,...board.cards}};
      const candidate={...result,[owner]:next};
      if(!accept(candidate,owner,result))continue;
      used.add(id);
      result=candidate;
      board=next;
    }
  }
  return result;
}

// Native jobs can return either one Board plan or lineups with embedded
// plans. Reconcile at this boundary, before downstream chart/rating scoring.
export function retainReferenceConnects(data,payload,response){
  if(!payload.boardOpt||payload.boardOpt.ignoreExisting||!response.plan&&!response.results?.some(row=>row.plan))return response;
  const {account,options}=payload;
  const cardById=new Map(data.cards.map(card=>[card.id,card]));
  const reconcile=(plan,parent)=>{
    if(!plan?.saves||!plan.after?.order)return;
    const order=plan.after.order.map(id=>cardById.get(id));
    if(!order.every(Boolean))return;
    const leader=plan.after.leaderChar??plan.leaderChar;
    const owned={...account.owned};
    for(const pull of parent?.pulls??[]){
      const card=cardById.get(pull.id);
      if(card)owned[pull.id]={...owned[pull.id],owned:true,level:pull.level>0?pull.level:
        Math.min(payload.extras?.nextLevel>0?payload.extras.nextLevel:card.maxLevel,card.maxLevel),
        bloom:pull.bloom>=0?pull.bloom:payload.extras?.nextBloom??0};
    }
    const roster={...options.boardConnectEntries,...owned};
    const score=boards=>evaluateReferenceTeam(createReferenceScoreContext(data,owned,boards,plan.ranks??account.ranks,
      options,account.dreamRank),order,plan.after.outfitId,leader);
    const restored=restoreUnusedConnects(data,account,plan.saves,(candidate,owner,previous)=>{
      const effects=boards=>referenceBoardNodeValues(owner,data,boards,roster,account.dreamRank);
      const old=effects(previous);
      const relevant=effects(candidate).some(({node,value},index)=>old[index].value!==value&&
        node.charTrigger!=='WORK'&&(node.charTrigger!=='SET_LIVE_LEADER'||leader===owner)&&
        (node.songTrigger||node.kind==='paramGroup'||node.kind.startsWith('leaderActive')||
          order.some(card=>referenceBoardTargetMatches(node,owner,card))));
      if(!relevant)return true;
      // Use the original native score when its scenario cannot be replayed.
      if(options.lbCharts?.length||parent?.candidateId||parent?.pulls?.length)return false;
      const before=score(previous),after=score(candidate);
      for(const key of ['score','maxScore']){
        if(!(Math.abs(before[key]-plan.after[key])<=0.01)||!(after[key]>=before[key]))return false;
      }
      Object.assign(plan.after,after);
      if(parent)Object.assign(parent,after);
      return true;
    });
    if(restored===plan.saves)return;
    plan.saves=restored;
    plan.changes=plan.changes.filter(change=>{
      change.connects=change.connects.filter(({socket})=>
        account.boards[change.owner]?.cards[socket]!==restored[change.owner]?.cards[socket]);
      return change.connects.length||change.buys.length||change.resets.length;
    });
  };
  reconcile(response.plan);
  for(const row of response.results??[])reconcile(row.plan,row);
  return response;
}
