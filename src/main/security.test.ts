import { isTrustedRendererFrame, mayOpenExternalUrl, shouldBlockNavigation } from './security'
import { applyAllRequestSchema, applyCardRequestSchema, saveProfileRequestSchema } from '@shared/ipc'

describe('renderer security', () => {
  it('accepts only the app top frame', () => {
    expect(isTrustedRendererFrame({ senderMatchesWindow: true, isTopFrame: true, url: 'file:///app/out/renderer/index.html', isPackaged: true })).toBe(true)
    expect(isTrustedRendererFrame({ senderMatchesWindow: true, isTopFrame: false, url: 'file:///app/index.html', isPackaged: true })).toBe(false)
    expect(isTrustedRendererFrame({ senderMatchesWindow: false, isTopFrame: true, url: 'file:///app/index.html', isPackaged: true })).toBe(false)
    expect(isTrustedRendererFrame({ senderMatchesWindow: true, isTopFrame: true, url: 'https://evil.example', isPackaged: true })).toBe(false)
  })

  it('restricts external links to the project', () => {
    expect(mayOpenExternalUrl('https://github.com/totallynottuco/holodori-planner/releases')).toBe(true)
    expect(mayOpenExternalUrl('https://github.com/another/repo')).toBe(false)
    expect(mayOpenExternalUrl('file:///C:/Windows/System32')).toBe(false)
  })

  it('blocks renderer navigation away from the loaded app document', () => {
    expect(shouldBlockNavigation('file:///app/index.html', 'https://example.com')).toBe(true)
    expect(shouldBlockNavigation('file:///app/index.html', 'file:///app/index.html')).toBe(false)
  })

  it('rejects malformed IPC payloads', () => {
    expect(() => applyCardRequestSchema.parse({ expectedRevision: -1, cardId: '' })).toThrow()
    expect(() => applyAllRequestSchema.parse({ expectedRevision: -1 })).toThrow()
    expect(() => saveProfileRequestSchema.parse({ expectedRevision: 0, profile: {} })).toThrow()
  })
})
