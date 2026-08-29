import type { GPUFeatureStatus } from 'electron'

export const requiredGpuFeatures = [
  'gpu_compositing',
  'rasterization',
  'webgl'
] as const satisfies readonly (keyof GPUFeatureStatus)[]

export type RequiredGpuFeature = (typeof requiredGpuFeatures)[number]

export interface GpuRuntimeInfo {
  mode: 'hardware-required'
  device: string
  features: Record<RequiredGpuFeature | 'webgl2', string>
}

export interface WebGlProbeResult {
  webgl2: boolean
  renderer: string
  vendor: string
}

export interface GpuPolicyResult {
  ready: boolean
  failures: string[]
  runtime: GpuRuntimeInfo | null
}

const hardwareStatuses = new Set([
  'enabled',
  'enabled_on',
  'enabled_force',
  'enabled_force_on'
])

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function formatIdentifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return `0x${value.toString(16).padStart(4, '0')}`
  }
  if (typeof value === 'string' && value.trim() && value !== '0x0000' && value !== '0') {
    return value.trim()
  }
  return null
}

export function evaluateGpuPolicy(
  hardwareAccelerationEnabled: boolean,
  featureStatus: GPUFeatureStatus,
  basicInfo: unknown,
  webGlProbe: WebGlProbeResult
): GpuPolicyResult {
  const failures: string[] = []
  if (!hardwareAccelerationEnabled) failures.push('Electron hardware acceleration is disabled.')

  const features = Object.fromEntries(
    requiredGpuFeatures.map((feature) => [feature, featureStatus[feature]])
  ) as Record<RequiredGpuFeature, string>

  for (const feature of requiredGpuFeatures) {
    if (!hardwareStatuses.has(features[feature])) {
      failures.push(`${feature} is ${features[feature] || 'unavailable'}, not hardware enabled.`)
    }
  }

  const info = isRecord(basicInfo) ? basicInfo : null
  const attributes = info && isRecord(info.auxAttributes) ? info.auxAttributes : null
  if (attributes?.softwareRendering === true) failures.push('Chromium reported software rendering.')

  if (!webGlProbe.webgl2) failures.push('A hardware WebGL2 context could not be created.')
  if (!webGlProbe.renderer.trim()) failures.push('WebGL2 did not report a hardware renderer.')
  if (/swiftshader|software|llvmpipe|microsoft basic render/i.test(webGlProbe.renderer)) {
    failures.push(`WebGL2 is using a software renderer (${webGlProbe.renderer}).`)
  }

  const devices = info && Array.isArray(info.gpuDevice) ? info.gpuDevice.filter(isRecord) : []
  const renderer = webGlProbe.renderer.toLocaleLowerCase()
  const activeDevice = devices.find((device) => device.active === true)
    ?? devices.find((device) => typeof device.deviceString === 'string' && renderer.includes(device.deviceString.toLocaleLowerCase()))
  const vendorId = formatIdentifier(activeDevice?.vendorId)
  const deviceId = formatIdentifier(activeDevice?.deviceId)
  if (!activeDevice || !vendorId || !deviceId) failures.push('The WebGL2 renderer did not match a hardware GPU.')

  if (failures.length > 0 || !vendorId || !deviceId) {
    return { ready: false, failures, runtime: null }
  }

  return {
    ready: true,
    failures: [],
    runtime: {
      mode: 'hardware-required',
      device: `${vendorId}:${deviceId}`,
      features: { ...features, webgl2: 'context-confirmed' }
    }
  }
}
