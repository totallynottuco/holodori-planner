import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { applyPlan, calculatePlan } from '@shared/planner'
import { progressionManifest } from '@shared/manifest'
import {
  applyPlannerRequestSchema,
  channels,
  importCommitSchema,
  plannerRequestSchema,
  saveProfileRequestSchema
} from '@shared/ipc'
import type { AppInfo } from '@shared/types'
import { ProfileStore } from './profile-store'
import { UpdaterService } from './updater'
import { isTrustedRendererFrame } from './security'

const projectUrl = 'https://github.com/totallynottuco/holodori-planner'

export function registerIpc(
  window: BrowserWindow,
  store: ProfileStore,
  updater: UpdaterService
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
  handle(channels.plannerPreview, async (_event, payload: unknown) => {
    const request = plannerRequestSchema.parse(payload)
    return calculatePlan(await store.getCurrent(), request, progressionManifest)
  })
  handle(channels.plannerApply, async (_event, payload: unknown) => {
    const request = applyPlannerRequestSchema.parse(payload)
    const current = await store.getCurrent()
    if (current.revision !== request.expectedRevision) throw new Error('This profile changed. Reload and try again.')
    const plan = calculatePlan(current, request.plan, progressionManifest)
    const next = applyPlan(current, plan)
    next.plannerSelection = {
      cardId: request.plan.cardId,
      targetLevel: request.plan.targetLevel,
      targetBloomStage: request.plan.targetBloomStage,
      useBloomStones: request.plan.useBloomStones
    }
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
    projectUrl
  }))
  handle(channels.appOpenProjectPage, () => shell.openExternal(projectUrl))
}
