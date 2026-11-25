/** Recovered Android and Steam note arithmetic. This kernel accepts resolved
 * inputs; it does not decide skill stacking, activation timing or note order.
 */
export const STEAM_NOTE_SCORE_MODEL_VERSION = 'steam-chart-permyriad-note-score-v2'
export const STEAM_PERFECT_NOTE_WEIGHTS = Object.freeze([1000, 1000, 1000, 100, 100, 1000, 1000])

export const LIVE_SCORE_MODEL_VERSION = 'android-1.3.0-chart-permyriad-note-score-v2'

export const LIVE_SCORE_CLIENT = Object.freeze({
  packageName: 'game.qualiarts.hololive.dreams.com',
  version: '1.1.0', versionCode: '1787028499', architecture: 'arm64-v8a',
  nativeSha256: 'e2aaf1a0fcd4c7f0e2cc0e2573750581a9979dd61a15f23878f065cb373490f8',
  metadataSha256: 'f2d4fbd35fabef8e4d27eb64dba4585a5e2a8f23e61ada6d47d8c465ed66283f',
  sourceCommit: '95e08ebe8f5b0bec83af036230f10291726b7130',
  settingSha256: '7ec99b8f7b7e66b1d9a98d38fb33237051536b06c003207050ddfe2d19412d3c',
  liveNoteSha256: '865d62f8af3fd06cc3c913a53309d223924cfa15e8f3a45f271b85e057fb2277',
  evaluationCoefficientPermil: 2300
})

export interface LiveNoteScoreInputs {
  platform: 'mobile' | 'pc'
  overallPower: number
  evaluationCoefficientPermil: number
  songCoefficientPermil: number
  chartScoreCoefficientPermyriad?: number
  difficultyLevel: number
  /** Sum of PERFECT coefficients over the client's entire NoteDataList,
   * including inactive hold relays. A scoring-event-only sum is insufficient.
   */
  notesPerfectCoefficientSumPermil: number
  noteJudgementCoefficientPermil: number
  comboBonusRatio: number
  /** Already resolved coefficient passed to CalcScore; not a sum of skills. */
  skillScoreUpRatio: number
  boardSongBonusPermil: number
  towerBonusPermil?: number
}

const F = Math.fround
const INT_MAX = 2_147_483_647
function integer(value: number, label: string, minimum = 0, maximum = INT_MAX) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is outside the supported integer range`)
}
function ratio(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(F(value))) throw new Error(`${label} must be a finite nonnegative float32 ratio`)
}
/** CalcUtility.FloatFromPermil: integer -> float32 -> divide -> float32. */
function permil(value: number) { return F(F(value) / 1000) }

function chartBase(power: number, evaluation: number, song: number, level: number, sum: number) {
  const musicCoefficient = F(1 + F(permil(song) * F(level - 5)))
  const perfectCoefficientSum = permil(sum)
  if (musicCoefficient <= 0) throw new Error('Music coefficient must be positive')
  const scaledPower = F(permil(evaluation) * F(power))
  const songScaledPower = F(scaledPower * musicCoefficient)
  return { musicCoefficient, perfectCoefficientSum, scaledPower, songScaledPower, base: F(songScaledPower / perfectCoefficientSum) }
}

function noteStages(base: number, combo: number, strength: number, weight: number, boardFactor: number, chartFactor: number) {
  const afterCombo = F(F(1 + F(combo)) * base)
  const afterSkills = F(F(1 + F(strength)) * afterCombo)
  const afterJudgement = F(permil(weight) * afterSkills)
  const beforeCeiling = F(F(boardFactor * afterJudgement) * chartFactor)
  return { afterCombo, afterSkills, afterJudgement, beforeCeiling }
}

function towerFactor(permils: number) {
  integer(permils, 'Challenge Live bonus')
  return F(1 + permil(permils))
}

/** Reuse the native award stages across a chart. The Board dialog can supply a
 * fractional projected permil here when the server formation integer is unknown. */
export function projectedMobileNoteAward(power: number, song: number, level: number, sum: number, chart: number, board: number, tower = 0) {
  integer(power, 'Overall Power', 0, Number.MAX_SAFE_INTEGER)
  ratio(board, 'Projected Board song bonus')
  const { base } = chartBase(power, LIVE_SCORE_CLIENT.evaluationCoefficientPermil, song, level, sum)
  const boardFactor = F(1 + permil(board)), chartFactor = F(F(chart) / 10_000), stageFactor = towerFactor(tower)
  return (combo: number, strength: number, weight: number) =>
    Math.ceil(F(noteStages(base, combo, strength, weight, boardFactor, chartFactor).beforeCeiling * stageFactor))
}

export function calculateLiveNoteScore(input: LiveNoteScoreInputs) {
  if (input.platform !== 'mobile' && input.platform !== 'pc') throw new Error('Unsupported note score platform')
  integer(input.overallPower, 'Overall Power', 0, Number.MAX_SAFE_INTEGER)
  integer(input.evaluationCoefficientPermil, 'Evaluation coefficient', 1)
  integer(input.songCoefficientPermil, 'Song coefficient')
  integer(input.difficultyLevel, 'Difficulty level', 1)
  integer(input.notesPerfectCoefficientSumPermil, 'Complete PERFECT coefficient sum', 1)
  integer(input.noteJudgementCoefficientPermil, 'Judgement coefficient')
  integer(input.boardSongBonusPermil, 'Board song bonus')
  ratio(input.comboBonusRatio, 'Combo bonus')
  ratio(input.skillScoreUpRatio, 'Skill bonus')

  const base = chartBase(input.overallPower, input.evaluationCoefficientPermil, input.songCoefficientPermil,
    input.difficultyLevel, input.notesPerfectCoefficientSumPermil)
  // Android 1.3.0 CalculateFinalScores applies the chart multiplier after the Board bonus, before ceil.
  const chartCoefficient = input.chartScoreCoefficientPermyriad ?? 10_000
  integer(chartCoefficient, 'Chart score coefficient')
  const stages = noteStages(base.base, input.comboBonusRatio, input.skillScoreUpRatio, input.noteJudgementCoefficientPermil,
    F(1 + permil(input.boardSongBonusPermil)), F(F(chartCoefficient) / 10_000))
  // CalculateFinalScores rounds the Tower award separately from the ordinary
  // song award, using the same unrounded subtotal after the chart coefficient.
  const beforeCeiling = input.towerBonusPermil === undefined ? stages.beforeCeiling :
    F(stages.beforeCeiling * towerFactor(input.towerBonusPermil))
  const points = Math.ceil(beforeCeiling)
  if (!Number.isSafeInteger(points) || points < 0 || points > INT_MAX) throw new Error('Note award exceeds the client integer range')
  return {
    modelVersion: input.platform === 'pc' ? STEAM_NOTE_SCORE_MODEL_VERSION : LIVE_SCORE_MODEL_VERSION, points,
    stages: { ...base, ...stages, beforeCeiling }
  }
}
