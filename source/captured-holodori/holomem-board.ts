import {
  accountCharactersById, boardConnectAffectedNodeIds, boardPointsForMemberLevel, boardRootNodeIds, boardTopology,
  resolveBoardConnectEffect, resolveBoardNodes, shortestBoardActivationPath,
  type ResolvedBoardNode,
} from '../hololive/vendor/shared/account-data';
import type { GameAccountCardSource, GameAccountSnapshot, ResourceKey } from '../hololive/vendor/shared/types';
import { characters, cardImage } from './game';
import type {SavedBoard,SavedBoards} from './saved-boards';
import {observedDreamRank} from './current-account';

function connectEffect(card: Pick<GameAccountCardSource,'cardId'|'potentialUpgradeCount'>) {
  try { return resolveBoardConnectEffect(card.cardId, card.potentialUpgradeCount); }
  catch { return null; }
}

export function connectCard(card: Pick<GameAccountCardSource,'cardId'|'potentialUpgradeCount'> & Partial<GameAccountCardSource> | undefined, cardId: string) {
  const catalog = characters[cardId];
  return {
    id: cardId,
    name: card?.cardName || catalog?.cardName || cardId,
    member: card?.memberName || catalog?.memberName || '',
    rarity: card?.rarity ?? catalog?.tier,
    bloom: card?.potentialUpgradeCount ?? null,
    art: cardImage(cardId, 'landscape'),
    thumbnail: cardImage(cardId, 'grid'),
    effect: card ? connectEffect(card) : null,
  };
}

type BoardInput={layout:SavedBoard;rank:number;available:number;dreamRank:number;cards:GameAccountCardSource[]};
export function projectHolomemBoard(snapshot: GameAccountSnapshot|undefined, characterId: string, input?:BoardInput) {
  const character = accountCharactersById.get(characterId);
  const imported = snapshot?.tables.boards?.find(row => row.characterId === characterId);
  if (!character || !input&&!imported) return null;
  const nodes = resolveBoardNodes(characterId);
  const {byId,edges} = boardTopology(nodes);
  const purchased = new Set(input?.layout.nodes??imported?.releasedSkillTreeNodeGroupIds);
  const active = new Set([...boardRootNodeIds(nodes), ...purchased]);
  const owned = new Map((input?.cards??snapshot?.tables.cards??[]).map(card => [card.cardId, card]));
  const slots=input?Object.entries(input.layout.cards):(imported?.connectedSkillTreeNodeGroupIds??[]).map((id,index)=>
    [id,imported!.connectedSkillTreeNodeCardIds[index]] as [string,string]);
  const assignments = new Map(slots.map(([id,cardId]) => {
    return [id, connectCard(owned.get(cardId), cardId)] as const;
  }));
  const points = snapshot?.tables.boardPoints?.find(row => row.skillTreePointId === character.boardPointId);
  const rank = input?.rank??snapshot?.tables.members.find(row => row.characterId === characterId)?.level ?? null;
  const available = input?.available??(points ? Number(points.quantity) : null);
  const knownTopology = [...purchased, ...assignments.keys()].every(id => byId.has(id));
  const spent = knownTopology ? [...purchased].reduce((sum, id) => sum + byId.get(id)!.boardPointCost, 0) : null;
  const earned = rank === null ? null : boardPointsForMemberLevel(characterId, rank);
  const reconciled = available !== null && earned !== null && spent !== null && earned - spent === available;
  return {nodes, byId, edges, purchased, active, assignments, rank, available, earned, spent, reconciled, knownTopology,
    dreamRank:input?.dreamRank??observedDreamRank(snapshot)??null};
}

export type HolomemBoard = NonNullable<ReturnType<typeof projectHolomemBoard>>;

export function boardConnectCandidates(cards:GameAccountCardSource[],boards:SavedBoards) {
  const positions = new Map<string, {member: string; slotId: string}>();
  for (const [owner,board] of Object.entries(boards)) {
    for(const [slotId,id] of Object.entries(board.cards)){
      positions.set(id, {
        member: accountCharactersById.get(owner)?.name || owner,
        slotId,
      });
    }
  }
  return cards.flatMap(card => {
    const candidate = connectCard(card, card.cardId);
    return candidate.effect ? [{...candidate, placement: positions.get(card.cardId)}] : [];
  });
}

export function boardConnectRange(board: HolomemBoard, slotId: string, card: ReturnType<typeof connectCard> | null) {
  return new Set(card?.effect ? boardConnectAffectedNodeIds(board.nodes, slotId, card.effect) : []);
}

export function previewBoardPath(board: HolomemBoard, node: ResolvedBoardNode) {
  if (board.active.has(node.groupId) || !board.knownTopology) return null;
  const path = shortestBoardActivationPath(board.nodes, board.purchased, node.groupId, board.dreamRank ?? 1);
  if (!path?.nodeIds.length) return null;
  const materials = new Map<ResourceKey, number>();
  for (const id of path.nodeIds) {
    for (const {resource, quantity} of board.byId.get(id)!.costs) {
      materials.set(resource, (materials.get(resource) ?? 0) + quantity);
    }
  }
  return {...path, costs: [...materials].map(([resource, quantity]) => ({resource, quantity}))};
}

export function boardNodeLabel(node: ResolvedBoardNode) {
  if (node.type === 'connect') return 'Connect Slot';
  if (node.type === 'leader') return 'Leader Skill';
  const effect = node.effect?.type ?? '';
  if (effect.includes('MINI_GAME_REWARD')) return 'Park Bonus';
  if (effect.includes('LIVE')) return 'Live Bonus';
  return 'Overall Boost';
}
