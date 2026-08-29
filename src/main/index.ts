import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { progressionManifest } from '@shared/manifest'
import { ProfileStore } from './profile-store'
import { UpdaterService } from './updater'
import { registerIpc } from './ipc'
import { shouldBlockNavigation } from './security'
import { evaluateGpuPolicy, type GpuRuntimeInfo, type WebGlProbeResult } from './gpu-policy'

log.initialize()
app.setName('holodori Planner')
const smokeDirectory = process.env.HOLODORI_SMOKE_DIR
app.setPath('userData', smokeDirectory || join(app.getPath('appData'), 'holodori Planner'))

const smokeMode = process.argv.includes('--smoke')
if (!smokeMode) {
  app.commandLine.removeSwitch('disable-gpu')
  app.commandLine.removeSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('force_high_performance_gpu')
  app.disableDomainBlockingFor3DAPIs()
}

const gpuInfoReady = smokeMode
  ? Promise.resolve(true)
  : new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 15_000)
      app.once('gpu-info-update', () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()

let mainWindow: BrowserWindow | null = null
let gpuRuntime: GpuRuntimeInfo | null = null
let gpuEnforcementActive = false
let quitting = false
let startupComplete = false

async function requireHardwareGpu(): Promise<GpuRuntimeInfo | null> {
  if (!await gpuInfoReady) {
    dialog.showErrorBox('Hardware GPU required', 'GPU initialization timed out. holodori Planner will now close rather than use software rendering.')
    return null
  }

  let probeWindow: BrowserWindow | null = null
  try {
    probeWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false
      }
    })
    await probeWindow.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ccanvas%20id%3D%22probe%22%3E%3C%2Fcanvas%3E')
    const webGlProbe = await probeWindow.webContents.executeJavaScript(`(() => {
      const canvas = document.getElementById('probe')
      const gl = canvas instanceof HTMLCanvasElement
        ? canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
        : null
      if (!gl) return { webgl2: false, renderer: '', vendor: '' }
      const debug = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        webgl2: true,
        renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '',
        vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : ''
      }
    })()`, true) as WebGlProbeResult
    const featureStatus = app.getGPUFeatureStatus()
    const basicInfo = await app.getGPUInfo('basic')
    log.info('GPU renderer probe', webGlProbe)
    const assessment = evaluateGpuPolicy(
      app.isHardwareAccelerationEnabled(),
      featureStatus,
      basicInfo,
      webGlProbe
    )
    if (!assessment.ready || !assessment.runtime) {
      const details = assessment.failures.map((failure) => `• ${failure}`).join('\n')
      log.error('Strict GPU policy rejected startup', assessment.failures)
      dialog.showErrorBox('Hardware GPU required', `holodori Planner cannot start without hardware GPU rendering.\n\n${details}`)
      return null
    }
    log.info('Strict GPU rendering active', assessment.runtime)
    return assessment.runtime
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('GPU diagnostics failed', error)
    dialog.showErrorBox('Hardware GPU required', `GPU diagnostics failed: ${message}\n\nholodori Planner will now close rather than use software rendering.`)
    return null
  } finally {
    probeWindow?.destroy()
  }
}

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
    if (smokeMode) {
      if (progressionManifest.cards.length === 0 || loaded.profile.schemaVersion !== 1) app.exit(1)
      else app.exit(0)
      return
    }
    gpuRuntime = await requireHardwareGpu()
    if (!gpuRuntime) {
      app.exit(78)
      return
    }
    gpuEnforcementActive = true
    mainWindow = createWindow()
    startupComplete = true
    const updater = new UpdaterService(() => mainWindow)
    registerIpc(mainWindow, store, updater, gpuRuntime)
    updater.schedule(loaded.profile.preferences.autoCheckUpdates)
  })

  app.on('before-quit', () => { quitting = true })
  app.on('child-process-gone', (_event, details) => {
    if (!gpuEnforcementActive || quitting || details.type !== 'GPU') return
    gpuEnforcementActive = false
    startupComplete = false
    log.error('GPU process exited under strict GPU policy', details)
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    dialog.showErrorBox('GPU process stopped', 'Hardware GPU rendering was interrupted. holodori Planner will close instead of falling back to software rendering.')
    app.exit(79)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => {
    if (startupComplete) app.quit()
  })
}
