import { exactFraction, type ExactFraction } from './chart-timeline'
import { calculatePerfectScoreGroup, type PerfectEvent, type PerfectGroupInputs } from './live-score-trace'
import { officialComboMultiplierPermil } from './optimizer-chart-pack'

const fraction = (value: ExactFraction) => exactFraction(BigInt(value.numerator), BigInt(value.denominator))
const integer = (value: number) => exactFraction(BigInt(value), 1n)
export const addScoreFractions = (a: ExactFraction, b: ExactFraction) => exactFraction(BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator))
const multiply = (a: ExactFraction, b: ExactFraction) => exactFraction(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator))
const subtract = (a: ExactFraction, b: ExactFraction) => exactFraction(BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator))
const compare = (a: ExactFraction, b: ExactFraction) => {
  const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator)
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}
const zero = integer(0), one = integer(1)
export const expectedScoreBounds = (lower: ExactFraction, upper: ExactFraction) => {
  if (compare(lower, upper) > 0) throw new Error('Invalid expected score bounds')
  return { lower, upper, exact: compare(lower, upper) === 0 ? lower : null }
}
export interface SupportedAttempt { attemptId: string; probability: ExactFraction; supportedScoreUpPermil: ExactFraction }

/** Distribution of the strongest supported successful Active. Independent
 * Bernoulli attempts are an explicit hypothetical model, not a client PRNG claim.
 * Primary/additional branches must already be combined into their single proc.
 */
export function supportedActiveDistribution(attempts: readonly SupportedAttempt[]) {
  const seen = new Set<string>()
  const rows = attempts.map(attempt => {
    if (!attempt.attemptId || seen.has(attempt.attemptId)) throw new Error('Missing or duplicate attempt ID')
    seen.add(attempt.attemptId)
    const probability = fraction(attempt.probability), strength = fraction(attempt.supportedScoreUpPermil)
    if (compare(probability, one) > 0) throw new Error('Probability exceeds one')
    const ratio = Number(strength.numerator) / Number(strength.denominator) / 1000
    if (!Number.isFinite(ratio) || ratio < 0 || !Number.isFinite(Math.fround(ratio))) throw new Error('Invalid supported skill ratio')
    return { probability, strength, skillScoreUpRatio: Math.fround(ratio) }
  }).sort((a, b) => compare(b.strength, a.strength))
  let survival = one
  const outcomes = []
  for (const row of rows) {
    const probability = multiply(survival, row.probability)
    if (probability.numerator !== '0') outcomes.push({ probability, skillScoreUpRatio: row.skillScoreUpRatio })
    survival = multiply(survival, subtract(one, row.probability))
    if (survival.numerator === '0') break
  }
  if (survival.numerator !== '0') outcomes.push({ probability: survival, skillScoreUpRatio: 0 })
  return outcomes
}

/** E[integer award], not ceil(score with E[skill]). Tie bounds assign combo
 * slots after averaging each note's awards. Choosing a different tie order
 * for each random outcome would instead compute E[min/max], a different claim.
 */
export function calculateExpectedPerfectGroup(input: Omit<PerfectGroupInputs, 'skillScoreUpRatio'>, events: readonly PerfectEvent[], offset: number, attempts: readonly SupportedAttempt[]) {
  const outcomes = supportedActiveDistribution(attempts)
  const totals = events.map(() => ({ lower: zero, upper: zero }))
  for (const outcome of outcomes) {
    const scored = calculatePerfectScoreGroup({ ...input, skillScoreUpRatio: outcome.skillScoreUpRatio }, events, offset)
    scored.notes.forEach((note, index) => {
      totals[index].lower = addScoreFractions(totals[index].lower, multiply(outcome.probability, integer(note.points.lower)))
      totals[index].upper = addScoreFractions(totals[index].upper, multiply(outcome.probability, integer(note.points.upper)))
    })
  }
  const end = offset + events.length
  const lowBonus = officialComboMultiplierPermil(offset + 1) - 1000
  const highBonus = officialComboMultiplierPermil(end) - 1000
  const highSlots = lowBonus === highBonus ? 0 : end - highBonus / 10 * 100 + 1
  const deltas = totals.map(row => subtract(row.upper, row.lower)).sort(compare)
  const base = totals.reduce((sum, row) => addScoreFractions(sum, row.lower), zero)
  const lower = deltas.slice(0, highSlots).reduce(addScoreFractions, base)
  const upper = highSlots ? deltas.slice(-highSlots).reduce(addScoreFractions, base) : base
  return { timeMicroseconds: events[0].timeMicroseconds, comboFrom: offset + 1, comboTo: end, outcomes,
    notes: events.map((event, index) => ({ eventIndex: offset + index, noteType: event.noteType,
      perfectCoefficientPermil: event.perfectCoefficientPermil, expectedPoints: expectedScoreBounds(totals[index].lower, totals[index].upper) })),
    expectedPoints: expectedScoreBounds(lower, upper) }
}
