import { exactFraction, prepareTimelineNotes, type BoundedMass, type ChartTimelineReport, type ExactFraction } from './chart-timeline'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import type { ScoringData } from './scoring-data'
import type { Resolution, SkillReport } from './team-parameters'
import { advanceClientSkillCheck, clientActivationProbability, clientActiveCooldown, clientFloatFraction, clientSkillScoreRatio } from './live-skill-client'
import { LIVE_SCORE_CLIENT } from './live-score'
import { resolveLifeCondition, resolveLiveLife } from './live-life'
import { resolveStaticSkillModifiers, type StaticSkillModifierType } from './static-skill-modifiers'

/** Reviewed Android arithmetic within an ideal-time diagnostic, not a full run simulation. */
export const LIVE_SKILL_MODEL_VERSION = 'client-informed-live-skills-v6'
export const LIVE_SKILL_UPDATE_ORDER = 'Active-checks-before-SP-activation-before-expiration-before-notes'
const SUPPORT = 'LIVE_ACTIVE_SKILL_EFFECT_UP_PERMIL_UP'
const SP_SUPPORT = 'SCORE_UP_EFFECT_UP_PERMIL_UP'
const PROBABILITY = 'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP'
const FREQUENCY = 'LIVE_ACTIVE_SKILL_COOL_TIME_SHORTEN_PERMIL_UP'
const SCORE = 'SCORE_UP_PERMIL_UP'
const ok = <T>(value: T): Resolution<T> => ({ status: 'resolved', value })
const unknown = <T>(reasons: string[]): Resolution<T> => ({ status: 'unresolved', value: null, reasons: [...new Set(reasons)] })
const f = (n: number | bigint, d: number | bigint = 1) => exactFraction(BigInt(n), BigInt(d))
const zero = f(0), one = f(1)
const add = (a: ExactFraction, b: ExactFraction) => f(BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator))
const mul = (a: ExactFraction, b: ExactFraction) => f(BigInt(a.numerator) * BigInt(b.numerator), BigInt(a.denominator) * BigInt(b.denominator))
const compare = (a: ExactFraction, b: ExactFraction) => {
  const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator)
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}
const seconds = (time: ExactFraction) => Number(time.numerator) / Number(time.denominator) / 1_000_000
const microseconds = (timeSeconds: number) => mul(clientFloatFraction(timeSeconds), f(1_000_000))
function wholePermil(value: ExactFraction): number {
  if (value.denominator !== '1' || BigInt(value.numerator) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Expected safe integer modifier')
  return Number(value.numerator)
}
function endTime(skill: SkillReport, start: ExactFraction): ExactFraction {
  const duration = skill.definition.durationMilliseconds
  if (duration === null || !Number.isSafeInteger(duration) || duration < 0) throw new Error('Missing or invalid skill duration')
  return microseconds(Math.fround(Math.fround(seconds(start)) + Math.fround(Math.fround(duration) / 1000)))
}
function map<T, U>(value: Resolution<T>, transform: (input: T) => U): Resolution<U> {
  return value.status === 'resolved' ? ok(transform(value.value)) : unknown(value.reasons)
}
function sum(values: Resolution<ExactFraction>[]): Resolution<ExactFraction> {
  const reasons = values.flatMap(value => value.status === 'unresolved' ? value.reasons : [])
  return reasons.length ? unknown(reasons) : ok(values.reduce((total, value) => add(total, value.value!), zero))
}

/** The client floors the adjusted milliseconds, then stores float32 seconds. */
export function adjustedActiveInterval(cooldownMilliseconds: number, frequencyPermil: number): ExactFraction {
  return microseconds(clientActiveCooldown(cooldownMilliseconds, frequencyPermil).seconds)
}

/** A Bernoulli expectation uses the client's float32 lottery threshold. */
export function activeProbability(basePermil: number, boardPermil: number, specialPermil: number) {
  const calculation = clientActivationProbability(basePermil, boardPermil, [], [specialPermil])
  return { ...calculation, value: ok(clientFloatFraction(calculation.bernoulliProbability)) }
}

/** Independent Bernoulli expectation. Branches of a single proc are combined before this step. */
export function expectedSupportedActive(outcomes: Array<{ probability: ExactFraction; strengthPermil: ExactFraction }>): ExactFraction {
  let survival = one, total = zero
  for (const row of outcomes.slice().sort((a, b) => compare(b.strengthPermil, a.strengthPermil))) {
    if (compare(row.probability, one) > 0) throw new Error('Probability exceeds one')
    total = add(total, mul(mul(survival, row.probability), row.strengthPermil))
    survival = mul(survival, f(BigInt(row.probability.denominator) - BigInt(row.probability.numerator), BigInt(row.probability.denominator)))
    if (survival.numerator === '0') break
  }
  return total
}

interface EffectWindow {
  skill: SkillReport
  start: ExactFraction
  end: ExactFraction
}
export interface LiveSkillAttempt {
  id: string
  ownerId: string
  skillId: string
  level: number
  startMicroseconds: ExactFraction
  endMicroseconds: ExactFraction
  probability: Resolution<ExactFraction>
  probabilityCalculation: ReturnType<typeof activeProbability> | null
  rawScoreUpPermil: Resolution<ExactFraction>
  staticSupportPermil: Resolution<ExactFraction>
  judgementEnhance?: Resolution<boolean>
}

/** Consumes the existing validated team/timeline boundary. No input is mutated. */
export function resolveLiveSkillSchedule(timeline: ChartTimelineReport, chart: OptimizerDecodedChart, data: ScoringData, staticModifiers: 'additive-assumption' | 'verified-only', includeJudgementEnhance = false, identity?: Parameters<typeof resolveLiveLife>[3]) {
  if (!['additive-assumption', 'verified-only'].includes(staticModifiers)) throw new Error('Unknown static modifier policy')
  if (chart.identity.chartKey !== timeline.chart.identity.chartKey || chart.platform !== timeline.chart.identity.platform
    || chart.identity.indexSha256 !== data.metadata.chartIndexSha256 || chart.identity.eventBlobSha256 !== data.metadata.chartBlobSha256
    || chart.identity.sourceCommit !== data.metadata.sourceCommit || chart.identity.sourceRepository !== data.metadata.sourceRepository
    || chart.identity.catalogVersion !== data.metadata.catalogVersion) throw new Error('Live skill model input identity mismatch')
  const notes = prepareTimelineNotes(chart)
  const team = timeline.team
  const life = resolveLiveLife(chart, team.skills, data, identity)
  const modifierReports = resolveStaticSkillModifiers(team, staticModifiers)
  const mode = timeline.activeMode === 'recorded' ? 'recorded' as const : 'expected' as const
  const scheduleReasons: string[] = []
  const noteCountBefore = (time: ExactFraction) => {
    let low = 0, high = notes.times.length
    while (low < high) {
      const mid = (low + high) >>> 1, order = compare(f(notes.times[mid]), time)
      if (order < 0) low = mid + 1
      else high = mid
    }
    return low
  }
  const condition = (branch: SkillReport['branches'][number], time: ExactFraction): Resolution<boolean> => {
    if (branch.status === 'active') return ok(true)
    if (branch.status === 'inactive') return ok(false)
    const triggers = branch.triggerGroupId ? data.triggers[branch.triggerGroupId] : []
    if (triggers?.length) {
      // Base.ManualUpdate dispatches skills before input judgments and note
      // updates. Under this model's exact-time convention, equal-time notes
      // cannot satisfy the gate until a later check. Real frame/judge times
      // remain outside the ideal-time model.
      const values = triggers.map(trigger => trigger.type === 'COMBO_GTE' ? ok(noteCountBefore(time) >= trigger.threshold)
        : trigger.type === 'LIFE_GTE' || trigger.type === 'LIFE_LTE' ? resolveLifeCondition(trigger, life.minimum)
          : unknown<boolean>([`condition:${branch.triggerGroupId}`]))
      if (values.some(value => value.status === 'resolved' && !value.value)) return ok(false)
      const reasons = values.flatMap(value => value.status === 'unresolved' ? value.reasons : [])
      return reasons.length ? unknown(reasons) : ok(true)
    }
    return unknown([`condition:${branch.triggerGroupId ?? 'unknown'}`])
  }
  const effectValue = (skill: SkillReport, type: string, time: ExactFraction): Resolution<ExactFraction> => {
    const rows = skill.branches.flatMap(branch => {
      const effects = data.activeEffects[branch.effectGroupId]
      if (!effects) throw new Error(`Missing skill effects ${branch.effectGroupId}`)
      return effects.filter(effect => effect.type === type && effect.value > 0).map(effect => ({ branch, value: f(effect.value), condition: condition(branch, time) }))
    })
    const possible = rows.filter(row => row.condition.status !== 'resolved' || row.condition.value)
    if (possible.length === 0) return ok(zero)
    const reasons = possible.flatMap(row => row.condition.status === 'unresolved' ? row.condition.reasons : [])
    if (reasons.length) return unknown(reasons)
    // The client admits branches independently, then takes the maximum for
    // each effect type in its Active/SP category. No card-specific replacement.
    return ok(possible.reduce((best, row) => compare(row.value, best) > 0 ? row.value : best, zero))
  }
  const memberModifier = (skill: SkillReport, type: StaticSkillModifierType): Resolution<ExactFraction> =>
    map(modifierReports.find(row => row.ownerId === skill.ownerId && row.skillId === skill.skillId && row.type === type)!.value, value => f(value))
  const specialWindows: EffectWindow[] = timeline.specialSlots.flatMap(slot => {
    if (slot.timeMicroseconds === null) return []
    const skill = team.skills.find(row => row.kind === 'special' && row.skillId === slot.skillId && row.ownerId === slot.ownerId)!
    const start = f(slot.timeMicroseconds)
    return [{ skill, start, end: endTime(skill, start) }]
  })
  const within = (time: ExactFraction, start: ExactFraction, end: ExactFraction) => compare(time, start) >= 0 && compare(time, end) < 0
  const specialAt = (time: ExactFraction, type: string, phase: 'active-check' | 'note' = 'note'): Resolution<ExactFraction> => {
    // UpdateSkill processes Active checks before admitting new SP effects;
    // ManualUpdate removes expired effects only afterward. At an exact-time
    // check, an ending SP still exists and a starting SP does not yet exist.
    // Note scoring follows both phases and therefore retains [start,end).
    // This fixes event ordering within ideal time, not unknown frame delays.
    const values = specialWindows.filter(row => phase === 'active-check'
      ? compare(time, row.start) > 0 && compare(time, row.end) <= 0
      : within(time, row.start, row.end)).map(row => effectValue(row.skill, type, row.start))
    const reasons = values.flatMap(value => value.status === 'unresolved' ? value.reasons : [])
    return reasons.length ? unknown(reasons) : ok(values.reduce((best, value) => compare(value.value!, best) > 0 ? value.value! : best, zero))
  }
  const attempts: LiveSkillAttempt[] = []
  const enhances = (skill: SkillReport, time: ExactFraction): Resolution<boolean> => {
    // JUDGEMENT_ENHANCE is a flag with source value 0, not a numeric bonus.
    const values = skill.branches.filter(branch => data.activeEffects[branch.effectGroupId].some(effect => effect.type === 'JUDGEMENT_ENHANCE')).map(branch => condition(branch, time))
    if (values.some(value => value.status === 'resolved' && value.value)) return ok(true)
    const reasons = values.flatMap(value => value.status === 'unresolved' ? value.reasons : [])
    return reasons.length ? unknown(reasons) : ok(false)
  }
  const schedules: Array<{ ownerId: string; skillId: string; intervalMicroseconds: Resolution<ExactFraction>; generatedChecks: number }> = []
  for (const skill of team.skills.filter(row => row.kind === 'active')) {
    const hasScore = skill.branches.some(branch => data.activeEffects[branch.effectGroupId].some(effect => effect.type === SCORE && effect.value > 0))
    if (!hasScore && !(includeJudgementEnhance && skill.branches.some(branch => data.activeEffects[branch.effectGroupId].some(effect => effect.type === 'JUDGEMENT_ENHANCE')))) continue
    const frequency = memberModifier(skill, FREQUENCY)
    const interval = map(frequency, value => adjustedActiveInterval(skill.definition.cooldownMilliseconds!, wholePermil(value)))
    const starts: ExactFraction[] = []
    if (mode === 'recorded') starts.push(...timeline.activations!.filter(row => row.ownerId === skill.ownerId && row.skillId === skill.skillId).map(row => f(row.timeMicroseconds)))
    else if (interval.status === 'unresolved') scheduleReasons.push(...interval.reasons)
    else {
      const duration = seconds(interval.value)
      for (let next = duration; next <= chart.durationMicroseconds / 1_000_000; next = advanceClientSkillCheck(next, duration)) {
        if (starts.length + attempts.length >= 5000) throw new Error('Too many live activation checks')
        starts.push(microseconds(next))
      }
    }
    schedules.push({ ownerId: skill.ownerId, skillId: skill.skillId, intervalMicroseconds: interval, generatedChecks: mode === 'expected' ? starts.length : 0 })
    for (const [index, start] of starts.entries()) {
      const board = memberModifier(skill, PROBABILITY), special = specialAt(start, PROBABILITY, 'active-check')
      let calculation: ReturnType<typeof activeProbability> | null = null
      let probability: Resolution<ExactFraction> = ok(one)
      if (mode === 'expected') {
        if (board.status === 'unresolved' || special.status === 'unresolved') probability = unknown([...(board.status === 'unresolved' ? board.reasons : []), ...(special.status === 'unresolved' ? special.reasons : [])])
        else {
          calculation = activeProbability(skill.definition.activationProbabilityPermil!, wholePermil(board.value), wholePermil(special.value))
          probability = calculation.value
        }
      }
      attempts.push({ id: `${skill.ownerId}:${skill.skillId}:${index + 1}`, ownerId: skill.ownerId, skillId: skill.skillId, level: skill.level,
        startMicroseconds: start, endMicroseconds: endTime(skill, start), probability, probabilityCalculation: calculation,
        rawScoreUpPermil: effectValue(skill, SCORE, start), staticSupportPermil: memberModifier(skill, SUPPORT),
        ...(includeJudgementEnhance ? { judgementEnhance: enhances(skill, start) } : {}) })
    }
  }
  return { notes, team, life, modifierReports, mode, scheduleReasons, schedules, attempts, specialWindows, effectValue, within, specialAt, enhances }
}

export function resolveLiveSkillModel(timeline: ChartTimelineReport, chart: OptimizerDecodedChart, data: ScoringData, staticModifiers: 'additive-assumption' | 'verified-only' = 'additive-assumption', includeJudgementEnhance = false, identity?: Parameters<typeof resolveLiveLife>[3]) {
  const { notes, team, life, modifierReports, mode, scheduleReasons, schedules, attempts, specialWindows, effectValue, within, specialAt, enhances } =
    resolveLiveSkillSchedule(timeline, chart, data, staticModifiers, includeJudgementEnhance, identity)
  const dependencies = new Set<string>()
  type Candidate = { attemptId: string; probability: Resolution<ExactFraction>; supportedScoreUpPermil: Resolution<ExactFraction> }
  const events: Array<{ timeMicroseconds: number; noteCount: number; candidates: Candidate[]; specialSupportPermil: Resolution<ExactFraction>; expectedScoreUpPermil: Resolution<ExactFraction> }> = []
  let low = zero, high = zero
  for (let start = 0; start < notes.times.length;) {
    const time = f(notes.times[start])
    let end = start + 1
    while (end < notes.times.length && notes.times[end] === notes.times[start]) end++
    const active = attempts.filter(row => within(time, row.startMicroseconds, row.endMicroseconds))
    const special = specialAt(time, SP_SUPPORT)
    const reasons = [...scheduleReasons]
    const outcomes: Parameters<typeof expectedSupportedActive>[0] = []
    const candidates: Candidate[] = []
    for (const attempt of active) {
      if (attempt.rawScoreUpPermil.status === 'resolved' && attempt.rawScoreUpPermil.value.numerator === '0' || attempt.probability.status === 'resolved' && attempt.probability.value.numerator === '0') continue
      const support = sum([attempt.staticSupportPermil, special])
      const strength = attempt.rawScoreUpPermil.status === 'resolved' && support.status === 'resolved'
        ? ok(mul(clientFloatFraction(clientSkillScoreRatio([{ category: 'active', scoreUpPermil: wholePermil(attempt.rawScoreUpPermil.value), cardSupportPermil: wholePermil(attempt.staticSupportPermil.value!) }], [], [wholePermil(special.value!)]).total), f(1000)))
        : unknown<ExactFraction>([...(attempt.rawScoreUpPermil.status === 'unresolved' ? attempt.rawScoreUpPermil.reasons : []), ...(support.status === 'unresolved' ? support.reasons : [])])
      candidates.push({ attemptId: attempt.id, probability: attempt.probability, supportedScoreUpPermil: strength })
      for (const value of [attempt.rawScoreUpPermil, attempt.probability, support]) if (value.status === 'unresolved') reasons.push(...value.reasons)
      if (attempt.probability.status === 'resolved' && strength.status === 'resolved') outcomes.push({ probability: attempt.probability.value, strengthPermil: strength.value })
    }
    const expected = reasons.length ? unknown<ExactFraction>(reasons) : ok(expectedSupportedActive(outcomes))
    if (expected.status === 'unresolved') expected.reasons.forEach(reason => dependencies.add(reason))
    else {
      low = add(low, mul(expected.value, f(notes.lower[end] - notes.lower[start], 1_000_000_000)))
      high = add(high, mul(expected.value, f(notes.upper[end] - notes.upper[start], 1_000_000_000)))
    }
    events.push({ timeMicroseconds: notes.times[start], noteCount: end - start, candidates, specialSupportPermil: special, expectedScoreUpPermil: expected })
    start = end
  }
  const exposure: Resolution<BoundedMass> = dependencies.size ? unknown([...dependencies]) : ok({ lower: low, upper: high, exact: compare(low, high) === 0 ? ok(low) : unknown(['simultaneous-note-order']) })
  const judgementReasons = new Set<string>(includeJudgementEnhance ? scheduleReasons : [])
  const judgementEnhancements = includeJudgementEnhance ? events.map(event => {
    const time = f(event.timeMicroseconds)
    const special = specialWindows.filter(row => within(time, row.start, row.end)).map(row => enhances(row.skill, row.start))
    const guaranteed = special.some(value => value.status === 'resolved' && value.value)
    const active = attempts.filter(row => within(time, row.startMicroseconds, row.endMicroseconds) && row.judgementEnhance?.value !== false)
    if (!guaranteed) {
      special.forEach(value => { if (value.status === 'unresolved') value.reasons.forEach(reason => judgementReasons.add(reason)) })
      active.forEach(row => {
        if (row.probability.status === 'resolved' && row.probability.value.numerator === '0') return
        for (const value of [row.judgementEnhance!, row.probability]) if (value.status === 'unresolved') value.reasons.forEach(reason => judgementReasons.add(reason))
      })
    }
    return { timeMicroseconds: event.timeMicroseconds, guaranteed,
      attemptIds: guaranteed ? [] : active.filter(row => row.judgementEnhance?.value === true && row.probability.status === 'resolved' && row.probability.value.numerator !== '0').map(row => row.id) }
  }) : []
  return {
    modelVersion: LIVE_SKILL_MODEL_VERSION, client: { ...LIVE_SCORE_CLIENT }, modifierReports, interpretation: 'client-arithmetic-with-ideal-timing-not-game-score' as const, activeMode: mode,
    conventions: { timerOriginMicroseconds: 0, firstCheck: 'after-floored-millisecond-interval', repeatedChecks: 'float32-addition-to-previous-deadline', window: '[start,end)',
      spProbabilityAtActiveCheck: '(start,end]', updateOrder: LIVE_SKILL_UPDATE_ORDER, comboConditions: 'at-check-before-notes', independentChecks: mode === 'expected', staticModifiers },
    schedules, attempts, events, activeNoteMass: exposure, life,
    specialWindows: specialWindows.map(({ skill, start, end }) => ({
      ownerId: skill.ownerId, start, end, support: effectValue(skill, SP_SUPPORT, start),
      rate: effectValue(skill, PROBABILITY, start),
    })),
    judgementEnhancements, judgementReasons: [...judgementReasons],
    deferredEffects: team.skills.filter(skill => skill.kind === 'active' || skill.kind === 'special').flatMap(skill => skill.branches.flatMap(branch =>
      data.activeEffects[branch.effectGroupId].filter(effect => effect.type === 'LIFE_RECOVERY' && life.minimum.status === 'unresolved' || effect.type === 'JUDGEMENT_ENHANCE' && !includeJudgementEnhance).map(effect => ({ ownerId: skill.ownerId, skillId: skill.skillId, effectType: effect.type, sourceValue: effect.value,
        reason: effect.type === 'LIFE_RECOVERY' ? 'LIFE impact is unreviewed for these inputs' : 'No score effect on AP; protection is evaluated separately for restricted Full Combo plays' })))),
    unresolved: [...dependencies],
    gameVerificationRequired: ['actual-frame-and-judgment-times', 'activation-clock-origin', 'independent-checks-and-prng', 'static-support-aggregation', 'whole-run-skill-integration'],
    chartScore: unknown<number>(['actual-frame-and-judgment-times', 'whole-run-skill-integration'])
  }
}
export type LiveSkillReport = ReturnType<typeof resolveLiveSkillModel>
