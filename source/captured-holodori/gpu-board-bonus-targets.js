import {boardFrontierPaths,boardReachability} from './unit-score-board-search';

export function boardBonusTarget(node,targets){
  const id=node.kind==='rewardExp'?'memberExp':node.kind==='rewardQty'?'memberGold':
    node.kind==='miniGameReward'?'minigame':null;
  if(!id||node.charTrigger==='SET_LIVE_LEADER')return null;
  const variant=`${id}:${node.variant}`;
  if(Object.hasOwn(targets,variant))return variant;
  return Object.hasOwn(targets,id)?id:null;
}

export function hasGpuBoardBonusTargets(targets){
  return Object.keys(targets).some(id=>['memberExp','memberGold','minigame'].includes(id.split(':')[0]));
}

export async function improveGpuBoardBonuses({owners,topology,nodeMaps,budgets,originalNodes,targets,branches,dreamRank,
  emptyBoard,materials,infinite,available,resetsLeft,protectedNode,priority,checkTrades,score,scoreValue,initial,boards,commit}){
  const baseline=scoreValue(initial);
  let row=initial;
  const gains={};
  const materialSet=new Set(materials);
  const frontierCache=new WeakMap(),cutCache=new WeakMap();
  const possible=new Set(owners.filter(owner=>topology[owner].some(node=>
    branches.has(node.branch)&&(node.hide??0)<=dreamRank&&(node.lock??0)<=dreamRank&&boardBonusTarget(node,targets))));
  if(!possible.size)return {row,gains};
  function moves(owner,save){
    const topologyForOwner=topology[owner],budget=budgets.get(owner);
    const frontier=boardFrontierPaths(topologyForOwner,save,dreamRank,branches,8);
    if(!frontier||save.nodes.some(id=>!frontier.active.has(id)))return [];
    return frontier.paths.flatMap(path=>{
      if(frontier.spent+path.points>budget||Object.keys(path.materials).some(id=>!materialSet.has(id)))return [];
      const target=boardBonusTarget(path.path.at(-1),targets);
      if(!target)return [];
      const rewards={};
      for(const node of path.path){
        const key=boardBonusTarget(node,targets);
        if(key)rewards[key]=(rewards[key]??0)+node.value;
      }
      const gain=Object.values(rewards).reduce((sum,value)=>sum+value,0);
      return [{owner,save,budget,spent:frontier.spent,...path,gain,rewards}];
    });
  }
  function cuts(owner,save){
    const nodes=nodeMaps.get(owner),seen=new Set();
    const canRemove=id=>{
      const node=nodes.get(id);
      return node?.pts&&branches.has(node.branch)&&!Object.hasOwn(save.cards,id)&&!protectedNode(node);
    };
    return save.nodes.flatMap(id=>{
      if(!canRemove(id))return [];
      const reachable=boardReachability(topology[owner],{...save,nodes:save.nodes.filter(other=>other!==id)},dreamRank);
      if(!reachable)return [];
      const removed=save.nodes.filter(other=>!reachable.active.has(other));
      if(!removed.length||removed.some(other=>!canRemove(other)))return [];
      const key=removed.slice().sort().join('|');
      if(seen.has(key))return [];
      seen.add(key);
      const refund={},original=originalNodes.get(owner);
      let loss=0,resetCost=0,points=0;
      for(const other of removed){
        const node=nodes.get(other);
        loss+=priority(node,owner);
        points+=node.pts;
        if(original.has(other))resetCost++;
        for(const item of node.items)refund[item.id]=(refund[item.id]??0)+item.qty;
      }
      return [{owner,next:{...save,nodes:save.nodes.filter(other=>reachable.active.has(other))},refund,resetCost,loss,points}];
    });
  }

  for(let step=0;step<24;step++){
    const stock=available(),resetBudget=resetsLeft(),additions=[],donors=[],local=[];
    for(const owner of owners){
      const save=boards[owner]??emptyBoard;
      if(possible.has(owner)&&!frontierCache.has(save)){
        const options=moves(owner,save);
        if(save!==emptyBoard)frontierCache.set(save,options);
        additions.push(...options);
      }else additions.push(...frontierCache.get(save)??[]);
      if(!save.nodes.length)continue;
      if(!cutCache.has(save))cutCache.set(save,cuts(owner,save).sort((a,b)=>a.loss-b.loss));
      const removable=cutCache.get(save).filter(cut=>cut.resetCost<=resetBudget);
      donors.push(...removable);
      if(!possible.has(owner))continue;
      const selectedCuts=new Set(removable.slice(0,4));
      for(const minimum of [5,10,15,20,30]){
        const cut=removable.find(candidate=>candidate.points>=minimum);
        if(cut)selectedCuts.add(cut);
      }
      for(const donor of selectedCuts){
        donor.moves??=moves(owner,donor.next);
        for(const move of donor.moves)local.push({move,donors:[donor],refund:donor.refund,loss:donor.loss});
      }
    }
    const candidates=local;
    for(const move of additions){
      const shortfalls=materials.flatMap((id,index)=>(move.materials[id]??0)>stock[index]?[{id,amount:move.materials[id]-stock[index]}]:[]);
      if(infinite||!shortfalls.length){candidates.push({move,donors:[],refund:{},loss:0});continue;}
      const possibleDonors=donors.filter(donor=>donor.owner!==move.owner&&shortfalls.some(({id})=>donor.refund[id]));
      const suffices=refund=>shortfalls.every(({id,amount})=>(refund[id]??0)>=amount);
      for(const donor of possibleDonors.filter(donor=>suffices(donor.refund)).sort((a,b)=>a.loss-b.loss).slice(0,8))
        candidates.push({move,donors:[donor],refund:donor.refund,loss:donor.loss});
      const cover=(donor,refund)=>shortfalls.reduce((sum,{id,amount})=>sum+
        Math.min(Math.max(0,amount-(refund[id]??0)),donor.refund[id]??0)/amount,0);
      const roots=possibleDonors.filter(donor=>!suffices(donor.refund))
        .map(donor=>({donor,value:cover(donor,{})/(1+donor.loss)})).sort((a,b)=>b.value-a.value).slice(0,3);
      for(const {donor:first} of roots){
        const group=[first],refund={...first.refund};
        for(let attempt=0;attempt<5&&!suffices(refund);attempt++){
          let best,bestValue=0;
          for(const donor of possibleDonors){
            if(group.some(other=>other.owner===donor.owner))continue;
            const value=cover(donor,refund)/(1+donor.loss);
            if(value>bestValue){best=donor;bestValue=value;}
          }
          if(!best)break;
          group.push(best);
          for(const [id,count] of Object.entries(best.refund))refund[id]=(refund[id]??0)+count;
        }
        if(suffices(refund))candidates.push({move,donors:group,refund,loss:group.reduce((sum,donor)=>sum+donor.loss,0)});
      }
    }
    if(!candidates.length)break;
    const legal=await checkTrades(candidates.map(({move,donors,refund})=>[
      move.spent+move.points,move.budget,Math.max(0,donors.reduce((sum,donor)=>sum+donor.resetCost,0)-
        move.path.filter(node=>originalNodes.get(move.owner).has(node.id)).length),1,
      ...materials.map(id=>move.materials[id]??0),...materials.map(id=>refund[id]??0),
    ]),[resetBudget,...stock],{unlimited:infinite});
    const ranked=candidates.filter((_,index)=>legal[index]).sort((a,b)=>
      b.move.gain/(1+b.move.points+b.loss/100)-a.move.gain/(1+a.move.points+a.loss/100));
    let best;
    for(const {move,donors} of ranked.slice(0,36)){
      if(best&&move.gain<best.gain)continue;
      const next={...boards,...Object.fromEntries(donors.map(donor=>[donor.owner,donor.next])),[move.owner]:{
        ...move.save,nodes:[...move.save.nodes,...move.path.filter(node=>node.pts).map(node=>node.id)],
      }};
      const nextRow=await score(next);
      const nextScore=scoreValue(nextRow);
      // An earlier limited reward must remain within its original score-loss allowance.
      const allowed=Object.keys({...gains,...move.rewards}).every(id=>targets[id]==null||baseline-nextScore<=targets[id]+1e-6);
      if(!allowed||best&&move.gain===best.gain&&nextScore<=best.score)continue;
      best={next,row:nextRow,score:nextScore,gain:move.gain,rewards:move.rewards};
    }
    if(!best)break;
    commit(best.next);
    boards=best.next;
    row=best.row;
    for(const [id,amount] of Object.entries(best.rewards))gains[id]=(gains[id]??0)+amount;
  }
  return {row,gains};
}
