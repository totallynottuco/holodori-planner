import { z } from 'zod'
import { appProfileSchema } from './profile'
export { channels } from './ipc-channels'

export const revisionSchema = z.number().int().nonnegative()
export const plannerRequestSchema = z.object({
  cardId: z.string().min(1),
  targetLevel: z.number().int().min(1).max(80),
  targetBloomStage: z.number().int().min(0).max(5),
  useBloomStones: z.boolean()
})
export const saveProfileRequestSchema = z.object({ expectedRevision: revisionSchema, profile: appProfileSchema })
export const applyCardRequestSchema = z.object({
  expectedRevision: revisionSchema,
  cardId: z.string().min(1)
})
export const applyAllRequestSchema = z.object({ expectedRevision: revisionSchema })
export const importCommitSchema = z.object({ token: z.string().uuid(), expectedRevision: revisionSchema })
