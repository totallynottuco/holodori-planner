import type { ChartSummary, OptimizerDecodedChart } from './optimizer-chart-pack'
import type { AppProfileV2, BoardRepairSummary } from './types'
import type { TeamParameterReport, TeamSelection } from './team-parameters'
import type { StaticModifierPolicy, resolveExpectedScoreTrace } from './expected-score-trace'
import type { calculatePerfectScoreTrace } from './live-score-trace'
import type { ScoreDistributionPlan } from './score-distribution'
import type { ScoreNoteRequest } from './score-note'

export interface CalculatorRequest {
  profile: AppProfileV2
  selection: TeamSelection
  chartKey: string
  platform: 'mobile'
  staticModifiers: StaticModifierPolicy
}
export interface CalculatorCatalog {
  songs: Array<{ id: string; title: string; charts: ChartSummary[] }>
}
export type CalculatorNoteRequest = CalculatorRequest & Pick<ScoreNoteRequest, 'noteNumber' | 'observation'>
type Expected = ReturnType<typeof resolveExpectedScoreTrace>
export interface CalculatorResult {
  selection: TeamSelection
  chart: ChartSummary
  songTitle: string
  profileRevision: number
  boardRepairs: BoardRepairSummary[]
  team: TeamParameterReport
  staticModifiers: StaticModifierPolicy
  expectedScore: Expected['expectedScenarioTotal']
  skillModifiers: Expected['skills']['modifierReports']
  life: Expected['skills']['life']
  distributionPlan: ScoreDistributionPlan | null
  baseline: ReturnType<typeof calculatePerfectScoreTrace>['total'] | null
  reasons: string[]
  assumptions: string[]
  series: Array<{ timeMicroseconds: number; expectedScore: Expected['expectedScenarioTotal'] }>
  identity: {
    inputsSha256: string
    modelVersion: string
    distributionModelVersion: string
    simulationTieOrder: string
    teamModelVersion: string
    formationModelVersion: string
    overallPowerModelVersion: string
    skillModelVersion: string
    noteScoreModelVersion: string
    chart: OptimizerDecodedChart['identity']
    scoringManifestSha256: string
    denominatorManifestSha256: string
    accountManifestSha256: string
    progressionManifestSha256: string
  }
}
