import type { GPUFeatureStatus } from 'electron'
import { evaluateGpuPolicy } from './gpu-policy'

const enabledFeatures = {
  '2d_canvas': 'enabled',
  flash_3d: 'unavailable',
  flash_stage3d: 'unavailable',
  flash_stage3d_baseline: 'unavailable',
  gpu_compositing: 'enabled',
  multiple_raster_threads: 'enabled_on',
  native_gpu_memory_buffers: 'enabled',
  rasterization: 'enabled_force',
  video_decode: 'enabled',
  video_encode: 'enabled',
  vpx_decode: 'enabled',
  webgl: 'enabled_on',
  webgl2: 'enabled_force_on'
} satisfies GPUFeatureStatus

const hardwareInfo = {
  auxAttributes: { softwareRendering: false, glImplementationParts: '(gl=egl-angle,angle=d3d11)' },
  gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2684 }]
}

const hardwareProbe = { webgl2: true, renderer: 'ANGLE (NVIDIA GeForce RTX 5080 Direct3D11)', vendor: 'Google Inc. (NVIDIA)' }

describe('strict GPU policy', () => {
  it('accepts a hardware device with all required hardware rendering paths', () => {
    expect(evaluateGpuPolicy(true, enabledFeatures, hardwareInfo, hardwareProbe)).toEqual({
      ready: true,
      failures: [],
      runtime: {
        mode: 'hardware-required',
        device: '0x10de:0x2684',
        features: {
          gpu_compositing: 'enabled',
          rasterization: 'enabled_force',
          webgl: 'enabled_on',
          webgl2: 'context-confirmed'
        }
      }
    })
  })

  it('rejects software rendering and disabled required features', () => {
    const result = evaluateGpuPolicy(false, { ...enabledFeatures, rasterization: 'disabled_software' }, {
      auxAttributes: { softwareRendering: true },
      gpuDevice: [{ active: false, vendorId: 0, deviceId: 0 }]
    }, { webgl2: false, renderer: 'Google SwiftShader', vendor: 'Google Inc.' })
    expect(result.ready).toBe(false)
    expect(result.runtime).toBeNull()
    expect(result.failures).toEqual(expect.arrayContaining([
      'Electron hardware acceleration is disabled.',
      'rasterization is disabled_software, not hardware enabled.',
      'Chromium reported software rendering.',
      'A hardware WebGL2 context could not be created.',
      'WebGL2 is using a software renderer (Google SwiftShader).',
      'The WebGL2 renderer did not match a hardware GPU.'
    ]))
  })

  it('rejects readback and software WebGL2 instead of permitting a fallback', () => {
    expect(evaluateGpuPolicy(true, { ...enabledFeatures, webgl: 'enabled_readback' }, hardwareInfo, hardwareProbe).ready).toBe(false)
    expect(evaluateGpuPolicy(true, enabledFeatures, hardwareInfo, { ...hardwareProbe, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))' }).ready).toBe(false)
  })

  it('accepts a renderer-matched device when Chromium leaves the active flag stale', () => {
    const staleInfo = {
      auxAttributes: {},
      gpuDevice: [{ active: false, deviceString: 'NVIDIA GeForce RTX 5080', vendorId: 0x10de, deviceId: 0x2c02 }]
    }
    expect(evaluateGpuPolicy(true, enabledFeatures, staleInfo, hardwareProbe).runtime?.device).toBe('0x10de:0x2c02')
  })
})
