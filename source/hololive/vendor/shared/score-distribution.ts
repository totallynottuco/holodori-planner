import { exactFraction, type ExactFraction } from './chart-timeline'
import { addScoreFractions } from './expected-score'

export const SCORE_DISTRIBUTION_MODEL_VERSION = 'independent-fc-run-distribution-v2'
export const SIMULATION_RNG_VERSION = 'xoshiro128ss-1.1-seed32-uniform53-v1'
export const FULL_COMBO_PLACEMENT_VERSION = 'uniform-effective-great-count-and-subset-split-stream-v1'
export type ScorePlayMode = 'all-perfect' | 'full-combo'
export interface FullComboNotes {
  notes: Array<{ noteIndex: number; groupIndex: number; baseLoss: number; candidateLosses: number[] }>
  protection: Array<{ guaranteed: boolean; attemptIndices: number[] }>
}
const UNIFORM_SIZE = 2 ** 53
const scale = 1n << 53n
const fraction = (value: number) => exactFraction(BigInt(value), 1n)
const multiply = (a: ExactFraction, b: ExactFraction) => exactFraction(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator))
const complement = (p: ExactFraction) => exactFraction(BigInt(p.denominator) - BigInt(p.numerator), BigInt(p.denominator))
const integer = (value: number, label: string) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`); return value }

export interface DistributionAttempt {
  id: string
  probability: ExactFraction
  startMicroseconds: ExactFraction
  endMicroseconds: ExactFraction
}
export interface DistributionGroupInput {
  timeMicroseconds: number
  basePoints: number
  candidates: Array<{ attemptId: string; points: number }>
}
export interface ScoreDistributionPlan {
  modelVersion: typeof SCORE_DISTRIBUTION_MODEL_VERSION
  tieOrder: 'retained-corpus-order'
  attempts: Array<DistributionAttempt & { threshold53: number }>
  groups: Array<{ timeMicroseconds: number; basePoints: number; candidates: Array<{ attemptIndex: number; points: number }> }>
  expectedMean: ExactFraction
  fullCombo?: FullComboNotes
  fullComboReasons?: string[]
  bounds: {
    minimum: { score: number; successfulAttemptIds: string[] }
    maximum: { score: number; successfulAttemptIds: string[] }
    proof: 'fixed-schedule-nonnegative-maximum-of-successful-effects'
  }
}

/** Exact for the model's binary client thresholds. Do not silently quantize
 * arbitrary rationals, or confuse this independent lottery with the game PRNG. */
function threshold53(p: ExactFraction) {
  const n = BigInt(p.numerator), d = BigInt(p.denominator)
  if (d <= 0n || n < 0n || n > d || n * scale % d !== 0n) throw new Error('Probability must be in [0,1] and exactly representable by the model lottery')
  return Number(n * scale / d)
}

/** For a fixed schedule, conditions, support and note order, each group is a
 * maximum of nonnegative fixed awards. Setting any optional success to true
 * cannot lower any group. Guaranteed-only and all-possible histories attain
 * the lower/upper totals simultaneously, proving bounds over Bernoulli histories.
 * This proof says nothing about allowed game PRNG seeds or actual frame timing.
 */
export function compileScoreDistribution(attempts: readonly DistributionAttempt[], groups: readonly DistributionGroupInput[]): ScoreDistributionPlan {
  if (attempts.length > 5000 || !groups.length || groups.length > 10000) throw new Error('Distribution exceeds supported size')
  const ids = new Map<string, number>()
  const rows = attempts.map((row, i) => {
    if (!row.id || ids.has(row.id)) throw new Error('Missing or duplicate activation check')
    ids.set(row.id, i)
    const start = exactFraction(BigInt(row.startMicroseconds.numerator), BigInt(row.startMicroseconds.denominator))
    const end = exactFraction(BigInt(row.endMicroseconds.numerator), BigInt(row.endMicroseconds.denominator))
    if (BigInt(end.numerator) * BigInt(start.denominator) <= BigInt(start.numerator) * BigInt(end.denominator)) throw new Error('Invalid effect lifetime')
    return { ...structuredClone(row), threshold53: threshold53(row.probability) }
  })
  let expectedMean = fraction(0), minimum = 0, maximum = 0, previousTime = -1
  const compiled = groups.map(group => {
    integer(group.basePoints, 'baseline award'); integer(group.timeMicroseconds, 'group time')
    if (group.timeMicroseconds <= previousTime) throw new Error('Distribution groups must have increasing timestamps')
    previousTime = group.timeMicroseconds
    const seen = new Set<string>()
    const candidates = group.candidates.map(candidate => {
      const index = ids.get(candidate.attemptId)
      if (index === undefined || seen.has(candidate.attemptId)) throw new Error('Unknown or repeated group activation')
      seen.add(candidate.attemptId)
      integer(candidate.points, 'candidate award')
      if (candidate.points < group.basePoints) throw new Error('Non-monotone effects require a different bounds solver')
      const attempt = rows[index], time = BigInt(group.timeMicroseconds)
      if (time * BigInt(attempt.startMicroseconds.denominator) < BigInt(attempt.startMicroseconds.numerator)
        || time * BigInt(attempt.endMicroseconds.denominator) >= BigInt(attempt.endMicroseconds.numerator)) throw new Error('Candidate is outside its effect lifetime')
      return { attemptIndex: index, points: candidate.points }
    }).sort((a, b) => b.points - a.points)
    let survival = fraction(1), mean = fraction(0)
    for (const candidate of candidates) {
      const p = rows[candidate.attemptIndex].probability
      mean = addScoreFractions(mean, multiply(multiply(survival, p), fraction(candidate.points)))
      survival = multiply(survival, complement(p))
    }
    expectedMean = addScoreFractions(expectedMean, addScoreFractions(mean, multiply(survival, fraction(group.basePoints))))
    minimum += candidates.find(row => rows[row.attemptIndex].threshold53 === UNIFORM_SIZE)?.points ?? group.basePoints
    maximum += candidates.find(row => rows[row.attemptIndex].threshold53 > 0)?.points ?? group.basePoints
    return { timeMicroseconds: group.timeMicroseconds, basePoints: group.basePoints, candidates }
  })
  return { modelVersion: SCORE_DISTRIBUTION_MODEL_VERSION, tieOrder: 'retained-corpus-order', attempts: rows, groups: compiled, expectedMean,
    bounds: { minimum: { score: integer(minimum, 'minimum score'), successfulAttemptIds: rows.filter(row => row.threshold53 === UNIFORM_SIZE).map(row => row.id) },
      maximum: { score: integer(maximum, 'maximum score'), successfulAttemptIds: rows.filter(row => row.threshold53 > 0).map(row => row.id) },
      proof: 'fixed-schedule-nonnegative-maximum-of-successful-effects' } }
}

export function replayScoreRun(plan: ScoreDistributionPlan, successfulAttemptIds: readonly string[], greatNoteIndices: readonly number[] = []) {
  const successes = new Set(successfulAttemptIds), known = new Set(plan.attempts.map(row => row.id))
  if (successes.size !== successfulAttemptIds.length || [...successes].some(id => !known.has(id))) throw new Error('Invalid activation history')
  for (const row of plan.attempts) {
    if (row.threshold53 === 0 && successes.has(row.id) || row.threshold53 === UNIFORM_SIZE && !successes.has(row.id)) throw new Error('Activation history violates a certain outcome')
  }
  if (greatNoteIndices.length > 10 || new Set(greatNoteIndices).size !== greatNoteIndices.length) throw new Error('Full Combo allows at most 10 distinct GREAT notes')
  const choices = runChoices(plan, index => successes.has(plan.attempts[index].id), greatNoteIndices.length > 0)
  const losses = new Map<number, number>()
  for (const noteIndex of greatNoteIndices) {
    const note = choices.eligible.find(row => row.noteIndex === noteIndex)
    if (!note) throw new Error('GREAT note is unavailable or protected by a judgment boost')
    losses.set(note.groupIndex, (losses.get(note.groupIndex) ?? 0) + note.loss)
  }
  let score = 0
  const groups = plan.groups.map((group, groupIndex) => {
    const winner = group.candidates.find(row => successes.has(plan.attempts[row.attemptIndex].id))
    const points = (winner?.points ?? group.basePoints) - (losses.get(groupIndex) ?? 0)
    score += points
    return { timeMicroseconds: group.timeMicroseconds, points, cumulativeScore: score, successfulScoringAttemptId: winner ? plan.attempts[winner.attemptIndex].id : null }
  })
  return { score: integer(score, 'run total'), successfulAttemptIds: [...successes], greatNoteIndices: [...greatNoteIndices], groups }
}

/** xoshiro128** 1.1 by Blackman/Vigna, public-domain reference:
 * https://prng.di.unimi.it/xoshiro128starstar.c . This is our simulation RNG.
 * Seed expansion and the two-draw 53-bit conversion are versioned here. */
export function simulationRandom(seed: number) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error('Seed must be a uint32')
  let value = seed >>> 0
  const s = Array.from({ length: 4 }, () => {
    value = (value + 0x9e3779b9) >>> 0
    let z = value
    z = Math.imul(z ^ z >>> 16, 0x21f0aaad)
    z = Math.imul(z ^ z >>> 15, 0x735a2d97)
    return (z ^ z >>> 15) >>> 0
  })
  if (s.reduce((combined, word) => combined | word, 0) === 0) s[0] = 1
  const rotl = (x: number, k: number) => (x << k | x >>> (32 - k)) >>> 0
  const next = () => {
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0, t = s[1] << 9
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 11)
    return result
  }
  return () => (next() >>> 5) * 67_108_864 + (next() >>> 6)
}

export interface ScoreSimulationOptions { seed: number; runs: number; playMode?: ScorePlayMode; maxGreats?: number }
export type RunWitness = { score: number; successfulAttemptIds: string[]; greatNoteIndices?: number[] }

export function scorePerformance(options: Pick<ScoreSimulationOptions, 'playMode' | 'maxGreats'>) {
  const playMode = options.playMode ?? 'all-perfect'
  if (playMode !== 'all-perfect' && playMode !== 'full-combo') throw new Error('Choose All Perfect or Full Combo')
  const maxGreats = options.maxGreats ?? (playMode === 'full-combo' ? 10 : 0)
  if (!Number.isInteger(maxGreats) || maxGreats < 0 || maxGreats > 10 || playMode === 'all-perfect' && maxGreats !== 0) throw new Error('GREAT limit must be 0–10, or zero for All Perfect')
  return { playMode, maxGreats }
}

function runChoices(plan: ScoreDistributionPlan, success: (index: number) => boolean, withGreats: boolean) {
  if (withGreats && !plan.fullCombo) throw new Error(`Full Combo unavailable: ${plan.fullComboReasons?.join('; ') || 'missing judgment model'}`)
  let score = 0
  const winners = plan.groups.map(group => {
    const winner = group.candidates.findIndex(row => success(row.attemptIndex))
    score += winner < 0 ? group.basePoints : group.candidates[winner].points
    return winner
  })
  const eligible = withGreats ? plan.fullCombo!.notes.flatMap(note => {
    const protection = plan.fullCombo!.protection[note.groupIndex]
    if (protection.guaranteed || protection.attemptIndices.some(success)) return []
    const winner = winners[note.groupIndex]
    return [{ noteIndex: note.noteIndex, groupIndex: note.groupIndex, loss: winner < 0 ? note.baseLoss : note.candidateLosses[winner] }]
  }) : []
  return { score, eligible }
}

/** With an intact combo, GREAT only reduces its own rounded award. More score
 * or judgment-boost successes cannot reduce the score or create new GREAT
 * positions. Thus the minimum uses guaranteed successes and the largest at
 * most K eligible losses; the maximum is the all-possible AP history. */
export function scoreOutcomeBounds(plan: ScoreDistributionPlan, options: Pick<ScoreSimulationOptions, 'playMode' | 'maxGreats'> = {}): { minimum: RunWitness; maximum: RunWitness } {
  const { playMode, maxGreats } = scorePerformance(options)
  if (playMode === 'all-perfect' || maxGreats === 0) return plan.bounds
  const minimum = runChoices(plan, index => plan.attempts[index].threshold53 === UNIFORM_SIZE, true)
  const worst = minimum.eligible.sort((a, b) => b.loss - a.loss || a.noteIndex - b.noteIndex).slice(0, maxGreats)
  return { minimum: { score: integer(minimum.score - worst.reduce((sum, row) => sum + row.loss, 0), 'Full Combo minimum'),
    successfulAttemptIds: [...plan.bounds.minimum.successfulAttemptIds], greatNoteIndices: worst.map(row => row.noteIndex).sort((a, b) => a - b) }, maximum: plan.bounds.maximum }
}

function uniformInteger(random: () => number, count: number) {
  const ceiling = UNIFORM_SIZE - UNIFORM_SIZE % count
  let value: number
  do { value = random() } while (value >= ceiling)
  return value % count
}

export function simulateScoreRuns(plan: ScoreDistributionPlan, options: ScoreSimulationOptions, onProgress?: (completed: number) => void) {
  if (plan.modelVersion !== SCORE_DISTRIBUTION_MODEL_VERSION || plan.tieOrder !== 'retained-corpus-order') throw new Error('Unsupported distribution model')
  if (!Number.isInteger(options.runs) || options.runs < 2 || options.runs > 10000) throw new Error('Choose between 2 and 10000 runs')
  const performance = scorePerformance(options), bounds = scoreOutcomeBounds(plan, performance)
  const random = simulationRandom(options.seed), successes = new Uint8Array(plan.attempts.length)
  // Keep the same activation histories when comparing AP and FC with one seed.
  // Error placement has its own versioned stream and cannot consume skill rolls.
  const placementRandom = simulationRandom((options.seed ^ 0xa5a5a5a5) >>> 0)
  const scores: number[] = []
  const greatCounts = Array.from({ length: performance.maxGreats + 1 }, () => 0)
  let mean = 0, m2 = 0
  let lowest: RunWitness | null = null, highest: RunWitness | null = null
  for (let run = 0; run < options.runs; run++) {
    for (let index = 0; index < successes.length; index++) successes[index] = Number(random() < plan.attempts[index].threshold53)
    const choices = runChoices(plan, index => Boolean(successes[index]), performance.maxGreats > 0)
    let score = choices.score
    const greatNoteIndices: number[] = []
    const count = performance.maxGreats ? uniformInteger(placementRandom, Math.min(performance.maxGreats, choices.eligible.length) + 1) : 0
    // Uniform subset without replacement: at most ten swaps, never enumerate placements.
    for (let i = 0; i < count; i++) {
      const j = i + uniformInteger(placementRandom, choices.eligible.length - i)
      ;[choices.eligible[i], choices.eligible[j]] = [choices.eligible[j], choices.eligible[i]]
      const note = choices.eligible[i]
      greatNoteIndices.push(note.noteIndex); score -= note.loss
    }
    greatNoteIndices.sort((a, b) => a - b); greatCounts[count]++
    if (score < bounds.minimum.score || score > bounds.maximum.score) throw new Error('Simulated score exceeds proven model bounds')
    scores.push(score)
    const delta = score - mean
    mean += delta / (run + 1); m2 += delta * (score - mean)
    if (!lowest || score < lowest.score) lowest = { score, successfulAttemptIds: plan.attempts.filter((_row, i) => successes[i]).map(row => row.id), greatNoteIndices }
    if (!highest || score > highest.score) highest = { score, successfulAttemptIds: plan.attempts.filter((_row, i) => successes[i]).map(row => row.id), greatNoteIndices }
    if ((run + 1) % 256 === 0 || run + 1 === options.runs) onProgress?.(run + 1)
  }
  scores.sort((a, b) => a - b)
  const scoreCounts: Array<{ score: number; count: number }> = []
  for (const score of scores) {
    const last = scoreCounts.at(-1)
    if (last?.score === score) last.count++; else scoreCounts.push({ score, count: 1 })
  }
  const percentile = (p: number) => scores[Math.max(0, Math.ceil(p * scores.length) - 1)]
  const standardDeviation = Math.sqrt(m2 / (options.runs - 1)), meanStandardError = standardDeviation / Math.sqrt(options.runs)
  // Known model bounds give a conservative IID Hoeffding interval even when
  // a small sample misses rare outcomes and its observed variance is zero.
  const meanMargin95 = (bounds.maximum.score - bounds.minimum.score) * Math.sqrt(Math.log(40) / (2 * options.runs))
  const width = Math.max(1, Math.ceil((scores.at(-1)! - scores[0] + 1) / 20))
  const histogram = Array.from({ length: Math.floor((scores.at(-1)! - scores[0]) / width) + 1 }, (_, i) => ({ from: scores[0] + i * width, to: scores[0] + (i + 1) * width - 1, count: 0 }))
  for (const row of scoreCounts) histogram[Math.floor((row.score - scores[0]) / width)].count += row.count
  return { modelVersion: SCORE_DISTRIBUTION_MODEL_VERSION, rngVersion: SIMULATION_RNG_VERSION, seed: options.seed, runs: options.runs,
    ...performance, placementModel: performance.playMode === 'full-combo' ? FULL_COMBO_PLACEMENT_VERSION : null,
    greatCounts, bounds,
    mean, standardDeviation, meanStandardError, meanSampling95: { method: 'bounded-iid-hoeffding' as const,
      lower: Math.max(bounds.minimum.score, mean - meanMargin95), upper: Math.min(bounds.maximum.score, mean + meanMargin95) },
    percentiles: { p10: percentile(.1), p50: percentile(.5), p90: percentile(.9) }, scoreCounts, histogram,
    sampledLowest: lowest!, sampledHighest: highest! }
}
export type ScoreSimulationResult = ReturnType<typeof simulateScoreRuns>

/** Wilson interval expresses sampling uncertainty, not formula/game uncertainty. */
export function scoreTargetProbability(result: ScoreSimulationResult, target: number) {
  integer(target, 'target score')
  const hits = result.scoreCounts.reduce((sum, row) => sum + (row.score >= target ? row.count : 0), 0)
  const n = result.runs, p = hits / n, z2 = 1.96 ** 2, denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator, radius = 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator
  return { hits, probability: p, interval95: { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) } }
}
