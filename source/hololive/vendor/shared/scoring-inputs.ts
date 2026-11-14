import type { TeamSelection } from './team-parameters'
import type { AppProfileV2 } from './types'

/** Only scoring-relevant state; pending edits change this even at the same revision. */
export function normalizedScoringInputs(profile: AppProfileV2, selection: TeamSelection) {
  return {
    selection: structuredClone(selection),
    cards: Object.fromEntries(Object.values(profile.cards).map(card => [card.cardId, { level: card.level, bloomStage: card.bloomStage }])),
    account: {
      memoriesCollected: profile.account.memoriesCollected,
      unlockedCharacterIds: profile.account.unlockedCharacterIds.slice().sort(),
      ownedCostumeIds: profile.account.ownedCostumeIds.slice().sort(),
      boards: Object.fromEntries(Object.entries(profile.account.boards).map(([id, board]) => [id, {
        characterId: board.characterId, unlockedNodeIds: board.unlockedNodeIds.slice().sort(), connectAssignments: { ...board.connectAssignments }
      }]))
    }
  }
}
