import { Check, CircleDollarSign, FlaskConical, Gem, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t, type TranslationKey } from '@shared/i18n'
import type { Inventory, ResourceKey } from '@shared/types'
import { NumberField } from '../components'
import { useProfile } from '../profile-context'

const groups: Array<{ title: string; icon: typeof Gem; keys: ResourceKey[] }> = [
  { title: 'General', icon: CircleDollarSign, keys: ['lessonPoints', 'hologold', 'hololium', 'bloomStones'] },
  { title: 'Cute', icon: Gem, keys: ['cuteBeads', 'cuteCrystals'] },
  { title: 'Pure', icon: FlaskConical, keys: ['pureBeads', 'pureCrystals'] },
  { title: 'Happy', icon: Check, keys: ['happyBeads', 'happyCrystals'] }
]

export function InventoryScreen(): React.JSX.Element {
  const { profile, save, busy, notify } = useProfile()
  const [draft, setDraft] = useState<Inventory>({ ...profile.inventory })
  useEffect(() => setDraft({ ...profile.inventory }), [profile.inventory])
  const changed = Object.keys(draft).some((key) => draft[key as ResourceKey] !== profile.inventory[key as ResourceKey])

  const commit = async (): Promise<void> => {
    await save({ ...profile, inventory: draft })
    notify('Inventory saved.')
  }

  return (
    <section className="screen inventory-grid">
      {groups.map((group) => {
        const Icon = group.icon
        return <div className={`panel inventory-group ${group.title.toLowerCase()}`} key={group.title}><div className="panel-title"><h2>{group.title}</h2><div className="group-icon"><Icon size={19} /></div></div><div className="field-grid">{group.keys.map((key) => <NumberField key={key} label={t(`resource.${key}` as TranslationKey)} value={draft[key]} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />)}</div></div>
      })}
      <div className="sticky-action"><span>{changed ? 'Unsaved inventory changes' : 'Inventory is up to date'}</span><button className="primary-button" disabled={!changed || busy} onClick={() => void commit()}><Save size={17} />Save inventory</button></div>
    </section>
  )
}
