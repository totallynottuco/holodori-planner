import { z } from 'zod'
import { officialComboMultiplierPermil, type OptimizerDecodedChart } from './optimizer-chart-pack'
import { resolveTeamParameters, type ObservedFormationBonuses, type Resolution, type SkillReport, type TeamSelection, type UnresolvedRule } from './team-parameters'
import { activeEffectTypes, type ScoringData } from './scoring-data'
import type { AppProfileV2 } from './types'

export const CHART_TIMELINE_MODEL_VERSION = 'chart-timeline-v1'
export const activeActivationSchema = z.object({
  ownerId: z.string().min(1), skillId: z.string().min(1), timeMicroseconds: z.number().int().min(0).max(0xffff_ffff)
}).strict()
export const activeActivationsSchema = z.array(activeActivationSchema).max(5000)
export type ActiveActivation = z.infer<typeof activeActivationSchema>
type EffectType = (typeof activeEffectTypes)[number]

/** Reduced exact rational; decimal strings keep JSON lossless without floating-point rounding. */
export interface ExactFraction { numerator: string; denominator: string }
export function exactFraction(numerator: bigint, denominator: bigint): ExactFraction {
  if (denominator <= 0n || numerator < 0n) throw new Error('Expected a nonnegative fraction with a positive denominator')
  let a = numerator, b = denominator
  while (b) [a, b] = [b, a % b]
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() }
}
const resolved = <T>(value: T): Resolution<T> => ({ status: 'resolved', value })
const missing = <T>(reasons: string[]): Resolution<T> => ({ status: 'unresolved', value: null, reasons: [...new Set(reasons)] })
export interface BoundedMass {
  lower: ExactFraction
  upper: ExactFraction
  exact: Resolution<ExactFraction>
}
export interface WindowCoverage {
  certainNotes: number
  possibleNotes: number
  comboWeightedNoteMass: BoundedMass
}
export interface TimelineWindow {
  id: string
  activationId: string
  source: 'active' | 'special'
  ownerId: string
  skillId: string
  level: number
  branch: 'primary' | 'additional'
  effectGroupId: string
  effectNumber: number
  effectType: EffectType
  sourceValue: number
  description: string
  startMicroseconds: number
  endMicroseconds: number
  condition: Resolution<boolean>
  coverage: WindowCoverage | null
}
export interface TimelineChannel {
  effectType: EffectType
  /** Raw Active effect coefficients only; never includes support, Board multipliers or score conversion. */
  rawActiveExposure: Resolution<BoundedMass>
  combination: 'highest-active-effect'
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`)
  return value
}
function boundIndex(times: Uint32Array, target: number, afterEqual: boolean): number {
  let low = 0, high = times.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (times[middle] < target || afterEqual && times[middle] === target) low = middle + 1
    else high = middle
  }
  return low
}

/** Prefix bounds allow every ordering of simultaneous note types across a combo threshold. */
export function prepareTimelineNotes(chart: OptimizerDecodedChart) {
  const times = chart.eventTimesMicroseconds, weights = chart.eventWeightsPermil
  if (times.length !== weights.length || times.length !== chart.eventNoteTypes.length || times.length !== chart.total_notes) throw new Error('Chart event lengths disagree')
  safeInteger(chart.durationMicroseconds, 'chart duration')
  if (chart.durationMicroseconds > 0xffff_ffff) throw new Error('Chart duration exceeds uint32')
  for (let index = 0; index < times.length; index++) {
    if (times[index] > chart.durationMicroseconds || index > 0 && times[index] < times[index - 1]) throw new Error('Invalid chart event order or duration')
    if (!Number.isInteger(weights[index]) || weights[index] < 1 || weights[index] > 65535 || chart.eventNoteTypes[index] < 1 || chart.eventNoteTypes[index] > 7) throw new Error('Invalid chart note coefficient/type')
  }
  const lower = new Float64Array(times.length + 1), upper = new Float64Array(times.length + 1)
  const ambiguousTieTimes: number[] = []
  for (let start = 0; start < times.length;) {
    let end = start + 1
    while (end < times.length && times[end] === times[start]) end++
    const ordered = Array.from(weights.subarray(start, end)).sort((a, b) => a - b)
    for (let index = start; index < end; index++) {
      const combo = officialComboMultiplierPermil(index + 1)
      lower[index + 1] = safeInteger(lower[index] + ordered[end - index - 1] * combo, 'minimum note mass')
      upper[index + 1] = safeInteger(upper[index] + ordered[index - start] * combo, 'maximum note mass')
    }
    if (lower[end] - lower[start] !== upper[end] - upper[start]) ambiguousTieTimes.push(times[start])
    start = end
  }
  return { times, lower, upper, ambiguousTieTimes }
}
type TimelineNotes = ReturnType<typeof prepareTimelineNotes>
function massBounds(low: bigint, high: bigint, denominator: bigint, reasons: string[]): BoundedMass {
  const lower = exactFraction(low, denominator), upper = exactFraction(high, denominator)
  return { lower, upper, exact: low === high ? resolved(lower) : missing(reasons) }
}
function windowCoverage(notes: TimelineNotes, start: number, end: number): WindowCoverage {
  const certainStart = boundIndex(notes.times, start, true), certainEnd = boundIndex(notes.times, end, false)
  const possibleStart = boundIndex(notes.times, start, false), possibleEnd = boundIndex(notes.times, end, true)
  const low = notes.lower[certainEnd] - notes.lower[certainStart]
  const high = notes.upper[possibleEnd] - notes.upper[possibleStart]
  return { certainNotes: certainEnd - certainStart, possibleNotes: possibleEnd - possibleStart,
    comboWeightedNoteMass: massBounds(BigInt(low), BigInt(high), 1_000_000n, ['skill-note-boundary-or-note-tie']) }
}

/** Returns raw coefficient exposure. Same-effect Active skills use max, never sum. */
export function rawActiveExposure(notes: TimelineNotes, windows: TimelineWindow[]): BoundedMass {
  const active = windows.filter(window => window.source === 'active' && window.endMicroseconds > window.startMicroseconds && !(window.condition.status === 'resolved' && !window.condition.value))
  const edges = active.flatMap((window, index) => [
    { time: window.startMicroseconds, kind: 'start' as const, index },
    { time: window.endMicroseconds, kind: 'end' as const, index }
  ]).sort((a, b) => a.time - b.time)
  const open = new Set<number>()
  let cursor = 0, low = 0n, high = 0n
  for (let start = 0; start < notes.times.length;) {
    const time = notes.times[start]
    let end = start + 1
    while (end < notes.times.length && notes.times[end] === time) end++
    while (cursor < edges.length && edges[cursor].time < time) {
      const edge = edges[cursor++]
      if (edge.kind === 'start') open.add(edge.index)
      else open.delete(edge.index)
    }
    const possible = new Set(open)
    while (cursor < edges.length && edges[cursor].time === time) {
      const edge = edges[cursor++]
      possible.add(edge.index)
      if (edge.kind === 'end') open.delete(edge.index)
    }
    let lowerCoefficient = 0, upperCoefficient = 0
    for (const index of possible) {
      const window = active[index]
      upperCoefficient = Math.max(upperCoefficient, window.sourceValue)
      if (window.startMicroseconds < time && window.endMicroseconds > time && window.condition.status === 'resolved') lowerCoefficient = Math.max(lowerCoefficient, window.sourceValue)
    }
    // Reconstruct the post-boundary active set without choosing a game event tie order.
    for (const index of possible) if (active[index].startMicroseconds === time && active[index].endMicroseconds > time) open.add(index)
    low += BigInt(notes.lower[end] - notes.lower[start]) * BigInt(lowerCoefficient)
    high += BigInt(notes.upper[end] - notes.upper[start]) * BigInt(upperCoefficient)
    start = end
  }
  return massBounds(low, high, 1_000_000_000n, ['active-conditions-or-boundary-order'])
}

export function resolveChartTimeline(profile: AppProfileV2, selection: TeamSelection, chart: OptimizerDecodedChart, data: ScoringData, recordedActivations: ActiveActivation[] | null = null, observed?:ObservedFormationBonuses) {
  const team = resolveTeamParameters(profile, selection, data, observed, chart.platform)
  if (chart.identity.schemaVersion !== 3 || chart.chartPackEventBlobSha256 !== chart.identity.eventBlobSha256) throw new Error('Unsupported chart identity')
  if (chart.music_id !== selection.songId || chart.identity.chartKey !== chart.key || chart.key !== `${chart.music_id}_${chart.difficulty}` || !['mobile', 'pc'].includes(chart.platform) || chart.identity.platform !== chart.platform) throw new Error('Chart, song or platform selection mismatch')
  if (chart.identity.sourceCommit !== data.metadata.sourceCommit || chart.identity.sourceRepository !== data.metadata.sourceRepository || chart.identity.catalogVersion !== data.metadata.catalogVersion || chart.identity.indexSha256 !== data.metadata.chartIndexSha256 || chart.identity.eventBlobSha256 !== data.metadata.chartBlobSha256) throw new Error('Chart/scoring provenance mismatch')
  const combo = data.comboGroups[team.song.comboGroupId]
  if (!combo || combo.length !== 11 || combo.some((row, index) => row.comboCountFrom !== index * 100 || row.scoreUpPermil !== index * 10)) throw new Error('Chart codec and song combo table are incompatible')
  if (chart.specialPointsMicroseconds.length !== 5) throw new Error('Expected five nullable SP slots')
  let previousPoint = -1
  for (const time of chart.specialPointsMicroseconds) if (time !== null) {
    safeInteger(time, 'SP time')
    if (time < previousPoint || time > chart.durationMicroseconds) throw new Error('Invalid SP timing')
    previousPoint = time
  }
  const notes = prepareTimelineNotes(chart)
  const windows: TimelineWindow[] = []
  const issues: UnresolvedRule[] = []
  const activations = recordedActivations === null ? null : activeActivationsSchema.parse(recordedActivations).sort((a, b) => a.timeMicroseconds - b.timeMicroseconds || a.ownerId.localeCompare(b.ownerId) || a.skillId.localeCompare(b.skillId))
  const knownActiveSkills = team.skills.filter(skill => skill.kind === 'active')
  const seen = new Set<string>()
  for (const activation of activations ?? []) {
    if (activation.timeMicroseconds > chart.durationMicroseconds) throw new Error('Active activation is outside chart duration')
    if (!knownActiveSkills.some(skill => skill.ownerId === activation.ownerId && skill.skillId === activation.skillId)) throw new Error('Active activation does not belong to this team or learned Board skills')
    const key = JSON.stringify([activation.ownerId, activation.skillId, activation.timeMicroseconds])
    if (seen.has(key)) throw new Error('Duplicate Active activation')
    seen.add(key)
  }
  function resolveCondition(branch: SkillReport['branches'][number], start: number, end: number): Resolution<boolean> {
    if (branch.status === 'active') return resolved(true)
    if (branch.status === 'inactive') return resolved(false)
    const triggers = branch.triggerGroupId ? data.triggers[branch.triggerGroupId] : []
    // Under AP the combo cannot fall. If the gate holds throughout the window,
    // activation-time versus live reevaluation cannot change the result.
    if (triggers.length && triggers.every(trigger => trigger.type === 'COMBO_GTE')) {
      const before = boundIndex(notes.times, start, false), after = boundIndex(notes.times, end, true)
      if (triggers.every(trigger => before >= trigger.threshold)) return resolved(true)
      if (triggers.some(trigger => after < trigger.threshold)) return resolved(false)
    }
    return missing([branch.reason ?? 'Live trigger evaluation timing is unverified'])
  }
  function addActivation(skill: SkillReport, start: number, source: 'active' | 'special', activationId: string): void {
    const duration = safeInteger((skill.definition.durationMilliseconds ?? 0) * 1000, 'skill duration')
    const end = safeInteger(start + duration, 'skill end time')
    for (const branch of skill.branches) {
      const condition = resolveCondition(branch, start, end)
      const effects = data.activeEffects[branch.effectGroupId]
      if (!effects) throw new Error(`Missing timeline effects: ${branch.effectGroupId}`)
      for (const effect of effects) {
        const id = `${activationId}:${branch.kind}:${effect.number}`
        const coverage = duration === 0 || condition.status === 'resolved' && !condition.value ? null : windowCoverage(notes, start, end)
        windows.push({ id, activationId, source, ownerId: skill.ownerId, skillId: skill.skillId, level: skill.level,
          branch: branch.kind, effectGroupId: branch.effectGroupId, effectNumber: effect.number, effectType: effect.type, sourceValue: effect.value, description: effect.description,
          startMicroseconds: start, endMicroseconds: end, condition, coverage })
        if (condition.status === 'unresolved') issues.push({ id: `condition:${id}`, sourceId: skill.skillId, reason: condition.reasons.join('; '), affects: [id] })
      }
    }
  }
  const specialSlots = selection.memberCardIds.map((ownerId, slot) => {
    const skill = team.skills.find(skill => skill.ownerId === ownerId && skill.kind === 'special')!
    const timeMicroseconds = chart.specialPointsMicroseconds[slot]
    if (timeMicroseconds !== null) addActivation(skill, timeMicroseconds, 'special', `sp:${slot + 1}`)
    return { slot: slot + 1, ownerId, skillId: skill.skillId, level: skill.level, timeMicroseconds, status: timeMicroseconds === null ? 'unavailable' as const : 'scheduled' as const }
  })
  for (const [index, activation] of (activations ?? []).entries()) {
    const skill = knownActiveSkills.find(skill => skill.ownerId === activation.ownerId && skill.skillId === activation.skillId)!
    addActivation(skill, activation.timeMicroseconds, 'active', `active:${index + 1}`)
  }
  if (activations === null) issues.push({ id: 'active-activations-unobserved', sourceId: 'LiveActiveSkillLevel', reason: 'Active activations were not supplied; base cooldowns and probabilities do not establish an observed run', affects: ['activeChannels', 'chartScore'] })
  const channels: TimelineChannel[] = activeEffectTypes.filter(type => type.endsWith('_PERMIL_UP')).map(effectType => {
    const matching = windows.filter(window => window.source === 'active' && window.effectType === effectType && !(window.condition.status === 'resolved' && !window.condition.value))
    const sameActivation = new Set<string>()
    const ambiguousBranch = matching.some(window => {
      if (sameActivation.has(window.activationId)) return true
      sameActivation.add(window.activationId)
      return false
    })
    const reason = `branch-composition:${effectType}`
    if (ambiguousBranch) issues.push({ id: reason, sourceId: 'LiveActiveSkillLevel', reason: 'Primary/additional same-type branch combination needs verification; the rule for distinct Active skills does not establish this', affects: [`activeChannels.${effectType}`] })
    return { effectType, combination: 'highest-active-effect', rawActiveExposure: activations === null ? missing(['active-activations-unobserved']) : ambiguousBranch ? missing([reason]) : resolved(rawActiveExposure(notes, matching)) }
  })
  const totalMass = massBounds(BigInt(notes.lower.at(-1)!), BigInt(notes.upper.at(-1)!), 1_000_000n, ['simultaneous-notes-at-combo-threshold'])
  if (notes.ambiguousTieTimes.length) issues.push({ id: 'simultaneous-note-order', sourceId: 'optimizer-chart-pack', reason: 'Mixed-weight simultaneous notes cross a combo threshold; game tie ordering is not verified', affects: ['noteMass', 'chartScore'] })
  if (windows.some(window => window.coverage && window.coverage.certainNotes !== window.coverage.possibleNotes)) issues.push({ id: 'skill-note-boundaries', sourceId: 'game-observation-required', reason: 'Notes coincide with skill starts or expirations; inclusive/exclusive game boundary order is not verified', affects: ['windows', 'activeChannels', 'chartScore'] })
  const limits: UnresolvedRule[] = [
    ...team.unresolved,
    ...issues,
    { id: 'score-formula', sourceId: 'Music.liveScoreCoefficientPermil', reason: 'Conversion from team parameters and note/skill coefficients to game score is not verified', affects: ['chartScore'] },
    { id: 'score-rounding', sourceId: 'game-observation-required', reason: 'Game per-event/final score rounding requires reference observations', affects: ['chartScore'] },
    { id: 'modifier-composition', sourceId: 'LivePassiveSkillEffect/SkillTreeEffect/LiveActiveSkillEffect', reason: 'Static support, SP effects, Board modifiers and Active effects are retained separately until their combination is verified', affects: ['chartScore'] }
  ]
  return {
    modelVersion: CHART_TIMELINE_MODEL_VERSION, status: 'unresolved' as const, assumption: 'all-perfect' as const,
    chart: { identity: structuredClone(chart.identity), musicId: chart.music_id, difficulty: chart.difficulty, difficultyLevel: chart.difficultyLevel, durationMicroseconds: chart.durationMicroseconds, noteCount: chart.total_notes },
    team, activeMode: activations === null ? 'unobserved' as const : 'recorded' as const,
    activations, specialSlots, windows, activeChannels: channels,
    noteMass: { comboWeighted: totalMass, ambiguousTieTimesMicroseconds: notes.ambiguousTieTimes },
    chartScore: missing<number>(limits.map(issue => issue.id)),
    unresolved: limits
  }
}
export type ChartTimelineReport = ReturnType<typeof resolveChartTimeline>
