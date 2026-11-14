import { exactFraction, type ExactFraction } from './chart-timeline'

export const SKILL_EXPECTATION_MODEL_VERSION = 'skill-expectation-v1'

/** One independently sampled, hypothetical activation attempt. Probabilities
 * must already include any assumed modifiers. This is not an observed success.
 * Primary/additional branches of one attempt must not be separate attempts.
 */
export interface SkillAttempt {
  id: string
  startMicroseconds: number
  endMicroseconds: number
  probabilityPermil: number
  scoreUpPermil: number
}

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Expected nonnegative safe integer ${label}`)
}
function validateChance(value: number): void {
  integer(value, 'probability')
  if (value > 1000) throw new Error('Probability exceeds 1000 permil')
}

/** E[max] for independent Bernoulli outcomes, including the all-failed outcome.
 * Exact arithmetic evaluates the supplied probability model, not game rules.
 */
export function expectedMaximumPermil(outcomes: readonly Pick<SkillAttempt, 'probabilityPermil' | 'scoreUpPermil'>[]): ExactFraction {
  for (const outcome of outcomes) {
    validateChance(outcome.probabilityPermil)
    integer(outcome.scoreUpPermil, 'Score UP coefficient')
  }
  const sorted = outcomes.filter(row => row.probabilityPermil > 0 && row.scoreUpPermil > 0)
    .slice().sort((a, b) => b.scoreUpPermil - a.scoreUpPermil)
  let numerator = 0n, denominator = 1n, survival = 1n
  for (const row of sorted) {
    numerator = numerator * 1000n + survival * BigInt(row.scoreUpPermil) * BigInt(row.probabilityPermil)
    denominator *= 1000n
    survival *= 1000n - BigInt(row.probabilityPermil)
    if (survival === 0n) break
  }
  return exactFraction(numerator, denominator)
}

function addWeighted(sum: ExactFraction, value: ExactFraction, weight: number): ExactFraction {
  const a = BigInt(sum.denominator), b = BigInt(value.denominator)
  return exactFraction(BigInt(sum.numerator) * b + BigInt(value.numerator) * BigInt(weight) * a, a * b)
}

/** Continuous-time diagnostic for an explicit independent-attempt schedule.
 * Simultaneous edges are processed together. [start,end) is a mathematical
 * convention for integration; it does not establish game note/skill tie order.
 * Zero baseline means no active Score UP, not zero base game score.
 */
export function evaluateSkillExpectation(durationMicroseconds: number, attempts: readonly SkillAttempt[]) {
  integer(durationMicroseconds, 'duration')
  if (durationMicroseconds === 0 || durationMicroseconds > 0xffff_ffff) throw new Error('Duration must be positive and within chart timing range')
  if (attempts.length > 5000) throw new Error('Too many activation attempts')
  const ids = new Set<string>()
  const edges: Array<{ time: number; index: number; starting: boolean }> = []
  for (const [index, attempt] of attempts.entries()) {
    if (!attempt.id || ids.has(attempt.id)) throw new Error('Missing or duplicate attempt ID')
    ids.add(attempt.id)
    integer(attempt.startMicroseconds, 'attempt start')
    integer(attempt.endMicroseconds, 'attempt end')
    validateChance(attempt.probabilityPermil)
    integer(attempt.scoreUpPermil, 'Score UP coefficient')
    if (attempt.endMicroseconds < attempt.startMicroseconds || attempt.startMicroseconds > durationMicroseconds) throw new Error('Invalid attempt timing')
    const end = Math.min(attempt.endMicroseconds, durationMicroseconds)
    if (end === attempt.startMicroseconds || attempt.probabilityPermil === 0 || attempt.scoreUpPermil === 0) continue
    edges.push({ time: attempt.startMicroseconds, index, starting: true }, { time: end, index, starting: false })
  }
  edges.sort((a, b) => a.time - b.time)
  const intervals: Array<{ startMicroseconds: number; endMicroseconds: number; expectedMaximumPermil: ExactFraction }> = []
  const active = new Set<number>()
  let cursor = 0, previousTime = 0
  let integral = exactFraction(0n, 1n)
  const append = (end: number) => {
    if (end === previousTime) return
    const expected = expectedMaximumPermil([...active].map(index => attempts[index]))
    intervals.push({ startMicroseconds: previousTime, endMicroseconds: end, expectedMaximumPermil: expected })
    integral = addWeighted(integral, expected, end - previousTime)
    previousTime = end
  }
  while (cursor < edges.length) {
    const time = edges[cursor].time
    append(time)
    while (cursor < edges.length && edges[cursor].time === time) {
      const edge = edges[cursor++]
      if (edge.starting) active.add(edge.index)
      else active.delete(edge.index)
    }
  }
  append(durationMicroseconds)
  return {
    modelVersion: SKILL_EXPECTATION_MODEL_VERSION,
    interpretation: 'hypothetical-independent-attempts' as const,
    durationMicroseconds, intervals,
    coefficientTimePermilMicroseconds: integral,
    meanScoreUpPermil: exactFraction(BigInt(integral.numerator), BigInt(integral.denominator) * BigInt(durationMicroseconds))
  }
}
