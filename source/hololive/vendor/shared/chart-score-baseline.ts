import { calculateLiveNoteScore, LIVE_SCORE_CLIENT, STEAM_PERFECT_NOTE_WEIGHTS } from './live-score'
import { REVIEWED_CHART_PACK, type OptimizerDecodedChart } from './optimizer-chart-pack'
import type { VerifiedChartDenominators } from './chart-denominators'

/** A single normal PERFECT tap with no combo, skill or Board song bonus.
 * This deliberately does not predict a team/run or interpret Unit Score.
 * Callers must obtain chart and song inputs through the verified data loader.
 */
export function inspectChartScoreBaseline(chart: OptimizerDecodedChart, overallPower: number, songCoefficientPermil: number, denominators: VerifiedChartDenominators) {
  if (!Number.isSafeInteger(overallPower) || overallPower <= 0) throw new Error('Overall Power must be a positive safe integer')
  if (!Number.isInteger(songCoefficientPermil) || songCoefficientPermil < 0 || songCoefficientPermil > 2_147_483_647) throw new Error('Invalid song coefficient')
  const { reasons, denominator } = inspectChartScoreEvidence(chart, denominators)
  const calculation = denominator === null ? null : calculateLiveNoteScore({
    platform: chart.platform, overallPower, evaluationCoefficientPermil: LIVE_SCORE_CLIENT.evaluationCoefficientPermil,
    songCoefficientPermil, difficultyLevel: chart.difficultyLevel,
    notesPerfectCoefficientSumPermil: denominator.completePerfectSumPermil,
    noteJudgementCoefficientPermil: 1000, comboBonusRatio: 0, skillScoreUpRatio: 0, boardSongBonusPermil: 0
  })
  return { status: calculation ? 'resolved' as const : 'unresolved' as const, calculation, reasons, denominator }
}

/** Validate chart evidence independently of whether a team's power resolves. */
export function inspectChartScoreEvidence(chart: OptimizerDecodedChart, denominators: VerifiedChartDenominators) {
  if (!['mobile', 'pc'].includes(chart.platform)) throw new Error('Unknown chart platform')
  const identity=denominators.identity
  if (chart.identity.indexSha256 !== (identity?.chartIndexSha256 ?? REVIEWED_CHART_PACK.indexSha256)
    || chart.identity.eventBlobSha256 !== (identity?.chartBlobSha256 ?? REVIEWED_CHART_PACK.eventBlobSha256)
    || chart.identity.sourceCommit !== (identity?.sourceCommit ?? LIVE_SCORE_CLIENT.sourceCommit)
    || chart.identity.platform !== chart.platform || chart.identity.chartKey !== chart.key) throw new Error('Incompatible chart identity')
  const reasons: string[] = []
  const reviewed = denominators.get(chart.key)
  if (!reviewed) throw new Error('Missing reviewed chart denominator evidence')
  if (chart.officialChartHash !== reviewed.officialChartHash || chart.difficultyLevel !== reviewed.difficultyLevel
    || chart.total_notes !== reviewed.scoringEvents) throw new Error('Chart does not match the reviewed denominator evidence')
  const sum = chart.eventWeightsPermil.reduce((total, weight) => total + weight, 0)
  if (chart.platform === 'pc') {
    if (chart.eventNoteTypes.some((type, index) => chart.eventWeightsPermil[index] !== STEAM_PERFECT_NOTE_WEIGHTS[type - 1])) {
      reasons.push('PC PERFECT coefficients are outside Steam scoring coverage.')
      return { reasons, denominator: null }
    }
    return { reasons, denominator: { ...reviewed, scoringEventPerfectSumPermil: sum,
      completePerfectSumPermil: sum + reviewed.inactiveHoldRelayCount * STEAM_PERFECT_NOTE_WEIGHTS[3] } }
  }
  if (sum !== reviewed.scoringEventPerfectSumPermil) throw new Error('Chart PERFECT coefficients do not match the reviewed evidence')
  return { reasons, denominator: { ...reviewed } }
}
