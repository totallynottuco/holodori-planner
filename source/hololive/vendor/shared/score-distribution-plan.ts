import { compileScoreDistribution } from './score-distribution'
import type { resolveExpectedScoreTrace } from './expected-score-trace'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import { officialComboMultiplierPermil } from './optimizer-chart-pack'
import { calculateLiveNoteScore, LIVE_SCORE_CLIENT } from './live-score'
import type { LiveSkillReport } from './live-skill-model'

/** Reviewed LiveNote.json at the shared source commit. Only Normal (1) and
 * LongStart (3) have a GREAT row: 800 permil. Other retained types cannot be
 * assigned GREAT. Keep this separate from applying 80% to rounded AP points. */
export const FULL_COMBO_RULES = Object.freeze({
  version: 'android-1.1.0-full-combo-v1', sourceCommit: LIVE_SCORE_CLIENT.sourceCommit,
  liveNoteSha256: LIVE_SCORE_CLIENT.liveNoteSha256,
  greatNoteTypes: [1, 3] as readonly number[], greatCoefficientPermil: 800, maximumGreats: 10
})

/** Compile the already resolved model once; runs only select pre-rounded awards.
 * The retained chart order is explicit and is not claimed as native tie order. */
export function compileExpectedScoreDistribution(trace: ReturnType<typeof resolveExpectedScoreTrace>, chart: OptimizerDecodedChart, songCoefficientPermil: number, judgementSkills?: LiveSkillReport) {
  if (trace.denominator.officialChartHash !== chart.officialChartHash || (chart.platform === 'pc' && judgementSkills)) throw new Error('Distribution chart identity mismatch')
  if (!trace.expectedScenarioTotal || trace.power.status !== 'resolved' || trace.boardSongBonus.status !== 'resolved') return null
  const power = trace.power.value, board = trace.boardSongBonus.value
  const used = new Set(trace.groups.flatMap(group => group.candidates.map(candidate => candidate.attemptId)))
  const canFullCombo = Boolean(judgementSkills && !judgementSkills.judgementReasons.length)
  if (canFullCombo) judgementSkills!.judgementEnhancements.forEach(group => group.attemptIds.forEach(id => used.add(id)))
  const attempts = (canFullCombo ? judgementSkills! : trace.skills).attempts.filter(row => used.has(row.id)).map(row => {
    if (row.probability.status !== 'resolved') throw new Error('Unresolved activation probability')
    return { id: row.id, probability: row.probability.value, startMicroseconds: row.startMicroseconds, endMicroseconds: row.endMicroseconds }
  })
  const lossesByGroup: Array<Map<string, number[]>> = []
  const eligibleByGroup: number[][] = []
  const groups = trace.groups.map(group => {
    const eligible = Array.from({ length: group.comboTo - group.comboFrom + 1 }, (_, i) => group.comboFrom - 1 + i).filter(i => FULL_COMBO_RULES.greatNoteTypes.includes(chart.eventNoteTypes[i]))
    eligibleByGroup.push(eligible)
    const losses = new Map<string, number[]>()
    lossesByGroup.push(losses)
    const score = (ratio: number) => {
      let points = 0
      const greatLosses: number[] = []
      for (let i = group.comboFrom - 1; i < group.comboTo; i++) {
        const input = {
        platform: chart.platform, overallPower: power, evaluationCoefficientPermil: LIVE_SCORE_CLIENT.evaluationCoefficientPermil,
        songCoefficientPermil, difficultyLevel: chart.difficultyLevel, notesPerfectCoefficientSumPermil: trace.denominator.completePerfectSumPermil,
        noteJudgementCoefficientPermil: chart.eventWeightsPermil[i], comboBonusRatio: Math.fround(Math.fround(officialComboMultiplierPermil(i + 1) - 1000) / 1000),
        skillScoreUpRatio: ratio, boardSongBonusPermil: board
        } as const
        const perfect = calculateLiveNoteScore(input).points
        points += perfect
        if (eligible.includes(i)) greatLosses.push(perfect - calculateLiveNoteScore({ ...input, noteJudgementCoefficientPermil: FULL_COMBO_RULES.greatCoefficientPermil }).points)
      }
      return { points, greatLosses }
    }
    const base = score(0)
    losses.set('baseline', base.greatLosses)
    const cache = new Map<number, ReturnType<typeof score>>()
    // Preserve strongest-effect precedence even when rounded AP awards tie.
    const candidates = group.candidates.map(candidate => {
      if (candidate.supportedScoreUpPermil.status !== 'resolved') throw new Error('Unresolved skill strength')
      const value = candidate.supportedScoreUpPermil.value, ratio = Math.fround(Number(value.numerator) / Number(value.denominator) / 1000)
      if (!cache.has(ratio)) cache.set(ratio, score(ratio))
      const result = cache.get(ratio)!
      losses.set(candidate.attemptId, result.greatLosses)
      return { attemptId: candidate.attemptId, points: result.points, ratio }
    }).sort((a, b) => b.ratio - a.ratio)
    return { timeMicroseconds: group.timeMicroseconds, basePoints: base.points, candidates }
  })
  const plan = compileScoreDistribution(attempts, groups)
  if (canFullCombo) {
    if (judgementSkills!.judgementEnhancements.length !== plan.groups.length) throw new Error('Judgment windows do not cover the chart')
    const indices = new Map(plan.attempts.map((row, i) => [row.id, i]))
    plan.fullCombo = {
      notes: plan.groups.flatMap((group, groupIndex) => eligibleByGroup[groupIndex].map((noteIndex, i) => ({ noteIndex, groupIndex,
        baseLoss: lossesByGroup[groupIndex].get('baseline')![i], candidateLosses: group.candidates.map(row => lossesByGroup[groupIndex].get(plan.attempts[row.attemptIndex].id)![i]) }))),
      protection: judgementSkills!.judgementEnhancements.map((group, i) => {
        if (group.timeMicroseconds !== plan.groups[i].timeMicroseconds) throw new Error('Judgment window timestamp mismatch')
        return { guaranteed: group.guaranteed, attemptIndices: group.attemptIds.map(id => {
          const index = indices.get(id)
          if (index === undefined) throw new Error('Missing judgment-boost activation')
          return index
        }) }
      })
    }
  } else plan.fullComboReasons = judgementSkills?.judgementReasons ?? ['Judgment windows not supplied']
  return plan
}
