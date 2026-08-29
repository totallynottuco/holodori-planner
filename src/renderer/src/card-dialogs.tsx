import { Search, X } from 'lucide-react'
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
} from './components'
import { useProfile } from './profile-context'

interface CatalogFilters {
  search: string
  member: string
  rarity: 'all' | `${Rarity}`
  attribute: 'all' | Attribute
}

const emptyCatalogFilters: CatalogFilters = { search: '', member: 'all', rarity: 'all', attribute: 'all' }

function matchesCatalog(card: CardCatalogEntry, filters: CatalogFilters): boolean {
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

export function AddCardsDialog({ open, onClose }: { open: boolean; onClose(): void }): React.JSX.Element | null {
  const { profile, save, notify } = useProfile()
  const [filters, setFilters] = useState<CatalogFilters>(emptyCatalogFilters)
  const [editing, setEditing] = useState<{ card: CardCatalogEntry; state: SavedCardState } | null>(null)
  const members = useMemo(() => [...new Set(progressionManifest.cards.map((card) => card.memberName))].sort(), [])
  const available = progressionManifest.cards.filter((card) => !profile.cards[card.id] && matchesCatalog(card, filters))

  const closeAll = (): void => {
    setEditing(null)
    onClose()
  }
  const saveCard = async (state: SavedCardState): Promise<void> => {
    await save({ ...profile, cards: { ...profile.cards, [state.cardId]: state }, plannerSelection: { cardId: state.cardId } })
    closeAll()
    notify('Card saved.')
  }

  if (!open) return null
  if (editing) {
    return <CardEditor card={editing.card} initial={editing.state} isNew onClose={() => setEditing(null)} onSave={(state) => void saveCard(state)} />
  }

  return (
    <Modal wide title={`Add cards · ${available.length} available`} onClose={closeAll} footer={<button className="ghost-button" onClick={closeAll}>Close</button>}>
      <div className="filter-controls catalog-filters">
        <label className="search-box"><Search size={18} /><input aria-label="Search card catalog" placeholder="Search member or card" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></label>
        <select aria-label="Filter catalog by member" value={filters.member} onChange={(event) => setFilters({ ...filters, member: event.target.value })}><option value="all">All members</option>{members.map((member) => <option key={member}>{member}</option>)}</select>
        <select aria-label="Filter catalog by rarity" value={filters.rarity} onChange={(event) => setFilters({ ...filters, rarity: event.target.value as CatalogFilters['rarity'] })}><option value="all">All rarities</option><option value="5">5★</option><option value="4">4★</option><option value="3">3★</option></select>
        <select aria-label="Filter catalog by attribute" value={filters.attribute} onChange={(event) => setFilters({ ...filters, attribute: event.target.value as CatalogFilters['attribute'] })}><option value="all">All attributes</option><option value="cute">Cute</option><option value="pure">Pure</option><option value="happy">Happy</option></select>
        {(filters.search || filters.member !== 'all' || filters.rarity !== 'all' || filters.attribute !== 'all') && <button className="icon-button" aria-label="Clear catalog filters" onClick={() => setFilters(emptyCatalogFilters)}><X size={18} /></button>}
      </div>
      {available.length === 0 ? <EmptyState title="No untracked cards match" /> : <div className="catalog-grid">{available.map((card) => (
        <button key={card.id} onClick={() => setEditing({ card, state: createDefaultCardState(card.id, `${card.memberName} — ${card.cardName}`) })}>
          <CardThumbnail card={card} alt="" />
          <span className="catalog-card-copy"><strong>{card.memberName}</strong><small>{card.cardName}</small><span><RarityStars value={card.rarity} /><AttributeChip attribute={card.attribute} /></span></span>
        </button>
      ))}</div>}
    </Modal>
  )
}
