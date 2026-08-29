import { canUseProductionUpdates, updateErrorStatus } from './update-policy'

describe('update policy', () => {
  it('permits network update checks only in packaged builds', () => {
    expect(canUseProductionUpdates(true)).toBe(true)
    expect(canUseProductionUpdates(false)).toBe(false)
  })

  it('keeps automatic-check failures unobtrusive', () => {
    expect(updateErrorStatus(true, 'check')).toEqual({
      state: 'error',
      message: 'Unable to check for updates.',
      background: true
    })
  })

  it('surfaces user-initiated download failures', () => {
    expect(updateErrorStatus(false, 'download')).toEqual({
      state: 'error',
      message: 'Unable to download the update.',
      background: false
    })
  })
})
