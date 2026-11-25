import type { ChartTimelineReport, ExactFraction } from './chart-timeline'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import { officialComboMultiplierPermil } from './optimizer-chart-pack'
import type { VerifiedChartDenominators } from './chart-denominators'
import type { ScoringData } from './scoring-data'
import { inspectChartScoreEvidence } from './chart-score-baseline'
import { inspectScoreSkillChannels, resolveScoreBoardSongBonus } from './recorded-score-trace'
import { resolveLiveSkillSchedule } from './live-skill-model'
import { clientSupportedSkillRatio } from './live-skill-arithmetic'
import { calculateLiveNoteScore, LIVE_SCORE_CLIENT } from './live-score'

type Candidate = { strength: number; probability: ExactFraction }
const numberOf = (value: ExactFraction) => Number(value.numerator) / Number(value.denominator)

/** Exact masses for the strongest successful Active within a stable set of windows.
 * Every lottery threshold is a float32, so all denominators are powers of two. */
function strongestOutcomes(candidates: Candidate[]) {
  let denominator = 1n,
    survival = 1n
  const outcomes: { strength: number; mass: bigint }[] = []
  for (const candidate of candidates.sort((a, b) => b.strength - a.strength)) {
    const top = BigInt(candidate.probability.numerator),
      bottom = BigInt(candidate.probability.denominator)
    if (top === 0n) continue
    for (const row of outcomes) row.mass *= bottom
    outcomes.push({ strength: candidate.strength, mass: survival * top })
    denominator *= bottom
    survival *= bottom - top
    if (!survival) break
  }
  if (survival) outcomes.push({ strength: 0, mass: survival })
  return { denominator, outcomes }
}

/** Value-only equivalent of the detailed AP expectation and its all-success maximum.
 * Schedule, formation and per-note arithmetic are shared with the full trace.
 * A window boundary changes the distribution only once, even if it spans hundreds of notes. */
export function calculateExpectedScoreTotals(
  timeline: ChartTimelineReport,
  chart: OptimizerDecodedChart,
  data: ScoringData,
  denominators: VerifiedChartDenominators,
) {
  if (timeline.activeMode !== 'unobserved') throw Error('Expected totals require an unobserved play')
  inspectScoreSkillChannels(timeline.team.skills, data)
  const evidence = inspectChartScoreEvidence(chart, denominators).denominator
  if (!evidence) throw Error('Expected score totals require verified chart coefficients')
  const schedule = resolveLiveSkillSchedule(timeline, chart, data, 'verified-only', false, denominators.identity)
  const power = timeline.team.overallPower.total,
    board = resolveScoreBoardSongBonus(timeline.team.contributions)
  const reasons = new Set(schedule.scheduleReasons)
  if (power.status === 'unresolved') power.reasons.forEach((reason) => reasons.add(reason))
  if (board.status === 'unresolved') board.reasons.forEach((reason) => reasons.add(reason))
  const attempts = schedule.attempts.map((attempt) => ({
    ...attempt,
    start: numberOf(attempt.startMicroseconds),
    end: numberOf(attempt.endMicroseconds),
  }))
  const specials = schedule.specialWindows.map((window) => ({
    start: numberOf(window.start),
    end: numberOf(window.end),
    support: schedule.effectValue(window.skill, 'SCORE_UP_EFFECT_UP_PERMIL_UP', window.start),
  }))
  const edges = [...new Set([0, ...[...attempts, ...specials].flatMap((row) => [row.start, row.end])])].sort(
    (a, b) => a - b,
  )
  // Awards depend only on the native strength, PERFECT weight and combo band at this fixed formation power.
  const awardCache = new Map<number, Map<number, number>>()
  function award(strength: number, weight: number, bonus: number) {
    let values = awardCache.get(strength)
    if (!values) {
      values = new Map()
      awardCache.set(strength, values)
    }
    const key = weight * 128 + bonus
    const prior = values.get(key)
    if (prior !== undefined) return prior
    const score = calculateLiveNoteScore({
      platform: chart.platform,
      overallPower: power.value!,
      evaluationCoefficientPermil: LIVE_SCORE_CLIENT.evaluationCoefficientPermil,
      songCoefficientPermil: timeline.team.song.scoreCoefficientPermil,
      difficultyLevel: chart.difficultyLevel,
      notesPerfectCoefficientSumPermil: evidence!.completePerfectSumPermil,
      chartScoreCoefficientPermyriad: evidence!.chartScoreCoefficientPermyriad,
      boardSongBonusPermil: board.value!,
      comboBonusRatio: Math.fround(bonus / 1000),
      noteJudgementCoefficientPermil: weight,
      skillScoreUpRatio: strength,
    }).points
    values.set(key, score)
    return score
  }
  const times = chart.eventTimesMicroseconds
  let offset = 0,
    totalDenominator = 1n,
    low = 0n,
    high = 0n,
    maximum = 0
  for (let edge = 0; edge < edges.length && offset < times.length; edge++) {
    const time = edges[edge],
      next = edges[edge + 1] ?? Infinity
    if (times[offset] >= next) continue
    const candidates: Candidate[] = []
    const open = specials.filter((row) => row.start <= time && time < row.end)
    for (const row of attempts) {
      if (
        row.start > time ||
        row.end <= time ||
        row.rawScoreUpPermil.value?.numerator === '0' ||
        row.probability.value?.numerator === '0'
      )
        continue
      let temporary = 0
      for (const special of open) {
        if (special.support.status === 'unresolved')
          special.support.reasons.forEach((reason) => reasons.add(reason))
        else temporary = Math.max(temporary, numberOf(special.support.value))
      }
      for (const value of [row.rawScoreUpPermil, row.probability, row.staticSupportPermil])
        if (value.status === 'unresolved') value.reasons.forEach((reason) => reasons.add(reason))
      if (row.rawScoreUpPermil.value && row.probability.value && row.staticSupportPermil.value) {
        candidates.push({
          probability: row.probability.value,
          strength: clientSupportedSkillRatio(
            numberOf(row.rawScoreUpPermil.value),
            numberOf(row.staticSupportPermil.value),
            Math.fround(temporary / 1000),
          ),
        })
      }
    }
    if (reasons.size) {
      while (offset < times.length && times[offset] < next) offset++
      continue
    }
    const { outcomes, denominator } = strongestOutcomes(candidates)
    const values = new Map<number, { expected: bigint; maximum: number }>()
    function note(weight: number, bonus: number) {
      const key = weight * 128 + bonus
      let result = values.get(key)
      if (!result) {
        const expected = outcomes.reduce(
          (sum, row) => sum + row.mass * BigInt(award(row.strength, weight, bonus)),
          0n,
        )
        result = { expected, maximum: award(outcomes[0].strength, weight, bonus) }
        values.set(key, result)
      }
      return result
    }
    let segmentLow = 0n,
      segmentHigh = 0n
    while (offset < times.length && times[offset] < next) {
      const start = offset,
        stamp = times[start]
      while (offset < times.length && times[offset] === stamp) offset++
      const end = offset,
        lowBonus = officialComboMultiplierPermil(start + 1) - 1000,
        highBonus = officialComboMultiplierPermil(end) - 1000
      if (highBonus - lowBonus > 10) throw Error('Simultaneous group spans more than two combo bands')
      const deltas: bigint[] = []
      for (let i = start; i < end; i++) {
        const weight = chart.eventWeightsPermil[i],
          row = note(weight, lowBonus)
        segmentLow += row.expected
        segmentHigh += row.expected
        if (lowBonus === highBonus) maximum += row.maximum
        else {
          deltas.push(note(weight, highBonus).expected - row.expected)
          maximum += note(weight, officialComboMultiplierPermil(i + 1) - 1000).maximum
        }
      }
      if (deltas.length) {
        const highSlots = end - (highBonus / 10) * 100 + 1
        deltas.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        for (let i = 0; i < highSlots; i++) {
          segmentLow += deltas[i]
          segmentHigh += deltas[deltas.length - 1 - i]
        }
      }
    }
    if (denominator > totalDenominator) {
      low *= denominator / totalDenominator
      high *= denominator / totalDenominator
      totalDenominator = denominator
    }
    low += segmentLow * (totalDenominator / denominator)
    high += segmentHigh * (totalDenominator / denominator)
  }
  if (reasons.size) throw Error([...reasons].join('; '))
  const truncate = (numerator: bigint) => Number((numerator * 1000n) / totalDenominator) / 1000
  return { low: truncate(low), high: truncate(high), maximum, overallPower: power.value! }
}
