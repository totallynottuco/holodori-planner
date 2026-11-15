const emptyBoard={nodes:[],cards:{}};

export const boardProtectionModes=[['flexible','Flexible'],['noResets','No resets'],['locked','Lock Board']];
export const hasBoardProtection=options=>Object.keys(options?.protection??{}).length>0;
export const boardProtection=(options,owner)=>options?.protection?.[owner]??'flexible';

export function boardPlanningBaseline(boards,options){
  return options?.ignoreExisting
    ? Object.fromEntries(Object.entries(boards).filter(([owner])=>boardProtection(options,owner)!=='flexible'))
    : boards;
}

export function preservesBoard(options,owner,before=emptyBoard,after=emptyBoard){
  const mode=boardProtection(options,owner);
  if(mode==='flexible')return true;
  if(mode==='locked'&&(before.nodes.length!==after.nodes.length||
    Object.keys(before.cards).length!==Object.keys(after.cards).length))return false;
  const nodes=new Set(after.nodes);
  return before.nodes.every(id=>nodes.has(id))&&
    Object.entries(before.cards).every(([slot,card])=>after.cards[slot]===card);
}

export function preservesBoardProtection(options,before,after){
  if(!hasBoardProtection(options))return true;
  const pinned=new Map();
  for(const owner of Object.keys(options.protection)){
    if(!preservesBoard(options,owner,before[owner],after[owner]))return false;
    for(const [slot,card] of Object.entries(before[owner]?.cards??{}))pinned.set(card,{owner,slot});
  }
  return Object.entries(after).every(([owner,board])=>Object.entries(board.cards).every(([slot,card])=>{
    const assignment=pinned.get(card);
    return !assignment||(assignment.owner===owner&&assignment.slot===slot);
  }));
}
