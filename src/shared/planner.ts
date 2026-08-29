import type {
  AppProfileV1,
  CardCatalogEntry,
  PlanResult,
  PlannerRequest,
  ProgressionManifest,
  RequirementLine,
  ResourceKey,
  SavedCardState
} from './types'

const attributeResources = {
  cute: { beads: 'cuteBeads', crystals: 'cuteCrystals' },
  pure: { beads: 'pureBeads', crystals: 'pureCrystals' },
  happy: { beads: 'happyBeads', crystals: 'happyCrystals' }
} as const

function rarityKey(rarity: number): '3' | '4' | '5' {
  return String(rarity) as '3' | '4' | '5'
}

export function minimumTrainingStage(
  card: CardCatalogEntry,
  level: number,
  manifest: ProgressionManifest
): number {
  const rules = manifest.rarities[rarityKey(card.rarity)]
  if (level <= rules.initialLevelCap) return 0
  const stage = rules.trainingStages.find((item) => level <= item.levelCap)
  if (!stage) throw new Error(`Level ${level} exceeds the ${card.rarity}★ maximum`)
  return stage.stage
}

export function normalizeCardState(
  state: SavedCardState,
  card: CardCatalogEntry,
  manifest: ProgressionManifest
): SavedCardState {
  const rules = manifest.rarities[rarityKey(card.rarity)]
  const level = Math.min(Math.max(1, state.level), rules.maxLevel)
  const trainingStage = Math.max(state.trainingStage, minimumTrainingStage(card, level, manifest)) as SavedCardState['trainingStage']
  const maxPartial =
    level === rules.maxLevel
      ? 0
      : manifest.cumulativeExperience[level] - manifest.cumulativeExperience[level - 1] - 1
  return {
    ...state,
    level,
    trainingStage,
    expIntoLevel: Math.min(Math.max(0, state.expIntoLevel), maxPartial),
    bloomStage: Math.min(5, Math.max(0, state.bloomStage)) as SavedCardState['bloomStage']
  }
}

export function calculatePlan(
  profile: AppProfileV1,
  request: PlannerRequest,
  manifest: ProgressionManifest
): PlanResult {
  const catalogCard = manifest.cards.find((card) => card.id === request.cardId)
  if (!catalogCard) throw new Error(`Unknown card ID: ${request.cardId}`)
  const rawState = profile.cards[request.cardId]
  if (!rawState) throw new Error('Add this card to Cards before planning it')
  const state = normalizeCardState(rawState, catalogCard, manifest)
  const rules = manifest.rarities[rarityKey(catalogCard.rarity)]

  if (!Number.isInteger(request.targetLevel) || request.targetLevel < state.level || request.targetLevel > rules.maxLevel) {
    throw new Error(`Target level must be between ${state.level} and ${rules.maxLevel}`)
  }
  if (
    !Number.isInteger(request.targetBloomStage) ||
    request.targetBloomStage < state.bloomStage ||
    request.targetBloomStage > manifest.bloom.maxStage
  ) {
    throw new Error(`Bloom target must be between ${state.bloomStage} and ${manifest.bloom.maxStage}`)
  }
  if (request.useBloomStones && catalogCard.rarity !== 5) {
    throw new Error('Bloom Stones can only be used on 5★ cards')
  }

  const currentCumulative = manifest.cumulativeExperience[state.level - 1] + state.expIntoLevel
  const targetCumulative = manifest.cumulativeExperience[request.targetLevel - 1]
  const experienceRequired = Math.max(0, targetCumulative - currentCumulative)
  const targetTrainingStage = Math.max(
    state.trainingStage,
    minimumTrainingStage(catalogCard, request.targetLevel, manifest)
  )
  const totals = new Map<ResourceKey | 'bloomPoints', number>()
  const add = (key: ResourceKey | 'bloomPoints', amount: number): void => {
    totals.set(key, (totals.get(key) ?? 0) + amount)
  }

  add('lessonPoints', experienceRequired)
  const attribute = attributeResources[catalogCard.attribute]
  for (const stage of rules.trainingStages) {
    if (stage.stage <= state.trainingStage || stage.stage > targetTrainingStage) continue
    add(attribute.beads, stage.cost.beads)
    add(attribute.crystals, stage.cost.crystals)
    add('hologold', stage.cost.hologold)
    add('hololium', stage.cost.hololium)
  }

  const bloomStagesNeeded = request.targetBloomStage - state.bloomStage
  const bloomPointsSpent = Math.min(state.bloomPoints, bloomStagesNeeded)
  const uncoveredBloom = bloomStagesNeeded - bloomPointsSpent
  const bloomStonesSpent = request.useBloomStones && catalogCard.rarity === 5 ? uncoveredBloom : 0
  add('bloomPoints', bloomStagesNeeded - bloomStonesSpent)
  add('bloomStones', bloomStonesSpent)

  const requirements: RequirementLine[] = [...totals.entries()]
    .filter(([, required]) => required > 0)
    .map(([key, required]) => {
      const available = key === 'bloomPoints' ? state.bloomPoints : profile.inventory[key]
      return { key, required, available, shortage: Math.max(0, required - available) }
    })

  return {
    card: catalogCard,
    current: state,
    target: { level: request.targetLevel, trainingStage: targetTrainingStage, bloomStage: request.targetBloomStage },
    experienceRequired,
    bloomPointsSpent,
    bloomStonesSpent,
    requirements,
    canApply: requirements.every((item) => item.shortage === 0)
  }
}

export function applyPlan(profile: AppProfileV1, plan: PlanResult): AppProfileV1 {
  if (!plan.canApply) throw new Error('The plan has resource shortages')
  const inventory = { ...profile.inventory }
  for (const item of plan.requirements) {
    if (item.key !== 'bloomPoints') inventory[item.key] -= item.required
  }
  const cards = { ...profile.cards }
  cards[plan.card.id] = {
    ...plan.current,
    level: plan.target.level,
    expIntoLevel: 0,
    trainingStage: plan.target.trainingStage as SavedCardState['trainingStage'],
    bloomStage: plan.target.bloomStage as SavedCardState['bloomStage'],
    bloomPoints: plan.current.bloomPoints - plan.bloomPointsSpent
  }
  return { ...profile, revision: profile.revision + 1, inventory, cards }
}
