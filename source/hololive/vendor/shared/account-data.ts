import rawAccountManifest from '../data/account.json'
import type { AppProfileV2, Attribute, CardStat, ResourceKey } from './types'

export type BoardNodeType = 'leader' | 'card' | 'content' | 'support' | 'connect'

export interface AccountCharacter {
  id: string
  name: string
  shortName: string
  assetId: string
  productionId: string
  rosterOrder: number
  levelGroupId: string
  maximumLevel: number
  boardTemplateId: string
  boardPointId: string
  groupIds: string[]
  defaultCostumeId: string
}

export interface AccountProduction {
  id: string
  name: string
  order: number
}

export interface AccountCharacterGroup {
  id: string
  name: string
  order: number
  characterIds: string[]
}

export interface MemberLevelProgression {
  level: number
  experience: number
  boardPointsEarned: number
  cumulativeBoardPoints: number
}

export interface PlayerLevelProgression {
  level: number
  experience: number
}

export interface BoardNodeEffect {
  type: string
  value: number
  target: {
    kind: 'all' | 'self' | 'character' | 'group' | 'attribute' | 'unknown'
    characterId: string | null
    groupId: string | null
    attribute: Attribute | null
  } | null
  characterTriggerType: string
  passiveCondition: {
    kind: 'song-character' | 'song-group' | 'owner-song' | 'owner-singer-type' | 'unknown'
    characterIds: string[]
    groupId: string | null
    singerType: 'all' | 'group' | 'solo' | null
  } | null
  liveActiveSkillId: string | null
}

export interface BoardNodeVariant {
  id: string
  number: number
  characterIds: string[]
  type: BoardNodeType
  grade: number
  effectId: string | null
  effect: BoardNodeEffect | null
  description: string
  viewPlayerLevel: number | null
  unlockPlayerLevel: number | null
  boardPointCost: number
  costs: Array<{ resource: ResourceKey; quantity: number }>
}

export interface BoardResetPolicy {
  /** Official `Setting.skillTreeResetConsumptionGoldQuantity`, charged for every removed node. */
  hologoldCostPerRemovedNode: number
  /** Removing a node also removes every purchased node disconnected from the Board origin. */
  removedNodeScope: 'selected-and-disconnected-dependents'
  /** Every removed node returns its complete `boardPointCost`. */
  boardPointRefund: 'full-node-cost'
  /** Every removed node returns every entry in its `costs` array. */
  materialRefund: 'full-node-cost'
}

export interface BoardResetQuote {
  removedNodeIds: string[]
  hologoldCost: number
  boardPointsRefunded: number
  materialsRefunded: Partial<Record<ResourceKey, number>>
}

export interface AccountManifestShape {
  schemaVersion: 10
  metadata: {
    catalogVersion: string
    sourceCommit: string
    coverage: {
      characters: number
      productions: number
      groups: number
      memberLevelGroups: number
      memberLevels: number
      playerLevels: number
      storyChapters: number
      memoriesAvailable: number
      memoryCollectEffects: number
      templates: number
      physicalNodesPerTemplate: number
      nodeVariants: number
      nodeVariantsWithMaterialCosts: number
      nodeCostEntries: number
      effectValueLimits: number
      connectEffects: number
      connectEffectLevels: number
      connectExtentEntries: number
      connectableCards: number
      cardParameterProfiles: number
      cardLevelGroups: number
      costumes: number
      settings: number
    }
  }
  characters: AccountCharacter[]
  productions: AccountProduction[]
  groups: AccountCharacterGroup[]
  memberLevelGroups: Record<string, MemberLevelProgression[]>
  playerLevels: PlayerLevelProgression[]
  storyChapters: Array<{ id: string; chapter: number; maximumEpisode: number }>
  memoriesAvailable: number
  memoryCollectEffects: Array<{ memories: number; allParameterUpPermil: number }>
  /** Retained evaluation coefficient; its complete Unit Score equation is unverified. */
  liveDeckEvaluationCoefficientPermilMultiply: number
  boardReset: BoardResetPolicy
  templates: Array<{ id: string; nodes: Array<{ nodeGroupId: string; x: number; y: number }> }>
  nodeGroups: Record<string, { id: string; variants: BoardNodeVariant[] }>
  effectValueLimits: Record<string, number>
  cardParameterProfiles: Record<string, {
    cardId: string
    characterId: string
    attribute: Attribute
    levelGroupId: string
    potentialGroupId: string
    parameterPermil: Record<CardStat, number>
  }>
  cardLevelBases: Record<string, Array<{ level: number; parameterBaseValue: number }>>
  cardPotentialParameterBonuses: Record<string, Array<{ bloomStage: number; permil: number }>>
  cardConnectEffectIds: Record<string, string>
  connectEffects: Record<string, {
    id: string
    extentGroupId: string
    levels: Array<{ level: 1 | 2; effectPermilUp: number; description: string }>
  }>
  connectExtents: Record<string, Array<{ x: number; y: number }>>
  costumes: Array<{
    id: string
    characterId: string
    name: string
    assetId: string
    leaderSkillId: string | null
    rarity: number
    isDefault: boolean
    sourceCardId: string
  }>
}

export interface ResolvedBoardNode extends BoardNodeVariant {
  groupId: string
  x: number
  y: number
}

export interface BoardActivationPath {
  nodeIds: string[]
  boardPointCost: number
}

export interface ResolvedBoardConnectEffect {
  cardId: string
  level: 1 | 2
  effectPermilUp: number
  description: string
  extentGroupId: string
  offsets: Array<{ x: number; y: number }>
}

export interface ResolvedCardParameters {
  cardId: string
  level: number
  bloomStage: number
  stats: Record<CardStat, number>
}

export interface ResolvedAccountCardParameters {
  cardId: string
  level: number
  bloomStage: number
  baseStats: Record<CardStat, number>
  accountStats: Record<CardStat, number>
  baseTotal: number
  accountTotal: number
}

export type AccountCostume = AccountManifestShape['costumes'][number]

const boardNodeColors: Record<Exclude<BoardNodeType, 'connect'>, 'red' | 'blue' | 'green' | 'yellow'> = {
  leader: 'red',
  card: 'blue',
  support: 'green',
  content: 'yellow'
}

export function boardNodeColor(type: BoardNodeType): 'red' | 'blue' | 'green' | 'yellow' | null {
  return type === 'connect' ? null : boardNodeColors[type]
}

export const boardEffectAssetNames = [
  'img_skill_icon_tree_allparameterup',
  'img_skill_icon_tree_allparameterupforcharactergrouping',
  'img_skill_icon_tree_allparameteruppermilup',
  'img_skill_icon_tree_lifeup',
  'img_skill_icon_tree_liveactiveskillactivationprobabilityuppermilup',
  'img_skill_icon_tree_liveactiveskillcooltimeshortenpermilup',
  'img_skill_icon_tree_liveactiveskilleffectuppermilup',
  'img_skill_icon_tree_livedeckleaderactiveskilladdition',
  'img_skill_icon_tree_livedeckleaderactiveskilllevelup',
  'img_skill_icon_tree_liverewardcardexpquantityuppermilup',
  'img_skill_icon_tree_liverewardquantityuppermilup',
  'img_skill_icon_tree_livescorebonusaddpermilupbymusicskilltreecharacterandmusicsingertype-all',
  'img_skill_icon_tree_livescorebonusaddpermilupbymusicskilltreecharacterandmusicsingertype-group',
  'img_skill_icon_tree_livescorebonusaddpermilupbymusicskilltreecharacterandmusicsingertype-solo',
  'img_skill_icon_tree_minigamerewardquantityuppermilup',
  'img_skill_icon_tree_performanceup',
  'img_skill_icon_tree_performanceuppermilup',
  'img_skill_icon_tree_senseup',
  'img_skill_icon_tree_senseuppermilup',
  'img_skill_icon_tree_techniqueup',
  'img_skill_icon_tree_techniqueuppermilup',
  'img_skill_icon_tree_workrewardquantityuppermilup'
] as const

const boardEffectAssetNameSet = new Set<string>(boardEffectAssetNames)
const boardEffectTypePrefix = 'SkillTreeEffectType_SKILL_TREE_EFFECT_TYPE_'

export function boardNodeShellAssetName(type: BoardNodeType, grade: number, unlocked: boolean): string {
  if (type === 'connect') return 'socket.webp'
  const level = grade >= 2 ? 2 : 1
  return `node-${boardNodeColors[type]}-lv${level}${unlocked ? '' : '-off'}.webp`
}

export function boardNodeShadowAssetName(type: BoardNodeType): string {
  return type === 'connect' ? 'socket-shadow.webp' : 'node-shadow.webp'
}

export function boardNodeEffectAssetName(node: Pick<BoardNodeVariant, 'effect' | 'effectId'>): string | null {
  if (!node.effect) return null
  let name = `img_skill_icon_tree_${node.effect.type
    .replace(boardEffectTypePrefix, '')
    .toLowerCase()
    .replaceAll('_', '')}`
  if (name.endsWith('musicsingertype')) {
    const singerType = node.effectId?.match(/music_singer_type-(all|group|solo)/)?.[1]
    if (!singerType) return null
    name += `-${singerType}`
  }
  return boardEffectAssetNameSet.has(name) ? `${name}.webp` : null
}

export let accountManifest = rawAccountManifest as AccountManifestShape
export function boardEffectValueLimit(effectType: string): number | null {
  const value = accountManifest.effectValueLimits[effectType]
  return Number.isInteger(value) && value > 0 ? value : null
}
export let accountCostumesById = new Map(accountManifest.costumes.map((costume) => [costume.id, costume]))

export function availableAccountCostumes(ownedCardIds: Iterable<string>, extraOwnedCostumeIds: Iterable<string> = []): AccountCostume[] {
  const cards = new Set(ownedCardIds)
  const extras = new Set(extraOwnedCostumeIds)
  return accountManifest.costumes.filter((costume) => costume.isDefault || cards.has(costume.sourceCardId) || extras.has(costume.id))
}

export function selectedAccountCostume(
  characterId: string,
  selectedCostumeIds: Record<string, string>,
  ownedCardIds: Iterable<string>,
  extraOwnedCostumeIds: Iterable<string> = []
): AccountCostume | null {
  const available = availableAccountCostumes(ownedCardIds, extraOwnedCostumeIds).filter((costume) => costume.characterId === characterId)
  return available.find((costume) => costume.id === selectedCostumeIds[characterId])
    ?? available.find((costume) => costume.isDefault)
    ?? null
}
export let accountCharactersById = new Map(accountManifest.characters.map((character) => [character.id, character]))
let accountGroupsById = new Map(accountManifest.groups.map((group) => [group.id, group]))

/** Scope a verified scoring snapshot to one synchronous evaluation. */
export function createScoringAccountScope(manifest?: AccountManifestShape) {
  if (!manifest) return <T>(run: () => T) => run()
  const characters = new Map(manifest.characters.map(row => [row.id, row]))
  const costumes = new Map(manifest.costumes.map(row => [row.id, row]))
  const groups = new Map(manifest.groups.map(row => [row.id, row]))
  return <T>(run: () => T): T => {
    const previous = [accountManifest, accountCharactersById, accountCostumesById, accountGroupsById] as const
    ;[accountManifest, accountCharactersById, accountCostumesById, accountGroupsById] = [manifest, characters, costumes, groups]
    try { return run() }
    finally { [accountManifest, accountCharactersById, accountCostumesById, accountGroupsById] = previous }
  }
}
/** Refresh identity indexes after a validated local catalog is installed at boot. */
export function refreshAccountCatalogIndexes() {
  accountCharactersById.clear()
  for (const character of accountManifest.characters) accountCharactersById.set(character.id, character)
  accountGroupsById.clear()
  for (const group of accountManifest.groups) accountGroupsById.set(group.id, group)
  accountCostumesById.clear()
  for (const costume of accountManifest.costumes) accountCostumesById.set(costume.id, costume)
}
export const maximumPlayerLevel = accountManifest.playerLevels.at(-1)?.level ?? 1
export const maximumMemoryCount = accountManifest.memoriesAvailable
export const accountRosterBranches = accountManifest.productions
  .slice()
  .sort((left, right) => left.order - right.order)
  .map((production) => ({
    ...production,
    generations: accountManifest.groups
      .filter((group) => group.characterIds.some((characterId) => {
        const character = accountCharactersById.get(characterId)
        return character?.productionId === production.id && character.groupIds[0] === group.id
      }))
      .sort((left, right) => left.order - right.order)
      .map((group) => ({
        ...group,
        characters: group.characterIds
          .map((characterId) => accountCharactersById.get(characterId))
          .filter((character): character is AccountCharacter => character?.productionId === production.id && character.groupIds[0] === group.id)
      }))
  }))

export function memberLevelProgression(characterId: string): MemberLevelProgression[] {
  const character = accountCharactersById.get(characterId)
  if (!character) throw new Error(`Unknown account member ${characterId}`)
  const levels = accountManifest.memberLevelGroups[character.levelGroupId]
  if (!levels) throw new Error(`Missing Member Level group ${character.levelGroupId}`)
  return levels
}

export function maximumStoryEpisode(chapter: number): number {
  return accountManifest.storyChapters.find((entry) => entry.chapter === chapter)?.maximumEpisode ?? 1
}

export function memoryParameterBonusPermil(memoriesCollected: number): number {
  const count = Math.max(0, Math.min(maximumMemoryCount, Math.trunc(memoriesCollected)))
  if (count === 0) return 0
  return accountManifest.memoryCollectEffects.find((entry) => entry.memories === count)?.allParameterUpPermil ?? 0
}

export function boardPointsForMemberLevel(characterId: string, level: number): number {
  const levels = memberLevelProgression(characterId)
  const clamped = Math.max(1, Math.min(levels.length, Math.trunc(level)))
  return levels[clamped - 1]?.cumulativeBoardPoints ?? 0
}

export function boardPointsSpent(characterId: string, unlockedNodeIds: Iterable<string>): number {
  const nodes = new Map(resolveBoardNodes(characterId).map((node) => [node.groupId, node]))
  return [...new Set(unlockedNodeIds)].reduce((total, nodeId) => total + (nodes.get(nodeId)?.boardPointCost ?? 0), 0)
}

export function minimumMemberLevelForBoardPoints(characterId: string, requiredPoints: number): number {
  const levels = memberLevelProgression(characterId)
  return levels.find((entry) => entry.cumulativeBoardPoints >= requiredPoints)?.level ?? levels.at(-1)?.level ?? 1
}

export function resolveBoardNodes(characterId: string): ResolvedBoardNode[] {
  const character = accountCharactersById.get(characterId)
  if (!character) throw new Error(`Unknown account member ${characterId}`)
  const template = accountManifest.templates.find((entry) => entry.id === character.boardTemplateId)
  if (!template) throw new Error(`Missing Board template ${character.boardTemplateId}`)
  return template.nodes.map((position) => {
    const group = accountManifest.nodeGroups[position.nodeGroupId]
    if (!group) throw new Error(`Missing Board node group ${position.nodeGroupId}`)
    const variant = group.variants.find((entry) => entry.characterIds.includes(characterId))
      ?? group.variants.find((entry) => entry.characterIds.length === 0)
    if (!variant) throw new Error(`Board node ${position.nodeGroupId} does not apply to ${character.name}`)
    return { ...variant, groupId: position.nodeGroupId, x: position.x, y: position.y }
  })
}

function boardNodeGraph(nodes: ResolvedBoardNode[]): Map<string, string[]> {
  const at = new Map(nodes.map((node) => [`${node.x},${node.y}`, node.groupId]))
  return new Map(nodes.map((node) => [node.groupId, [
    at.get(`${node.x - 1},${node.y}`),
    at.get(`${node.x + 1},${node.y}`),
    at.get(`${node.x},${node.y - 1}`),
    at.get(`${node.x},${node.y + 1}`)
  ].filter((groupId): groupId is string => Boolean(groupId)).sort()]))
}

export function boardRootNodeIds(nodes: ResolvedBoardNode[]): Set<string> {
  return new Set(nodes.filter((node) => node.boardPointCost === 0).map((node) => node.groupId))
}

/** Returns the purchased component connected to the Board's zero-cost origin. */
export function connectedBoardNodeIds(nodes: ResolvedBoardNode[], unlockedNodeIds: Iterable<string>): Set<string> {
  const graph = boardNodeGraph(nodes)
  const active = new Set(unlockedNodeIds)
  const connected = boardRootNodeIds(nodes)
  const pending = [...connected]
  while (pending.length > 0) {
    const current = pending.shift()!
    for (const neighbor of graph.get(current) ?? []) {
      if (!active.has(neighbor) || connected.has(neighbor)) continue
      connected.add(neighbor)
      pending.push(neighbor)
    }
  }
  return connected
}

/** Removes purchases that no longer have an uninterrupted route to the Board origin. */
export function pruneDisconnectedBoardNodeIds(nodes: ResolvedBoardNode[], unlockedNodeIds: Iterable<string>): string[] {
  const unlocked = [...new Set(unlockedNodeIds)]
  const connected = connectedBoardNodeIds(nodes, unlocked)
  const roots = boardRootNodeIds(nodes)
  return unlocked.filter((groupId) => connected.has(groupId) && !roots.has(groupId))
}

/** Quotes the full per-node reset cost/refund after dependency pruning. */
export function quoteBoardReset(
  characterId: string,
  unlockedNodeIds: Iterable<string>,
  selectedNodeIds: Iterable<string>
): BoardResetQuote {
  const nodes = resolveBoardNodes(characterId)
  const byId = new Map(nodes.map((node) => [node.groupId, node]))
  const roots = boardRootNodeIds(nodes)
  const unlocked = [...new Set(unlockedNodeIds)].filter((nodeId) => !roots.has(nodeId))
  for (const nodeId of unlocked) if (!byId.has(nodeId)) throw new Error(`Unknown Board node ${nodeId} for ${characterId}`)
  const retainedCandidates = new Set(unlocked)
  for (const nodeId of selectedNodeIds) retainedCandidates.delete(nodeId)
  const retained = new Set(pruneDisconnectedBoardNodeIds(nodes, retainedCandidates))
  const removedNodeIds = unlocked.filter((nodeId) => !retained.has(nodeId)).sort()
  const materialsRefunded: Partial<Record<ResourceKey, number>> = {}
  let boardPointsRefunded = 0
  for (const nodeId of removedNodeIds) {
    const node = byId.get(nodeId)!
    boardPointsRefunded += node.boardPointCost
    for (const cost of node.costs) {
      materialsRefunded[cost.resource] = (materialsRefunded[cost.resource] ?? 0) + cost.quantity
    }
  }
  return {
    removedNodeIds,
    hologoldCost: removedNodeIds.length * accountManifest.boardReset.hologoldCostPerRemovedNode,
    boardPointsRefunded,
    materialsRefunded
  }
}

/**
 * Finds the route requiring the fewest additional node activations from the
 * currently connected component. Board Pt and geometric length break ties.
 */
export function shortestBoardActivationPath(
  nodes: ResolvedBoardNode[],
  unlockedNodeIds: Iterable<string>,
  targetGroupId: string,
  dreamRank: number
): BoardActivationPath | null {
  const byId = new Map(nodes.map((node) => [node.groupId, node]))
  if (!byId.has(targetGroupId)) return null
  const graph = boardNodeGraph(nodes)
  const unlocked = new Set(unlockedNodeIds)
  const connected = connectedBoardNodeIds(nodes, unlocked)
  if (connected.has(targetGroupId)) return { nodeIds: [], boardPointCost: 0 }

  interface RouteState {
    groupId: string
    activations: number
    boardPointCost: number
    distance: number
    nodeIds: string[]
  }
  const compare = (left: RouteState, right: RouteState): number =>
    left.activations - right.activations
    || left.boardPointCost - right.boardPointCost
    || left.distance - right.distance
    || left.groupId.localeCompare(right.groupId)
  const frontier: RouteState[] = [...connected].map((groupId) => ({
    groupId,
    activations: 0,
    boardPointCost: 0,
    distance: 0,
    nodeIds: []
  }))
  const best = new Map<string, RouteState>()

  while (frontier.length > 0) {
    frontier.sort(compare)
    const current = frontier.shift()!
    const previous = best.get(current.groupId)
    if (previous && compare(previous, current) <= 0) continue
    best.set(current.groupId, current)
    if (current.groupId === targetGroupId) {
      return { nodeIds: current.nodeIds, boardPointCost: current.boardPointCost }
    }

    for (const neighborId of graph.get(current.groupId) ?? []) {
      const neighbor = byId.get(neighborId)!
      const alreadyPurchased = unlocked.has(neighborId) || connected.has(neighborId)
      const requiredRank = neighbor.unlockPlayerLevel ?? neighbor.viewPlayerLevel ?? 1
      if (!alreadyPurchased && requiredRank > dreamRank) continue
      const next: RouteState = {
        groupId: neighborId,
        activations: current.activations + (alreadyPurchased ? 0 : 1),
        boardPointCost: current.boardPointCost + (alreadyPurchased ? 0 : neighbor.boardPointCost),
        distance: current.distance + 1,
        nodeIds: alreadyPurchased ? current.nodeIds : [...current.nodeIds, neighborId]
      }
      const known = best.get(neighborId)
      if (!known || compare(next, known) < 0) frontier.push(next)
    }
  }
  return null
}

export function resolveBoardConnectEffect(cardId: string, bloomStage: number): ResolvedBoardConnectEffect | null {
  const effectId = accountManifest.cardConnectEffectIds[cardId]
  if (!effectId) return null
  const effect = accountManifest.connectEffects[effectId]
  if (!effect) throw new Error(`Missing Connect effect ${effectId} for ${cardId}`)
  const level = bloomStage >= 5 ? 2 : 1
  const values = effect.levels.find((entry) => entry.level === level)
  const offsets = accountManifest.connectExtents[effect.extentGroupId]
  if (!values || !offsets) throw new Error(`Incomplete Connect effect ${effectId}`)
  return { cardId, level, effectPermilUp: values.effectPermilUp, description: values.description, extentGroupId: effect.extentGroupId, offsets }
}

function ceilRatio(value: number, denominator: number): number {
  return Math.floor((value + denominator - 1) / denominator)
}

export function resolveCardParameters(cardId: string, level: number, bloomStage: number): ResolvedCardParameters {
  const profile = accountManifest.cardParameterProfiles[cardId]
  if (!profile) throw new Error(`Missing official card parameters for ${cardId}`)
  const levels = accountManifest.cardLevelBases[profile.levelGroupId]
  if (!levels?.length) throw new Error(`Missing card parameter Level group ${profile.levelGroupId}`)
  const normalizedLevel = Math.max(1, Math.min(levels.at(-1)?.level ?? 1, Math.trunc(level)))
  const normalizedBloom = Math.max(0, Math.min(5, Math.trunc(bloomStage)))
  const levelBase = levels[normalizedLevel - 1]?.parameterBaseValue
  if (!levelBase) throw new Error(`Missing Level ${normalizedLevel} card parameters for ${cardId}`)
  const bloomPermil = (accountManifest.cardPotentialParameterBonuses[profile.potentialGroupId] ?? [])
    .filter((bonus) => bonus.bloomStage <= normalizedBloom)
    .reduce((sum, bonus) => sum + bonus.permil, 0)
  const multiplier = 1000 + bloomPermil
  const weightedStat = (weightPermil: number): number => {
    const levelStat = ceilRatio(levelBase * weightPermil, 1_000)
    return ceilRatio(levelStat * multiplier, 1_000)
  }
  return {
    cardId,
    level: normalizedLevel,
    bloomStage: normalizedBloom,
    stats: {
      performance: weightedStat(profile.parameterPermil.performance),
      technique: weightedStat(profile.parameterPermil.technique),
      sense: weightedStat(profile.parameterPermil.sense)
    }
  }
}

export function boardConnectAffectedNodeIds(
  nodes: ResolvedBoardNode[],
  connectNodeId: string,
  effect: Pick<ResolvedBoardConnectEffect, 'offsets'>
): string[] {
  const origin = nodes.find((node) => node.groupId === connectNodeId)
  if (!origin || origin.type !== 'connect') return []
  const at = new Map(nodes.map((node) => [`${node.x},${node.y}`, node.groupId]))
  return effect.offsets.flatMap((offset) => {
    const groupId = at.get(`${origin.x + offset.x},${origin.y + offset.y}`)
    return groupId ? [groupId] : []
  })
}

export function boardConnectBonusPermilByNode(
  nodes: ResolvedBoardNode[],
  unlockedNodeIds: Iterable<string>,
  assignments: Record<string, string | null>,
  bloomStages: ReadonlyMap<string, number>
): Map<string, number> {
  const active = connectedBoardNodeIds(nodes, unlockedNodeIds)
  const bonuses = new Map<string, number>()
  for (const [connectNodeId, cardId] of Object.entries(assignments)) {
    if (!cardId || !active.has(connectNodeId)) continue
    const effect = resolveBoardConnectEffect(cardId, bloomStages.get(cardId) ?? 0)
    if (!effect) continue
    for (const nodeId of boardConnectAffectedNodeIds(nodes, connectNodeId, effect)) {
      if (!active.has(nodeId)) continue
      bonuses.set(nodeId, (bonuses.get(nodeId) ?? 0) + effect.effectPermilUp)
    }
  }
  return bonuses
}

const parameterEffectPrefix = 'SkillTreeEffectType_SKILL_TREE_EFFECT_TYPE_'
const alwaysCharacterTrigger = 'SkillTreeEffectCharacterTriggerType_SKILL_TREE_EFFECT_CHARACTER_TRIGGER_TYPE_ALWAYS'
const parameterStats: CardStat[] = ['performance', 'technique', 'sense']

function emptyParameterStats(): Record<CardStat, number> {
  return { performance: 0, technique: 0, sense: 0 }
}

export function boardEffectTargetsCard(effect: BoardNodeEffect, boardCharacterId: string, cardId: string): boolean {
  const card = accountManifest.cardParameterProfiles[cardId]
  if (!card || effect.characterTriggerType !== alwaysCharacterTrigger || effect.passiveCondition || !effect.target) return false
  return boardTargetMatchesCard(effect.target, boardCharacterId, card, (groupId, characterId) => Boolean(accountGroupsById.get(groupId)?.characterIds.includes(characterId)))
}

/** Target matching without activation policy; team calculations supply the full official group catalog. */
export function boardTargetMatchesCard(
  target: NonNullable<BoardNodeEffect['target']>,
  boardCharacterId: string,
  card: { characterId: string; attribute: Attribute },
  inGroup: (groupId: string, characterId: string) => boolean
): boolean {
  switch (target.kind) {
    case 'all': return true
    case 'self': return boardCharacterId === card.characterId
    case 'character': return target.characterId === card.characterId
    case 'group': return Boolean(target.groupId && inGroup(target.groupId, card.characterId))
    case 'attribute': return target.attribute === card.attribute
    default: return false
  }
}

export function amplifyBoardEffectValue(value: number, connectBonusPermil: number): number {
  return ceilRatio(value * (1_000 + connectBonusPermil), 1_000)
}

export function limitBoardEffectValue(effectType: string, value: number): number {
  const limit = boardEffectValueLimit(effectType)
  return limit === null ? value : Math.min(value, limit)
}

export function applyCardParameterBonuses(
  baseStats: Readonly<Record<CardStat, number>>,
  flat: Readonly<Record<CardStat, number>>,
  permil: Readonly<Record<CardStat, number>>
): Record<CardStat, number> {
  return Object.fromEntries(parameterStats.map((stat) => [
    stat,
    ceilRatio(baseStats[stat] * (1_000 + permil[stat]), 1_000) + flat[stat]
  ])) as Record<CardStat, number>
}

function addAll(stats: Record<CardStat, number>, value: number): void {
  for (const stat of parameterStats) stats[stat] += value
}

/**
 * Resolves the values shown on an owned card's detail screen. Card Level and
 * Bloom are inherent; only unconditional Board effects are account-wide here.
 */
interface PreparedAccountParameterEffect { boardCharacterId:string;effect:BoardNodeEffect;value:number }
function prepareAccountParameterEffects(profile:Pick<AppProfileV2,'account'|'cards'>,bloomStages:ReadonlyMap<string,number>):PreparedAccountParameterEffect[] {
  const prepared:PreparedAccountParameterEffect[]=[]
  for (const board of Object.values(profile.account.boards)) {
    if (!accountCharactersById.has(board.characterId)) continue
    const nodes = resolveBoardNodes(board.characterId)
    const active = connectedBoardNodeIds(nodes, board.unlockedNodeIds)
    const connectBonuses = boardConnectBonusPermilByNode(nodes, active, board.connectAssignments, bloomStages)
    for (const node of nodes) {
      if (!active.has(node.groupId) || !node.effect) continue
      prepared.push({boardCharacterId:board.characterId,effect:node.effect,value:amplifyBoardEffectValue(node.effect.value,connectBonuses.get(node.groupId)??0)})
    }
  }
  return prepared
}
function applyAccountParameterEffects(base:ResolvedCardParameters,prepared:PreparedAccountParameterEffect[]):ResolvedAccountCardParameters {
  const cardId=base.cardId
  const flat = emptyParameterStats()
  const permil = emptyParameterStats()
  const limitedEffects = new Map<string, number>()
  for (const {boardCharacterId,effect,value} of prepared) {
      if (!boardEffectTargetsCard(effect,boardCharacterId,cardId)) continue
      const effectType = effect.type.replace(parameterEffectPrefix, '')
      if (accountManifest.effectValueLimits[effect.type]) {
        limitedEffects.set(effect.type, (limitedEffects.get(effect.type) ?? 0) + value)
        continue
      }
      switch (effectType) {
        case 'PERFORMANCE_UP': flat.performance += value; break
        case 'TECHNIQUE_UP': flat.technique += value; break
        case 'SENSE_UP': flat.sense += value; break
        case 'ALL_PARAMETER_UP': addAll(flat, value); break
        case 'PERFORMANCE_UP_PERMIL_UP': permil.performance += value; break
        case 'TECHNIQUE_UP_PERMIL_UP': permil.technique += value; break
        case 'SENSE_UP_PERMIL_UP': permil.sense += value; break
        case 'ALL_PARAMETER_UP_PERMIL_UP': addAll(permil, value); break
      }
  }

  for (const [effectType, value] of limitedEffects) {
    const limited = limitBoardEffectValue(effectType, value)
    if (effectType.endsWith('_ALL_PARAMETER_UP_FOR_CHARACTER_GROUPING')) addAll(flat, limited)
  }

  const accountStats = applyCardParameterBonuses(base.stats, flat, permil)
  const baseTotal = parameterStats.reduce((sum, stat) => sum + base.stats[stat], 0)
  const accountTotal = parameterStats.reduce((sum, stat) => sum + accountStats[stat], 0)
  return {
    cardId,
    level: base.level,
    bloomStage: base.bloomStage,
    baseStats: base.stats,
    accountStats,
    baseTotal,
    accountTotal
  }
}

export function resolveAccountCardParameters(
  profile:Pick<AppProfileV2,'account'|'cards'>,cardId:string,level:number,bloomStage:number
):ResolvedAccountCardParameters {
  const base=resolveCardParameters(cardId,level,bloomStage)
  const bloomStages=new Map<string,number>(Object.values(profile.cards).map(card=>[card.cardId,card.bloomStage]))
  // The editor draft remains authoritative before its profile save completes.
  bloomStages.set(cardId,base.bloomStage)
  return applyAccountParameterEffects(base,prepareAccountParameterEffects(profile,bloomStages))
}

/** A captured owned roster shares one authoritative set of Connect Blooms.
 * Prepare Board topology/effects once, then use the identical single-card math. */
export function resolveAccountCardParametersBatch(
  profile:Pick<AppProfileV2,'account'|'cards'>,cards:ReadonlyArray<{cardId:string;level:number;bloomStage:number}>
):ResolvedAccountCardParameters[] {
  const bases=cards.map(card=>resolveCardParameters(card.cardId,card.level,card.bloomStage))
  const bloomStages=new Map<string,number>(Object.values(profile.cards).map(card=>[card.cardId,card.bloomStage]))
  for(const base of bases)bloomStages.set(base.cardId,base.bloomStage)
  const prepared=prepareAccountParameterEffects(profile,bloomStages)
  return bases.map(base=>applyAccountParameterEffects(base,prepared))
}

export function characterIdForMemberName(memberName: string): string | null {
  return accountManifest.characters.find((character) => character.name === memberName)?.id ?? null
}
