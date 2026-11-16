import {boardRootNodeIds,connectedBoardNodeIds,resolveBoardNodes} from '../hololive/vendor/shared/account-data';

export type SavedBoard = {nodes:string[];cards:Record<string,string>};
export type SavedBoards = Record<string,SavedBoard>;
type BoardChange = {key:string;kind:'buy'|'reset'|'connect';id:string;card?:string;recommended?:true};
type ConnectLocation = {owner:string;slot:string};
const emptyBoard:SavedBoard={nodes:[],cards:{}};

export function boardChanges(before:SavedBoard|undefined,after:SavedBoard|undefined):BoardChange[] {
  const old=before??emptyBoard,next=after??emptyBoard;
  const oldNodes=new Set(old.nodes),newNodes=new Set(next.nodes);
  return [
    ...next.nodes.filter(id=>!oldNodes.has(id)).map(id=>({key:'buy:'+id,kind:'buy' as const,id})),
    ...old.nodes.filter(id=>!newNodes.has(id)).map(id=>({key:'reset:'+id,kind:'reset' as const,id})),
    ...[...new Set([...Object.keys(old.cards),...Object.keys(next.cards)])]
      .filter(id=>(old.cards[id]||undefined)!==(next.cards[id]||undefined))
      .map(id=>({key:'connect:'+id,kind:'connect' as const,id,card:next.cards[id]||undefined})),
  ];
}

export function boardConnectLocations(boards:SavedBoards):Map<string,ConnectLocation> {
  const locations=new Map<string,ConnectLocation>();
  for(const [owner,board] of Object.entries(boards)){
    for(const [slot,card] of Object.entries(board.cards))locations.set(card,{owner,slot});
  }
  return locations;
}

export function remainingBoardChanges(original:SavedBoard|undefined,optimized:SavedBoard,
  saved:SavedBoard|undefined,connectOverrides?:Record<string,string|null>):BoardChange[] {
  const changes=boardChanges(original,optimized);
  if(saved)for(const [id,card] of Object.entries(optimized.cards)){
    if(original?.cards[id]===card&&saved.cards[id]!==card){
      changes.push({key:'connect:'+id,kind:'connect',id,card,recommended:true});
    }
  }
  for(const [id,card] of Object.entries(connectOverrides??{})){
    const key='connect:'+id;
    const index=changes.findIndex(change=>change.key===key);
    const change={key,kind:'connect' as const,id,card:card??undefined};
    if(index<0)changes.push(change);else changes[index]=change;
  }
  const current=saved??original??emptyBoard;
  const nodes=new Set(current.nodes);
  return changes.filter(change=>change.kind==='connect'
    ?(current.cards[change.id]||undefined)!==change.card
    :nodes.has(change.id)===(change.kind==='reset'));
}

export function validateSavedBoard(owner:string,board:SavedBoard) {
  const nodes=resolveBoardNodes(owner);
  const byId=new Map(nodes.map(node=>[node.groupId,node]));
  const purchased=new Set(board.nodes),root=boardRootNodeIds(nodes);
  if(!nodes.length||[...purchased].some(id=>!byId.has(id)))
    throw Error('This Board contains nodes unavailable in the local catalog.');
  const active=connectedBoardNodeIds(nodes,purchased);
  if([...purchased].some(id=>!active.has(id)))
    throw Error('Select the connecting unlocks or resets so every node has a path to the center.');
  for(const id of Object.keys(board.cards)){
    if(!active.has(id)||byId.get(id)?.type!=='connect')
      throw Error('Unlock the Connect slot or select its card removal before saving.');
  }
  return [...purchased].filter(id=>!root.has(id)).reduce((sum,id)=>sum+byId.get(id)!.boardPointCost,0);
}

export function projectBoardSelection(owner:string,before:SavedBoard|undefined,changes:BoardChange[],selected:string[],budget:number) {
  const board=applyBoardChanges(before,changes,new Set(selected));
  try {
    const points=validateSavedBoard(owner,board);
    return {board,points,error:points>budget?'Selected changes exceed the Board Point budget.':''};
  }catch(error){return {board,points:null,error:(error as Error).message};}
}

function applyBoardChanges(before:SavedBoard|undefined,changes:BoardChange[],keys?:Set<string>):SavedBoard {
  const old=before??emptyBoard;
  const nodes=new Set(old.nodes),cards={...old.cards};
  for(const change of changes){
    if(keys&&!keys.has(change.key))continue;
    if(change.kind==='buy')nodes.add(change.id);
    if(change.kind==='reset')nodes.delete(change.id);
    if(change.kind==='connect'){
      if(change.card)cards[change.id]=change.card;
      else delete cards[change.id];
    }
  }
  return {nodes:[...nodes],cards};
}

type BoardResolution='game'|'saved';
type BoardConflict={owner:string;slots:string[];cards:string[];layout:boolean;missingBaseline:boolean;game:SavedBoard;saved:SavedBoard};

export function reconcileProtectedBoards(previous:SavedBoards,observed:SavedBoards,saved:SavedBoards,
  protection:Record<string,string>,choices:Record<string,BoardResolution>={}){
  const boards={...saved};
  const conflicts=new Map<string,BoardConflict>();
  const drafts=new Set<string>();
  let completed=0,pending=0,unobserved=0;
  const conflict=(owner:string)=>{
    if(!conflicts.has(owner))conflicts.set(owner,{owner,slots:[],cards:[],layout:false,missingBaseline:false,
      game:observed[owner],saved:saved[owner]});
    return conflicts.get(owner)!;
  };
  for(const [owner,target] of Object.entries(saved)){
    if(!Object.hasOwn(protection,owner))continue;
    const game=observed[owner],base=previous[owner];
    if(!game){unobserved++;continue;}
    drafts.add(owner);
    if(!boardChanges(game,target).length){
      completed+=boardChanges(base,target).length;
      delete boards[owner];
      continue;
    }
    if(!base){conflict(owner).missingBaseline=true;continue;}
    const changes=boardChanges(base,target),gameNodes=new Set(game.nodes),remaining=[];
    for(const change of changes){
      const {id,kind,card}=change;
      const done=kind==='connect'?game.cards[id]===card:gameNodes.has(id)===(kind==='buy');
      if(done){completed++;continue;}
      remaining.push(change);
      if(kind==='connect'&&game.cards[id]!==base.cards[id])conflict(owner).slots.push(id);
    }
    const merged=applyBoardChanges(game,remaining);
    if(boardChanges(game,merged).length){
      boards[owner]=merged;
      try{validateSavedBoard(owner,merged);}catch{conflict(owner).layout=true;}
    }else delete boards[owner];
  }
  const placements=(all:SavedBoards)=>{
    const byCard=new Map<string,{owner:string;slot:string}[]>();
    for(const [owner,board] of Object.entries(all))for(const [slot,card] of Object.entries(board.cards)){
      const group=byCard.get(card)??[];
      group.push({owner,slot});
      byCard.set(card,group);
    }
    return byCard;
  };
  const observedCards=new Set(Object.values(observed).flatMap(board=>Object.values(board.cards)));
  const retained=Object.fromEntries(Object.entries(previous).filter(([owner])=>!Object.hasOwn(observed,owner))
    .map(([owner,board])=>[owner,{nodes:board.nodes,cards:Object.fromEntries(Object.entries(board.cards)
      .filter(([,card])=>!observedCards.has(card)))}]));
  const imported={...retained,...observed};
  for(const [card,group] of placements({...imported,...boards})){
    if(group.length<2)continue;
    for(const {owner} of group)if(drafts.has(owner))conflict(owner).cards.push(card);
  }
  let error='';
  for(const [owner,review] of conflicts){
    const choice=choices[owner];
    if(!choice)continue;
    const {game,saved:target}=review;
    const source=choice==='game'?game:target;
    let next=source;
    if(!review.layout&&!review.missingBaseline){
      const merged=boards[owner]??game;
      const cards={...merged.cards};
      const slots=new Set([...review.slots,...Object.keys({...game.cards,...target.cards}).filter(slot=>
        review.cards.includes(game.cards[slot])||review.cards.includes(target.cards[slot]))]);
      for(const slot of slots){
        if(source.cards[slot])cards[slot]=source.cards[slot];else delete cards[slot];
      }
      next={...merged,cards};
    }
    if(!boardChanges(game,next).length){delete boards[owner];continue;}
    boards[owner]=next;
    try{validateSavedBoard(owner,next);}
    catch(cause){error=(cause as Error).message;}
  }
  const effective={...imported,...boards};
  for(const [card,group] of placements(effective)){
    if(group.length<2)continue;
    const affected=group.filter(({owner})=>drafts.has(owner));
    if(!affected.length)continue;
    const chosen=affected.filter(({owner,slot})=>conflicts.has(owner)&&(
      choices[owner]==='game'&&observed[owner]?.cards[slot]===card||
      choices[owner]==='saved'&&saved[owner]?.cards[slot]===card));
    if(chosen.length!==1){
      for(const {owner} of affected)if(!conflict(owner).cards.includes(card))conflict(owner).cards.push(card);
      if(affected.every(({owner})=>choices[owner]))error='Two Boards still claim the same Connect card. Change one of the choices.';
      continue;
    }
    // Delay cross-Board changes until every affected member has a choice.
    if(affected.some(({owner})=>conflicts.has(owner)&&!choices[owner]))continue;
    for(const {owner,slot} of group){
      if(chosen[0].owner===owner&&chosen[0].slot===slot)continue;
      const {cards,nodes}=effective[owner];
      const next={nodes,cards:{...cards}};
      delete next.cards[slot];
      effective[owner]=next;
      if(boardChanges(imported[owner],next).length)boards[owner]=next;else delete boards[owner];
    }
  }
  for(const owner of drafts)if(boards[owner])pending+=boardChanges(observed[owner],boards[owner]).length;
  return {boards,retained,conflicts:[...conflicts.values()],completed,pending,unobserved,error};
}

export function mergeSavedBoards(imported:SavedBoards,saved:SavedBoards):SavedBoards {
  const assigned=new Set(Object.values(saved).flatMap(board=>Object.values(board.cards)));
  return {...Object.fromEntries(Object.entries(imported).filter(([id])=>!Object.hasOwn(saved,id)).map(([id,board])=>
    [id,{nodes:board.nodes,cards:Object.fromEntries(Object.entries(board.cards).filter(([,card])=>!assigned.has(card)))}])),...saved};
}

export function boardPlanUpdates(current:SavedBoards,requested:SavedBoards,expected=current):SavedBoards {
  const assignments=new Map<string,{owner:string;slot:string}>();
  for(const [owner,board] of Object.entries(requested)){
    for(const [slot,card] of Object.entries(board.cards)){
      if(expected[owner]?.cards[slot]===card)continue;
      if(assignments.has(card))throw Error('Choose one Connect slot for this card before saving.');
      assignments.set(card,{owner,slot});
    }
  }
  const updates={...requested};
  for(const [owner,board] of Object.entries({...current,...requested})){
    const movesAway=([slot,card]:[string,string])=>{
      const target=assignments.get(card);
      return target&&(owner!==target.owner||slot!==target.slot);
    };
    const cards=Object.entries(board.cards);
    const remaining=cards.filter(entry=>!movesAway(entry));
    if(remaining.length!==cards.length)updates[owner]={...board,cards:Object.fromEntries(remaining)};
    // Include the source on a retry after a write failed but the local move was already applied.
    else if(Object.entries(expected[owner]?.cards??{}).some(entry=>movesAway(entry)))updates[owner]=board;
  }
  return updates;
}

export function protectedSavedBoards(imported:SavedBoards,saved:SavedBoards,protection:Record<string,string>) {
  const plans:SavedBoards={};
  for(const [owner,board] of Object.entries(saved)){
    if(!Object.hasOwn(protection,owner))continue;
    plans[owner]=board;
  }
  if(!Object.keys(plans).length)return {boards:imported,plans};
  const boards=mergeSavedBoards(imported,plans);
  // A saved plan can move a Connect card from a flexible Board. When both
  // Boards are protected, keep the conflict visible instead of clearing a pin.
  for(const owner of Object.keys(protection)){
    if(!Object.hasOwn(plans,owner)&&imported[owner])boards[owner]=imported[owner];
  }
  checkSavedBoardAssignments(boards);
  return {boards,plans};
}

export function checkSavedBoardAssignments(boards:SavedBoards) {
  const cards=new Set<string>();
  for(const board of Object.values(boards)){
    for(const card of Object.values(board.cards)){
      if(cards.has(card))throw Error('A Connect card can only occupy one slot.');
      cards.add(card);
    }
  }
}

export function boardTable(boards:SavedBoards) {
  return Object.entries(boards).map(([characterId,board])=>({
    characterId,releasedSkillTreeNodeGroupIds:board.nodes,
    connectedSkillTreeNodeGroupIds:Object.keys(board.cards),connectedSkillTreeNodeCardIds:Object.values(board.cards),
  }));
}
