import { Edit3, Plus, Search, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { progressionManifest } from '@shared/manifest'
import type { Attribute, CardCatalogEntry, Rarity, SavedCardState } from '@shared/types'
import { AddCardsDialog, CardEditor } from '../card-dialogs'
import { AttributeChip, CardThumbnail, EmptyState, Rarity as RarityStars } from '../components'
import { useProfile } from '../profile-context'

interface Filters {
  search: string
  member: string
  rarity: 'all' | `${Rarity}`
  attribute: 'all' | Attribute
}

const emptyFilters: Filters = { search: '', member: 'all', rarity: 'all', attribute: 'all' }

function matches(card: CardCatalogEntry, filters: Filters): boolean {
  const query = filters.search.trim().toLowerCase()
  return (!query || `${card.memberName} ${card.cardName}`.toLowerCase().includes(query)) &&
    (filters.member === 'all' || card.memberName === filters.member) &&
    (filters.rarity === 'all' || String(card.rarity) === filters.rarity) &&
    (filters.attribute === 'all' || card.attribute === filters.attribute)
}

export function CharactersScreen(): React.JSX.Element {
  const { profile, save, busy, notify } = useProfile()
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [editing, setEditing] = useState<{ card: CardCatalogEntry; state: SavedCardState } | null>(null)
  const [adding, setAdding] = useState(false)
  const catalogMap = useMemo(() => new Map(progressionManifest.cards.map((card) => [card.id, card])), [])
  const members = useMemo(() => [...new Set(progressionManifest.cards.map((card) => card.memberName))].sort(), [])

  const owned = Object.values(profile.cards)
    .filter((state) => {
      const card = catalogMap.get(state.cardId)
      return card ? matches(card, filters) : state.nameSnapshot.toLowerCase().includes(filters.search.toLowerCase())
    })
    .sort((a, b) => (catalogMap.get(a.cardId)?.memberName ?? a.nameSnapshot).localeCompare(catalogMap.get(b.cardId)?.memberName ?? b.nameSnapshot))

  const saveCard = async (state: SavedCardState): Promise<void> => {
    await save({ ...profile, cards: { ...profile.cards, [state.cardId]: state }, plannerSelection: { cardId: state.cardId } })
    setEditing(null)
    notify('Card saved.')
  }
  const removeCard = async (state: SavedCardState): Promise<void> => {
    if (!window.confirm(`Remove ${state.nameSnapshot} from this profile?`)) return
    const cards = { ...profile.cards }
    delete cards[state.cardId]
    await save({
      ...profile,
      cards,
      plannerSelection: profile.plannerSelection.cardId === state.cardId ? { cardId: null } : profile.plannerSelection
    })
    notify('Card removed.')
  }

  return (
    <section className="screen">
      <div className="toolbar panel">
        <div className="filter-controls">
          <label className="search-box"><Search size={18} /><input aria-label="Search characters" placeholder="Search member or card" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></label>
          <select aria-label="Filter by member" value={filters.member} onChange={(event) => setFilters({ ...filters, member: event.target.value })}><option value="all">All members</option>{members.map((member) => <option key={member}>{member}</option>)}</select>
          <select aria-label="Filter by rarity" value={filters.rarity} onChange={(event) => setFilters({ ...filters, rarity: event.target.value as Filters['rarity'] })}><option value="all">All rarities</option><option value="5">5★</option><option value="4">4★</option><option value="3">3★</option></select>
          <select aria-label="Filter by attribute" value={filters.attribute} onChange={(event) => setFilters({ ...filters, attribute: event.target.value as Filters['attribute'] })}><option value="all">All attributes</option><option value="cute">Cute</option><option value="pure">Pure</option><option value="happy">Happy</option></select>
          {(filters.search || filters.member !== 'all' || filters.rarity !== 'all' || filters.attribute !== 'all') && <button className="icon-button" aria-label="Clear filters" onClick={() => setFilters(emptyFilters)}><X size={18} /></button>}
        </div>
        <button className="primary-button" onClick={() => setAdding(true)}><Plus size={17} />Add cards</button>
      </div>
      {owned.length === 0 ? (
        <EmptyState title={Object.keys(profile.cards).length ? 'No cards match these filters' : 'Your character list is empty'} action={<button className="primary-button" onClick={() => setAdding(true)}>Add cards</button>} />
      ) : (
        <div className="character-grid">
          {owned.map((state) => {
            const card = catalogMap.get(state.cardId)
            const activeGoal = state.goal.targetLevel > state.level || state.goal.targetBloomStage > state.bloomStage
            if (!card) return <article className="character-card panel removed-card" key={state.cardId}><div className="removed-art">?</div><div className="character-copy"><strong>{state.nameSnapshot}</strong><span>Removed from current catalog</span></div><button className="icon-button danger" onClick={() => void removeCard(state)}><Trash2 size={18} /></button></article>
            return (
              <article className={`character-card panel ${card.attribute}`} key={state.cardId}>
                <div className="character-art"><CardThumbnail card={card} alt={`${card.memberName} — ${card.cardName}`} /></div>
                <div className="character-card-body">
                  <div className="character-heading"><div><strong>{card.memberName}</strong><span title={card.cardName}>{card.cardName}</span></div><RarityStars value={card.rarity} /></div>
                  <div className="character-badges"><AttributeChip attribute={card.attribute} />{activeGoal && <span className="status-chip goal">Goal set</span>}</div>
                  <div className="character-stats"><span>Lv.<b>{state.level}</b></span><span>SP <b>{state.trainingStage || '—'}</b></span><span>Bloom <b>{state.bloomStage}</b></span></div>
                  {activeGoal && <div className="goal-line">Goal: Lv.{state.goal.targetLevel} · Bloom {state.goal.targetBloomStage}</div>}
                  <div className="character-actions"><button className="ghost-button compact" onClick={() => setEditing({ card, state })}><Edit3 size={15} />Edit</button><button className="icon-button danger" disabled={busy} onClick={() => void removeCard(state)} aria-label={`Remove ${state.nameSnapshot}`}><Trash2 size={17} /></button></div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <AddCardsDialog open={adding} onClose={() => setAdding(false)} />
      {editing && <CardEditor card={editing.card} initial={editing.state} onClose={() => setEditing(null)} onSave={(state) => void saveCard(state)} />}
    </section>
  )
}
