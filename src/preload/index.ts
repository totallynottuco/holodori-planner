import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '@shared/ipc-channels'
import type { HolodoriApi } from '@shared/api'
import type { UpdateStatus } from '@shared/types'

const api: HolodoriApi = {
  profile: {
    load: () => ipcRenderer.invoke(channels.profileLoad),
    save: (expectedRevision, profile) => ipcRenderer.invoke(channels.profileSave, { expectedRevision, profile }),
    export: () => ipcRenderer.invoke(channels.profileExport),
    importPreview: () => ipcRenderer.invoke(channels.profileImportPreview),
    importCommit: (token, expectedRevision) =>
      ipcRenderer.invoke(channels.profileImportCommit, { token, expectedRevision })
  },
  planner: {
    preview: (plan) => ipcRenderer.invoke(channels.plannerPreview, plan),
    apply: (expectedRevision, plan) => ipcRenderer.invoke(channels.plannerApply, { expectedRevision, plan })
  },
  updates: {
    check: () => ipcRenderer.invoke(channels.updatesCheck),
    download: () => ipcRenderer.invoke(channels.updatesDownload),
    install: () => ipcRenderer.invoke(channels.updatesInstall),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status)
      ipcRenderer.on(channels.updatesStatus, listener)
      return () => ipcRenderer.removeListener(channels.updatesStatus, listener)
    }
  },
  app: {
    getInfo: () => ipcRenderer.invoke(channels.appGetInfo),
    openProjectPage: () => ipcRenderer.invoke(channels.appOpenProjectPage)
  }
}

contextBridge.exposeInMainWorld('holodori', api)
