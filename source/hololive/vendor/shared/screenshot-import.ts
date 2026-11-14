import { minimumTrainingStage } from './planner'
import { createDefaultCardState } from './profile'
import type {
  AppProfileV2,
  ProgressionManifest,
  SavedCardState,
  ScreenshotImportApplyResult,
  ScreenshotImportDetection
} from './types'

export function mergeScreenshotImport(
  current: AppProfileV2,
  detections: ScreenshotImportDetection[],
  manifest: ProgressionManifest
): ScreenshotImportApplyResult {
  if (detections.length === 0) throw new Error('Choose at least one detected card')
  const catalog = new Map(manifest.cards.map((card) => [card.id, card]))
  const cards = structuredClone(current.cards)
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  let unchanged = 0

  for (const detection of detections) {
    if (seen.has(detection.cardId)) throw new Error(`Duplicate screenshot card ID: ${detection.cardId}`)
    seen.add(detection.cardId)
    const card = catalog.get(detection.cardId)
    if (!card) throw new Error(`Unknown card ID: ${detection.cardId}`)
    const rules = manifest.rarities[String(card.rarity) as '3' | '4' | '5']
    if (!Number.isInteger(detection.level) || detection.level < 1 || detection.level > rules.maxLevel) {
      throw new Error(`${card.memberName} has an invalid imported level`)
    }
    if (!Number.isInteger(detection.bloomStage) || detection.bloomStage < 0 || detection.bloomStage > 5) {
      throw new Error(`${card.memberName} has an invalid imported Bloom stage`)
    }

    const saved = cards[card.id]
    if (!saved) {
      const created = createDefaultCardState(card.id, `${card.memberName} — ${card.cardName}`)
      const trainingStage = minimumTrainingStage(card, detection.level, manifest) as SavedCardState['trainingStage']
      cards[card.id] = {
        ...created,
        level: detection.level,
        trainingStage,
        bloomStage: detection.bloomStage,
        goal: {
          active: false,
          targetLevel: detection.level,
          targetTrainingStage: trainingStage
        }
      }
      added += 1
      continue
    }

    const level = detection.level
    const bloomStage = detection.bloomStage as SavedCardState['bloomStage']
    const trainingStage = Math.max(
      saved.trainingStage,
      minimumTrainingStage(card, level, manifest)
    ) as SavedCardState['trainingStage']
    const didChange = level !== saved.level || bloomStage !== saved.bloomStage || trainingStage !== saved.trainingStage
    const targetLevel = saved.goal.active ? Math.max(saved.goal.targetLevel, level) : level
    const targetTrainingStage = saved.goal.active
      ? Math.max(
          saved.goal.targetTrainingStage,
          trainingStage,
          minimumTrainingStage(card, targetLevel, manifest)
        ) as SavedCardState['trainingStage']
      : trainingStage
    cards[card.id] = {
      ...saved,
      level,
      expIntoLevel: level !== saved.level ? 0 : saved.expIntoLevel,
      trainingStage,
      bloomStage,
      goal: {
        active: saved.goal.active,
        targetLevel,
        targetTrainingStage
      }
    }
    if (didChange) updated += 1
    else unchanged += 1
  }

  return {
    profile: {
      ...current,
      revision: current.revision + 1,
      catalogVersionLastSeen: manifest.metadata.catalogVersion,
      cards
    },
    added,
    updated,
    unchanged
  }
}
