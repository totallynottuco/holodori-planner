import {boardFrontierPaths,boardReachability} from './unit-score-board-search';

const sumCost=(a,b)=>a.map((value,index)=>value+b[index]);
const compare=(a,b)=>a.value-b.value||(a.tieScore??a.score)-(b.tieScore??b.score);
const amount=(materials,values)=>materials.map(id=>values[id]??0);

export async function refineBoardExchanges({boards,owners,topology,allowed,dreamRank,budgets,order,leader,
  materials,stock,maxResets,resetCount,original,protectedNode,rankLayouts,checkTrades,score,includeSong,infinite=false}){
  const members=new Set(order.map(card=>card.characterId));
  const branches=new Set(includeSong?['blue','green','yellow','red']:['blue','green']);
  const targets=node=>order.some(card=>node.targetType==='ALL'||
    node.targetType==='ATTRIBUTE'&&card.attribute===node.targetAttr||
    node.targetType==='CHARACTER_GROUPING'&&card.groupingIds.includes(node.targetGrouping)||
    node.targetType==='CHARACTER'&&card.characterId===node.targetCharacter);
  const useful=(node,owner)=>node.kind==='songBonus'?!!includeSong?.(node,owner):
    node.kind&&node.charTrigger!=='WORK'&&
    (node.charTrigger!=='SET_LIVE_LEADER'||owner===leader)&&
    (targets(node)||members.has(owner)&&node.targetType==='SKILL_TREE_CHARACTER');
  const indices=new Map(owners.map(owner=>[owner,new Map(topology[owner].map(node=>[node.id,node]))]));
  const frontier=(owner,layout,depth=8)=>boardFrontierPaths(topology[owner],layout,dreamRank,allowed,depth);
  const offsets=new Map(materials.map((id,index)=>[id,index]));
  let uses=Array.isArray(stock)?stock:amount(materials,stock);
  let remaining=maxResets<0?0xffffffff:maxResets-resetCount;
  let current=score(boards);
  const baseline=boards;
  const cached=new WeakMap();
  function variant(owner,board,removed,added,est,receiver,key){
    const byId=indices.get(owner),owned=original.get(owner);
    const delta=materials.map(()=>0);
    let resets=0;
    for(const [ids,sign] of [[added,1],[removed,-1]])for(const id of ids){
      if(owned.has(id))resets-=sign;
      for(const {id:item,qty} of byId.get(id).items){
        const index=offsets.get(item);
        if(index===undefined)return null;
        delta[index]+=sign*qty;
      }
    }
    return {owner,board,delta,resets,est,receiver,key};
  }
  function nodeWeight(node,owner){
    if(!useful(node,owner))return 0;
    if(node.kind==='songBonus')return 24*node.value;
    if(node.kind==='activeChance')return 10*node.value;
    if(node.kind==='activeFreq')return 12*node.value;
    if(node.kind==='activeEffect')return 4*node.value;
    const count=node.targetType==='ALL'?order.length:
      node.targetType==='CHARACTER_GROUPING'?order.filter(card=>card.groupingIds.includes(node.targetGrouping)).length:1;
    return count*node.value*(node.kind.endsWith('Permil')?4:node.kind==='param'||node.kind==='paramGroup'?0.3:0.1);
  }
  function layoutVariants(owner,board){
    if(cached.has(board))return cached.get(board);
    const byId=indices.get(owner),pointCap=budgets.get(owner),out=[];
    const preserve=new Set(board.nodes.filter(id=>{
      const node=byId.get(id);
      return Object.hasOwn(board.cards,id)||protectedNode(node)||
        node.branch&&!allowed.has(node.branch);
    }));
    const graph=frontier(owner,board);
    if(!graph||board.nodes.some(id=>!graph.active.has(id)))return out;
    const signatures=new Set();
    const weights=new Map(topology[owner].map(node=>[node.id,nodeWeight(node,owner)]));
    const addPaths=(parent,from,removed,loss,limit)=>{
      const proposal=[];
      for(const move of from.paths){
        if(from.spent+move.points>pointCap||
          !move.path.some(node=>branches.has(node.branch)&&useful(node,owner)))continue;
        const est=move.path.reduce((sum,node)=>sum+weights.get(node.id),0)-loss;
        const added=move.path.filter(node=>node.pts>0).map(node=>node.id);
        const nodes=[...parent.nodes,...added];
        const signature=nodes.slice().sort().join(',');
        if(signatures.has(signature))continue;
        signatures.add(signature);
        const released=removed.filter(id=>!added.includes(id));
        const acquired=added.filter(id=>!removed.includes(id));
        const row=variant(owner,{...parent,nodes},released,acquired,est,move.path.at(-1).id,signature);
        if(row)proposal.push(row);
      }
      proposal.sort((a,b)=>b.est-a.est);
      const blue=proposal.filter(row=>byId.get(row.receiver).branch==='blue');
      const green=proposal.filter(row=>byId.get(row.receiver).branch==='green');
      const timing=blue.filter(row=>byId.get(row.receiver).kind==='activeFreq');
      const others=includeSong?proposal.filter(row=>!['blue','green'].includes(byId.get(row.receiver).branch)):[];
      out.push(...new Set([...blue.slice(0,limit),...green.slice(0,limit),...timing.slice(0,2),...others.slice(0,limit)]));
    };
    addPaths(board,graph,[],0,12);
    const cuts=new Set();
    for(const id of board.nodes){
      if(preserve.has(id)||!branches.has(byId.get(id).branch))continue;
      if(!members.has(owner)&&byId.get(id).branch!=='green'&&
        (!includeSong||byId.get(id).branch!=='yellow'&&owner!==leader))continue;
      const pruned={...board,nodes:board.nodes.filter(other=>other!==id)};
      const direct=boardReachability(topology[owner],pruned,dreamRank);
      if(!direct||[...preserve].some(other=>!direct.active.has(other)))continue;
      const removed=board.nodes.filter(other=>!direct.active.has(other));
      const key=removed.slice().sort().join('|');
      if(!removed.length||cuts.has(key))continue;
      cuts.add(key);
      const clean={...board,nodes:board.nodes.filter(other=>direct.active.has(other))};
      const loss=removed.reduce((sum,other)=>sum+weights.get(other),0);
      const cut=variant(owner,clean,removed,[],-loss,null,clean.nodes.slice().sort().join(','));
      if(cut)out.push(cut);
      if(members.has(owner)||owner===leader||graph.spent+2>pointCap)addPaths(clean,frontier(owner,clean),removed,loss,3);
    }
    cached.set(board,out);
    return out;
  }
  for(let step=0;step<6;step++){
    const rows=owners.flatMap(owner=>boards[owner]?layoutVariants(owner,boards[owner]):[]);
    const cuts=rows.filter(row=>!row.receiver);
    const recipients=rows.filter(row=>row.receiver);
    const permitted=delta=>infinite||delta.every((cost,index)=>cost<=uses[index]);
    const single=recipients.filter(row=>permitted(row.delta)&&row.resets<=remaining);
    const candidates=[],seen=new Set();
    const remember=(edits,delta,resets)=>{
      const key=edits.map(({owner,key})=>owner+':'+key).sort().join('|');
      if(seen.has(key))return;
      seen.add(key);
      candidates.push({delta,resets,boards:{...boards,...Object.fromEntries(edits.map(({owner,board})=>[owner,board]))}});
    };
    function diversify(pool,limit){
      pool.sort((a,b)=>b.est-a.est);
      const groups=new Map();
      for(const row of pool){
        const key=row.owner+':'+row.receiver;
        const group=groups.get(key)??[];
        if(group.length<2)group.push(row);
        groups.set(key,group);
      }
      return [...groups.values()].flat().slice(0,limit);
    }
    const direct=single.filter(row=>members.has(row.owner));
    const global=single.filter(row=>!members.has(row.owner));
    for(const row of [...diversify(direct,95),...diversify(global,35)])
      remember([row],row.delta,row.resets);
    const underfunded=recipients.filter(row=>!permitted(row.delta)&&row.resets<=remaining);
    for(const row of diversify(underfunded,34)){
      const donations=[];
      for(const donor of cuts){
        if(donor.owner===row.owner)continue;
        const delta=sumCost(donor.delta,row.delta),resets=donor.resets+row.resets;
        if(resets<=remaining&&permitted(delta))donations.push({donor,delta,resets,est:donor.est+row.est});
      }
      donations.sort((a,b)=>b.est-a.est);
      for(const {donor,delta,resets} of donations.slice(0,4))remember([row,donor],delta,resets);
    }
    const swaps=direct.filter(row=>row.delta.some(qty=>qty<0));
    for(const row of diversify(swaps,8)){
      const neighbors=swaps.filter(other=>other.owner!==row.owner&&other.receiver!==row.receiver);
      for(const other of diversify(neighbors,3)){
        const delta=sumCost(row.delta,other.delta),resets=row.resets+other.resets;
        if(permitted(delta)&&resets<=remaining)remember([row,other],delta,resets);
      }
    }
    for(const row of cuts.filter(row=>members.has(row.owner)&&row.resets<=remaining)
      .sort((a,b)=>b.est-a.est).slice(0,14))remember([row],row.delta,row.resets);
    if(!candidates.length)break;
    const checks=await checkTrades(candidates.map(({delta,resets})=>[0,0,Math.max(0,resets),1,
      ...delta.map(n=>Math.max(0,n)),...delta.map(n=>Math.max(0,-n))]),
    [remaining,...uses.map(count=>Math.min(count,0xffffffff))],{unlimited:infinite});
    const layouts=candidates.filter((_,index)=>checks[index]);
    const ranked=await rankLayouts(layouts,undefined,12);
    let best;
    for(const layout of ranked){
      const row=score(layout.boards);
      if(compare(row,best?.row??current)>0)best={layout,row};
    }
    if(!best)break;
    boards=best.layout.boards;
    current=best.row;
    uses=uses.map((stock,index)=>stock-best.layout.delta[index]);
    if(maxResets>=0)remaining-=best.layout.resets;
  }
  return boards===baseline?null:{boards,row:current};
}
