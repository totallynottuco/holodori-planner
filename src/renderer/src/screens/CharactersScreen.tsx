import { Edit3, Plus, Search, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { progressionManifest } from '@shared/manifest'
import { normalizeCardState } from '@shared/planner'
import { createDefaultCardState } from '@shared/profile'
import type { Attribute, CardCatalogEntry, Rarity, SavedCardState } from '@shared/types'
import {
  AttributeChip,
  CardIdentity,
  CardThumbnail,
  EmptyState,
  Modal,
  NumberField,
  Rarity as RarityStars
} from '../components'
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

export function CardEditor({
  card,
  initial,
  isNew = false,
  onClose,
  onSave
}: {
  card: CardCatalogEntry
  initial: SavedCardState
  isNew?: boolean
  onClose(): void
  onSave(value: SavedCardState): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const rules = progressionManifest.rarities[String(card.rarity) as '3' | '4' | '5']
  const normalized = normalizeCardState(draft, card, progressionManifest)
  const adjusted = normalized.trainingStage !== draft.trainingStage ||
    normalized.expIntoLevel !== draft.expIntoLevel ||
    normalized.goal.targetLevel !== draft.goal.targetLevel ||
    normalized.goal.targetBloomStage !== draft.goal.targetBloomStage
  const nextExp = normalized.level === rules.maxLevel
    ? 0
    : progressionManifest.cumulativeExperience[normalized.level] - progressionManifest.cumulativeExperience[normalized.level - 1]

  return (
    <Modal
      title={isNew ? 'Add card' : 'Edit card'}
      onClose={onClose}
      footer={<><button className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => onSave(normalized)}>Save card</button></>}
    >
      <CardIdentity card={card} />
      <div className="editor-section-title">Current</div>
      <div className="editor-grid">
        <NumberField label="Level" value={draft.level} min={1} max={rules.maxLevel} onChange={(level) => setDraft((value) => ({ ...value, level }))} />
        <NumberField label="Partial EXP" value={draft.expIntoLevel} min={0} max={Math.max(0, nextExp - 1)} disabled={normalized.level === rules.maxLevel} onChange={(expIntoLevel) => setDraft((value) => ({ ...value, expIntoLevel }))} />
        <label className="field"><span>SP Training</span><select value={draft.trainingStage} onChange={(event) => setDraft((value) => ({ ...value, trainingStage: Number(event.target.value) as SavedCardState['trainingStage'] }))}>{[0, 1, 2, 3, 4].map((stage) => <option key={stage} value={stage}>{stage === 0 ? 'Base' : `Stage ${stage}`}</option>)}</select></label>
        <NumberField label="Bloom" value={draft.bloomStage} min={0} max={5} onChange={(bloomStage) => setDraft((value) => ({ ...value, bloomStage: bloomStage as SavedCardState['bloomStage'] }))} />
        <NumberField label="Unused Bloom Points" value={draft.bloomPoints} min={0} onChange={(bloomPoints) => setDraft((value) => ({ ...value, bloomPoints }))} />
      </div>
      <div className="editor-section-title">Goal</div>
      <div className="editor-grid goal-fields">
        <NumberField label="Target Level" value={draft.goal.targetLevel} min={draft.level} max={rules.maxLevel} onChange={(targetLevel) => setDraft((value) => ({ ...value, goal: { ...value.goal, targetLevel } }))} />
        <NumberField label="Target Bloom" value={draft.goal.targetBloomStage} min={draft.bloomStage} max={5} onChange={(targetBloomStage) => setDraft((value) => ({ ...value, goal: { ...value.goal, targetBloomStage: targetBloomStage as SavedCardState['goal']['targetBloomStage'] } }))} />
      </div>
      {card.rarity === 5 && (
        <label className="toggle-row editor-toggle"><span><b>Use Bloom Stones</b></span><input type="checkbox" checked={draft.goal.useBloomStones} onChange={(event) => setDraft((value) => ({ ...value, goal: { ...value.goal, useBloomStones: event.target.checked } }))} /></label>
      )}
      {adjusted && <div className="inline-alert info">SP Training, EXP, or targets will be adjusted to match the current state.</div>}
    </Modal>
  )
}

export function CharactersScreen(): React.JSX.Element {
  const { profile, save, busy, notify } = useProfile()
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [catalogFilters, setCatalogFilters] = useState<Filters>(emptyFilters)
  const [editing, setEditing] = useState<{ card: CardCatalogEntry; state: SavedCardState; isNew: boolean } | null>(null)
  const [adding, setAdding] = useState(false)
  const catalogMap = useMemo(() => new Map(progressionManifest.cards.map((card) => [card.id, card])), [])
  const members = useMemo(() => [...new Set(progressionManifest.cards.map((card) => card.memberName))].sort(), [])

  const owned = Object.values(profile.cards)
    .filter((state) => {
      const card = catalogMap.get(state.cardId)
      return card ? matches(card, filters) : state.nameSnapshot.toLowerCase().includes(filters.search.toLowerCase())
    })
    .sort((a, b) => (catalogMap.get(a.cardId)?.memberName ?? a.nameSnapshot).localeCompare(catalogMap.get(b.cardId)?.memberName ?? b.nameSnapshot))
  const available = progressionManifest.cards.filter((card) => !profile.cards[card.id] && matches(card, catalogFilters))

  const saveCard = async (state: SavedCardState): Promise<void> => {
    await save({ ...profile, cards: { ...profile.cards, [state.cardId]: state }, plannerSelection: { cardId: state.cardId } })
    setEditing(null)
    setAdding(false)
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

  const filterControls = (value: Filters, onChange: (next: Filters) => void, catalog = false): React.JSX.Element => (
    <div className={`filter-controls ${catalog ? 'catalog-filters' : ''}`}>
      <label className="search-box"><Search size={18} /><input aria-label={catalog ? 'Search card catalog' : 'Search characters'} placeholder="Search member or card" value={value.search} onChange={(event) => onChange({ ...value, search: event.target.value })} /></label>
      <select aria-label="Filter by member" value={value.member} onChange={(event) => onChange({ ...value, member: event.target.value })}><option value="all">All members</option>{members.map((member) => <option key={member}>{member}</option>)}</select>
      <select aria-label="Filter by rarity" value={value.rarity} onChange={(event) => onChange({ ...value, rarity: event.target.value as Filters['rarity'] })}><option value="all">All rarities</option><option value="5">5★</option><option value="4">4★</option><option value="3">3★</option></select>
      <select aria-label="Filter by attribute" value={value.attribute} onChange={(event) => onChange({ ...value, attribute: event.target.value as Filters['attribute'] })}><option value="all">All attributes</option><option value="cute">Cute</option><option value="pure">Pure</option><option value="happy">Happy</option></select>
      {(value.search || value.member !== 'all' || value.rarity !== 'all' || value.attribute !== 'all') && <button className="icon-button" aria-label="Clear filters" onClick={() => onChange(emptyFilters)}><X size={18} /></button>}
    </div>
  )

  return (
    <section className="screen">
      <div className="toolbar panel">
        {filterControls(filters, setFilters)}
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
                  <div className="character-actions"><button className="ghost-button compact" onClick={() => setEditing({ card, state, isNew: false })}><Edit3 size={15} />Edit</button><button className="icon-button danger" disabled={busy} onClick={() => void removeCard(state)} aria-label={`Remove ${state.nameSnapshot}`}><Trash2 size={17} /></button></div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {adding && !editing && (
        <Modal wide title={`Add cards · ${available.length} available`} onClose={() => setAdding(false)} footer={<button className="ghost-button" onClick={() => setAdding(false)}>Close</button>}>
          {filterControls(catalogFilters, setCatalogFilters, true)}
          {available.length === 0 ? <EmptyState title="No untracked cards match" /> : <div className="catalog-grid">{available.map((card) => (
            <button key={card.id} onClick={() => setEditing({ card, state: createDefaultCardState(card.id, `${card.memberName} — ${card.cardName}`), isNew: true })}>
              <CardThumbnail card={card} alt="" />
              <span className="catalog-card-copy"><strong>{card.memberName}</strong><small>{card.cardName}</small><span><RarityStars value={card.rarity} /><AttributeChip attribute={card.attribute} /></span></span>
            </button>
          ))}</div>}
        </Modal>
      )}
      {editing && <CardEditor card={editing.card} initial={editing.state} isNew={editing.isNew} onClose={() => setEditing(null)} onSave={(state) => void saveCard(state)} />}
    </section>
  )
}
