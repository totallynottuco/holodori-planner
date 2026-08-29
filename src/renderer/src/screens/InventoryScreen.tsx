import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t, type TranslationKey } from '@shared/i18n'
import { resourceKeys, type Inventory, type ResourceKey } from '@shared/types'
import { MaterialIcon } from '../components'
import { useProfile } from '../profile-context'

type InventoryTab = 'all' | 'general' | 'cute' | 'pure' | 'happy' | 'bloom'

const tabKeys: Record<InventoryTab, ResourceKey[]> = {
  all: [...resourceKeys],
  general: ['lessonPoints', 'hologold', 'hololium'],
  cute: ['cuteBeads', 'cuteCrystals'],
  pure: ['pureBeads', 'pureCrystals'],
  happy: ['happyBeads', 'happyCrystals'],
  bloom: ['bloomStones']
}

export function InventoryScreen(): React.JSX.Element {
  const { profile, save, busy, notify } = useProfile()
  const [draft, setDraft] = useState<Inventory>({ ...profile.inventory })
  const [tab, setTab] = useState<InventoryTab>('all')
  useEffect(() => setDraft({ ...profile.inventory }), [profile.inventory])
  const changed = resourceKeys.some((key) => draft[key] !== profile.inventory[key])

  const commit = async (): Promise<void> => {
    await save({ ...profile, inventory: draft })
    notify('Inventory saved.')
  }

  return (
    <section className="screen inventory-screen">
      <div className="tab-bar panel" role="tablist" aria-label="Inventory groups">
        {(['all', 'general', 'cute', 'pure', 'happy', 'bloom'] as const).map((value) => <button role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} key={value} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      <div className="material-grid">
        {tabKeys[tab].map((key) => (
          <label className={`material-card panel ${key.startsWith('cute') ? 'cute' : key.startsWith('pure') ? 'pure' : key.startsWith('happy') ? 'happy' : ''}`} key={key}>
            <div className="material-image"><MaterialIcon resource={key} /></div>
            <span>{t(`resource.${key}` as TranslationKey)}</span>
            <input aria-label={t(`resource.${key}` as TranslationKey)} type="number" min="0" step="1" value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: Math.max(0, Math.trunc(Number(event.target.value) || 0)) }))} />
          </label>
        ))}
      </div>
      <div className="sticky-action"><span>{changed ? 'Unsaved inventory changes' : 'Inventory is up to date'}</span><button className="primary-button" disabled={!changed || busy} onClick={() => void commit()}><Save size={17} />Save inventory</button></div>
    </section>
  )
}
