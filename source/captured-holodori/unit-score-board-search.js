import {evaluateUnitScore,unitScoreContext} from './unit-score-search';

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
  const geometry={dreamRank,byId,root:byPosition.get('0,0'),neighbors:node=>adjacency.get(node)};
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

function affectsTeam(node,owner,order,leader) {
  if(node.songTrigger||!statKinds.has(node.kind)&&!skillKinds.has(node.kind))return false;
  if(node.charTrigger==='WORK'||node.charTrigger==='SET_LIVE_LEADER'&&owner!==leader)return false;
  if(node.targetType==='SKILL_TREE_CHARACTER')return order.some(card=>card.characterId===owner);
  if(node.targetType==='CHARACTER_GROUPING')return order.some(card=>card.groupingIds.includes(node.targetGrouping));
  return node.targetType==='ALL'||order.some(card=>card.characterId===owner);
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
  const changes=new Map(),bought={};
  const ownedConnects=Object.keys(account.owned).filter(id=>account.owned[id]?.owned&&data.connects[id])
    .sort((a,b)=>connectStrength(b)-connectStrength(a));
  function connectStrength(id){
    const card=data.connects[id],entry=account.owned[id];
    const level=card.level2Bloom&&entry.bloom>=card.level2Bloom?1:0;
    return (card.levels[level]?.permil??0)*card.extent.length;
  }
  function affordable(materials) {
    return boardOpt.infiniteMaterials||Object.entries(materials).every(([id,cost])=>
      (bought[id]??0)+cost<=(boardOpt.materials[id]??0));
  }

  // A bounded greedy search evaluates legal moves with the exact Unit Score
  // formula. Short paths can cross a neutral node to reach a useful effect.
  for(let step=0;step<10;step++){
    const candidates=[];
    const assigned=new Set(Object.values(saves).flatMap(board=>Object.values(board.cards)));
    const spareConnects=ownedConnects.filter(id=>!assigned.has(id)).slice(0,3);
    for(const owner of owners){
      const save=saves[owner]??{nodes:[],cards:{}};
      const graph=boardGraph(data.boards[owner],save,account.dreamRank);
      if(save.nodes.some(id=>!graph.byId.has(id)))continue;
      const budget=boardPointsAtRank(data.boardPointLadder,ranks[owner]);
      const spent=sum(save.nodes,id=>graph.byId.get(id).pts);
      const frontier=[],visited=new Set(graph.active);
      for(const id of graph.active){
        const node=graph.byId.get(id);
        if(node.socket&&!save.cards[id]&&graph.neighbors(node).some(other=>
          graph.active.has(other.id)&&affectsTeam(other,owner,order,team.leaderChar))){
          for(const cardId of spareConnects)candidates.push({owner,save,budget,spent,path:[],points:0,materials:{},
            socket:id,cardId,priority:connectStrength(cardId)/20});
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
    candidates.sort((a,b)=>moveValue(b)-moveValue(a));
    let best;
    for(const move of candidates.slice(0,32)){
      const next={nodes:[...move.save.nodes,...move.path.filter(node=>node.pts>0).map(node=>node.id)],
        cards:move.socket?{...move.save.cards,[move.socket]:move.cardId}:move.save.cards};
      const boards={...saves,[move.owner]:next};
      const context=unitScoreContext(data,payload,boards,ranks);
      const result=evaluateUnitScore(context,order,team.outfitId,team.leaderChar);
      if(result.displayUnitScore>(best?.result.displayUnitScore??current.displayUnitScore))best={move,boards,result};
    }
    if(!best)break;
    const {move,boards,result}=best;
    saves=boards;
    current=result;
    for(const [id,amount] of Object.entries(move.materials))bought[id]=(bought[id]??0)+amount;
    const previous=changes.get(move.owner)??{owner:move.owner,buys:[],resets:[],connects:[]};
    changes.set(move.owner,{...previous,buys:[...previous.buys,...move.path.filter(node=>node.pts>0).map(node=>node.id)],
      connects:move.socket?[...previous.connects,{socket:move.socket,cardId:move.cardId}]:previous.connects,
      ptsBudget:move.budget,ptsSpent:move.spent+move.points});
  }
  if(current===team)return team;
  return {...current,plan:{changes:[...changes.values()],resetCount:0,bought,refunded:{},saves,ranks,
    ignoredExisting:boardOpt.ignoreExisting,before:team,after:current,leaderChar:team.leaderChar,outfitId:team.outfitId}};
}
