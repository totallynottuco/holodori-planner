import { CheckCircle2, Download, ExternalLink, FileDown, FileUp, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ImportPreview, UpdateStatus } from '@shared/types'
import { Modal } from '../components'
import { useProfile } from '../profile-context'

export function SettingsScreen(): React.JSX.Element {
  const { profile, info, replace, setBusy, busy, notify, save } = useProfile()
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [preview, setPreview] = useState<ImportPreview | null>(null)

  useEffect(() => window.holodori.updates.onStatus((next) => setStatus(next)), [])

  const exportProfile = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.holodori.profile.export()
      if (!result.canceled) notify('Profile backup exported.')
    } finally { setBusy(false) }
  }
  const chooseImport = async (): Promise<void> => {
    setBusy(true)
    try { setPreview(await window.holodori.profile.importPreview()) } finally { setBusy(false) }
  }
  const commitImport = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      const imported = await window.holodori.profile.importCommit(preview.token, profile.revision)
      replace(imported)
      setPreview(null)
      notify('Profile backup imported.')
    } finally { setBusy(false) }
  }
  const toggleUpdates = async (enabled: boolean): Promise<void> => {
    await save({ ...profile, preferences: { ...profile.preferences, autoCheckUpdates: enabled } })
    notify('Update preference saved.')
  }

  const updateLabel = status.state === 'checking' ? 'Checking…' : status.state === 'available' ? `Version ${status.version} available` : status.state === 'downloading' ? `Downloading ${status.percent}%` : status.state === 'downloaded' ? `Version ${status.version} ready` : status.state === 'not-available' ? 'You’re up to date' : status.state === 'error' ? status.message : 'Ready to check'

  return <section className="screen settings-grid">
    <div className="panel settings-card"><div className="panel-title"><h2>App</h2><span className="version-chip">v{info.version}</span></div><div className="settings-rows"><div><span>App version</span><strong>{info.version}</strong></div><div><span>Game data</span><strong>{info.catalogVersion}</strong></div><div><span>Profile</span><strong className="path-text" title={info.profilePath}>{info.profilePath}</strong></div></div><button className="ghost-button" onClick={() => void window.holodori.app.openProjectPage()}>GitHub project <ExternalLink size={16} /></button></div>

    <div className="panel settings-card"><div className="panel-title"><h2>Updates</h2>{status.state === 'not-available' && <CheckCircle2 className="success-icon" size={21} />}</div><div className="update-status"><div className={`update-orb ${status.state}`}><RefreshCw size={22} /></div><div><strong>{updateLabel}</strong>{'releaseNotes' in status && status.releaseNotes && <small>{status.releaseNotes}</small>}</div></div><label className="toggle-row"><span><b>Automatic checks</b></span><input type="checkbox" checked={profile.preferences.autoCheckUpdates} onChange={(event) => void toggleUpdates(event.target.checked)} /></label><div className="button-row"><button className="ghost-button" disabled={busy || status.state === 'checking'} onClick={() => void window.holodori.updates.check()}><RefreshCw size={16} />Check now</button>{status.state === 'available' && <button className="primary-button" onClick={() => void window.holodori.updates.download()}><Download size={17} />Download</button>}{status.state === 'downloaded' && <button className="primary-button" onClick={() => void window.holodori.updates.install()}><RotateCcw size={17} />Restart & install</button>}</div></div>

    <div className="panel settings-card"><div className="panel-title"><h2>Profile backup</h2></div><div className="backup-actions"><button className="action-tile" disabled={busy} onClick={() => void exportProfile()}><FileDown size={24} /><span><strong>Export</strong><small>Save a complete JSON backup</small></span></button><button className="action-tile" disabled={busy} onClick={() => void chooseImport()}><FileUp size={24} /><span><strong>Import</strong><small>Validate and replace this profile</small></span></button></div></div>

    <div className="panel settings-card attribution"><div className="panel-title"><h2>About</h2></div><p>Unofficial fan-made tool. Not affiliated with COVER Corp. or hololive production.</p><p>Progression and catalog facts are normalized from HolodoriDB master-data research. No game artwork, logos, or extracted UI assets are included.</p><div className="license-line"><span>License</span><strong>MIT</strong></div></div>

    {preview && <Modal title="Replace current profile?" onClose={() => setPreview(null)} footer={<><button className="ghost-button" onClick={() => setPreview(null)}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void commitImport()}>Replace profile</button></>}><div className="import-file">{preview.fileName}</div><div className="preview-stats"><div><span>Cards</span><strong>{preview.summary.cards}</strong></div><div><span>Inventory units</span><strong>{preview.summary.inventoryUnits.toLocaleString()}</strong></div><div><span>Backup revision</span><strong>{preview.summary.revision}</strong></div></div><div className="inline-alert warning">Your current profile will be backed up, then replaced.</div></Modal>}
  </section>
}
