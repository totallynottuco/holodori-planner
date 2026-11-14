import { exactFraction, prepareTimelineNotes, type ExactFraction, type ChartTimelineReport } from './chart-timeline'
import { LIVE_SKILL_MODEL_VERSION, resolveLiveSkillModel } from './live-skill-model'
import { clientFloatFraction, clientSkillScoreRatio } from './live-skill-client'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import type { ScoringData } from './scoring-data'

export const NORMALIZATION_AUDIT_VERSION = 'source-normalization-audit-v1'
export const NORMALIZATION_SOURCE = 'https://github.com/ace-ks-dev/holodori-optimizer/blob/d5bd12a03abc074cc3892a703d879ae53dcd9b70/index.html'
const f = (n: bigint | number, d: bigint | number = 1) => exactFraction(BigInt(n), BigInt(d))
const zero = f(0), one = f(1)
const add = (a: ExactFraction, b: ExactFraction) => f(BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator))
const multiply = (a: ExactFraction, b: ExactFraction) => f(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator))
const compare = (a: ExactFraction, b: ExactFraction) => {
  const difference = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}
function safe(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`)
  return BigInt(value)
}

/** The published candidate, NOT a game formula. Its denominator excludes flick/Combo bonuses. */
export function sourceNormalNoteCandidate(power: number, songCoefficientPermil: number, denominatorPermil: number): ExactFraction {
  if (denominatorPermil <= 0) throw new Error('Normalization needs a positive note denominator')
  return f(safe(power, 'power') * 460n * safe(songCoefficientPermil, 'song coefficient'), safe(denominatorPermil, 'note denominator'))
}

/** A necessary consistency check, not evidence of accuracy when it passes.
 * One final floor/round/ceil per note differs by less than one point per note.
 * Earlier rounding stages are deliberately not covered by this allowance.
 */
export function compareScoreEnvelope(base: ExactFraction, minimumMass: ExactFraction, maximumMass: ExactFraction, noteCount: number, observed: { lower: number; upper: number }) {
  const count = safe(noteCount, 'note count'), lowerObservation = safe(observed.lower, 'observed score'), upperObservation = safe(observed.upper, 'observed score')
  if (lowerObservation > upperObservation || compare(minimumMass, maximumMass) > 0) throw new Error('Invalid score interval')
  const minimum = multiply(base, minimumMass), maximum = multiply(base, maximumMass)
  const lowerNumerator = BigInt(minimum.numerator) - count * BigInt(minimum.denominator)
  const generousLower = f(lowerNumerator > 0n ? lowerNumerator : 0n, BigInt(minimum.denominator))
  const generousUpper = add(maximum, f(count))
  return {
    status: compare(f(lowerObservation), generousUpper) > 0 ? 'above-envelope' as const : compare(f(upperObservation), generousLower) < 0 ? 'below-envelope' as const : 'not-ruled-out' as const,
    observed: { ...observed }, unrounded: { lower: minimum, upper: maximum },
    withFinalNoteRoundingAllowance: { lower: generousLower, upper: generousUpper }, roundingAllowancePoints: noteCount
  }
}

/** Compare an AP reading against a deliberately generous source-model ceiling.
 * Every available Active is allowed at every note, without cooldown or proc failures.
 * Thus probability stacking and activation luck cannot explain an above-envelope result.
 */
export function auditSourceNormalization(timeline: ChartTimelineReport, chart: OptimizerDecodedChart, data: ScoringData, observed: { lower: number; upper: number }) {
  const identity = { modelVersion: NORMALIZATION_AUDIT_VERSION, source: NORMALIZATION_SOURCE, liveSkillModelVersion: LIVE_SKILL_MODEL_VERSION, chartIdentity: structuredClone(chart.identity) }
  const scope = 'Historical rejected normalization candidate combined with the identified skill model; never validates or rejects the game observation itself.'
  const assumptions = ['all-perfect', 'ideal-time SP windows and client support arithmetic', 'every generated Active strength available throughout the chart', 'at most one final floor/round/ceil per note']
  const missing = (reasons: string[]) => ({ ...identity, scope, assumptions, status: 'unresolved' as const, reasons: [...new Set(reasons)], candidateBaseNormalNote: null, envelope: null })
  if (chart.platform !== 'mobile') return missing(['pc-live-skill-arithmetic'])
  if (timeline.team.parameterTotal.status === 'unresolved') return missing(['overall-power'])
  // Board song-bonus aggregation is not established here. Never silently drop it.
  if (timeline.team.contributions.some(row => row.system === 'board' && row.type.startsWith('LIVE_SCORE_BONUS_') && row.status !== 'inactive')) return missing(['board-song-bonus'])
  const notes = prepareTimelineNotes(chart)
  if (chart.total_notes === 0) return missing(['no-scoring-notes'])
  // The envelope ignores a supplied success recording: it must include all possible checks.
  const live = resolveLiveSkillModel({ ...timeline, activeMode: 'unobserved', activations: null }, chart, data)
  const scheduleProblems = live.schedules.flatMap(row => row.intervalMicroseconds.status === 'unresolved' ? row.intervalMicroseconds.reasons : [])
  const available = live.attempts.filter(row => row.rawScoreUpPermil.status !== 'resolved' || row.rawScoreUpPermil.value.numerator !== '0')
  const problems = [...scheduleProblems, ...available.flatMap(row => [row.rawScoreUpPermil, row.staticSupportPermil].flatMap(value => value.status === 'unresolved' ? value.reasons : []))]
  if (problems.length) return missing(problems)
  // Duplicate checks carry identical candidates frequently; deduplicate without changing max.
  const candidates = [...new Map(available.map(row => [JSON.stringify([row.rawScoreUpPermil.value, row.staticSupportPermil.value]), row])).values()]
  let minimumMass = zero, maximumMass = zero, noteCursor = 0
  for (const event of live.events) {
    if (candidates.length && event.specialSupportPermil.status === 'unresolved') return missing(event.specialSupportPermil.reasons)
    let coefficient = one
    for (const candidate of candidates) {
      // Same float32 skill strength as the identified live model. Only the
      // historical normalization and envelope arithmetic remain rational.
      const permil = (value: ExactFraction) => Number(value.numerator) / Number(value.denominator)
      const supported = clientSkillScoreRatio([{ category: 'active', scoreUpPermil: permil(candidate.rawScoreUpPermil.value!), cardSupportPermil: permil(candidate.staticSupportPermil.value!) }], [], [permil(event.specialSupportPermil.value!)])
      const total = add(one, clientFloatFraction(supported.total))
      if (compare(total, coefficient) > 0) coefficient = total
    }
    const end = noteCursor + event.noteCount
    minimumMass = add(minimumMass, f(notes.lower[end] - notes.lower[noteCursor], 1_000_000))
    maximumMass = add(maximumMass, multiply(coefficient, f(notes.upper[end] - notes.upper[noteCursor], 1_000_000)))
    noteCursor = end
  }
  const denominatorPermil = Array.from(chart.eventWeightsPermil).reduce((sum, weight) => sum + (weight < 200 ? 100 : 1000), 0)
  const candidateBaseNormalNote = sourceNormalNoteCandidate(timeline.team.parameterTotal.value, timeline.team.song.scoreCoefficientPermil, denominatorPermil)
  const envelope = compareScoreEnvelope(candidateBaseNormalNote, minimumMass, maximumMass, chart.total_notes, observed)
  return { ...identity, scope, assumptions, status: envelope.status, reasons: [], denominatorPermil, candidateBaseNormalNote, envelope }
}
