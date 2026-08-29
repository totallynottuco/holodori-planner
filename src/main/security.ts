export interface RendererFrameCheck {
  senderMatchesWindow: boolean
  isTopFrame: boolean
  url: string
  isPackaged: boolean
}

export function isTrustedRendererFrame(check: RendererFrameCheck): boolean {
  if (!check.senderMatchesWindow || !check.isTopFrame) return false
  if (check.url.startsWith('file://')) return true
  if (check.isPackaged) return false
  try {
    const url = new URL(check.url)
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export function mayOpenExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith('/totallynottuco/holodori-planner')
  } catch {
    return false
  }
}

export function shouldBlockNavigation(currentUrl: string, requestedUrl: string): boolean {
  return requestedUrl !== currentUrl
}
