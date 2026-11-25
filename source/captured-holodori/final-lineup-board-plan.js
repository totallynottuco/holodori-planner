import {boardReachability} from './unit-score-board-search';
import {boardProtection, pinsBoardConnects} from './board-protection';

const personalKinds=new Set(['param','sense','technique','performance','paramPermil','sensePermil',
  'techniquePermil','performancePermil','activeEffect','activeChance','activeFreq']);
const personal=node=>node?.targetType==='SKILL_TREE_CHARACTER'&&personalKinds.has(node.kind);
const empty={nodes:[],cards:{}};

// A funded layout can be reused by a different final lineup. Strip only edits
// whose effects cannot apply to that lineup, including free nodes on the path.
export function finalLineupBoardPlan(data,payload,plan,members,leader){
  if(!plan?.changes?.length||!leader||members.includes(undefined))return plan;
  const {account,boardOpt}=payload;
  const saves={...plan.saves},bought={...plan.bought},changes=[];
  const starting=account.boards;
  const used=new Set(Object.values({...starting,...saves}).flatMap(board=>Object.values(board.cards)));
  const originallyUsed=new Set(Object.values(starting).flatMap(board=>Object.values(board.cards)));
  let modified=false;
  for(const change of plan.changes){
    const owner=change.owner,board=saves[owner],original=starting[owner]??empty;
    const topology=data.boards[owner];
    if(!board||!topology||members.includes(owner)||leader===owner||boardProtection(boardOpt,owner)==='locked'){
      changes.push(change);
      continue;
    }
    const nodes=new Map(topology.map(node=>[node.id,node]));
    const state=boardReachability(topology,board,account.dreamRank);
    if(!state){changes.push(change);continue;}
    let purchases=board.nodes,cards=board.cards;
    const removed=new Set(),restored=new Set();
    const activeRelevant=topology.filter(node=>state.active.has(node.id)&&node.kind&&!personal(node));
    for(const {socket} of change.connects){
      const id=cards[socket],old=original.cards[socket],slot=nodes.get(socket);
      // A transfer may be paying for a real gain elsewhere. Only undo an
      // isolated substitution, retaining all multi-board assignment constraints.
      if(!slot||!state.active.has(socket)||id===old||id&&originallyUsed.has(id)||old&&used.has(old)||
        plan.ignoredExisting||pinsBoardConnects(boardOpt,owner))continue;
      const touchesRelevant=[id,old].filter(Boolean).some(card=>{
        const footprint=data.connects[card]?.extent;
        return !footprint||activeRelevant.some(node=>footprint.some(([x,y])=>slot.x+x===node.x&&slot.y+y===node.y));
      });
      if(touchesRelevant)continue;
      cards={...cards};
      if(id)used.delete(id);
      if(old){cards[socket]=old;used.add(old);}else delete cards[socket];
      restored.add(socket);
    }
    let pending=change.buys.filter(id=>personal(nodes.get(id))&&!original.nodes.includes(id));
    while(pending.length){
      const prior=pending;
      pending=[];
      for(const id of prior){
        const next=purchases.filter(nodeId=>nodeId!==id);
        const reach=boardReachability(topology,{nodes:next,cards},account.dreamRank);
        if(!reach||[...next,...Object.keys(cards)].some(key=>!reach.active.has(key))||
          activeRelevant.some(node=>!reach.active.has(node.id))){pending.push(id);continue;}
        removed.add(id);
        purchases=next;
        for(const item of nodes.get(id).items)bought[item.id]-=item.qty;
      }
      if(prior.length===pending.length)break;
    }
    if(!removed.size&&!restored.size){changes.push(change);continue;}
    modified=true;
    saves[owner]={...board,nodes:purchases,cards};
    const buys=change.buys.filter(id=>!removed.has(id));
    const connects=change.connects.filter(edit=>!restored.has(edit.socket));
    if(buys.length||connects.length||change.resets.length)changes.push({...change,buys,connects,
      ptsSpent:purchases.reduce((total,id)=>total+nodes.get(id).pts,0)});
  }
  return modified?{...plan,saves,bought,changes}:plan;
}
