import { hasActiveGoal } from './profile'
import { resourceKeys } from './types'
import type {
  AggregatePlanResult,
  AppProfileV2,
  CardCatalogEntry,
  Inventory,
  MaterialConversion,
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

const beadConversionInput = 30
const crystalConversionOutput = 10
const beadConversionCoinCost = 200

function rarityKey(rarity: number): '3' | '4' | '5' {
  return String(rarity) as '3' | '4' | '5'
}

function resolveRequirements(
  totals: Map<ResourceKey | 'bloomPoints', number>,
  inventory: Inventory,
  bloomPoints = 0
): { requirements: RequirementLine[]; conversions: MaterialConversion[] } {
  const convertedAvailability = new Map<ResourceKey, number>()
  const conversions: MaterialConversion[] = []
  let conversionCoinCost = 0

  for (const pair of Object.values(attributeResources)) {
    const requiredBeads = totals.get(pair.beads) ?? 0
    const requiredCrystals = totals.get(pair.crystals) ?? 0
    const excessBeads = Math.max(0, inventory[pair.beads] - requiredBeads)
    const missingCrystals = Math.max(0, requiredCrystals - inventory[pair.crystals])
    const neededBatches = Math.ceil(missingCrystals / crystalConversionOutput)
    const availableBatches = Math.floor(excessBeads / beadConversionInput)
    const batches = Math.min(neededBatches, availableBatches)
    if (batches <= 0) continue
    const input = batches * beadConversionInput
    const output = batches * crystalConversionOutput
    const fee = batches * beadConversionCoinCost
    conversions.push({
      from: pair.beads,
      to: pair.crystals,
      input,
      output,
      fee: { key: 'megaSphereCoin', amount: fee }
    })
    conversionCoinCost += fee
    convertedAvailability.set(pair.crystals, output)
  }

  const resolvedTotals = new Map(totals)
  if (conversionCoinCost > 0) {
    resolvedTotals.set('megaSphereCoin', (resolvedTotals.get('megaSphereCoin') ?? 0) + conversionCoinCost)
  }
  const order = new Map<ResourceKey | 'bloomPoints', number>([
    ...resourceKeys.map((key, index) => [key, index] as const),
    ['bloomPoints', resourceKeys.length]
  ])
  const requirements = [...resolvedTotals.entries()]
    .filter(([, required]) => required > 0)
    .sort(([left], [right]) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    .map(([key, required]) => {
      const available = key === 'bloomPoints'
        ? bloomPoints
        : inventory[key] + (convertedAvailability.get(key) ?? 0)
      return { key, required, available, shortage: Math.max(0, required - available) }
    })

  return { requirements, conversions }
}

export function minimumTrainingStage(
  card: Pick<CardCatalogEntry, 'rarity'>,
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
  const trainingStage = Math.max(
    state.trainingStage,
    minimumTrainingStage(card, level, manifest)
  ) as SavedCardState['trainingStage']
  const maxPartial = level === rules.maxLevel
    ? 0
    : manifest.cumulativeExperience[level] - manifest.cumulativeExperience[level - 1] - 1
  const bloomStage = Math.min(5, Math.max(0, state.bloomStage)) as SavedCardState['bloomStage']
  const targetLevel = Math.min(rules.maxLevel, Math.max(level, state.goal.targetLevel))
  const targetTrainingStage = Math.max(
    trainingStage,
    state.goal.targetTrainingStage,
    minimumTrainingStage(card, targetLevel, manifest)
  ) as SavedCardState['goal']['targetTrainingStage']
  return {
    ...state,
    level,
    trainingStage,
    expIntoLevel: Math.min(Math.max(0, state.expIntoLevel), maxPartial),
    bloomStage,
    goal: { active: state.goal.active, targetLevel, targetTrainingStage }
  }
}

export function requestForGoal(state: SavedCardState): PlannerRequest {
  return {
    cardId: state.cardId,
    targetLevel: state.goal.targetLevel,
    targetTrainingStage: state.goal.targetTrainingStage
  }
}

export function calculatePlan(
  profile: AppProfileV2,
  request: PlannerRequest,
  manifest: ProgressionManifest
): PlanResult {
  const catalogCard = manifest.cards.find((card) => card.id === request.cardId)
  if (!catalogCard) throw new Error(`Unknown card ID: ${request.cardId}`)
  const rawState = profile.cards[request.cardId]
  if (!rawState) throw new Error('Add this card to Characters before planning it')
  const state = normalizeCardState(rawState, catalogCard, manifest)
  const rules = manifest.rarities[rarityKey(catalogCard.rarity)]

  if (!Number.isInteger(request.targetLevel) || request.targetLevel < state.level || request.targetLevel > rules.maxLevel) {
    throw new Error(`Target level must be between ${state.level} and ${rules.maxLevel}`)
  }
  if (!Number.isInteger(request.targetTrainingStage) || request.targetTrainingStage < state.trainingStage || request.targetTrainingStage > 4) {
    throw new Error(`Target SP Training must be between ${state.trainingStage} and 4`)
  }
  const minimumTargetTraining = minimumTrainingStage(catalogCard, request.targetLevel, manifest)
  if (request.targetTrainingStage < minimumTargetTraining) {
    throw new Error(`Level ${request.targetLevel} requires SP Training ${minimumTargetTraining}`)
  }
  const currentCumulative = manifest.cumulativeExperience[state.level - 1] + state.expIntoLevel
  const targetCumulative = manifest.cumulativeExperience[request.targetLevel - 1]
  const experienceRequired = Math.max(0, targetCumulative - currentCumulative)
  const targetTrainingStage = request.targetTrainingStage
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

  const { requirements, conversions } = resolveRequirements(totals, profile.inventory, state.bloomPoints)
  const isComplete = request.targetLevel === state.level && targetTrainingStage === state.trainingStage

  return {
    card: catalogCard,
    current: state,
    target: {
      level: request.targetLevel,
      trainingStage: targetTrainingStage
    },
    experienceRequired,
    requirements,
    conversions,
    isComplete,
    canApply: !isComplete && requirements.every((item) => item.shortage === 0)
  }
}

export function calculateGoalPlan(
  profile: AppProfileV2,
  cardId: string,
  manifest: ProgressionManifest
): PlanResult {
  const state = profile.cards[cardId]
  if (!state) throw new Error('Unknown saved card')
  if (!hasActiveGoal(state)) throw new Error('This card is not in the planner')
  return calculatePlan(profile, requestForGoal(state), manifest)
}

export function calculateAggregatePlan(
  profile: AppProfileV2,
  manifest: ProgressionManifest
): AggregatePlanResult {
  const catalogOrder = new Map(manifest.cards.map((card, index) => [card.id, index]))
  const plans = Object.values(profile.cards)
    .filter((state) => hasActiveGoal(state))
    .filter((state) => !state.inactive)
    .filter((state) => catalogOrder.has(state.cardId))
    .sort((a, b) => (catalogOrder.get(a.cardId) ?? 0) - (catalogOrder.get(b.cardId) ?? 0))
    .map((state) => calculatePlan(profile, requestForGoal(state), manifest))

  const required = new Map<ResourceKey | 'bloomPoints', number>()
  for (const plan of plans) {
    for (const item of plan.requirements) {
      if (item.key === 'megaSphereCoin') continue
      required.set(item.key, (required.get(item.key) ?? 0) + item.required)
    }
  }

  const { requirements, conversions } = resolveRequirements(required, profile.inventory)
  return {
    plans,
    requirements,
    conversions,
    canApplyAll: plans.some((plan) => !plan.isComplete) && requirements.every((item) => item.shortage === 0)
  }
}

function deductResources(
  inventory: Inventory,
  requirements: RequirementLine[],
  conversions: MaterialConversion[]
): Inventory {
  const next = { ...inventory }
  for (const item of requirements) {
    if (item.key !== 'bloomPoints') next[item.key] -= item.required
  }
  for (const conversion of conversions) {
    next[conversion.from] -= conversion.input
    next[conversion.to] += conversion.output
  }
  return next
}

function completedCard(plan: PlanResult): SavedCardState {
  return {
    ...plan.current,
    level: plan.target.level,
    expIntoLevel: 0,
    trainingStage: plan.target.trainingStage as SavedCardState['trainingStage'],
    goal: {
      active: plan.current.goal.active,
      targetLevel: plan.target.level,
      targetTrainingStage: plan.target.trainingStage as SavedCardState['trainingStage']
    }
  }
}

function applyPlanWithoutRevision(profile: AppProfileV2, plan: PlanResult): AppProfileV2 {
  const cards = { ...profile.cards }
  cards[plan.card.id] = completedCard(plan)
  return {
    ...profile,
    inventory: deductResources(profile.inventory, plan.requirements, plan.conversions),
    cards,
    plannerSelection: { cardId: plan.card.id }
  }
}

export function applyPlan(profile: AppProfileV2, plan: PlanResult): AppProfileV2 {
  if (plan.isComplete) throw new Error('This planner goal is already complete')
  if (!plan.canApply) throw new Error('The plan has resource shortages')
  const next = applyPlanWithoutRevision(profile, plan)
  return { ...next, revision: profile.revision + 1 }
}

export function applyAggregatePlan(
  profile: AppProfileV2,
  aggregate: AggregatePlanResult
): AppProfileV2 {
  if (!aggregate.plans.some((plan) => !plan.isComplete)) throw new Error('There are no unfinished plans to apply')
  if (!aggregate.canApplyAll) throw new Error('The aggregate plan has resource shortages')
  const pending = aggregate.plans.filter((item) => !item.isComplete)
  const cards = { ...profile.cards }
  for (const plan of pending) cards[plan.card.id] = completedCard(plan)
  return {
    ...profile,
    revision: profile.revision + 1,
    inventory: deductResources(profile.inventory, aggregate.requirements, aggregate.conversions),
    cards,
    plannerSelection: { cardId: pending.at(-1)?.card.id ?? profile.plannerSelection.cardId }
  }
}
