const emptyBoard={nodes:[],cards:{}};

export const boardProtectionModes=[['flexible','Flexible'],['noResets','No resets'],['locked','Lock Board']];
export const hasBoardProtection=options=>!!options?.preserveConnects||Object.keys(options?.protection??{}).length>0;
export const boardProtection=(options,owner)=>options?.protection?.[owner]??'flexible';
export const pinsBoardConnects=(options,owner)=>!!options?.preserveConnects||boardProtection(options,owner)!=='flexible';

// An empty-Board start can refund unrelated purchases, but must retain a
// route through the existing purchases to every occupied Connect slot.
export function retainedConnectorPaths(boards,nodesFor,dreamRank){
  const routes={};
  for(const [owner,{nodes,cards}] of Object.entries(boards)){
    const slots=Object.keys(cards);
    if(!slots.length)continue;
    const purchased=new Set(nodes);
    const positions=new Map((nodesFor(owner)??[]).filter(node=>
      (node.hide??0)<=dreamRank&&(purchased.has(node.id)||!node.pts&&(node.lock??0)<=dreamRank))
      .map(node=>[`${node.x},${node.y}`,node]));
    const root=positions.get('0,0');
    if(!root)continue;
    const pending=[root],parents=new Map([[root.id,null]]);
    for(const node of pending)for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const next=positions.get(`${node.x+x},${node.y+y}`);
      if(!next||parents.has(next.id))continue;
      parents.set(next.id,node.id);
      pending.push(next);
    }
    if(!slots.every(slot=>parents.has(slot)))continue;
    const retained=new Set();
    for(const slot of slots)for(let step=slot;step!==null&&!retained.has(step);step=parents.get(step))retained.add(step);
    routes[owner]=nodes.filter(id=>retained.has(id));
  }
  return routes;
}

export function boardPlanningBaseline(boards,options){
  if(!options?.ignoreExisting)return boards;
  return Object.fromEntries(Object.entries(boards).flatMap(([owner,board])=>{
    if(boardProtection(options,owner)!=='flexible')return [[owner,board]];
    if(options.preserveConnects&&Object.keys(board.cards).length){
      return [[owner,{...board,nodes:options.connectorPaths?.[owner]??board.nodes}]];
    }
    return [];
  }));
}

export function preservesBoard(options,owner,before=emptyBoard,after=emptyBoard){
  const mode=boardProtection(options,owner);
  if(pinsBoardConnects(options,owner)&&!Object.entries(before.cards).every(([slot,card])=>after.cards[slot]===card))return false;
  if(mode==='flexible')return true;
  if(mode==='locked'&&(before.nodes.length!==after.nodes.length||
    Object.keys(before.cards).length!==Object.keys(after.cards).length))return false;
  const nodes=new Set(after.nodes);
  return before.nodes.every(id=>nodes.has(id));
}

export function preservesBoardProtection(options,before,after){
  if(!hasBoardProtection(options))return true;
  const pinned=new Map();
  const owners=new Set([...Object.keys(options.protection??{}),...(options.preserveConnects?Object.keys(before):[])]);
  for(const owner of owners){
    if(!preservesBoard(options,owner,before[owner],after[owner]))return false;
    for(const [slot,card] of Object.entries(before[owner]?.cards??{}))pinned.set(card,{owner,slot});
  }
  return Object.entries(after).every(([owner,board])=>Object.entries(board.cards).every(([slot,card])=>{
    const assignment=pinned.get(card);
    return !assignment||(assignment.owner===owner&&assignment.slot===slot);
  }));
}
