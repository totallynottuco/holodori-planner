import {boardRootNodeIds,connectedBoardNodeIds,resolveBoardNodes} from '../hololive/vendor/shared/account-data';

export type SavedBoard = {nodes:string[];cards:Record<string,string>};
export type SavedBoards = Record<string,SavedBoard>;
type BoardChange = {key:string;kind:'buy'|'reset'|'connect';id:string;card?:string};
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
  const old=before??emptyBoard;
  const nodes=new Set(old.nodes),cards={...old.cards};
  const keys=new Set(selected);
  for(const change of changes){
    if(!keys.has(change.key))continue;
    if(change.kind==='buy')nodes.add(change.id);
    if(change.kind==='reset')nodes.delete(change.id);
    if(change.kind==='connect'){
      if(change.card)cards[change.id]=change.card;
      else delete cards[change.id];
    }
  }
  const board={nodes:[...nodes],cards};
  try {
    const points=validateSavedBoard(owner,board);
    return {board,points,error:points>budget?'Selected changes exceed the Board Point budget.':''};
  }catch(error){return {board,points:null,error:(error as Error).message};}
}

export function mergeSavedBoards(imported:SavedBoards,saved:SavedBoards):SavedBoards {
  const assigned=new Set(Object.values(saved).flatMap(board=>Object.values(board.cards)));
  return {...Object.fromEntries(Object.entries(imported).filter(([id])=>!Object.hasOwn(saved,id)).map(([id,board])=>
    [id,{nodes:board.nodes,cards:Object.fromEntries(Object.entries(board.cards).filter(([,card])=>!assigned.has(card)))}])),...saved};
}

export function checkSavedBoardAssignments(boards:SavedBoards) {
  const cards=new Set<string>();
  for(const board of Object.values(boards)){
    for(const card of Object.values(board.cards)){
      if(cards.has(card))throw Error('A Connect card is already assigned. Save both affected Boards together.');
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
