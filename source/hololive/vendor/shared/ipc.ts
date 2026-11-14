import { z } from 'zod'
import { appProfileSchema } from './profile'
import { teamSelectionSchema } from './team-parameters'
import { scoreNoteRequestSchema } from './score-note'
export { channels } from './ipc-channels'

export const revisionSchema = z.number().int().nonnegative()
export const chartRequestSchema = z.object({ chartKey: z.string().regex(/^m\d{4}_(easy|normal|hard|expert)$/u), platform: z.enum(['mobile', 'pc']) }).strict()
export const calculatorRequestSchema = z.object({
  profile: appProfileSchema, selection: teamSelectionSchema, chartKey: chartRequestSchema.shape.chartKey,
  platform: z.literal('mobile'), staticModifiers: z.enum(['verified-only', 'additive-assumption'])
}).strict()
export const calculatorNoteRequestSchema = calculatorRequestSchema.extend({
  noteNumber: scoreNoteRequestSchema.shape.noteNumber, observation: scoreNoteRequestSchema.shape.observation
})
export const plannerRequestSchema = z.object({
  cardId: z.string().min(1),
  targetLevel: z.number().int().min(1).max(80),
  targetTrainingStage: z.number().int().min(0).max(4)
})
export const saveProfileRequestSchema = z.object({ expectedRevision: revisionSchema, profile: appProfileSchema })
export const applyCardRequestSchema = z.object({
  expectedRevision: revisionSchema,
  cardId: z.string().min(1)
})
export const applyAllRequestSchema = z.object({ expectedRevision: revisionSchema })
const screenshotImportDetectionSchema = z.object({
  cardId: z.string().min(1),
  level: z.number().int().min(1).max(80),
  bloomStage: z.union([
    z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
  ])
})
export const screenshotImportRequestSchema = z.object({
  expectedRevision: revisionSchema,
  detections: z.array(screenshotImportDetectionSchema).min(1).max(500)
}).superRefine((request, context) => {
  const ids = new Set<string>()
  request.detections.forEach((detection, index) => {
    if (ids.has(detection.cardId)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate screenshot card ID: ${detection.cardId}`,
        path: ['detections', index, 'cardId']
      })
    }
    ids.add(detection.cardId)
  })
})
export const importCommitSchema = z.object({ token: z.string().uuid(), expectedRevision: revisionSchema })
export const windowModeSchema = z.enum(['windowed', 'fullscreen', 'borderless'])
