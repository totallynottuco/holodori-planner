import { ChevronRight, PackageOpen, PanelLeftClose, PanelLeftOpen, Settings, Sparkles, UsersRound } from 'lucide-react'
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { profile } = useProfile()
  const owned = Object.keys(profile.cards).length
  const activeGoals = Object.values(profile.cards).filter((state) =>
    state.goal.targetLevel > state.level || state.goal.targetBloomStage > state.bloomStage
  ).length
  const title = nav.find((item) => item.id === screen)?.label ?? ''

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
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
                aria-label={sidebarCollapsed ? item.label : undefined}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon size={20} />
                <span>{item.label}</span>
                {count > 0 && <em>{count}</em>}
              </button>
            )
          })}
        </nav>
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((value) => !value)}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
        </button>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <h1>{title}</h1>
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
      <div id="modal-root" className="modal-root" />
    </div>
  )
}

export function App(): React.JSX.Element {
  return <ProfileProvider><Shell /></ProfileProvider>
}
