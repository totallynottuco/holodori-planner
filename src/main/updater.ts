import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { channels } from '@shared/ipc'
import { canUseProductionUpdates, updateErrorStatus } from './update-policy'

const { autoUpdater } = electronUpdater

function notes(info: UpdateInfo): string {
  if (typeof info.releaseNotes === 'string') return info.releaseNotes
  if (Array.isArray(info.releaseNotes)) return info.releaseNotes.map((item) => item.note).join('\n')
  return ''
}

export class UpdaterService {
  private status: UpdateStatus = { state: 'idle' }
  private currentVersion = ''
  private backgroundCheck = false
  private firstTimer: NodeJS.Timeout | null = null
  private repeatTimer: NodeJS.Timeout | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    autoUpdater.logger = log
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('checking-for-update', () => this.publish({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.currentVersion = info.version
      this.publish({ state: 'available', version: info.version, releaseNotes: notes(info) })
    })
    autoUpdater.on('update-not-available', () => this.publish({ state: 'not-available' }))
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.publish({ state: 'downloading', percent: Math.round(progress.percent), version: this.currentVersion })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.publish({ state: 'downloaded', version: info.version, releaseNotes: notes(info) })
    })
    autoUpdater.on('error', (error) => {
      log.error('Update error', error)
      this.publish(updateErrorStatus(this.backgroundCheck, 'check'))
    })
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  async check(background = false): Promise<void> {
    this.backgroundCheck = background
    if (!canUseProductionUpdates(app.isPackaged)) {
      this.publish({ state: 'not-available' })
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      log.error('Update check failed', error)
      this.publish(updateErrorStatus(background, 'check'))
    } finally {
      this.backgroundCheck = false
    }
  }

  async download(): Promise<void> {
    if (this.status.state !== 'available') throw new Error('No update is ready to download')
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      log.error('Update download failed', error)
      this.publish(updateErrorStatus(false, 'download'))
    }
  }

  install(): void {
    if (this.status.state !== 'downloaded') throw new Error('No downloaded update is ready to install')
    autoUpdater.quitAndInstall(false, true)
  }

  schedule(enabled: boolean): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.repeatTimer) clearInterval(this.repeatTimer)
    this.firstTimer = null
    this.repeatTimer = null
    if (!enabled || !canUseProductionUpdates(app.isPackaged)) return
    this.firstTimer = setTimeout(() => void this.check(true), 15_000)
    this.repeatTimer = setInterval(() => void this.check(true), 6 * 60 * 60 * 1000)
    this.firstTimer.unref()
    this.repeatTimer.unref()
  }

  private publish(status: UpdateStatus): void {
    this.status = status
    this.getWindow()?.webContents.send(channels.updatesStatus, status)
  }
}
