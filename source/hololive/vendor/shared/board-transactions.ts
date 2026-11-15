import { boardPointsForMemberLevel, boardPointsSpent, connectedBoardNodeIds, quoteBoardReset, resolveBoardConnectEffect, resolveBoardNodes, shortestBoardActivationPath, type BoardResetQuote } from './account-data'
import type { AccountBoardState, AppProfileV2 } from './types'

export interface BoardUnlockQuote {
  nodeIds: string[]
  boardPointCost: number
  problems: string[]
}

export function profileBoard(profile: AppProfileV2, characterId: string): AccountBoardState {
  return profile.account.boards[characterId] ?? { characterId, characterLevel: 1, unlockedNodeIds: [], connectAssignments: {} }
}

export function quoteBoardUnlock(profile: AppProfileV2, characterId: string, target: string): BoardUnlockQuote {
  const board = profileBoard(profile, characterId)
  const nodes = resolveBoardNodes(characterId)
  const path = shortestBoardActivationPath(nodes, board.unlockedNodeIds, target, profile.account.playerLevel)
  if (!path) return { nodeIds: [], boardPointCost: 0, problems: ['No connected path is available at this Dream Rank.'] }
  const available = boardPointsForMemberLevel(characterId, board.characterLevel) - boardPointsSpent(characterId, board.unlockedNodeIds)
  const problems = path.boardPointCost > available ? [`Need ${path.boardPointCost} Board Pt; ${available} available.`] : []
  return { nodeIds: path.nodeIds, boardPointCost: path.boardPointCost, problems }
}

export function unlockBoardNode(profile: AppProfileV2, characterId: string, target: string): AppProfileV2 {
  const quote = quoteBoardUnlock(profile, characterId, target)
  if (quote.problems.length) throw new Error(quote.problems.join(' '))
  if (!quote.nodeIds.length) return profile
  const board = profileBoard(profile, characterId)
  return { ...profile, account: { ...profile.account, boards: { ...profile.account.boards,
    [characterId]: { ...board, unlockedNodeIds: [...new Set([...board.unlockedNodeIds, ...quote.nodeIds])] } } } }
}

/** Board editing only records state. Confirmation binds the nodes being removed, never inventory. */
export function resetBoardNodes(profile: AppProfileV2, characterId: string, selected: readonly string[], approved?: Pick<BoardResetQuote, 'removedNodeIds'>): AppProfileV2 {
  const board = profileBoard(profile, characterId)
  const quote = quoteBoardReset(characterId, board.unlockedNodeIds, selected)
  if (!quote.removedNodeIds.length) return profile
  if (approved && JSON.stringify(quote.removedNodeIds) !== JSON.stringify(approved.removedNodeIds)) throw new Error('The Board reset changed. Review the updated preview before confirming.')
  const removed = new Set(quote.removedNodeIds)
  const unlockedNodeIds = board.unlockedNodeIds.filter((id) => !removed.has(id))
  const active = connectedBoardNodeIds(resolveBoardNodes(characterId), unlockedNodeIds)
  return { ...profile, account: { ...profile.account, boards: { ...profile.account.boards,
    [characterId]: { ...board, unlockedNodeIds, connectAssignments: Object.fromEntries(Object.entries(board.connectAssignments).filter(([id]) => active.has(id))) } } } }
}

/** Relocate a card and replace the destination assignment in one profile mutation. */
export function assignBoardConnectCard(profile: AppProfileV2, characterId: string, nodeId: string, cardId: string | null): AppProfileV2 {
  const board = profileBoard(profile, characterId)
  const nodes = resolveBoardNodes(characterId)
  if (!nodes.some((node) => node.groupId === nodeId && node.type === 'connect')
    || !connectedBoardNodeIds(nodes, board.unlockedNodeIds).has(nodeId)) {
    throw new Error('Choose an active Connect Slot before assigning a card.')
  }
  if (cardId !== null && !resolveBoardConnectEffect(cardId, profile.cards[cardId]?.bloomStage ?? 0)) {
    throw new Error(`Card ${cardId} has no Connect effect.`)
  }
  if ((board.connectAssignments[nodeId] ?? null) === cardId) return profile
  const boards = { ...profile.account.boards }
  if (cardId !== null) {
    for (const [ownerId, owner] of Object.entries(boards)) {
      if (!Object.values(owner.connectAssignments).includes(cardId)) continue
      boards[ownerId] = { ...owner, connectAssignments: Object.fromEntries(
        Object.entries(owner.connectAssignments).filter(([, assigned]) => assigned !== cardId)
      ) }
    }
  }
  const destination = boards[characterId] ?? board
  const connectAssignments = { ...destination.connectAssignments }
  if (cardId === null) delete connectAssignments[nodeId]
  else connectAssignments[nodeId] = cardId
  boards[characterId] = { ...destination, connectAssignments }
  return { ...profile, account: { ...profile.account, boards } }
}
