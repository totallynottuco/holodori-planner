import { z } from 'zod'
import { appProfileSchema } from './profile'
import { activeActivationsSchema } from './chart-timeline'
import type { ResolvedAccountCardParameters } from './account-data'
import { teamSelectionSchema, type Resolution, type TeamParameterReport, type UnresolvedRule } from './team-parameters'
import { powerComponents } from './overall-power'

export const SCORING_REFERENCE_SCHEMA_VERSION = 1
export const SCORING_REFERENCE_MODEL_VERSION = 'scoring-reference-v3'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const stat = z.enum(['performance', 'technique', 'sense'])
export const observedIntervalSchema = z.object({ lower: integer, upper: integer }).strict()
  .refine(value => value.lower <= value.upper, 'Observation lower bound exceeds upper bound')
const observed = observedIntervalSchema.nullable()
export const scoreBonusComponents = ['outfit', 'active', 'board', 'passive', 'special'] as const
export const referenceObservationSchema = z.discriminatedUnion('metric', [
  z.object({ metric: z.literal('card-detail-parameter'), cardId: z.string().min(1), stat, observed }).strict(),
  z.object({ metric: z.literal('card-detail-total'), cardId: z.string().min(1), observed }).strict(),
  z.object({ metric: z.literal('member-parameter'), cardId: z.string().min(1), stat, observed }).strict(),
  z.object({ metric: z.literal('member-parameter-total'), cardId: z.string().min(1), observed }).strict(),
  z.object({ metric: z.literal('parameter-sum'), stat, observed }).strict(),
  z.object({ metric: z.literal('roster-bonus'), observed }).strict(),
  z.object({ metric: z.literal('overall-power'), observed }).strict(),
  z.object({ metric: z.literal('overall-power-component'), component: z.enum(powerComponents), observed }).strict(),
  z.object({ metric: z.literal('score-bonus'), observed }).strict(),
  z.object({ metric: z.literal('score-bonus-component'), component: z.enum(scoreBonusComponents), observed }).strict(),
  z.object({ metric: z.literal('unit-score'), observed }).strict(),
  z.object({ metric: z.literal('chart-score'), observed }).strict()
])
export type ReferenceObservation = z.infer<typeof referenceObservationSchema>
export const referenceArtifactSchema = z.object({ name: z.string().min(1).max(260), byteLength: integer, sha256: hash }).strict()
export const judgementSummarySchema = z.object({ perfect: integer, great: integer, good: integer, bad: integer, miss: integer, maxCombo: integer }).strict().superRefine((value, context) => {
  const total = BigInt(value.perfect) + BigInt(value.great) + BigInt(value.good) + BigInt(value.bad) + BigInt(value.miss)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) context.addIssue({ code: 'custom', message: 'Judgement count exceeds the safe integer range' })
  if (BigInt(value.maxCombo) > total) context.addIssue({ code: 'custom', message: 'Maximum combo exceeds the number of judged notes' })
})
export function validateJudgementSummary(raw: unknown, chartNoteCount: number) {
  const summary = judgementSummarySchema.parse(raw)
  if (summary.perfect + summary.great + summary.good + summary.bad + summary.miss !== chartNoteCount) throw new Error('Observed judgement counts do not match the selected chart note count')
  return summary
}
export const referenceRunSchema = z.object({
  chartKey: z.string().regex(/^m\d{4}_(easy|normal|hard|expert)$/), platform: z.enum(['mobile', 'pc']),
  performance: z.enum(['all-perfect', 'judgement-summary']), judgementSummary: judgementSummarySchema.optional(),
  activeRecording: z.object({ coverage: z.literal('complete-successful-activations'), activations: activeActivationsSchema }).strict().nullable()
}).strict().superRefine((run, context) => {
  if (run.performance === 'judgement-summary' && !run.judgementSummary) context.addIssue({ code: 'custom', message: 'A judgement-summary run requires observed counts and maximum combo' })
  if (run.performance === 'all-perfect' && run.judgementSummary && (run.judgementSummary.great || run.judgementSummary.good || run.judgementSummary.bad || run.judgementSummary.miss || run.judgementSummary.maxCombo !== run.judgementSummary.perfect)) context.addIssue({ code: 'custom', message: 'Non-PERFECT results cannot be evaluated as an all-PERFECT run' })
  if (run.performance === 'judgement-summary' && run.activeRecording) context.addIssue({ code: 'custom', message: 'The current activation recording format describes all-PERFECT runs; a non-AP replay needs ordered judgement events' })
})
export type ReferenceRun = z.infer<typeof referenceRunSchema>
export const referenceBindingSchema = z.object({
  normalizedInputsSha256: hash, scoringManifestSha256: hash, accountManifestSha256: hash, progressionManifestSha256: hash,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), catalogVersion: z.string().min(1),
  chartIndexSha256: hash, chartBlobSha256: hash, runSha256: hash
}).strict()

/** Observations survive model changes. Only inputs and reviewed data are pinned. */
export const scoringReferenceSchema = z.object({
  schemaVersion: z.literal(SCORING_REFERENCE_SCHEMA_VERSION), state: z.enum(['draft', 'recorded']),
  capturedWith: z.object({ teamModel: z.string().min(1), timelineModel: z.string().min(1).nullable() }).strict(),
  binding: referenceBindingSchema,
  inputs: z.object({ profile: appProfileSchema, selection: teamSelectionSchema, run: referenceRunSchema.nullable() }).strict(),
  preparation: z.object({
    notices: z.array(z.string()),
    boardRepairs: z.array(z.object({ characterId: z.string(), removedNodeIds: z.array(z.string()), removedAssignmentIds: z.array(z.string()) }).strict())
  }).strict(),
  provenance: z.object({
    kind: z.enum(['game-observation', 'synthetic']).nullable(),
    method: z.enum(['screenshot', 'video', 'manual-transcription', 'hand-calculated']).nullable(),
    gameVersion: z.string().min(1).nullable(), observedAt: z.iso.datetime({ offset: true }).nullable(),
    notes: z.string().max(10000), artifacts: z.array(referenceArtifactSchema).max(20)
  }).strict(),
  observations: z.array(referenceObservationSchema).min(1).max(64)
}).strict().superRefine((reference, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  const keys = reference.observations.map(observationKey)
  if (new Set(keys).size !== keys.length) issue('Duplicate observation metric')
  for (const observation of reference.observations) {
    if ('cardId' in observation && !reference.inputs.selection.memberCardIds.includes(observation.cardId)) issue(`Observation card is not in the lineup: ${observation.cardId}`)
    if (observation.metric === 'chart-score' && !reference.inputs.run) issue('A chart-score observation requires explicit chart, platform and performance inputs')
    if (observation.metric === 'roster-bonus' && observation.observed && observation.observed.upper > 5000) issue('Roster bonus must be expressed in permyriad, between 0 and 5000')
  }
  if (new Set(reference.provenance.artifacts.map(row => row.sha256)).size !== reference.provenance.artifacts.length) issue('Duplicate source artifact')
  if (reference.state === 'draft') return
  if (!reference.observations.some(row => row.observed !== null)) issue('A recorded reference needs at least one observation')
  const source = reference.provenance
  if (!source.kind || !source.method || !source.notes.trim()) issue('A recorded reference needs provenance kind, method and notes')
  if (source.kind === 'game-observation') {
    if (source.method === 'hand-calculated') issue('Hand calculations are synthetic, not game observations')
    if (['screenshot', 'video'].includes(source.method ?? '') && !source.artifacts.length) issue('Screenshot/video observations need a source artifact digest')
  }
  if (source.kind === 'synthetic' && source.method !== 'hand-calculated') issue('Synthetic references must be explicitly hand-calculated')
})
export type ScoringReference = z.infer<typeof scoringReferenceSchema>

export function observationKey(observation: ReferenceObservation): string {
  switch (observation.metric) {
    case 'card-detail-parameter': return `detail:${observation.cardId}:${observation.stat}`
    case 'card-detail-total': return `detail:${observation.cardId}:total`
    case 'member-parameter': return `member:${observation.cardId}:${observation.stat}`
    case 'member-parameter-total': return `member:${observation.cardId}:total`
    case 'parameter-sum': return `sum:${observation.stat}`
    case 'overall-power-component': return `power:${observation.component}`
    case 'score-bonus-component': return `score-bonus:${observation.component}`
    default: return observation.metric
  }
}

/** Empty slots are intentional: predictions must never prefill observations. */
export function referenceObservationSlots(team: TeamParameterReport, hasChart: boolean): ReferenceObservation[] {
  const stats = ['performance', 'technique', 'sense'] as const
  return [
    ...team.members.flatMap(member => stats.map(stat => ({ metric: 'card-detail-parameter' as const, cardId: member.cardId, stat, observed: null }))),
    ...team.members.map(member => ({ metric: 'card-detail-total' as const, cardId: member.cardId, observed: null })),
    ...team.members.flatMap(member => stats.map(stat => ({ metric: 'member-parameter' as const, cardId: member.cardId, stat, observed: null }))),
    ...team.members.map(member => ({ metric: 'member-parameter-total' as const, cardId: member.cardId, observed: null })),
    ...stats.map(stat => ({ metric: 'parameter-sum' as const, stat, observed: null })),
    { metric: 'roster-bonus', observed: null },
    { metric: 'overall-power', observed: null },
    ...powerComponents.map(component => ({ metric: 'overall-power-component' as const, component, observed: null })),
    { metric: 'score-bonus', observed: null },
    ...scoreBonusComponents.map(component => ({ metric: 'score-bonus-component' as const, component, observed: null })),
    { metric: 'unit-score', observed: null },
    ...(hasChart ? [{ metric: 'chart-score' as const, observed: null }] : [])
  ]
}

export interface ReferenceComparison {
  key: string
  unit: 'parameter' | 'permyriad' | 'points' | 'unit-score'
  observed: z.infer<typeof observedIntervalSchema>
  predicted: Resolution<number>
  status: 'match' | 'mismatch' | 'compatible' | 'unresolved'
  /** Predicted minus observed; never a fitted correction or a scoring coefficient. */
  difference: { lower: number; upper: number } | null
  dependencies: UnresolvedRule[]
}

// Score Bonus is measured independently, never back-solved from Unit Score.
const unitScoreDependencies: UnresolvedRule[] = [
  { id: 'score-bonus-composition', sourceId: 'LangClientCommon_Eng:136643844825088', reason: 'Score Bonus composition from skill and Board effects is not verified; record the displayed percentage independently', affects: ['scoreBonus', 'unitScore'] },
  ...scoreBonusComponents.map(component => ({ id: `score-bonus-composition:${component}`, sourceId: { outfit: 'LiveLeaderSkill', active: 'LiveActiveSkillLevel', board: 'SkillTreeEffect', passive: 'LivePassiveSkillLevel', special: 'LiveSpecialSkillLevel' }[component], reason: `The ${component} contribution to the displayed Score Bonus has no verified calculation and display-rounding rule`, affects: [`scoreBonus.${component}`, 'scoreBonus', 'unitScore'] })),
  { id: 'unit-score-formula', sourceId: 'Setting', reason: 'Game Unit Score conversion is not verified; an observed Unit Score is retained without a prediction', affects: ['unitScore'] }
]

/** Compare only complete final values. Intermediate stages cannot stand in for them. */
export function compareReferenceObservations(observations: ReferenceObservation[], team: TeamParameterReport,
  chart: { chartScore: Resolution<number>; unresolved: UnresolvedRule[] } | null = null,
  cardDetails: Record<string, ResolvedAccountCardParameters> = {}) {
  const comparisons: ReferenceComparison[] = []
  const pending: string[] = []
  for (const raw of observations) {
    const observation = referenceObservationSchema.parse(raw)
    const key = observationKey(observation)
    if ('cardId' in observation && !team.members.some(member => member.cardId === observation.cardId)) throw new Error(`Observation card is not in the lineup: ${observation.cardId}`)
    let predicted: Resolution<number>
    switch (observation.metric) {
      case 'card-detail-parameter':
      case 'card-detail-total': {
        const details = cardDetails[observation.cardId]
        if (!details && observation.observed) throw new Error('A card-detail observation requires a matching account calculation')
        predicted = details ? { status: 'resolved', value: observation.metric === 'card-detail-total' ? details.accountTotal : details.accountStats[observation.stat] } : { status: 'unresolved', value: null, reasons: ['card-detail-unavailable'] }
        break
      }
      case 'member-parameter': {
        const member = team.members.find(row => row.cardId === observation.cardId)
        if (!member) throw new Error(`Observation card is not in the lineup: ${observation.cardId}`)
        predicted = member.parameters[observation.stat]
        break
      }
      case 'member-parameter-total': {
        const member = team.members.find(row => row.cardId === observation.cardId)
        if (!member) throw new Error(`Observation card is not in the lineup: ${observation.cardId}`)
        predicted = member.parameterTotal
        break
      }
      case 'parameter-sum': predicted = team.parameterTotals[observation.stat]; break
      case 'roster-bonus': predicted = team.rosterBonus.permyriad; break
      case 'overall-power': predicted = team.overallPower.total; break
      case 'overall-power-component': predicted = team.overallPower.components[observation.component]; break
      case 'score-bonus': predicted = { status: 'unresolved', value: null, reasons: ['score-bonus-composition'] }; break
      case 'score-bonus-component': predicted = { status: 'unresolved', value: null, reasons: [`score-bonus-composition:${observation.component}`] }; break
      case 'unit-score': predicted = { status: 'unresolved', value: null, reasons: ['unit-score-formula'] }; break
      case 'chart-score':
        if (!chart) throw new Error('A chart-score observation requires a matching timeline')
        predicted = chart.chartScore
    }
    if (!observation.observed) { pending.push(key); continue }
    const { lower, upper } = observation.observed
    const difference = predicted.status === 'resolved' ? { lower: predicted.value - upper, upper: predicted.value - lower } : null
    const status = predicted.status === 'unresolved' ? 'unresolved' : predicted.value < lower || predicted.value > upper ? 'mismatch' : lower === upper ? 'match' : 'compatible'
    const issues = observation.metric === 'chart-score' ? chart!.unresolved : [...team.unresolved, ...unitScoreDependencies]
    comparisons.push({ key, unit: observation.metric === 'roster-bonus' || observation.metric === 'score-bonus' || observation.metric === 'score-bonus-component' ? 'permyriad' : observation.metric === 'chart-score' ? 'points' : observation.metric === 'unit-score' ? 'unit-score' : 'parameter', observed: { lower, upper }, predicted: structuredClone(predicted), status, difference,
      dependencies: predicted.status === 'unresolved' ? predicted.reasons.map(id => structuredClone(issues.find(issue => issue.id === id) ?? { id, sourceId: 'input-data', reason: id, affects: [key] })) : [] })
  }
  if (new Set(observations.map(observationKey)).size !== observations.length) throw new Error('Duplicate observation metric')
  const supplied = new Set(observations.map(observationKey))
  for (const slot of referenceObservationSlots(team, chart !== null)) if (!supplied.has(observationKey(slot))) pending.push(observationKey(slot))
  const status = comparisons.some(row => row.status === 'mismatch') ? 'mismatch' : !comparisons.length || comparisons.some(row => row.status !== 'match') ? 'incomplete' : 'match'
  return { status, comparisons, unmeasured: pending }
}
