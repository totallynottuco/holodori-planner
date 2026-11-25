import { z } from 'zod'
import type { ChartTimelineReport } from './chart-timeline'
import type { OptimizerDecodedChart } from './optimizer-chart-pack'
import type { VerifiedChartDenominators } from './chart-denominators'
import type { ScoringData } from './scoring-data'
import type { describeScoringInputs, ScoringDigest } from './scoring-report-identity'
import { resolveExpectedScoreTrace } from './expected-score-trace'
import { calculatePerfectScoreGroup } from './live-score-trace'
import { LIVE_SCORE_CLIENT, LIVE_SCORE_MODEL_VERSION } from './live-score'

export const noteObservationSchema = z.object({
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), awardedPoints: z.number().int().nonnegative().max(2_147_483_647)
}).strict()
export const scoreNoteRequestSchema = z.object({
  chartKey: z.string().regex(/^m\d{4}_(easy|normal|hard|expert)$/), platform: z.literal('mobile'),
  noteNumber: z.number().int().positive(), staticModifiers: z.enum(['verified-only', 'additive-assumption']).default('verified-only'),
  observation: noteObservationSchema.optional()
}).strict()
export type ScoreNoteRequest = z.output<typeof scoreNoteRequestSchema>

/** Shared comparison of discrete awards, never an assertion that the model is verified. */
export function compareNoteObservation<T extends { possibleAwards: number[] }>(report: { identity: { inputsSha256: string }; outcomes: T[] | null }, raw: unknown) {
  const observation = noteObservationSchema.parse(raw)
  if (observation.inputFingerprint !== report.identity.inputsSha256) throw new Error('Observation belongs to a different profile, selection, chart, note or model. Use the fingerprint from the matching probe.')
  const matchingOutcomes = report.outcomes?.filter(row => row.possibleAwards.includes(observation.awardedPoints)) ?? null
  const status = matchingOutcomes === null ? 'unresolved' as const : matchingOutcomes.length ? 'compatible' as const : 'mismatch' as const
  return { awardedPoints: observation.awardedPoints, status, matchingOutcomes }
}

/** One PERFECT award from the same verified inputs and kernel as the full calculator.
 * The caller supplies a prepared team and verified chart/resources; no filesystem access. */
export function resolveScoreNote(request: ScoreNoteRequest, timeline: ChartTimelineReport, chart: OptimizerDecodedChart, data: ScoringData,
  denominators: VerifiedChartDenominators, description: ReturnType<typeof describeScoringInputs>, digest: ScoringDigest) {
  if (request.chartKey !== chart.identity.chartKey || request.platform !== chart.identity.platform) throw new Error('Note probe chart identity mismatch')
  if (!Number.isInteger(request.noteNumber) || request.noteNumber < 1 || request.noteNumber > chart.total_notes) throw new Error(`Note number exceeds this chart's ${chart.total_notes} scoring events`)
  const trace = resolveExpectedScoreTrace(timeline, chart, data, denominators, request.staticModifiers)
  const noteIndex = request.noteNumber - 1, timeMicroseconds = chart.eventTimesMicroseconds[noteIndex]
  const group = trace.groups.find(row => row.timeMicroseconds === timeMicroseconds)!
  const start = group.comboFrom - 1, length = group.comboTo - start
  const events = Array.from({ length }, (_, index) => ({ timeMicroseconds, noteType: chart.eventNoteTypes[start + index], perfectCoefficientPermil: chart.eventWeightsPermil[start + index] }))
  const identity = { modelVersion: 'conditional-perfect-note-probe-v1', noteScoreModelVersion: LIVE_SCORE_MODEL_VERSION,
    skillModelVersion: trace.skills.modelVersion, static: description.identity, chart: chart.identity,
    denominatorSha256: denominators.sha256, client: LIVE_SCORE_CLIENT }
  const context = { chartKey: request.chartKey, platform: request.platform, noteNumber: request.noteNumber, staticModifiers: request.staticModifiers, assumptions: trace.assumptions }
  const inputFingerprint = digest({ identity, context })
  const outcomes = group.calculation && trace.power.status === 'resolved' && trace.boardSongBonus.status === 'resolved'
    ? group.calculation.outcomes.map(outcome => {
      const score = calculatePerfectScoreGroup({ platform: chart.platform, overallPower: trace.power.value!, evaluationCoefficientPermil: LIVE_SCORE_CLIENT.evaluationCoefficientPermil,
        chartScoreCoefficientPermyriad: trace.denominator.chartScoreCoefficientPermyriad,
        songCoefficientPermil: timeline.team.song.scoreCoefficientPermil, difficultyLevel: chart.difficultyLevel,
        notesPerfectCoefficientSumPermil: trace.denominator.completePerfectSumPermil, skillScoreUpRatio: outcome.skillScoreUpRatio, boardSongBonusPermil: trace.boardSongBonus.value!
      }, events, start).notes[noteIndex - start].points
      const possibleAwards = [...new Set([score.lower, score.upper])]
      const sourceAttemptIds = group.candidates.filter(row => row.supportedScoreUpPermil.status === 'resolved'
        && Math.fround(Number(row.supportedScoreUpPermil.value.numerator) / Number(row.supportedScoreUpPermil.value.denominator) / 1000) === outcome.skillScoreUpRatio).map(row => row.attemptId)
      return { skillScoreUpRatio: outcome.skillScoreUpRatio, probability: outcome.probability, sourceAttemptIds, possibleAwards }
    }) : null
  const possibleAwards = outcomes ? [...new Set(outcomes.flatMap(row => row.possibleAwards))].sort((a, b) => a - b) : null
  const attempts = trace.skills.attempts.filter(row => group.candidates.some(candidate => candidate.attemptId === row.id))
  const report = { kind: 'conditional-perfect-note-probe' as const, identity: { ...identity, inputsSha256: inputFingerprint }, context,
    preparation: description.preparation, selection: timeline.team.selection, songTitle: timeline.team.song.title,
    note: { number: request.noteNumber, timeMicroseconds, noteType: chart.eventNoteTypes[noteIndex], perfectCoefficientPermil: chart.eventWeightsPermil[noteIndex], simultaneousNotes: length, comboFrom: group.comboFrom, comboTo: group.comboTo },
    overallPower: trace.power, attempts, specialSupportPermil: trace.skills.events.find(row => row.timeMicroseconds === timeMicroseconds)!.specialSupportPermil, modifiers: trace.skills.modifierReports,
    outcomes, possibleAwards, reasons: group.reasons, formationSourceNotes: [...new Set(timeline.team.members.flatMap(member => member.formationStages.sourceNotes))],
    limitation: 'One PERFECT scoring event with an unbroken preceding combo and ideal skill/SP timing. Use the score increase for this event, not cumulative score or a simultaneous pair total. Compatibility does not verify the model or identify an activation history. Changed gameplay timing can also cause a mismatch.' }
  return { ...report, comparison: request.observation ? compareNoteObservation(report, request.observation) : null }
}

export type ScoreNoteReport = ReturnType<typeof resolveScoreNote>
