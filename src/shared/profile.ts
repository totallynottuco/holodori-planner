import { z } from 'zod'
import { resourceKeys, type AppProfileV1, type Inventory, type ProgressionManifest } from './types'

const nonNegativeInteger = z.number().int().nonnegative()

export const inventorySchema = z.object(
  Object.fromEntries(resourceKeys.map((key) => [key, nonNegativeInteger])) as Record<
    (typeof resourceKeys)[number],
    typeof nonNegativeInteger
  >
)

export const savedCardSchema = z.object({
  cardId: z.string().min(1),
  nameSnapshot: z.string().min(1),
  level: z.number().int().min(1).max(80),
  expIntoLevel: nonNegativeInteger,
  trainingStage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  bloomStage: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5)
  ]),
  bloomPoints: nonNegativeInteger
})

export const appProfileSchema = z.object({
  schemaVersion: z.literal(1),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardSchema),
  plannerSelection: z.object({
    cardId: z.string().min(1).nullable(),
    targetLevel: z.number().int().min(1).max(80).nullable(),
    targetBloomStage: z.number().int().min(0).max(5).nullable(),
    useBloomStones: z.boolean()
  }),
  preferences: z.object({
    language: z.literal('en'),
    autoCheckUpdates: z.boolean()
  })
})

export function emptyInventory(): Inventory {
  return Object.fromEntries(resourceKeys.map((key) => [key, 0])) as Inventory
}

export function createDefaultProfile(catalogVersion: string): AppProfileV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    catalogVersionLastSeen: catalogVersion,
    inventory: emptyInventory(),
    cards: {},
    plannerSelection: {
      cardId: null,
      targetLevel: null,
      targetBloomStage: null,
      useBloomStones: false
    },
    preferences: { language: 'en', autoCheckUpdates: true }
  }
}

export function validateProfileForManifest(
  input: unknown,
  manifest: ProgressionManifest,
  allowRemovedCards = true
): AppProfileV1 {
  const profile = appProfileSchema.parse(input)
  const catalog = new Map(manifest.cards.map((card) => [card.id, card]))

  for (const state of Object.values(profile.cards)) {
    const card = catalog.get(state.cardId)
    if (!card) {
      if (!allowRemovedCards) throw new Error(`Unknown card ID: ${state.cardId}`)
      continue
    }
    const rules = manifest.rarities[String(card.rarity) as '3' | '4' | '5']
    if (state.level > rules.maxLevel) throw new Error(`${card.cardName} exceeds its level cap`)
    const cap = state.trainingStage === 0 ? rules.initialLevelCap : rules.trainingStages[state.trainingStage - 1].levelCap
    if (state.level > cap) throw new Error(`${card.cardName} needs a higher SP Training stage`)
    if (state.level === rules.maxLevel && state.expIntoLevel !== 0) {
      throw new Error(`${card.cardName} cannot have partial EXP at maximum level`)
    }
    if (state.level < rules.maxLevel) {
      const next = manifest.cumulativeExperience[state.level] - manifest.cumulativeExperience[state.level - 1]
      if (state.expIntoLevel >= next) throw new Error(`${card.cardName} partial EXP reaches the next level`)
    }
  }

  if (profile.plannerSelection.cardId && !profile.cards[profile.plannerSelection.cardId]) {
    throw new Error('Planner selection must reference a saved card')
  }

  return profile
}

export function migrateProfile(input: unknown, manifest: ProgressionManifest): AppProfileV1 {
  if (!input || typeof input !== 'object') throw new Error('Profile must be an object')
  const record = input as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new Error(`Unsupported profile schema: ${String(record.schemaVersion)}`)
  return validateProfileForManifest(input, manifest)
}
