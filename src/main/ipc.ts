import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import {
  applyAggregatePlan,
  applyPlan,
  calculateAggregatePlan,
  calculateGoalPlan
} from '@shared/planner'
import { progressionManifest } from '@shared/manifest'
import {
  applyAllRequestSchema,
  applyCardRequestSchema,
  channels,
  importCommitSchema,
  saveProfileRequestSchema
} from '@shared/ipc'
import type { AppInfo } from '@shared/types'
import { ProfileStore } from './profile-store'
import { UpdaterService } from './updater'
import { isTrustedRendererFrame } from './security'
import type { GpuRuntimeInfo } from './gpu-policy'

const projectUrl = 'https://github.com/totallynottuco/holodori-planner'

export function registerIpc(
  window: BrowserWindow,
  store: ProfileStore,
  updater: UpdaterService,
  gpu: GpuRuntimeInfo
): void {
  const trusted = (event: IpcMainInvokeEvent): void => {
    const senderFrame = event.senderFrame
    const accepted = isTrustedRendererFrame({
      senderMatchesWindow: event.sender === window.webContents,
      isTopFrame: senderFrame !== null && senderFrame === event.sender.mainFrame,
      url: senderFrame?.url ?? '',
      isPackaged: app.isPackaged
    })
    if (!accepted) throw new Error('IPC request rejected from an untrusted frame')
  }
  const handle = <T extends unknown[]>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args: T) => {
      trusted(event)
      return listener(event, ...args)
    })
  }

  handle(channels.profileLoad, () => store.load())
  handle(channels.profileSave, (_event, payload: unknown) => {
    const request = saveProfileRequestSchema.parse(payload)
    return store.save(request.expectedRevision, request.profile).then((profile) => {
      updater.schedule(profile.preferences.autoCheckUpdates)
      return profile
    })
  })
  handle(channels.profileExport, async () => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Export profile backup',
      defaultPath: `holodori-planner-profile-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON profile', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await store.exportTo(result.filePath)
    return { canceled: false, path: result.filePath }
  })
  handle(channels.profileImportPreview, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Import profile backup',
      properties: ['openFile'],
      filters: [{ name: 'JSON profile', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length !== 1) return null
    return store.previewImport(result.filePaths[0])
  })
  handle(channels.profileImportCommit, (_event, payload: unknown) => {
    const request = importCommitSchema.parse(payload)
    return store.commitImport(request.token, request.expectedRevision).then((profile) => {
      updater.schedule(profile.preferences.autoCheckUpdates)
      return profile
    })
  })
  handle(channels.plannerPreview, async () => {
    return calculateAggregatePlan(await store.getCurrent(), progressionManifest)
  })
  handle(channels.plannerApplyCard, async (_event, payload: unknown) => {
    const request = applyCardRequestSchema.parse(payload)
    const current = await store.getCurrent()
    if (current.revision !== request.expectedRevision) throw new Error('This profile changed. Reload and try again.')
    const plan = calculateGoalPlan(current, request.cardId, progressionManifest)
    const next = applyPlan(current, plan)
    return store.commitCalculated(request.expectedRevision, next)
  })
  handle(channels.plannerApplyAll, async (_event, payload: unknown) => {
    const request = applyAllRequestSchema.parse(payload)
    const current = await store.getCurrent()
    if (current.revision !== request.expectedRevision) throw new Error('This profile changed. Reload and try again.')
    const aggregate = calculateAggregatePlan(current, progressionManifest)
    const next = applyAggregatePlan(current, aggregate)
    return store.commitCalculated(request.expectedRevision, next)
  })
  handle(channels.updatesCheck, () => updater.check(false))
  handle(channels.updatesDownload, () => updater.download())
  handle(channels.updatesInstall, () => updater.install())
  handle(channels.appGetInfo, (): AppInfo => ({
    version: app.getVersion(),
    catalogVersion: progressionManifest.metadata.catalogVersion,
    profilePath: store.profilePath,
    isPackaged: app.isPackaged,
    projectUrl,
    gpu
  }))
  handle(channels.appOpenProjectPage, () => shell.openExternal(projectUrl))
}
