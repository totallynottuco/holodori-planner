import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { progressionManifest } from '@shared/manifest'
import { ProfileStore } from './profile-store'
import { UpdaterService } from './updater'
import { registerIpc } from './ipc'
import { shouldBlockNavigation } from './security'

log.initialize()
app.setName('holodori Planner')
const smokeDirectory = process.env.HOLODORI_SMOKE_DIR
app.setPath('userData', smokeDirectory || join(app.getPath('appData'), 'holodori Planner'))

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'holodori Planner',
    backgroundColor: '#edfaff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (shouldBlockNavigation(window.webContents.getURL(), url)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

if (singleInstance) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    const store = new ProfileStore(app.getPath('userData'), progressionManifest)
    const loaded = await store.load()
    if (process.argv.includes('--smoke')) {
      if (progressionManifest.cards.length === 0 || loaded.profile.schemaVersion !== 1) app.exit(1)
      else app.exit(0)
      return
    }
    mainWindow = createWindow()
    const updater = new UpdaterService(() => mainWindow)
    registerIpc(mainWindow, store, updater)
    updater.schedule(loaded.profile.preferences.autoCheckUpdates)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
