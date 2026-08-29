import { Boxes, ChevronRight, Gem, PackageOpen, Settings, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { ProfileProvider, useProfile } from './profile-context'
import { PlannerScreen } from './screens/PlannerScreen'
import { CardsScreen } from './screens/CardsScreen'
import { InventoryScreen } from './screens/InventoryScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export type Screen = 'planner' | 'cards' | 'inventory' | 'settings'

const nav = [
  { id: 'planner' as const, label: 'Planner', icon: Sparkles },
  { id: 'cards' as const, label: 'Cards', icon: Boxes },
  { id: 'inventory' as const, label: 'Inventory', icon: PackageOpen },
  { id: 'settings' as const, label: 'Settings', icon: Settings }
]

function Shell(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('planner')
  const { profile } = useProfile()
  const owned = Object.keys(profile.cards).length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">H</div><div><strong>holodori</strong><span>Planner</span></div></div>
        <nav aria-label="Main navigation">
          {nav.map((item) => {
            const Icon = item.icon
            return <button key={item.id} className={screen === item.id ? 'active' : ''} onClick={() => setScreen(item.id)} aria-current={screen === item.id ? 'page' : undefined}><Icon size={20} /><span>{item.label}</span>{item.id === 'cards' && owned > 0 && <em>{owned}</em>}</button>
          })}
        </nav>
        <div className="sidebar-foot"><Gem size={17} /><span>Fan-made tool</span></div>
      </aside>
      <main className="workspace">
        <header className="topbar"><div><span className="eyebrow">hololive Dreams</span><h1>{nav.find((item) => item.id === screen)?.label}</h1></div><button className="ghost-button compact" onClick={() => setScreen('inventory')}>Resources <ChevronRight size={16} /></button></header>
        {screen === 'planner' && <PlannerScreen onNavigate={setScreen} />}
        {screen === 'cards' && <CardsScreen />}
        {screen === 'inventory' && <InventoryScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </main>
    </div>
  )
}

export function App(): React.JSX.Element {
  return <ProfileProvider><Shell /></ProfileProvider>
}
