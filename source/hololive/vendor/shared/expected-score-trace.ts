import type { ChartTimelineReport } from './chart-timeline'
import type { VerifiedChartDenominators } from './chart-denominators'
import { inspectChartScoreEvidence } from './chart-score-baseline'
import { addScoreFractions, calculateExpectedPerfectGroup, expectedScoreBounds, type SupportedAttempt } from './expected-score'
import { LIVE_SKILL_UPDATE_ORDER, resolveLiveSkillModel } from './live-skill-model'
import { LIVE_SCORE_CLIENT } from './live-score'
import { LIVE_LIFE_RULES } from './live-life'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import type { ScoringData } from './scoring-data'
import { inspectScoreSkillChannels, resolveScoreBoardSongBonus } from './recorded-score-trace'

export const EXPECTED_SCORE_TRACE_MODEL_VERSION = 'android-1.1.0-independent-ap-score-v1'
import type { StaticModifierPolicy } from './static-skill-modifiers'
export type { StaticModifierPolicy } from './static-skill-modifiers'

export function resolveExpectedScoreTrace(timeline: ChartTimelineReport, chart: OptimizerDecodedChart, data: ScoringData, denominators: VerifiedChartDenominators, staticModifiers: StaticModifierPolicy = 'verified-only') {
  if (timeline.activeMode !== 'unobserved' || timeline.activations !== null) throw new Error('Expected mode does not accept recorded activations')
  inspectScoreSkillChannels(timeline.team.skills, data)
  const evidence = inspectChartScoreEvidence(chart, denominators)
  if (!evidence.denominator) throw new Error('Expected score traces require verified chart coefficients')
  const skills = resolveLiveSkillModel(timeline, chart, data, staticModifiers, false, denominators.identity)
  const power = timeline.team.overallPower.total, boardSongBonus = resolveScoreBoardSongBonus(timeline.team.contributions)
  const zero = { numerator: '0', denominator: '1' }
  let cumulative: ReturnType<typeof expectedScoreBounds> | null = expectedScoreBounds(zero, zero)
  const groups = [], reasons = new Set<string>()
  let offset = 0
  for (const event of skills.events) {
    const currentReasons = [power, boardSongBonus, event.expectedScoreUpPermil].flatMap(value => value.status === 'unresolved' ? value.reasons : [])
    currentReasons.forEach(reason => reasons.add(reason))
    const attempts: SupportedAttempt[] = []
    for (const candidate of event.candidates) {
      if (candidate.probability.status === 'resolved' && candidate.supportedScoreUpPermil.status === 'resolved') attempts.push({
        attemptId: candidate.attemptId, probability: candidate.probability.value, supportedScoreUpPermil: candidate.supportedScoreUpPermil.value
      })
    }
    if (offset + event.noteCount > chart.total_notes || Array.from(chart.eventTimesMicroseconds.slice(offset, offset + event.noteCount)).some(time => time !== event.timeMicroseconds)) throw new Error('Skill trace and chart events do not match')
    // The expectation field above is only a dependency gate; its mean strength
    // is never used for scoring. Calculate each candidate outcome separately.
    const calculation = !currentReasons.length && power.status === 'resolved' && boardSongBonus.status === 'resolved'
      ? calculateExpectedPerfectGroup({ platform: chart.platform, overallPower: power.value,
        evaluationCoefficientPermil: LIVE_SCORE_CLIENT.evaluationCoefficientPermil, songCoefficientPermil: timeline.team.song.scoreCoefficientPermil,
        difficultyLevel: chart.difficultyLevel, notesPerfectCoefficientSumPermil: evidence.denominator.completePerfectSumPermil,
        chartScoreCoefficientPermyriad: evidence.denominator.chartScoreCoefficientPermyriad,
        boardSongBonusPermil: boardSongBonus.value
      }, Array.from({ length: event.noteCount }, (_, index) => ({ timeMicroseconds: event.timeMicroseconds,
        noteType: chart.eventNoteTypes[offset + index], perfectCoefficientPermil: chart.eventWeightsPermil[offset + index] })), offset, attempts) : null
    cumulative = cumulative && calculation ? expectedScoreBounds(addScoreFractions(cumulative.lower, calculation.expectedPoints.lower), addScoreFractions(cumulative.upper, calculation.expectedPoints.upper)) : null
    groups.push({ timeMicroseconds: event.timeMicroseconds, comboFrom: offset + 1, comboTo: offset + event.noteCount,
      candidates: event.candidates, calculation, cumulativeExpectedPoints: cumulative, reasons: currentReasons })
    offset += event.noteCount
  }
  if (offset !== chart.total_notes) throw new Error('Skill trace does not cover every scoring event')
  if (cumulative?.exact === null) reasons.add('simultaneous-note-order')
  return { modelVersion: EXPECTED_SCORE_TRACE_MODEL_VERSION, skills, denominator: evidence.denominator, power, boardSongBonus,
    status: cumulative !== null && cumulative.exact !== null ? 'resolved' as const : 'unresolved' as const,
    expectedScenarioTotal: cumulative, groups, reasons: [...reasons],
    gameScore: { status: 'unresolved' as const, value: null, reasons: ['actual-frame-and-judgment-times', 'SP-dispatch-times', 'independent-checks-and-prng'] },
    assumptions: ['independent-Bernoulli-Active-checks', 'ideal-chart-time-cooldowns', 'chronological-chart-time-PERFECT-judgments', 'fixed-tie-order-independent-of-lottery', 'SP-at-chart-slots', 'effects-active-on-[start,end)', LIVE_SKILL_UPDATE_ORDER, 'SP-probability-at-Active-check-on-(start,end]', `LIFE:${LIVE_LIFE_RULES.version}`, `static-modifiers:${staticModifiers}`] }
}
