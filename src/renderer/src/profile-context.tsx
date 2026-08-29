import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppInfo, AppProfileV2 } from '@shared/types'

interface ProfileContextValue {
  profile: AppProfileV2
  info: AppInfo
  recoveryNotice: string | null
  busy: boolean
  save(candidate: AppProfileV2): Promise<AppProfileV2>
  replace(profile: AppProfileV2): void
  setBusy(value: boolean): void
  notify(message: string): void
}

const ProfileContext = createContext<ProfileContextValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [profile, setProfile] = useState<AppProfileV2 | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void Promise.all([window.holodori.profile.load(), window.holodori.app.getInfo()])
      .then(([loaded, appInfo]) => {
        if (!mounted) return
        setProfile(loaded.profile)
        setRecoveryNotice(loaded.recoveryNotice)
        setInfo(appInfo)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
    return () => {
      mounted = false
    }
  }, [])

  const save = useCallback(
    async (candidate: AppProfileV2): Promise<AppProfileV2> => {
      if (!profile) throw new Error('Profile is still loading')
      setBusy(true)
      setError(null)
      try {
        const saved = await window.holodori.profile.save(profile.revision, candidate)
        setProfile(saved)
        return saved
      } catch (reason) {
        const text = reason instanceof Error ? reason.message : String(reason)
        setError(text)
        throw reason
      } finally {
        setBusy(false)
      }
    },
    [profile]
  )

  const notify = useCallback((text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => (current === text ? null : current)), 3200)
  }, [])

  const value = useMemo<ProfileContextValue | null>(
    () =>
      profile && info
        ? {
            profile,
            info,
            recoveryNotice,
            busy,
            save,
            replace: setProfile,
            setBusy,
            notify
          }
        : null,
    [profile, info, recoveryNotice, busy, save, notify]
  )

  if (error && !value) {
    return <main className="fatal-state"><div className="panel"><h1>Unable to start</h1><p>{error}</p></div></main>
  }
  if (!value) return <main className="loading-state"><div className="brand-mark large">H</div><span>Loading planner…</span></main>

  return (
    <ProfileContext.Provider value={value}>
      {children}
      {recoveryNotice && (
        <div className="notice recovery" role="status">
          <span>{recoveryNotice}</span>
          <button className="icon-button" onClick={() => setRecoveryNotice(null)} aria-label="Dismiss recovery notice">×</button>
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
        </div>
      )}
      {message && <div className="toast" role="status">{message}</div>}
    </ProfileContext.Provider>
  )
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext)
  if (!value) throw new Error('useProfile must be used inside ProfileProvider')
  return value
}
