import type {
  AppInfo,
  AggregatePlanResult,
  AppProfileV2,
  ImportPreview,
  ProfileLoadResult,
  ScreenshotImportApplyResult,
  ScreenshotImportDetection,
  UpdateStatus,
  WindowMode,
  WindowStateInfo
} from './types'

import type { ChartSummary, OptimizerChartPlatform, OptimizerDecodedChart } from './optimizer-chart-pack'
import type { CalculatorCatalog, CalculatorNoteRequest, CalculatorRequest, CalculatorResult } from './score-calculator'
import type { ScoreNoteReport } from './score-note'

export interface HolodoriApi {
  calculator: {
    catalog(): Promise<CalculatorCatalog>
    calculate(request: CalculatorRequest): Promise<CalculatorResult>
    note(request: CalculatorNoteRequest): Promise<ScoreNoteReport>
  }
  charts: {
    list(): Promise<ChartSummary[]>
    get(chartKey: string, platform: OptimizerChartPlatform): Promise<OptimizerDecodedChart>
  }
  profile: {
    load(): Promise<ProfileLoadResult>
    save(expectedRevision: number, profile: AppProfileV2): Promise<AppProfileV2>
    export(): Promise<{ canceled: boolean; path?: string }>
    importPreview(): Promise<ImportPreview | null>
    importCommit(token: string, expectedRevision: number): Promise<AppProfileV2>
  }
  planner: {
    preview(): Promise<AggregatePlanResult>
    applyCard(expectedRevision: number, cardId: string): Promise<AppProfileV2>
    applyAll(expectedRevision: number): Promise<AppProfileV2>
  }
  cards: {
    applyScreenshotImport(expectedRevision: number, detections: ScreenshotImportDetection[]): Promise<ScreenshotImportApplyResult>
  }
  updates: {
    check(): Promise<void>
    download(): Promise<void>
    install(): Promise<void>
    onStatus(callback: (status: UpdateStatus) => void): () => void
  }
  app: {
    getInfo(): Promise<AppInfo>
    openProjectPage(): Promise<void>
    getWindowState(): Promise<WindowStateInfo>
    setWindowMode(mode: WindowMode): Promise<WindowStateInfo>
    resetWindow(): Promise<WindowStateInfo>
  }
}
