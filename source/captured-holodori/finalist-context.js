import { createReferenceScoreContext } from './reference-rating-math.js';
import { boardPlanningBaseline } from './board-protection.js';
import { MobileCoverageError } from './reviewed-mobile-search.js';

export function nextPulls(row) {
  return row.pulls?.length?row.pulls:row.candidateId?[{id:row.candidateId,new:true,copies:1}]:[];
}

export function nextCardEntry(card,extras,pull,base) {
  if(pull.level>=0)return {level:pull.level,bloom:pull.bloom,...(!pull.new&&base?.sp!=null?{sp:base.sp}:{})};
  return {level:extras.nextLevel>0?Math.min(extras.nextLevel,card.maxLevel):card.maxLevel,
    bloom:Math.min(extras.nextBloom??0,card.maxBloom)};
}

export function mobileTeam(row,payload,cards) {
  const {account,options,extras}=payload;
  if(options.goal!=='next')return {...row,lineup:row.order.map(id=>account.owned[id])};
  const entries={};
  for(const pull of nextPulls(row)){
    const card=cards.get(pull.id);
    if(!card||(!pull.new&&!(pull.level>=1)))throw new MobileCoverageError('An upgrade has no reviewed card state.');
    const entry=nextCardEntry(card,extras,pull,account.owned[pull.id]);
    if(!Number.isInteger(entry.level)||entry.level<1||entry.level>card.maxLevel||
      !Number.isInteger(entry.bloom)||entry.bloom<0||entry.bloom>card.maxBloom)
      throw new MobileCoverageError('An upgrade has an unsupported Level or Bloom.');
    entries[pull.id]=entry;
  }
  const lineup=row.order.map(id=>entries[id]??account.owned[id]);
  if(lineup.some(entry=>!entry))throw new MobileCoverageError('An acquisition has no reviewed card state.');
  return {...row,entries,lineup};
}

export function createFinalistContext(data,payload,row,cards,options=payload.options,
  boards=row.plan?.saves??row.boards??boardPlanningBaseline(payload.account.boards,payload.boardOpt),
  ranks=row.plan?.ranks??payload.account.ranks){
  const account=payload.account;
  let owned=account.owned;
  if(payload.options.goal==='next'&&nextPulls(row).length){
    owned={...owned};
    for(const pull of nextPulls(row)){
      const card=cards.get(pull.id);
      if(!card)throw Error(`Cannot project unknown upgrade card ${pull.id}.`);
      owned[pull.id]={...nextCardEntry(card,payload.extras,pull,owned[pull.id]),owned:true};
    }
  }
  return createReferenceScoreContext(data,owned,boards,ranks,options,account.dreamRank);
}
