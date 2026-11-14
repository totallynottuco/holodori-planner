import type { ScoreDistributionPlan, ScoreSimulationOptions, ScoreSimulationResult } from './score-distribution'

export interface ScoreSimulationRequest { plan: ScoreDistributionPlan; options: ScoreSimulationOptions; inputFingerprint: string }
export type ScoreSimulationMessage = { kind: 'progress'; completed: number }
  | { kind: 'complete'; simulation: ScoreSimulationResult; simulationFingerprint: string }
  | { kind: 'error'; message: string }
