import type { Resolution, SkillReport, TeamParameterReport } from './team-parameters'

export const STATIC_SKILL_MODIFIER_TYPES = [
  'LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP',
  'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP',
  'LIVE_ACTIVE_SKILL_COOL_TIME_SHORTEN_PERMIL_UP'
] as const
export type StaticSkillModifierType = typeof STATIC_SKILL_MODIFIER_TYPES[number]
export type StaticModifierPolicy = 'verified-only' | 'additive-assumption'
export function singleSourceModifier(values: readonly number[]): number | null {
  const nonzero = values.filter(value => value !== 0)
  return nonzero.length > 1 ? null : nonzero[0] ?? 0
}
const known = (value: number): Resolution<number> => ({ status: 'resolved', value })
const missing = (reasons: string[]): Resolution<number> => ({ status: 'unresolved', value: null, reasons: [...new Set(reasons)] })

export interface StaticSkillModifierReport {
  ownerId: string
  skillId: string
  type: StaticSkillModifierType
  policy: StaticModifierPolicy
  sources: Array<{ id: string; system: 'board' | 'leader' | 'passive' | 'memory'; ownerCharacterId: string | null; description: string; value: Resolution<number> }>
  additiveEstimate: Resolution<number>
  value: Resolution<number>
  explanation: string
}

/** Preserve the existing strict gate and additive diagnostic, exposing the
 * exact inputs used by the live engine instead of recalculating them in UI. */
export function resolveStaticSkillModifier(team: TeamParameterReport, skill: SkillReport, type: StaticSkillModifierType, policy: StaticModifierPolicy): StaticSkillModifierReport {
  if (!STATIC_SKILL_MODIFIER_TYPES.includes(type) || !['verified-only', 'additive-assumption'].includes(policy)) throw new Error('Unknown static skill modifier or policy')
  const sources: StaticSkillModifierReport['sources'] = []
  const finish = (additiveEstimate: Resolution<number>, value: Resolution<number>, explanation: string) => structuredClone({ ownerId: skill.ownerId, skillId: skill.skillId, type, policy, sources, additiveEstimate, value, explanation })
  if (skill.source === 'board') return finish(known(0), known(0), 'The reviewed client gives Board-granted Active skills no card modifiers.')
  const member = team.members.find(row => row.cardId === skill.ownerId)
  if (!member) return finish(missing([`board-active-modifiers:${skill.skillId}`]), missing([`board-active-modifiers:${skill.skillId}`]), 'Skill owner is absent from the selected members.')
  const board = member.boardModifiers.find(row => row.type === type)?.value ?? known(0)
  sources.push({ id: `board:${member.cardId}:${type}`, system: 'board', ownerCharacterId: null, description: 'Holomem Board, including Connect amplification and caps', value: board })
  for (const row of team.contributions) {
    if (row.system === 'board' || row.type !== type || row.status === 'inactive' || !row.recipientCardIds.includes(skill.ownerId)) continue
    sources.push({ id: row.id, system: row.system, ownerCharacterId: row.ownerCharacterId, description: row.description, value: row.status === 'active' ? known(row.value) : missing([`support-recipient:${row.id}`]) })
  }
  const reasons = sources.flatMap(row => row.value.status === 'unresolved' ? row.value.reasons : [])
  for (const row of sources) if (row.value.status === 'resolved' && (!Number.isSafeInteger(row.value.value) || row.value.value < 0)) throw new Error('Invalid static skill modifier coefficient')
  if (reasons.length) return finish(missing(reasons), missing(reasons), 'A source or its recipient is unresolved; its value is not treated as zero.')
  const total = sources.reduce((sum, row) => sum + BigInt(row.value.value!), 0n)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Static skill modifier exceeds the safe integer range')
  const estimate = known(Number(total))
  const multiple = singleSourceModifier(sources.map(row => row.value.value!)) === null
  if (multiple && policy === 'verified-only') return finish(estimate, missing([`static-modifier-composition:${skill.ownerId}:${type}`]), 'The source values are known, but their combined server value is unverified. The additive estimate is shown separately and is not used in strict scoring.')
  return finish(estimate, estimate, multiple ? 'Assumes these sources add. Server composition and rounding remain unverified.' : 'Only one nonzero source applies; no cross-source stacking assumption is needed.')
}

export function resolveStaticSkillModifiers(team: TeamParameterReport, policy: StaticModifierPolicy) {
  return team.skills.filter(skill => skill.kind === 'active').flatMap(skill => STATIC_SKILL_MODIFIER_TYPES.map(type => resolveStaticSkillModifier(team, skill, type, policy)))
}
