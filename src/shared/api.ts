import type {
  AppInfo,
  AppProfileV1,
  ImportPreview,
  PlanResult,
  PlannerRequest,
  ProfileLoadResult,
  UpdateStatus
} from './types'

export interface HolodoriApi {
  profile: {
    load(): Promise<ProfileLoadResult>
    save(expectedRevision: number, profile: AppProfileV1): Promise<AppProfileV1>
    export(): Promise<{ canceled: boolean; path?: string }>
    importPreview(): Promise<ImportPreview | null>
    importCommit(token: string, expectedRevision: number): Promise<AppProfileV1>
  }
  planner: {
    preview(plan: PlannerRequest): Promise<PlanResult>
    apply(expectedRevision: number, plan: PlannerRequest): Promise<AppProfileV1>
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
  }
}
