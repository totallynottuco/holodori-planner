import type { UpdateStatus } from '@shared/types'

export function canUseProductionUpdates(isPackaged: boolean): boolean {
  return isPackaged
}

export function updateErrorStatus(background: boolean, action: 'check' | 'download'): UpdateStatus {
  return {
    state: 'error',
    message: action === 'check' ? 'Unable to check for updates.' : 'Unable to download the update.',
    background
  }
}
