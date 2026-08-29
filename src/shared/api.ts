import type {
  AppInfo,
  AggregatePlanResult,
  AppProfileV2,
  ImportPreview,
  ProfileLoadResult,
  UpdateStatus
} from './types'

export interface HolodoriApi {
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
