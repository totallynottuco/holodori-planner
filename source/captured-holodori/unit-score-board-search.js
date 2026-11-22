import {evaluateUnitScore,unitScoreContext} from './unit-score-search';
import {referenceBoardTargetMatches} from './reference-rating-math';
import {boardChanges} from './saved-boards';

const directions=[[1,0],[-1,0],[0,1],[0,-1]];
const statKinds=new Set(['param','performance','technique','sense','paramPermil','performancePermil',
  'techniquePermil','sensePermil','paramGroup']);
const skillKinds=new Set(['activeEffect','activeChance','activeFreq']);
const position=(x,y)=>x+','+y;
const sum=(rows,value)=>rows.reduce((total,row)=>total+value(row),0);
const boardGeometry=new WeakMap();

function geometryFor(nodes,dreamRank) {
  const previous=boardGeometry.get(nodes);
  if(previous&&previous.dreamRank===dreamRank)return previous;
  const visible=nodes.filter(node=>node.hide==null||node.hide<=dreamRank);
  const byId=new Map(visible.map(node=>[node.id,node]));
  const byPosition=new Map(visible.map(node=>[position(node.x,node.y),node]));
  const adjacency=new Map(visible.map(node=>[node,directions.map(([x,y])=>
    byPosition.get(position(node.x+x,node.y+y))).filter(Boolean)]));
  const geometry={dreamRank,byId,byPosition,root:byPosition.get('0,0'),neighbors:node=>adjacency.get(node)};
  boardGeometry.set(nodes,geometry);
  return geometry;
}

function walkBoard({root,neighbors},purchased,dreamRank) {
  const unlocked=node=>purchased.has(node.id)||node.pts===0&&(node.lock==null||node.lock<=dreamRank);
  const active=new Set(),queue=[];
  if(root&&unlocked(root)){active.add(root.id);queue.push(root);}
  for(const node of queue)for(const next of neighbors(node)){
    if(!active.has(next.id)&&unlocked(next)){active.add(next.id);queue.push(next);}
  }
  return {active,queue};
}

function boardGraph(nodes,save,dreamRank) {
  const geometry=geometryFor(nodes,dreamRank);
  return {...geometry,...walkBoard(geometry,new Set(save.nodes),dreamRank)};
}

function boardState(nodes,save,dreamRank) {
  const geometry=geometryFor(nodes,dreamRank);
  const purchased=new Set();
  let spent=0;
  for(const id of save.nodes){
    const node=geometry.byId.get(id);
    if(!node)return null;
    purchased.add(id);
    spent+=node.pts;
  }
  return {...walkBoard(geometry,purchased,dreamRank),spent,neighbors:geometry.neighbors};
}

export function boardReachability(nodes,save,dreamRank) {
  const state=boardState(nodes,save,dreamRank);
  return state?{active:state.active,spent:state.spent}:null;
}

// Find all cuts in one pass over the purchased graph. A DFS child is
// severed only when its subtree has no route above the removed node.
export function boardResetCuts(nodes,save,dreamRank){
  const {root,byId,neighbors}=geometryFor(nodes,dreamRank);
  const purchased=new Set(save.nodes);
  if(save.nodes.some(id=>!byId.has(id)))return null;
  const free=node=>node.pts===0&&(node.lock==null||node.lock<=dreamRank);
  const unlocked=node=>purchased.has(node.id)||free(node);
  const visited=new Map();
  function walk(node,parent){
    const enter=visited.size;
    const record={node,parent,enter,low:enter,ancestor:null};
    visited.set(node,record);
    for(const next of neighbors(node)){
      if(next===parent?.node||!unlocked(next))continue;
      const seen=visited.get(next);
      record.low=Math.min(record.low,seen?seen.enter:walk(next,record));
    }
    return record.low;
  }
  if(root&&unlocked(root))walk(root,null);
  const cuts=new Map(save.nodes.map(id=>[id,[]]));
  for(const record of visited.values()){
    const {parent,low}=record;
    if(!parent)continue;
    const separates=low>=parent.enter&&purchased.has(parent.node.id)&&!free(parent.node);
    record.ancestor=separates?parent:parent.ancestor;
  }
  // Emit only affected pairs, in saved order, including any nodes that
  // were unreachable before the reset. Free connectors cannot be cut.
  for(const id of save.nodes){
    const record=visited.get(byId.get(id));
    if(!record){
      for(const removed of cuts.values())removed.push(id);
      continue;
    }
    if(!free(record.node))cuts.get(id).push(id);
    for(let cut=record.ancestor;cut;cut=cut.ancestor)cuts.get(cut.node.id).push(id);
  }
  return cuts;
}

function affectsTeam(node,owner,order,leader) {
  if(node.songTrigger||!statKinds.has(node.kind)&&!skillKinds.has(node.kind))return false;
  if(node.charTrigger==='WORK'||node.charTrigger==='SET_LIVE_LEADER'&&owner!==leader)return false;
  if(node.kind==='paramGroup')return order.some(card=>card.groupingIds.includes(node.targetGrouping));
  return order.some(card=>referenceBoardTargetMatches(node,owner,card));
}

export function boardPointsAtRank(ladder,rank) {
  return sum(ladder.slice(1,Math.max(1,rank)+1),value=>value);
}

// Return legal frontier paths without scoring them. The GPU planner and
// existing Unit Score planner share the same topology interpretation.
export function boardFrontierPaths(nodes,save,dreamRank,branches,maxDepth=3){
  const state=boardState(nodes,save,dreamRank);
  if(!state)return null;
  const {queue:connected,active,spent,neighbors}=state;
  const paths=[],sockets=[],seen=new Set(active),queue=[];
  function expand(node,previous){
    if(seen.has(node.id)||node.lock!=null&&node.lock>dreamRank||node.branch&&!branches.has(node.branch))return;
    seen.add(node.id);
    queue.push(previous?[...previous,node]:[node]);
  }
  for(const node of connected){
    if(node.socket&&!save.cards[node.id])sockets.push(node);
    for(const next of neighbors(node))expand(next);
  }
  for(const path of queue){
    paths.push({path,...pathCosts(path)});
    if(path.length<maxDepth)for(const next of neighbors(path.at(-1)))expand(next,path);
  }
  return {paths,sockets,active,spent};
}

function pathCosts(path) {
  const materials={};
  for(const node of path)for(const item of node.items)materials[item.id]=(materials[item.id]??0)+item.qty;
  return {points:sum(path,node=>node.pts),materials};
}

function moveValue(move) {
  return move.priority/(1+move.points+sum(Object.values(move.materials),value=>value)/20);
}

export function improveUnitScoreBoards(data,payload,team) {
  const {account,boardOpt}=payload;
  if(!boardOpt)return team;
  const order=team.order.map(id=>data.cards.find(card=>card.id===id));
  if(order.some(card=>!card))return team;
  const ranks={...account.ranks};
  if(boardOpt.allInvited)for(const id of Object.keys(data.boards))ranks[id]??=1;
  if(boardOpt.maxBoardPoints)for(const id of Object.keys(ranks))ranks[id]=data.boardPointLadder.length-1;
  const allowed=new Set(boardOpt.branches);
  const owners=Object.keys(ranks).filter(id=>data.boards[id]);
  let saves=boardOpt.ignoreExisting?{}:account.boards;
  let current=team;
  const starting=saves,bought={};
  const connectRoster={...payload.options.boardConnectEntries,...account.owned};
  const ownedConnects=Object.keys(connectRoster).filter(id=>connectRoster[id]?.owned&&data.connects[id]);
  function affordable(materials) {
    return boardOpt.infiniteMaterials||Object.entries(materials).every(([id,cost])=>
      (bought[id]??0)+cost<=(boardOpt.materials[id]??0));
  }

  // A bounded greedy search evaluates legal moves with the exact Unit Score
  // formula. Short paths can cross a neutral node to reach a useful effect.
  for(let step=0;step<10;step++){
    const candidates=[];
    const placed=new Map(Object.entries(saves).flatMap(([owner,board])=>
      Object.entries(board.cards).map(([socket,id])=>[id,{owner,socket}])));
    for(const owner of owners){
      const save=saves[owner]??{nodes:[],cards:{}};
      const graph=boardGraph(data.boards[owner],save,account.dreamRank);
      if(save.nodes.some(id=>!graph.byId.has(id)))continue;
      const budget=boardPointsAtRank(data.boardPointLadder,ranks[owner]);
      const spent=sum(save.nodes,id=>graph.byId.get(id).pts);
      const frontier=[],visited=new Set(graph.active);
      for(const id of graph.active){
        const node=graph.byId.get(id);
        if(node.socket){
          const seen=new Set();
          for(const cardId of ownedConnects){
            if(cardId===save.cards[id])continue;
            const prior=placed.get(cardId);
            if(prior&&!Object.hasOwn(ranks,prior.owner))continue;
            const card=data.connects[cardId];
            const affected=card.extent.map(([x,y])=>graph.byPosition.get(position(node.x+x,node.y+y)))
              .filter(other=>other&&graph.active.has(other.id)&&affectsTeam(other,owner,order,team.leaderChar));
            if(!affected.length)continue;
            const strength=card.levels[card.level2Bloom&&connectRoster[cardId].bloom>=card.level2Bloom?1:0]?.permil??0;
            const key=prior?cardId:strength+':'+affected.map(other=>other.id).sort().join(',');
            if(!strength||seen.has(key))continue;
            seen.add(key);
            candidates.push({owner,save,budget,spent,path:[],points:0,materials:{},socket:id,cardId,prior,
              priority:strength*sum(affected,other=>other.value*(skillKinds.has(other.kind)?8:1))/1000});
          }
        }
        for(const next of graph.neighbors(node))if(!visited.has(next.id))frontier.push([next]);
      }
      for(const path of frontier){
        const node=path.at(-1);
        if(visited.has(node.id)||node.lock!=null&&node.lock>account.dreamRank||
          node.branch&&!allowed.has(node.branch))continue;
        const costs=pathCosts(path);
        if(spent+costs.points>budget||!affordable(costs.materials))continue;
        visited.add(node.id);
        if(affectsTeam(node,owner,order,team.leaderChar)){
          const priority=sum(path,item=>affectsTeam(item,owner,order,team.leaderChar)
            ? item.value*(skillKinds.has(item.kind)?8:item.kind.endsWith('Permil')?12:1):0);
          candidates.push({owner,save,budget,spent,path,...costs,priority});
        }
        if(path.length<3)for(const next of graph.neighbors(node))if(!visited.has(next.id))frontier.push([...path,next]);
      }
    }
    candidates.sort((a,b)=>moveValue(b)-moveValue(a)||Number(!!a.prior)-Number(!!b.prior));
    let best;
    for(const move of candidates.slice(0,32)){
      const next={nodes:[...move.save.nodes,...move.path.filter(node=>node.pts>0).map(node=>node.id)],
        cards:move.socket?{...move.save.cards,[move.socket]:move.cardId}:move.save.cards};
      const boards={...saves,[move.owner]:next};
      if(move.prior){
        const {owner,socket}=move.prior,source=boards[owner];
        const cards={...source.cards},displaced=move.save.cards[move.socket];
        if(displaced)cards[socket]=displaced;
        else delete cards[socket];
        boards[owner]={...source,cards};
      }
      const context=unitScoreContext(data,payload,boards,ranks);
      const result=evaluateUnitScore(context,order,team.outfitId,team.leaderChar);
      if(result.displayUnitScore>(best?.result.displayUnitScore??current.displayUnitScore))best={move,boards,result};
    }
    if(!best)break;
    const {move,boards,result}=best;
    saves=boards;
    current=result;
    for(const [id,amount] of Object.entries(move.materials))bought[id]=(bought[id]??0)+amount;
  }
  if(current===team)return team;
  const changes=Object.entries(saves).flatMap(([owner,board])=>{
    if(board===starting[owner])return [];
    const edits=boardChanges(starting[owner],board);
    return edits.length?[{owner,buys:edits.filter(e=>e.kind==='buy').map(e=>e.id),resets:[],
      connects:edits.filter(e=>e.kind==='connect').map(e=>({socket:e.id,cardId:e.card??null})),
      ptsBudget:boardPointsAtRank(data.boardPointLadder,ranks[owner]),
      ptsSpent:boardReachability(data.boards[owner],board,account.dreamRank).spent}]:[];
  });
  return {...current,plan:{changes,resetCount:0,bought,refunded:{},saves,ranks,
    ignoredExisting:boardOpt.ignoreExisting,before:team,after:current,leaderChar:team.leaderChar,outfitId:team.outfitId}};
}
