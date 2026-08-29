import { ChevronRight, Gem, PackageOpen, Settings, Sparkles, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { t } from '@shared/i18n'
import { ProfileProvider, useProfile } from './profile-context'
import { CharactersScreen } from './screens/CharactersScreen'
import { InventoryScreen } from './screens/InventoryScreen'
import { PlannerScreen } from './screens/PlannerScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export type Screen = 'planner' | 'characters' | 'inventory' | 'settings'

const nav = [
  { id: 'planner' as const, label: t('nav.planner'), icon: Sparkles },
  { id: 'characters' as const, label: t('nav.characters'), icon: UsersRound },
  { id: 'inventory' as const, label: t('nav.inventory'), icon: PackageOpen },
  { id: 'settings' as const, label: t('nav.settings'), icon: Settings }
]

function Shell(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('planner')
  const { profile } = useProfile()
  const owned = Object.keys(profile.cards).length
  const activeGoals = Object.values(profile.cards).filter((state) =>
    state.goal.targetLevel > state.level || state.goal.targetBloomStage > state.bloomStage
  ).length
  const title = nav.find((item) => item.id === screen)?.label ?? ''

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">H</div>
          <div><strong>holodori</strong><span>Planner</span></div>
        </div>
        <nav aria-label="Main navigation">
          {nav.map((item) => {
            const Icon = item.icon
            const count = item.id === 'characters' ? owned : item.id === 'planner' ? activeGoals : 0
            return (
              <button
                key={item.id}
                className={screen === item.id ? 'active' : ''}
                onClick={() => setScreen(item.id)}
                aria-current={screen === item.id ? 'page' : undefined}
              >
                <Icon size={20} />
                <span>{item.label}</span>
                {count > 0 && <em>{count}</em>}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-foot"><Gem size={17} /><span>Fan-made tool</span></div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">hololive Dreams</span><h1>{title}</h1></div>
          {screen !== 'inventory' && (
            <button className="ghost-button compact" onClick={() => setScreen('inventory')}>
              Inventory <ChevronRight size={16} />
            </button>
          )}
        </header>
        {screen === 'planner' && <PlannerScreen onNavigate={setScreen} />}
        {screen === 'characters' && <CharactersScreen />}
        {screen === 'inventory' && <InventoryScreen />}
        {screen === 'settings' && <SettingsScreen />}
      </main>
    </div>
  )
}

export function App(): React.JSX.Element {
  return <ProfileProvider><Shell /></ProfileProvider>
}
