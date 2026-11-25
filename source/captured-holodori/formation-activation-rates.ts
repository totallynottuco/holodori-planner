import { limitBoardEffectValue, resolveBoardNodes } from '../hololive/vendor/shared/account-data'
import { clientActivationProbability } from '../hololive/vendor/shared/live-skill-arithmetic'
import { resolveStaticSkillModifier, singleSourceModifier } from '../hololive/vendor/shared/static-skill-modifiers'
import type { TeamParameterReport } from '../hololive/vendor/shared/team-parameters'

const rateType = 'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP'
const boardType = 'SkillTreeEffectType_SKILL_TREE_EFFECT_TYPE_' + rateType
const lunaPassive = 'live_passive_skill-card-00028-5-uniq-0121-00'

/** Isolate the two formation effects, before any temporary chart effects. */
function isolatedRates(team: TeamParameterReport, mobile: boolean) {
  const passive = team.contributions.find(row => row.system === 'passive' && row.sourceId === lunaPassive && row.type === rateType)
  if (!passive || passive.status === 'unresolved') return null
  const leader = team.leader.characterId
  const board = team.contributions.find(row => row.id === `board:${leader}:R-064` && row.type === rateType)
  const effect = resolveBoardNodes(leader).find(node => node.groupId === 'R-064')?.effect
  if (!effect || effect.type !== boardType || effect.target?.kind !== 'all' ||
      !effect.characterTriggerType.endsWith('_SET_LIVE_LEADER') || effect.passiveCondition ||
      (board && board.status !== 'active')) return null
  const boardPermil = limitBoardEffectValue(boardType, board?.value ?? effect.value)
  const rows = []
  for (const id of team.selection.memberCardIds) {
    const skill = team.skills.find(row => row.source === 'member' && row.kind === 'active' && row.ownerId === id)
    const base = skill?.definition.activationProbabilityPermil
    if (base == null) return null
    const luna = passive.status === 'active' && passive.recipientCardIds.includes(id) ? passive.value : 0
    const node = !board || board.recipientCardIds.includes(id) ? boardPermil : 0
    const both = singleSourceModifier([luna, node])
    const rate = (modifier: number) => Math.min(1000, clientActivationProbability(base, modifier, [], []).effectivePermil)
    const uncertain = mobile && passive.possiblePassiveRecipientIds?.includes(id)
    rows.push({ id, lunaOnly: uncertain ? null : rate(luna), boardOnly: rate(node), both: uncertain || both === null ? null : rate(both) })
  }
  return { rows, boardEquipped: Boolean(board) }
}

export function formationActivationRates(team: TeamParameterReport, mobile: boolean) {
  const isolated = isolatedRates(team, mobile)
  if (!mobile) return isolated
  const rows = team.selection.memberCardIds.map((id, slot) => {
    const skill = team.skills.find(row => row.kind === 'active' && row.source === 'member' && row.ownerId === id)
    const base = skill?.definition.activationProbabilityPermil ?? null
    const modifier = skill && resolveStaticSkillModifier(team, skill, rateType, 'verified-only').value
    const uncertain = team.contributions.some(row => row.type === rateType && row.possiblePassiveRecipientIds?.includes(id))
    const permanent = base !== null && modifier?.status === 'resolved' && !uncertain
      ? Math.min(1000, clientActivationProbability(base, modifier.value, [], []).effectivePermil) : null
    return { ...isolated?.rows[slot], id, base, permanent }
  })
  return { rows, mobile: true, isolated: Boolean(isolated), boardEquipped: isolated?.boardEquipped }
}
