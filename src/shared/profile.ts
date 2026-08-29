import { z } from 'zod'
import {
  resourceKeys,
  type AppProfileV2,
  type CardGoal,
  type Inventory,
  type ProgressionManifest,
  type SavedCardState
} from './types'

const nonNegativeInteger = z.number().int().nonnegative()
const bloomStageSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
])
const trainingStageSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)
])

export const inventorySchema = z.object(
  Object.fromEntries(resourceKeys.map((key) => [key, nonNegativeInteger])) as Record<
    (typeof resourceKeys)[number],
    typeof nonNegativeInteger
  >
)

export const cardGoalSchema = z.object({
  targetLevel: z.number().int().min(1).max(80),
  targetBloomStage: bloomStageSchema,
  useBloomStones: z.boolean()
})

export const savedCardSchema = z.object({
  cardId: z.string().min(1),
  nameSnapshot: z.string().min(1),
  level: z.number().int().min(1).max(80),
  expIntoLevel: nonNegativeInteger,
  trainingStage: trainingStageSchema,
  bloomStage: bloomStageSchema,
  bloomPoints: nonNegativeInteger,
  goal: cardGoalSchema
})

export const appProfileSchema = z.object({
  schemaVersion: z.literal(2),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardSchema),
  plannerSelection: z.object({ cardId: z.string().min(1).nullable() }),
  preferences: z.object({ language: z.literal('en'), autoCheckUpdates: z.boolean() })
})

const savedCardV1Schema = savedCardSchema.omit({ goal: true })
const appProfileV1Schema = z.object({
  schemaVersion: z.literal(1),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardV1Schema),
  plannerSelection: z.object({
    cardId: z.string().min(1).nullable(),
    targetLevel: z.number().int().min(1).max(80).nullable(),
    targetBloomStage: z.number().int().min(0).max(5).nullable(),
    useBloomStones: z.boolean()
  }),
  preferences: z.object({ language: z.literal('en'), autoCheckUpdates: z.boolean() })
})

export function emptyInventory(): Inventory {
  return Object.fromEntries(resourceKeys.map((key) => [key, 0])) as Inventory
}

export function createDefaultGoal(level = 1, bloomStage: CardGoal['targetBloomStage'] = 0): CardGoal {
  return { targetLevel: level, targetBloomStage: bloomStage, useBloomStones: false }
}

export function createDefaultCardState(cardId: string, nameSnapshot: string): SavedCardState {
  return {
    cardId,
    nameSnapshot,
    level: 1,
    expIntoLevel: 0,
    trainingStage: 0,
    bloomStage: 0,
    bloomPoints: 0,
    goal: createDefaultGoal()
  }
}

export function createDefaultProfile(catalogVersion: string): AppProfileV2 {
  return {
    schemaVersion: 2,
    revision: 0,
    catalogVersionLastSeen: catalogVersion,
    inventory: emptyInventory(),
    cards: {},
    plannerSelection: { cardId: null },
    preferences: { language: 'en', autoCheckUpdates: true }
  }
}

export function hasActiveGoal(state: SavedCardState): boolean {
  return state.goal.targetLevel > state.level || state.goal.targetBloomStage > state.bloomStage
}

export function validateProfileForManifest(
  input: unknown,
  manifest: ProgressionManifest,
  allowRemovedCards = true
): AppProfileV2 {
  const profile = appProfileSchema.parse(input)
  const catalog = new Map(manifest.cards.map((card) => [card.id, card]))

  for (const [key, state] of Object.entries(profile.cards)) {
    if (key !== state.cardId) throw new Error(`Card map key does not match ${state.cardId}`)
    const card = catalog.get(state.cardId)
    if (!card) {
      if (!allowRemovedCards) throw new Error(`Unknown card ID: ${state.cardId}`)
      if (state.goal.targetLevel < state.level || state.goal.targetBloomStage < state.bloomStage) {
        throw new Error(`${state.nameSnapshot} has targets below its current state`)
      }
      continue
    }
    const rules = manifest.rarities[String(card.rarity) as '3' | '4' | '5']
    if (state.level > rules.maxLevel) throw new Error(`${card.cardName} exceeds its level cap`)
    const cap = state.trainingStage === 0
      ? rules.initialLevelCap
      : rules.trainingStages[state.trainingStage - 1].levelCap
    if (state.level > cap) throw new Error(`${card.cardName} needs a higher SP Training stage`)
    if (state.level === rules.maxLevel && state.expIntoLevel !== 0) {
      throw new Error(`${card.cardName} cannot have partial EXP at maximum level`)
    }
    if (state.level < rules.maxLevel) {
      const next = manifest.cumulativeExperience[state.level] - manifest.cumulativeExperience[state.level - 1]
      if (state.expIntoLevel >= next) throw new Error(`${card.cardName} partial EXP reaches the next level`)
    }
    if (state.goal.targetLevel < state.level || state.goal.targetLevel > rules.maxLevel) {
      throw new Error(`${card.cardName} has an invalid level target`)
    }
    if (state.goal.targetBloomStage < state.bloomStage) {
      throw new Error(`${card.cardName} has a Bloom target below its current state`)
    }
    if (state.goal.useBloomStones && card.rarity !== 5) {
      throw new Error(`${card.cardName} cannot use Bloom Stones`)
    }
  }

  if (profile.plannerSelection.cardId && !profile.cards[profile.plannerSelection.cardId]) {
    throw new Error('Planner selection must reference a saved card')
  }
  return profile
}

function migrateV1(input: unknown): AppProfileV2 {
  const old = appProfileV1Schema.parse(input)
  const cards = Object.fromEntries(Object.entries(old.cards).map(([cardId, state]) => {
    const selected = old.plannerSelection.cardId === cardId
    const targetLevel = selected && old.plannerSelection.targetLevel !== null
      ? Math.max(state.level, old.plannerSelection.targetLevel)
      : state.level
    const targetBloomStage = (selected && old.plannerSelection.targetBloomStage !== null
      ? Math.max(state.bloomStage, old.plannerSelection.targetBloomStage)
      : state.bloomStage) as CardGoal['targetBloomStage']
    return [cardId, {
      ...state,
      goal: {
        targetLevel,
        targetBloomStage,
        useBloomStones: selected && old.plannerSelection.useBloomStones
      }
    }]
  }))
  return {
    schemaVersion: 2,
    revision: old.revision,
    catalogVersionLastSeen: old.catalogVersionLastSeen,
    inventory: old.inventory,
    cards,
    plannerSelection: { cardId: old.plannerSelection.cardId },
    preferences: old.preferences
  }
}

export function migrateProfile(input: unknown, manifest: ProgressionManifest): AppProfileV2 {
  if (!input || typeof input !== 'object') throw new Error('Profile must be an object')
  const record = input as Record<string, unknown>
  if (record.schemaVersion === 1) return validateProfileForManifest(migrateV1(input), manifest)
  if (record.schemaVersion === 2) return validateProfileForManifest(input, manifest)
  throw new Error(`Unsupported profile schema: ${String(record.schemaVersion)}`)
}
