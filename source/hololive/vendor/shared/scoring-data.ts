import { z } from 'zod'
import { accountManifest } from './account-data'
import type { ProgressionManifest } from './types'

const id = z.string().min(1)
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const description = { descriptionId: id, description: z.string().min(1) }
const attribute = z.enum(['cute', 'pure', 'happy'])
export const passiveEffectTypes = ['PERFORMANCE_UP_PERMIL_UP', 'TECHNIQUE_UP_PERMIL_UP', 'SENSE_UP_PERMIL_UP', 'ALL_PARAMETER_UP_PERMIL_UP', 'LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP', 'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP'] as const
export const activeEffectTypes = ['SCORE_UP_PERMIL_UP', 'JUDGEMENT_ENHANCE', 'LIFE_RECOVERY', 'SCORE_UP_EFFECT_UP_PERMIL_UP', 'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP'] as const
export const triggerTypes = ['COMBO_GTE', 'DECK_CARD_ATTRIBUTE', 'DECK_CARD_CHARACTER_GROUPING', 'DECK_LEADER_CHARACTER', 'DECK_LEADER_CHARACTER_GROUPING', 'JUDGEMENT_TYPE_GTE', 'LIFE_GTE', 'LIFE_LTE', 'MUSIC_CHARACTER'] as const
export const bloomEffectTypes = ['ACTIVE_SKILL_LEVEL_UP', 'ALL_PARAMETER_UP_PERMIL_UP', 'SPECIAL_SKILL_LEVEL_UP', 'PASSIVE_SKILL_LEVEL_UP', 'SKILL_TREE_CONNECT_EFFECT_LEVEL_UP'] as const
const branch = z.object({ kind: z.enum(['primary', 'additional']), effectGroupId: id, triggerGroupId: id.nullable() }).strict()
const skill = z.object({ id, levels: z.array(z.object({
  level: uint.min(1).max(2), branches: z.array(branch).min(1).max(2),
  cooldownMilliseconds: uint.nullable(), durationMilliseconds: uint.nullable(),
  activationProbabilityPermil: uint.max(1000).nullable(), ...description
}).strict()).min(1).max(2) }).strict()

export const scoringDataSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: z.object({ sourceRepository: id, sourceCommit: id, catalogVersion: id,
    sourceTableSha256: z.record(id, z.string().regex(/^[a-f0-9]{64}$/)),
    chartIndexSha256: id, chartBlobSha256: id
  }).strict(),
  cards: z.record(id, z.object({ id, characterId: id, levelGroupId: id, potentialGroupId: id, passiveSkillId: id, activeSkillId: id, specialSkillId: id }).strict()),
  characterIds: z.array(id).min(1),
  groups: z.record(id, z.object({ id, name: id, characterIds: z.array(id).min(1) }).strict()),
  songs: z.record(id, z.object({ id, title: id, titleId: id, characterIds: z.array(id), singerType: z.enum(['solo', 'group', 'all']), scoreCoefficientPermil: uint, comboGroupId: id }).strict()),
  levelBonuses: z.record(id, z.array(z.object({ level: uint.min(1), liveDeckPowerPermyriadUp: uint }).strict()).min(1)),
  bloomEffects: z.record(id, z.array(z.object({ bloomStage: uint.min(1).max(5), type: z.enum(bloomEffectTypes), value: uint }).strict()).min(1)),
  leaderSkills: z.record(id, skill), passiveSkills: z.record(id, skill), activeSkills: z.record(id, skill), specialSkills: z.record(id, skill),
  passiveEffects: z.record(id, z.array(z.object({ number: uint.min(1), type: z.enum(passiveEffectTypes), value: uint, targetId: id, ...description }).strict()).min(1)),
  activeEffects: z.record(id, z.array(z.object({ number: uint.min(1), type: z.enum(activeEffectTypes), value: uint, ...description }).strict()).min(1)),
  targets: z.record(id, z.object({ id, type: z.enum(['ALL', 'ATTRIBUTE', 'CHARACTER_GROUPING', 'SELF']), targetCount: uint.min(1).max(5).nullable(), attribute: attribute.nullable(), groupId: id.nullable(), ...description }).strict()),
  triggers: z.record(id, z.array(z.object({ number: uint.min(1), type: z.enum(triggerTypes), threshold: uint, attribute: attribute.nullable(), groupId: id.nullable(), characterIds: z.array(id), judgementType: z.enum(['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS']).nullable(), ...description }).strict()).min(1)),
  comboGroups: z.record(id, z.array(z.object({ comboCountFrom: uint, scoreUpPermil: uint }).strict()).min(1))
}).strict()

export type ScoringData = z.infer<typeof scoringDataSchema>
export type ScoringSkill = ScoringData['passiveSkills'][string]
export type ScoringTrigger = ScoringData['triggers'][string][number]

/** Canonical JSON: sorted object keys; array ordering remains meaningful. */
export function canonicalScoringJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalScoringJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalScoringJson(entry)}`).join(',')}}`
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('Scoring identity requires JSON values')
  return json
}

/** Structural/reference validation shared by import, verification and CLI loading. */
export function validateScoringData(input: unknown, catalog: {
  metadata: Pick<ProgressionManifest['metadata'], 'sourceCommit' | 'sourceRepository' | 'catalogVersion'>;
  cards: readonly {id: string}[];
}, musicIds: readonly string[], account = accountManifest): ScoringData {
  const data = scoringDataSchema.parse(input)
  const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Scoring data: ${message}`) }
  const sameIds = (actual: string[], expected: string[], label: string): void => require(canonicalScoringJson(actual.sort()) === canonicalScoringJson(expected.sort()), `${label} coverage mismatch`)
  require(data.metadata.sourceCommit === catalog.metadata.sourceCommit && data.metadata.sourceRepository === catalog.metadata.sourceRepository && data.metadata.catalogVersion === catalog.metadata.catalogVersion, 'source/catalog mismatch')
  require(account.metadata.sourceCommit === data.metadata.sourceCommit && account.metadata.catalogVersion === data.metadata.catalogVersion, 'account source mismatch')
  sameIds(Object.keys(data.cards), catalog.cards.map(card => card.id), 'card')
  sameIds(Object.keys(data.songs), [...musicIds], 'song')
  require(Object.keys(data.groups).length === 16 && data.groups['grp-indonesia'], 'official group coverage mismatch')
  const characters = new Set(data.characterIds)
  require(characters.size === data.characterIds.length && account.characters.every(row => characters.has(row.id)), 'character coverage mismatch')
  for (const [key, group] of Object.entries(data.groups)) require(key === group.id && new Set(group.characterIds).size === group.characterIds.length && group.characterIds.every(id => characters.has(id)), `invalid group ${key}`)
  const playable = new Set(account.characters.map(row => row.id))
  for (const group of account.groups) sameIds(data.groups[group.id]?.characterIds.filter(id => playable.has(id)) ?? [], group.characterIds.slice(), `group ${group.id}`)
  for (const [key, card] of Object.entries(data.cards)) {
    const base = account.cardParameterProfiles[key]
    require(key === card.id && base && base.characterId === card.characterId && base.levelGroupId === card.levelGroupId && base.potentialGroupId === card.potentialGroupId, `card/account relationship ${key}`)
    require(data.passiveSkills[card.passiveSkillId] && data.activeSkills[card.activeSkillId] && data.specialSkills[card.specialSkillId], `missing card skill ${key}`)
    require(data.bloomEffects[card.potentialGroupId] && data.levelBonuses[card.levelGroupId], `missing progression ${key}`)
  }
  for (const [key, levels] of Object.entries(data.levelBonuses)) {
    require(levels.every((row, index) => row.level === index + 1), `noncontiguous levels ${key}`)
    require(levels.length === account.cardLevelBases[key]?.length, `account Level coverage ${key}`)
  }
  sameIds(Object.keys(data.levelBonuses), Object.keys(account.cardLevelBases), 'Level group')
  for (const [key, effects] of Object.entries(data.bloomEffects)) {
    require(effects.length === 5 && effects.every((row, index) => row.bloomStage === index + 1), `Bloom coverage ${key}`)
    for (const effect of effects) if (effect.type !== 'ALL_PARAMETER_UP_PERMIL_UP') require(effect.value === 2, `unsupported skill level ${key}`)
  }
  for (const costume of account.costumes) require(!costume.leaderSkillId || data.leaderSkills[costume.leaderSkillId], `missing outfit skill ${costume.id}`)
  for (const group of Object.values(account.nodeGroups)) for (const node of group.variants) require(!node.effect?.liveActiveSkillId || data.activeSkills[node.effect.liveActiveSkillId], `missing Board skill ${node.id}`)
  for (const [kind, skills] of Object.entries({ leader: data.leaderSkills, passive: data.passiveSkills, active: data.activeSkills, special: data.specialSkills })) {
    for (const [key, skill] of Object.entries(skills)) {
      require(key === skill.id && skill.levels.every((row, index) => row.level === index + 1), `skill level identity ${key}`)
      require(kind === 'leader' ? skill.levels.length === 1 : kind === 'active' && !key.startsWith('live_active_skill-card-') || skill.levels.length === 2, `skill level coverage ${key}`)
      for (const level of skill.levels) {
        require(level.branches[0].kind === 'primary' && (level.branches.length === 1 || level.branches[1].kind === 'additional'), `skill branches ${key}`)
        require(kind === 'active' ? level.cooldownMilliseconds !== null && level.activationProbabilityPermil !== null && level.durationMilliseconds !== null : level.cooldownMilliseconds === null && level.activationProbabilityPermil === null, `skill timing ${key}`)
        require(kind === 'special' ? level.durationMilliseconds !== null : kind === 'active' || level.durationMilliseconds === null, `skill duration ${key}`)
        for (const branch of level.branches) require((kind === 'leader' || kind === 'passive' ? data.passiveEffects : data.activeEffects)[branch.effectGroupId] && (!branch.triggerGroupId || data.triggers[branch.triggerGroupId]), `missing skill branch reference ${key}`)
      }
    }
  }
  for (const [key, song] of Object.entries(data.songs)) require(key === song.id && song.characterIds.every(id => characters.has(id)) && data.comboGroups[song.comboGroupId], `song reference ${key}`)
  for (const [key, target] of Object.entries(data.targets)) require(key === target.id && (target.type !== 'ATTRIBUTE' || target.attribute) && (target.type !== 'CHARACTER_GROUPING' || target.groupId && data.groups[target.groupId]), `target reference ${key}`)
  for (const [key, effects] of Object.entries(data.passiveEffects)) require(effects.every((row, index) => row.number === index + 1 && data.targets[row.targetId]), `passive effect reference ${key}`)
  for (const [key, effects] of Object.entries(data.activeEffects)) require(effects.every((row, index) => row.number === index + 1), `active effect sequence ${key}`)
  for (const [key, triggers] of Object.entries(data.triggers)) for (const [index, trigger] of triggers.entries()) {
    require(trigger.number === index + 1 && (!trigger.groupId || data.groups[trigger.groupId]) && trigger.characterIds.every(id => characters.has(id)), `trigger reference ${key}`)
    require(!trigger.type.includes('ATTRIBUTE') || trigger.attribute, `missing trigger attribute ${key}`)
    require(!trigger.type.includes('GROUPING') || trigger.groupId, `missing trigger group ${key}`)
    require(!['DECK_LEADER_CHARACTER', 'MUSIC_CHARACTER'].includes(trigger.type) || trigger.characterIds.length, `missing trigger characters ${key}`)
    require(trigger.type !== 'JUDGEMENT_TYPE_GTE' || trigger.judgementType, `missing judgement ${key}`)
  }
  return data
}
