import { z } from 'zod'
import {
  accountManifest, accountCharactersById, accountCostumesById, availableAccountCostumes,
  resolveCardParameters, resolveBoardNodes, connectedBoardNodeIds, boardConnectBonusPermilByNode,
  amplifyBoardEffectValue, limitBoardEffectValue, applyCardParameterBonuses, boardTargetMatchesCard,
  memoryParameterBonusPermil, type BoardNodeEffect
} from './account-data'
import type { AppProfileV2, CardStat } from './types'
import type { ScoringData, ScoringSkill, ScoringTrigger } from './scoring-data'
import { resolveFormationTotal } from './formation-total'
import { resolveOverallPower } from './overall-power'

export const SCORING_MODEL_VERSION = 'team-parameters-v5'
export const teamSelectionSchema = z.object({
  memberCardIds: z.array(z.string().min(1)).length(5),
  leaderCharacterId: z.string().min(1), outfitId: z.string().min(1), songId: z.string().min(1)
}).strict()
export type TeamSelection = z.infer<typeof teamSelectionSchema>
export type Resolution<T> = { status: 'resolved'; value: T } | { status: 'unresolved'; value: null; reasons: string[] }
export interface UnresolvedRule { id: string; sourceId: string; reason: string; affects: string[] }
export interface ParameterContribution {
  id: string
  system: 'board' | 'leader' | 'passive' | 'memory'
  sourceId: string
  ownerCharacterId: string | null
  description: string
  type: string
  value: number
  unit: 'flat' | 'permil' | 'source-value'
  stats: CardStat[]
  recipientCardIds: string[]
  status: 'active' | 'inactive' | 'unresolved'
  reason: string | null
  connectBonusPermil: number
  originalValue: number
}
export interface SkillReport {
  source: 'leader' | 'member' | 'board'
  ownerId: string
  kind: 'leader' | 'passive' | 'active' | 'special'
  skillId: string
  level: number
  definition: ScoringSkill['levels'][number]
  branches: Array<{ kind: 'primary' | 'additional'; effectGroupId: string; triggerGroupId: string | null; status: 'active' | 'inactive' | 'deferred' | 'unresolved'; reason: string | null }>
}
export interface TeamParameterReport {
  modelVersion: string
  status: 'resolved' | 'unresolved'
  selection: TeamSelection
  song: ScoringData['songs'][string]
  leader: { characterId: string; name: string; outfitId: string; outfitName: string }
  members: Array<{
    cardId: string; characterId: string; level: number; bloomStage: number
    inherentStats: Record<CardStat, number>
    /** This is the independently verified Board stage, never a complete team-adjusted total. */
    inherentAndBoardStats: Record<CardStat, Resolution<number>>
    boardModifiers: Array<{ type: string; knownSumBeforeCap: number; value: Resolution<number> }>
    parameters: Record<CardStat, Resolution<number>>
    parameterTotal: Resolution<number>
    formationStages: Omit<ReturnType<typeof resolveFormationTotal>, 'parameters' | 'parameterTotal' | 'unresolved'>
    contributionIds: string[]
  }>
  parameterTotals: Record<CardStat, Resolution<number>>
  /** Sum of the five independently rounded member totals; never game Unit Score. */
  parameterTotal: Resolution<number>
  overallPower: ReturnType<typeof resolveOverallPower>
  rosterBonus: { permyriad: Resolution<number>; formationApplication: Resolution<'identity' | 'member-subtotal-before-memory'>; knownSubtotalPermyriad: number; capPermyriad: 5000; contributions: Array<{ cardId: string; level: number; permyriad: number | null }> }
  contributions: ParameterContribution[]
  skills: SkillReport[]
  deferredTimelineEffects: Array<{ skillId: string; ownerId: string; reason: string }>
  unresolved: UnresolvedRule[]
}

const stats: CardStat[] = ['performance', 'technique', 'sense']
const emptyStats = (): Record<CardStat, number> => ({ performance: 0, technique: 0, sense: 0 })
const resolved = <T>(value: T): Resolution<T> => ({ status: 'resolved', value })
const unresolvedValue = <T>(reasons: string[]): Resolution<T> => ({ status: 'unresolved', value: null, reasons })
/** An unresolved input cannot become a zero term in a complete parameter total. */
function sumParameters(values: Resolution<number>[]): Resolution<number> {
  const reasons = [...new Set(values.flatMap(row => row.status === 'unresolved' ? row.reasons : []))]
  if (values.some(row => row.status === 'unresolved')) return unresolvedValue(reasons)
  const sum = values.reduce((sum, row) => sum + BigInt(row.value!), 0n)
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Parameter total exceeds safe report integer range')
  return resolved(Number(sum))
}
function parameterEffect(type: string): { stats: CardStat[]; unit: ParameterContribution['unit'] } {
  if (['ALL_PARAMETER_UP', 'ALL_PARAMETER_UP_FOR_CHARACTER_GROUPING'].includes(type)) return { stats: [...stats], unit: 'flat' }
  if (type === 'ALL_PARAMETER_UP_PERMIL_UP') return { stats: [...stats], unit: 'permil' }
  for (const stat of stats) {
    if (type === `${stat.toUpperCase()}_UP`) return { stats: [stat], unit: 'flat' }
    if (type === `${stat.toUpperCase()}_UP_PERMIL_UP`) return { stats: [stat], unit: 'permil' }
  }
  return { stats: [], unit: type.endsWith('PERMIL_UP') ? 'permil' : 'source-value' }
}

/** Values are current Level rows, not a cumulative sum of all earlier Level rows. */
export function resolveRosterBonus(profile: Pick<AppProfileV2, 'cards'>, data: ScoringData): TeamParameterReport['rosterBonus'] {
  const contributions = Object.values(profile.cards).sort((a, b) => a.cardId.localeCompare(b.cardId)).map(card => {
    const metadata = data.cards[card.cardId]
    const row = metadata && data.levelBonuses[metadata.levelGroupId]?.find(row => row.level === card.level)
    return { cardId: card.cardId, level: card.level, permyriad: row?.liveDeckPowerPermyriadUp ?? null }
  })
  const sum = contributions.reduce((sum, row) => sum + BigInt(row.permyriad ?? 0), 0n)
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Roster bonus exceeds safe report integer range')
  const missing = contributions.filter(row => row.permyriad === null).map(row => `Missing current-level roster bonus for ${row.cardId}`)
  return {
    permyriad: missing.length ? unresolvedValue(missing) : resolved(Number(sum > 5000n ? 5000n : sum)),
    formationApplication: missing.length ? unresolvedValue(['roster-metadata']) : resolved(sum === 0n ? 'identity' : 'member-subtotal-before-memory'),
    knownSubtotalPermyriad: Number(sum), capPermyriad: 5000, contributions
  }
}

export function cardSkillLevels(cardId: string, bloomStage: number, data: ScoringData): { passive: number; active: number; special: number; connect: number } {
  const card = data.cards[cardId]
  if (!card) throw new Error(`Missing scoring metadata for ${cardId}`)
  const result = { passive: 1, active: 1, special: 1, connect: 1 }
  for (const effect of data.bloomEffects[card.potentialGroupId]) {
    if (effect.bloomStage > bloomStage) continue
    switch (effect.type) {
      case 'PASSIVE_SKILL_LEVEL_UP': result.passive = effect.value; break
      case 'ACTIVE_SKILL_LEVEL_UP': result.active = effect.value; break
      case 'SPECIAL_SKILL_LEVEL_UP': result.special = effect.value; break
      case 'SKILL_TREE_CONNECT_EFFECT_LEVEL_UP': result.connect = effect.value; break
    }
  }
  return result
}

/** Pure static calculation. Callers supply a prepared profile and verified scoring data. */
export interface ObservedFormationBonuses {memoryPermil?:number;upgradePermyriad?:number}

export function resolveTeamParameters(profile: AppProfileV2, input: TeamSelection, data: ScoringData, observed?: ObservedFormationBonuses): TeamParameterReport {
  const selection = teamSelectionSchema.parse(input)
  if (new Set(selection.memberCardIds).size !== 5) throw new Error('The lineup must contain five different cards')
  const selected = selection.memberCardIds.map(cardId => {
    if (!profile.cards[cardId]) throw new Error(`Lineup card is not owned: ${cardId}`)
    const card = data.cards[cardId]
    if (!card) throw new Error(`Missing scoring metadata for lineup card ${cardId}`)
    const saved = profile.cards[cardId]
    if (!Number.isInteger(saved.level) || !data.levelBonuses[card.levelGroupId]?.some(row => row.level === saved.level) || !Number.isInteger(saved.bloomStage) || saved.bloomStage < 0 || saved.bloomStage > 5) throw new Error(`Invalid saved progression for ${cardId}`)
    return card
  })
  const memberCharacters = new Set(selected.map(card => card.characterId))
  if (memberCharacters.size !== 5) throw new Error('The lineup must contain five distinct Holomem')
  const leader = accountCharactersById.get(selection.leaderCharacterId)
  if (!leader || !profile.account.unlockedCharacterIds.includes(leader.id)) throw new Error('The selected leader must be unlocked')
  const outfit = accountCostumesById.get(selection.outfitId)
  if (!outfit || outfit.characterId !== leader.id || !availableAccountCostumes(Object.keys(profile.cards), profile.account.ownedCostumeIds).some(row => row.id === outfit.id)) throw new Error('The selected outfit must be available and belong to the leader')
  const song = data.songs[selection.songId]
  if (!song) throw new Error(`Unknown song ${selection.songId}`)
  const inGroup = (groupId: string, characterId: string): boolean => Boolean(data.groups[groupId]?.characterIds.includes(characterId))
  const contributions: ParameterContribution[] = []
  const skills: SkillReport[] = []
  const issues: UnresolvedRule[] = []
  const deferredTimelineEffects: TeamParameterReport['deferredTimelineEffects'] = []
  // ALL songs omit singer IDs. Do not mistake that omission for no singers, or
  // invent whether it includes an independent leader outside the five members.
  const songMatches = (predicate: (characterId: string) => boolean): boolean | null => song.singerType === 'all' && !song.characterIds.length ? null : song.characterIds.some(predicate)
  const condition = (trigger: ScoringTrigger): boolean | null => {
    switch (trigger.type) {
      case 'DECK_CARD_ATTRIBUTE': return selected.filter(card => accountManifest.cardParameterProfiles[card.id].attribute === trigger.attribute).length >= trigger.threshold
      case 'DECK_CARD_CHARACTER_GROUPING': return selected.filter(card => inGroup(trigger.groupId!, card.characterId)).length >= trigger.threshold
      case 'DECK_LEADER_CHARACTER': return trigger.characterIds.includes(leader.id)
      case 'DECK_LEADER_CHARACTER_GROUPING': return inGroup(trigger.groupId!, leader.id)
      case 'MUSIC_CHARACTER': return songMatches(id => trigger.characterIds.includes(id))
      default: return null
    }
  }
  const branchState = (groupId: string | null): Pick<SkillReport['branches'][number], 'status' | 'reason'> => {
    if (!groupId) return { status: 'active', reason: null }
    const triggers = data.triggers[groupId]
    if (!triggers) throw new Error(`Missing trigger ${groupId}`)
    const outcomes = triggers.map(trigger => ({ trigger, met: condition(trigger) }))
    const inactive = outcomes.filter(row => row.met === false)
    if (inactive.length) return { status: 'inactive', reason: inactive.map(row => row.trigger.description).join('; ') }
    if (outcomes.some(row => row.met === null && row.trigger.type === 'MUSIC_CHARACTER')) return { status: 'unresolved', reason: 'ALL song singer membership is not enumerated by the source' }
    if (outcomes.some(row => row.met === null)) return { status: 'deferred', reason: 'Requires live combo, judgement, or LIFE state' }
    return { status: 'active', reason: null }
  }
  const reportSkill = (skill: ScoringSkill, levelNumber: number, kind: SkillReport['kind'], source: SkillReport['source'], ownerId: string, ownerCharacterId: string): void => {
    const definition = skill.levels.find(row => row.level === levelNumber)
    if (!definition) throw new Error(`Missing ${skill.id} Level ${levelNumber}`)
    const branches = definition.branches.map(branch => ({ ...branch, ...branchState(branch.triggerGroupId) }))
    skills.push({ source, ownerId, kind, skillId: skill.id, level: levelNumber, definition: structuredClone(definition), branches })
    if (kind === 'active' || kind === 'special') {
      deferredTimelineEffects.push({ skillId: skill.id, ownerId, reason: kind === 'active' ? 'Activation timing, probability, duration and effect stacking require the timeline engine' : 'Ordered SP activation and duration require the timeline engine' })
      return
    }
    for (const branch of branches) for (const effect of data.passiveEffects[branch.effectGroupId]) {
      const target = data.targets[effect.targetId]
      const eligible = selected.filter(card => target.type === 'ALL' || target.type === 'SELF' && card.characterId === ownerCharacterId || target.type === 'ATTRIBUTE' && accountManifest.cardParameterProfiles[card.id].attribute === target.attribute || target.type === 'CHARACTER_GROUPING' && inGroup(target.groupId!, card.characterId)).map(card => card.id)
      const ambiguous = branch.status !== 'inactive' && target.targetCount !== null && eligible.length > target.targetCount
      const id = `${skill.id}:${levelNumber}:${branch.kind}:${effect.number}`
      const parameter = parameterEffect(effect.type)
      const status = branch.status === 'inactive' || eligible.length === 0 ? 'inactive' : ambiguous || branch.status === 'deferred' || branch.status === 'unresolved' ? 'unresolved' : 'active'
      const reason = branch.status === 'inactive' ? branch.reason : eligible.length === 0 ? 'No eligible lineup member' : ambiguous ? `Recipient selection is unverified: ${target.targetCount} of ${eligible.length} eligible members` : branch.reason
      contributions.push({ id, system: kind, sourceId: skill.id, ownerCharacterId, description: effect.description, type: effect.type, value: effect.value, ...parameter, recipientCardIds: eligible, status, reason, connectBonusPermil: 0, originalValue: effect.value })
      if (status === 'unresolved') issues.push({ id, sourceId: skill.id, reason: reason!, affects: eligible.flatMap(cardId => parameter.stats.length ? parameter.stats.map(stat => `${cardId}.${stat}`) : [`${cardId}.skillModifiers`]) })
    }
  }
  if (outfit.leaderSkillId) reportSkill(data.leaderSkills[outfit.leaderSkillId], 1, 'leader', 'leader', leader.id, leader.id)
  for (const card of selected) {
    const levels = cardSkillLevels(card.id, profile.cards[card.id].bloomStage, data)
    reportSkill(data.passiveSkills[card.passiveSkillId], levels.passive, 'passive', 'member', card.id, card.characterId)
    reportSkill(data.activeSkills[card.activeSkillId], levels.active, 'active', 'member', card.id, card.characterId)
    reportSkill(data.specialSkills[card.specialSkillId], levels.special, 'special', 'member', card.id, card.characterId)
  }

  const boardCondition = (effect: BoardNodeEffect, owner: string): boolean | null => {
    const trigger = effect.characterTriggerType
    if (trigger.endsWith('_SET_LIVE_LEADER') && owner !== leader.id || trigger.endsWith('_WORK')) return false
    if (!trigger.endsWith('_ALWAYS') && !trigger.endsWith('_SET_LIVE_LEADER')) return null
    const condition = effect.passiveCondition
    if (!condition) return true
    switch (condition.kind) {
      case 'song-character': return songMatches(id => condition.characterIds.includes(id))
      case 'song-group': return songMatches(id => inGroup(condition.groupId!, id))
      case 'owner-song': return songMatches(id => id === owner)
      case 'owner-singer-type': return song.singerType === condition.singerType ? songMatches(id => id === owner) : false
      default: return null
    }
  }
  const blooms = new Map(Object.values(profile.cards).map(card => [card.cardId, card.bloomStage]))
  const boardSkills = new Map<string, { level: number; learned: boolean }>()
  for (const board of Object.values(profile.account.boards).sort((a, b) => a.characterId.localeCompare(b.characterId))) {
    const nodes = resolveBoardNodes(board.characterId)
    const connected = connectedBoardNodeIds(nodes, board.unlockedNodeIds)
    const bonuses = boardConnectBonusPermilByNode(nodes, connected, board.connectAssignments, blooms)
    for (const node of nodes) {
      const effect = node.effect
      if (!connected.has(node.groupId) || !effect) continue
      const type = effect.type.replace('SkillTreeEffectType_SKILL_TREE_EFFECT_TYPE_', '')
      const activation = (node.type === 'leader' && board.characterId !== leader.id || node.type === 'card' && !memberCharacters.has(board.characterId)) ? false : boardCondition(effect, board.characterId)
      const recipients = selected.filter(card => !effect.target || boardTargetMatchesCard(effect.target, board.characterId, accountManifest.cardParameterProfiles[card.id], inGroup)).map(card => card.id)
      const parameter = parameterEffect(type)
      const status = activation === false || effect.target && recipients.length === 0 ? 'inactive' : activation === null || effect.target?.kind === 'unknown' ? 'unresolved' : 'active'
      const id = `board:${board.characterId}:${node.groupId}`
      const reason = status === 'inactive' ? 'Board role, song condition, or target does not match this selection' : status === 'unresolved' ? song.singerType === 'all' && !song.characterIds.length ? 'ALL song singer membership is not enumerated by the source' : 'Unknown Board activation or target rule' : null
      // Skill-level selectors are discrete, not Connect-amplified percentages.
      const connectBonusPermil = type.startsWith('LIVE_DECK_LEADER_ACTIVE_SKILL_') ? 0 : bonuses.get(node.groupId) ?? 0
      const value = amplifyBoardEffectValue(effect.value, connectBonusPermil)
      contributions.push({ id, system: 'board', sourceId: node.effectId ?? node.id, ownerCharacterId: board.characterId, description: node.description, type, value, ...parameter, recipientCardIds: recipients, status, reason, connectBonusPermil, originalValue: effect.value })
      if (status === 'unresolved') issues.push({ id, sourceId: node.id, reason: reason!, affects: recipients.flatMap(cardId => parameter.stats.map(stat => `${cardId}.${stat}`)) })
      if (status === 'active' && effect.liveActiveSkillId) {
        const previous = boardSkills.get(effect.liveActiveSkillId) ?? { learned: false, level: 1 }
        if (type === 'LIVE_DECK_LEADER_ACTIVE_SKILL_ADDITION') previous.learned = true
        if (type === 'LIVE_DECK_LEADER_ACTIVE_SKILL_LEVEL_UP') previous.level = Math.max(previous.level, effect.value)
        boardSkills.set(effect.liveActiveSkillId, previous)
      }
    }
  }
  for (const [id, { learned, level }] of boardSkills) if (learned) reportSkill(data.activeSkills[id], level, 'active', 'board', leader.id, leader.id)
  const memory = observed?.memoryPermil ?? memoryParameterBonusPermil(profile.account.memoriesCollected)
  if (memory) contributions.push({ id: 'memories', sourceId: `PosterCollectEffect:${profile.account.memoriesCollected}`, system: 'memory', ownerCharacterId: null, description: `${profile.account.memoriesCollected} Memories: ${memory} permil all parameters`, type: 'ALL_PARAMETER_UP_PERMIL_UP', value: memory, unit: 'permil', stats: [...stats], recipientCardIds: [...selection.memberCardIds], status: 'active', reason: null, connectBonusPermil: 0, originalValue: memory })

  const rosterBonus = observed?.upgradePermyriad===undefined ? resolveRosterBonus(profile, data) : {
    permyriad:resolved(observed.upgradePermyriad),
    formationApplication:resolved(observed.upgradePermyriad?'member-subtotal-before-memory' as const:'identity' as const),
    knownSubtotalPermyriad:observed.upgradePermyriad,capPermyriad:5000 as const,contributions:[],
  }
  const formationOutputs = selected.flatMap(card => stats.map(stat => `${card.id}.${stat}`))
  if (rosterBonus.permyriad.status === 'unresolved') issues.push({ id: 'roster-metadata', sourceId: 'CardLevel.liveDeckPowerPermyriadUp', reason: rosterBonus.permyriad.reasons.join('; '), affects: ['rosterBonus', ...formationOutputs] })

  const members = selected.map(card => {
    const saved = profile.cards[card.id]
    const inherent = resolveCardParameters(card.id, saved.level, saved.bloomStage).stats
    const received = contributions.filter(row => row.recipientCardIds.includes(card.id) && row.status !== 'inactive')
    const flat = emptyStats(), permil = emptyStats()
    const boardByType = new Map<string, number>()
    for (const row of received) if (row.system === 'board' && row.status === 'active') boardByType.set(row.type, (boardByType.get(row.type) ?? 0) + row.value)
    const knownBoardModifiers = [...boardByType].map(([type, sumBeforeCap]) => ({ type, sumBeforeCap, value: limitBoardEffectValue(`SkillTreeEffectType_SKILL_TREE_EFFECT_TYPE_${type}`, sumBeforeCap) }))
    const boardTypes = new Set(received.filter(row => row.system === 'board').map(row => row.type))
    const boardModifiers = [...boardTypes].map(type => {
      const missing = received.filter(row => row.system === 'board' && row.type === type && row.status === 'unresolved').map(row => row.id)
      const known = knownBoardModifiers.find(row => row.type === type)
      return { type, knownSumBeforeCap: known?.sumBeforeCap ?? 0, value: missing.length ? unresolvedValue<number>(missing) : resolved(known?.value ?? 0) }
    })
    for (const row of knownBoardModifiers) {
      const parameter = parameterEffect(row.type)
      for (const stat of parameter.stats) (parameter.unit === 'flat' ? flat : permil)[stat] += row.value
    }
    const boardStats = applyCardParameterBonuses(inherent, flat, permil)
    const boardStage = Object.fromEntries(stats.map(stat => {
      const missing = received.filter(row => row.system === 'board' && row.status === 'unresolved' && row.stats.includes(stat)).map(row => row.id)
      return [stat, missing.length ? unresolvedValue<number>(missing) : resolved(boardStats[stat])]
    })) as Record<CardStat, Resolution<number>>
    const { parameters, parameterTotal, unresolved, ...formationStages } = resolveFormationTotal({ cardId: card.id, inherentStats: inherent,
      inherentAndBoardStats: boardStage, contributions: received,
      rosterPermyriad: rosterBonus.permyriad.status === 'resolved' ? rosterBonus.permyriad : unresolvedValue(['roster-metadata']) })
    issues.push(...unresolved)
    return { cardId: card.id, characterId: card.characterId, level: saved.level, bloomStage: saved.bloomStage, inherentStats: inherent, inherentAndBoardStats: boardStage, boardModifiers, parameters, parameterTotal, formationStages, contributionIds: received.map(row => row.id) }
  })
  const parameterTotals = Object.fromEntries(stats.map(stat => {
    const values = members.map(row => row.parameters[stat])
    return [stat, sumParameters(values)]
  })) as Record<CardStat, Resolution<number>>
  const parameterTotal = sumParameters(members.map(member => member.parameterTotal))
  return { modelVersion: SCORING_MODEL_VERSION, status: issues.length ? 'unresolved' : 'resolved', selection, song: structuredClone(song), leader: { characterId: leader.id, name: leader.name, outfitId: outfit.id, outfitName: outfit.name }, members, parameterTotals, parameterTotal, overallPower: resolveOverallPower(members), rosterBonus, contributions, skills, deferredTimelineEffects, unresolved: issues }
}
