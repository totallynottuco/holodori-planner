import type { ChartTimelineReport } from './chart-timeline'
import type { VerifiedChartDenominators } from './chart-denominators'
import { inspectChartScoreEvidence } from './chart-score-baseline'
import { calculatePerfectScoreGroup, scoreBounds } from './live-score-trace'
import { resolveLiveSkillModel } from './live-skill-model'
import { LIVE_SCORE_CLIENT } from './live-score'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import type { ScoringData } from './scoring-data'
import type { ParameterContribution, Resolution, SkillReport } from './team-parameters'

export const RECORDED_SCORE_TRACE_MODEL_VERSION = 'android-1.1.0-recorded-ap-trace-v1'
const ok = <T>(value: T): Resolution<T> => ({ status: 'resolved', value })
const unknown = <T>(reasons: string[]): Resolution<T> => ({ status: 'unresolved', value: null, reasons: [...new Set(reasons)] })

export function inspectScoreSkillChannels(skills: SkillReport[], data: ScoringData) {
  for (const skill of skills) for (const branch of skill.branches) {
    // These channels are absent from the pinned data. Reject new unsupported
    // source shapes instead of silently dropping them in the current adapter.
    if (skill.kind === 'special' && data.activeEffects[branch.effectGroupId]?.some(effect => effect.type === 'SCORE_UP_PERMIL_UP')
      || skill.kind === 'active' && data.activeEffects[branch.effectGroupId]?.some(effect => effect.type === 'SCORE_UP_EFFECT_UP_PERMIL_UP')) throw new Error('Unsupported skill channel for score trace')
  }
}

export function resolveScoreBoardSongBonus(contributions: ParameterContribution[]): Resolution<number> {
  const songBonuses = contributions.filter(row => row.type.startsWith('LIVE_SCORE_BONUS_') && row.status !== 'inactive' && row.value !== 0)
  return songBonuses.length ? unknown(['server-board-song-bonus-composition']) : ok(0)
}

/** Replay complete successful Active activations with ideal chart-time SP and
 * AP judgments. No lotteries or average skill coefficients enter the scorer.
 * A scenario result does not establish actual frame or player judgment times.
 */
export function resolveRecordedScoreTrace(timeline: ChartTimelineReport, chart: OptimizerDecodedChart, data: ScoringData, denominators: VerifiedChartDenominators) {
  if (timeline.activeMode !== 'recorded' || timeline.activations === null) throw new Error('A complete successful-activation recording is required')
  inspectScoreSkillChannels(timeline.team.skills, data)
  const evidence = inspectChartScoreEvidence(chart, denominators)
  if (!evidence.denominator) throw new Error('Recorded score traces require the reviewed mobile client')
  const skills = resolveLiveSkillModel(timeline, chart, data, 'verified-only')
  const power = timeline.team.overallPower.total
  // The client receives this separately precomputed server field. An empty
  // set of applicable bonus sources contributes zero; nonzero composition
  // is not yet reconstructed.
  const boardSongBonus = resolveScoreBoardSongBonus(timeline.team.contributions)
  const groups = []
  let cumulative: ReturnType<typeof scoreBounds> | null = scoreBounds(0, 0)
  const reasons = new Set<string>()
  let offset = 0
  for (const event of skills.events) {
    const currentReasons = [power, boardSongBonus, event.expectedScoreUpPermil].flatMap(value => value.status === 'unresolved' ? value.reasons : [])
    currentReasons.forEach(reason => reasons.add(reason))
    // In recorded mode every admitted proc has probability one. This field is
    // therefore the deterministic supported maximum, never a probability mean.
    const skillScoreUpRatio: Resolution<number> = event.expectedScoreUpPermil.status === 'resolved'
      ? ok(Math.fround(Number(event.expectedScoreUpPermil.value.numerator) / Number(event.expectedScoreUpPermil.value.denominator) / 1000))
      : unknown(event.expectedScoreUpPermil.reasons)
    const count = event.noteCount
    if (offset + count > chart.total_notes || Array.from(chart.eventTimesMicroseconds.slice(offset, offset + count)).some(time => time !== event.timeMicroseconds)) throw new Error('Skill trace and chart events do not match')
    const calculation = power.status === 'resolved' && boardSongBonus.status === 'resolved' && skillScoreUpRatio.status === 'resolved'
      ? calculatePerfectScoreGroup({ platform: chart.platform, overallPower: power.value,
        evaluationCoefficientPermil: LIVE_SCORE_CLIENT.evaluationCoefficientPermil, songCoefficientPermil: timeline.team.song.scoreCoefficientPermil,
        difficultyLevel: chart.difficultyLevel, notesPerfectCoefficientSumPermil: evidence.denominator.completePerfectSumPermil,
        chartScoreCoefficientPermyriad: evidence.denominator.chartScoreCoefficientPermyriad,
        boardSongBonusPermil: boardSongBonus.value, skillScoreUpRatio: skillScoreUpRatio.value
      }, Array.from({ length: count }, (_, index) => ({ timeMicroseconds: event.timeMicroseconds,
        noteType: chart.eventNoteTypes[offset + index], perfectCoefficientPermil: chart.eventWeightsPermil[offset + index] })), offset) : null
    cumulative = cumulative && calculation ? scoreBounds(cumulative.lower + calculation.points.lower, cumulative.upper + calculation.points.upper) : null
    groups.push({ timeMicroseconds: event.timeMicroseconds, comboFrom: offset + 1, comboTo: offset + count,
      skillScoreUpRatio, candidates: event.candidates, specialSupportPermil: event.specialSupportPermil,
      calculation, cumulativePoints: cumulative ? { ...cumulative } : null, reasons: currentReasons })
    offset += count
  }
  if (offset !== chart.total_notes) throw new Error('Skill trace does not cover every scoring event')
  if (cumulative?.exact === null) reasons.add('simultaneous-note-order')
  return { modelVersion: RECORDED_SCORE_TRACE_MODEL_VERSION, skills, denominator: evidence.denominator, power, boardSongBonus,
    status: cumulative !== null && cumulative.exact !== null ? 'resolved' as const : 'unresolved' as const,
    scenarioTotal: cumulative, groups, reasons: [...reasons],
    gameScore: unknown<number>(['actual-frame-and-judgment-times', 'SP-dispatch-times']),
    assumptions: ['complete-recorded-Active-successes', 'chronological-chart-time-PERFECT-judgments', 'SP-at-chart-slots', 'effects-active-on-[start,end)', 'verified-static-modifiers-only'] }
}
