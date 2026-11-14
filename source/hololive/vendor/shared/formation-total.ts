import type { CardStat } from './types'
import type { ParameterContribution, Resolution, UnresolvedRule } from './team-parameters'

export const FORMATION_TOTAL_MODEL_VERSION = 'formation-total-v3'
const stats: CardStat[] = ['performance', 'technique', 'sense']
type Parameters = Record<CardStat, Resolution<number>>
const resolved = (value: number): Resolution<number> => ({ status: 'resolved', value })
const missing = (reasons: string[]): Resolution<number> => ({ status: 'unresolved', value: null, reasons: [...new Set(reasons)] })
const reasonsOf = (values: Resolution<number>[]) => values.flatMap(value => value.status === 'unresolved' ? value.reasons : [])
function integer(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Formation arithmetic requires nonnegative safe integers')
  return BigInt(value)
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Formation result exceeds safe integer range')
  return Number(value)
}
function ceilRatio(numerator: bigint, denominator: bigint): number {
  return safeNumber((numerator + denominator - 1n) / denominator)
}
function sum(values: Resolution<number>[]): Resolution<number> {
  if (values.some(value => value.status === 'unresolved')) return missing(reasonsOf(values))
  return resolved(safeNumber(values.reduce((sum, value) => sum + integer(value.value!), 0n)))
}

/**
 * Reference-backed formation total, distinct from game Unit Score.
 * Preserve the existing Board stage. Round one leader/passive/Memory bonus
 * per stat upward on inherent stats. Sum two independent passive coefficients
 * before rounding, following the reviewed Dreams Lab rule. Apply roster to the whole
 * pre-Memory subtotal, round once, then add the rounded Memory bonuses.
 * See docs/scoring-rules.md for observed evidence and unsupported stacking.
 */
export function resolveFormationTotal(input: {
  cardId: string
  inherentStats: Record<CardStat, number>
  inherentAndBoardStats: Parameters
  contributions: readonly ParameterContribution[]
  rosterPermyriad: Resolution<number>
}) {
  const issues: UnresolvedRule[] = []
  const sourceNotes = new Set<string>()
  for (const value of Object.values(input.inherentStats)) integer(value)
  if (input.rosterPermyriad.status === 'resolved' && integer(input.rosterPermyriad.value) > 5000n) throw new Error('Formation roster bonus exceeds the reviewed cap')
  const received = input.contributions.filter(row => row.recipientCardIds.includes(input.cardId) && row.status !== 'inactive' && row.value !== 0)
  const bonuses = Object.fromEntries((['leader', 'passive', 'memory'] as const).map(system => {
    const values = Object.fromEntries(stats.map(stat => {
      const rows = received.filter(row => row.system === system && row.stats.includes(stat))
      const unknown = rows.filter(row => row.status === 'unresolved').map(row => row.id)
      if (unknown.length) return [stat, missing(unknown)]
      const unsupported = rows.filter(row => row.unit !== 'permil')
      if (unsupported.length) {
        const ids = unsupported.map(row => {
          const id = `application:${row.id}:${stat}`
          issues.push({ id, sourceId: row.sourceId, reason: `Unsupported ${system} parameter unit ${row.unit}`, affects: [`${input.cardId}.${stat}`, `${input.cardId}.parameterTotal`] })
          return id
        })
        return [stat, missing(ids)]
      }
      if (rows.length > 1) {
        const id = `stacking:${input.cardId}:${system}:${stat}`
        // The controlled Suisei swap establishes addition; Dreams Lab's guide
        // and published Un implementation specify summing rates before ceiling.
        // Keep the established scope: two distinct member skills, known targets.
        const independentPassives = system === 'passive' && rows.length === 2 &&
          rows.every(row => row.ownerCharacterId !== null) && rows[0].ownerCharacterId !== rows[1].ownerCharacterId &&
          rows[0].sourceId !== rows[1].sourceId
        if (independentPassives) {
          sourceNotes.add('Two-member passive percentages are summed before rounding per stat, following Dreams Lab. This is community-source evidence; the current-team rounding difference still needs an in-game check.')
          const base = integer(input.inherentStats[stat])
          const combined = ceilRatio(base * rows.reduce((total, row) => total + integer(row.value), 0n), 1000n)
          return [stat, resolved(combined)]
        }
        const reason = `Multiple ${system} modifiers affect ${stat}; their combination and rounding are not covered by the formation references`
        issues.push({ id, sourceId: rows.map(row => row.sourceId).join(', '), reason, affects: [`${input.cardId}.${stat}`, `${input.cardId}.parameterTotal`] })
        return [stat, missing([id])]
      }
      const row = rows[0]
      if (!row) return [stat, resolved(0)]
      return [stat, resolved(ceilRatio(integer(input.inherentStats[stat]) * integer(row.value), 1000n))]
    })) as Parameters
    return [system, values]
  })) as Record<'leader' | 'passive' | 'memory', Parameters>
  const beforeRosterParameters = Object.fromEntries(stats.map(stat => [stat, sum([input.inherentAndBoardStats[stat], bonuses.leader[stat], bonuses.passive[stat]])])) as Parameters
  const beforeRosterTotal = sum(Object.values(beforeRosterParameters))
  const memoryTotal = sum(Object.values(bonuses.memory))
  const afterRosterTotal = beforeRosterTotal.status === 'resolved' && input.rosterPermyriad.status === 'resolved'
    ? resolved(ceilRatio(integer(beforeRosterTotal.value) * (10000n + integer(input.rosterPermyriad.value)), 10000n))
    : missing(reasonsOf([beforeRosterTotal, input.rosterPermyriad]))
  const rosterIncrease = beforeRosterTotal.status === 'resolved' && afterRosterTotal.status === 'resolved'
    ? resolved(afterRosterTotal.value - beforeRosterTotal.value) : missing(reasonsOf([beforeRosterTotal, afterRosterTotal]))
  const parameterTotal = sum([afterRosterTotal, memoryTotal])
  const allocationId = `roster-stat-allocation:${input.cardId}`
  if (input.rosterPermyriad.status === 'resolved' && input.rosterPermyriad.value > 0) issues.push({
    id: allocationId, sourceId: 'CardLevel.liveDeckPowerPermyriadUp', reason: 'Roster rounding is established for the whole member subtotal; assigning its rounded increase to individual Performance/Technique/Sense values is unverified',
    affects: stats.map(stat => `${input.cardId}.${stat}`)
  })
  const parameters = Object.fromEntries(stats.map(stat => {
    const value = sum([beforeRosterParameters[stat], bonuses.memory[stat]])
    if (input.rosterPermyriad.status === 'unresolved') return [stat, missing([...reasonsOf([value]), ...input.rosterPermyriad.reasons])]
    return [stat, input.rosterPermyriad.value === 0 ? value : missing([...reasonsOf([value]), allocationId])]
  })) as Parameters
  return { modelVersion: FORMATION_TOTAL_MODEL_VERSION, bonuses, beforeRosterParameters, beforeRosterTotal,
    rosterIncrease, afterRosterTotal, memoryTotal, parameterTotal, parameters, unresolved: issues, sourceNotes: [...sourceNotes] }
}
