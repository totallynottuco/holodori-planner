import { calculateLiveNoteScore, type LiveNoteScoreInputs } from './live-score'
import { officialComboMultiplierPermil } from './optimizer-chart-pack'

export const LIVE_SCORE_TRACE_MODEL_VERSION = 'android-1.1.0-ap-no-bonuses-trace-v1'

export interface PerfectEvent {
  timeMicroseconds: number
  noteType: number
  perfectCoefficientPermil: number
}
export type PerfectGroupInputs = Omit<LiveNoteScoreInputs, 'noteJudgementCoefficientPermil' | 'comboBonusRatio'>
type TraceInputs = Omit<PerfectGroupInputs, 'skillScoreUpRatio' | 'boardSongBonusPermil'>

export function scoreBounds(lower: number, upper: number) {
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower < 0 || upper < lower) throw new Error('Score total exceeds the supported integer range')
  return { lower, upper, exact: lower === upper ? lower : null }
}

/** Every note in a simultaneous group sees the same resolved skill state.
 * This kernel can also be used by a recorded-effect trace. Never pass a mean
 * skill coefficient: scoring/ceiling must happen before any expectation.
 */
export function calculatePerfectScoreGroup(input: PerfectGroupInputs, events: readonly PerfectEvent[], offset: number) {
  if (!events.length || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid score group or combo offset')
  const time = events[0].timeMicroseconds, end = offset + events.length
  if (!Number.isSafeInteger(time) || time < 0 || events.some(event => event.timeMicroseconds !== time)) throw new Error('Expected one simultaneous score group')
  const lowBonus = officialComboMultiplierPermil(offset + 1) - 1000
  const highBonus = officialComboMultiplierPermil(end) - 1000
  if (highBonus - lowBonus > 10) throw new Error('Simultaneous group spans more than two combo bonus bands')
  const award = (coefficient: number, bonus: number) => calculateLiveNoteScore({ ...input,
    noteJudgementCoefficientPermil: coefficient, comboBonusRatio: Math.fround(Math.fround(bonus) / 1000)
  }).points
  const notes = events.map((event, index) => {
    if (!Number.isInteger(event.noteType) || event.noteType < 1 || event.noteType > 7
      || !Number.isInteger(event.perfectCoefficientPermil) || event.perfectCoefficientPermil <= 0) throw new Error('Invalid PERFECT scoring event')
    return { eventIndex: offset + index, noteType: event.noteType, perfectCoefficientPermil: event.perfectCoefficientPermil,
      points: scoreBounds(award(event.perfectCoefficientPermil, lowBonus), award(event.perfectCoefficientPermil, highBonus)) }
  })
  const base = notes.reduce((total, note) => total + note.points.lower, 0)
  const highSlots = highBonus === lowBonus ? 0 : end - (highBonus / 10 * 100) + 1
  // Optimize rounded award differences, assigning each high combo slot once.
  const deltas = notes.map(note => note.points.upper - note.points.lower).sort((a, b) => a - b)
  const lowSum = base + deltas.slice(0, highSlots).reduce((total, delta) => total + delta, 0)
  const highSum = base + (highSlots ? deltas.slice(-highSlots).reduce((total, delta) => total + delta, 0) : 0)
  return { timeMicroseconds: time, comboFrom: offset + 1, comboTo: end, notes, points: scoreBounds(lowSum, highSum) }
}

/** Controlled AP scenario: chronological perfect judgments, no skill or Board
 * song bonus. Inputs are already resolved; the chart adapter verifies provenance.
 * Event indexes identify corpus records, not native order within a time group.
 */
export function calculatePerfectScoreTrace(input: TraceInputs, events: readonly PerfectEvent[]) {
  if (!events.length) throw new Error('A score trace requires scoring events')
  const groups = []
  let lower = 0, upper = 0
  for (let start = 0; start < events.length;) {
    const time = events[start].timeMicroseconds
    if (!Number.isSafeInteger(time) || time < 0 || start > 0 && time < events[start - 1].timeMicroseconds) throw new Error('Score events must have nonnegative, ordered integer timestamps')
    let end = start + 1
    while (end < events.length && events[end].timeMicroseconds === time) end++
    const group = calculatePerfectScoreGroup({ ...input, skillScoreUpRatio: 0, boardSongBonusPermil: 0 }, events.slice(start, end), start)
    lower += group.points.lower
    upper += group.points.upper
    groups.push({ ...group, cumulativePoints: scoreBounds(lower, upper) })
    start = end
  }
  const total = scoreBounds(lower, upper)
  return { modelVersion: LIVE_SCORE_TRACE_MODEL_VERSION, status: total.exact === null ? 'unresolved' as const : 'resolved' as const,
    total, noteCount: events.length, groups,
    reasons: total.exact === null ? ['Simultaneous-note order changes the rounded score; the corpus does not retain native judgment order.'] : [] }
}
