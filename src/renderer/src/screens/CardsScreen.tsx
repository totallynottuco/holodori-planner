import { Edit3, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { progressionManifest } from '@shared/manifest'
import { normalizeCardState } from '@shared/planner'
import type { CardCatalogEntry, SavedCardState } from '@shared/types'
import { AttributeChip, CardIdentity, EmptyState, Modal, NumberField, Rarity } from '../components'
import { useProfile } from '../profile-context'

function defaultState(card: CardCatalogEntry): SavedCardState {
  return { cardId: card.id, nameSnapshot: `${card.memberName} — ${card.cardName}`, level: 1, expIntoLevel: 0, trainingStage: 0, bloomStage: 0, bloomPoints: 0 }
}

function CardEditor({ card, initial, onClose, onSave }: { card: CardCatalogEntry; initial: SavedCardState; onClose(): void; onSave(value: SavedCardState): void }): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const rules = progressionManifest.rarities[String(card.rarity) as '3' | '4' | '5']
  const normalized = normalizeCardState(draft, card, progressionManifest)
  const adjusted = normalized.trainingStage !== draft.trainingStage || normalized.expIntoLevel !== draft.expIntoLevel
  const nextExp = normalized.level === rules.maxLevel ? 0 : progressionManifest.cumulativeExperience[normalized.level] - progressionManifest.cumulativeExperience[normalized.level - 1]

  return <Modal title={initial.level === 1 && initial.bloomStage === 0 && initial.bloomPoints === 0 ? 'Add card' : 'Edit card'} onClose={onClose} footer={<><button className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => onSave(normalized)}>Save card</button></>}>
    <CardIdentity card={card} />
    <div className="editor-grid">
      <NumberField label="Level" value={draft.level} min={1} max={rules.maxLevel} onChange={(level) => setDraft((value) => ({ ...value, level }))} />
      <NumberField label="Partial EXP" value={draft.expIntoLevel} min={0} max={Math.max(0, nextExp - 1)} disabled={normalized.level === rules.maxLevel} onChange={(expIntoLevel) => setDraft((value) => ({ ...value, expIntoLevel }))} />
      <label className="field"><span>SP Training</span><select value={draft.trainingStage} onChange={(event) => setDraft((value) => ({ ...value, trainingStage: Number(event.target.value) as SavedCardState['trainingStage'] }))}>{[0, 1, 2, 3, 4].map((stage) => <option key={stage} value={stage}>{stage === 0 ? 'Base' : `Stage ${stage}`}</option>)}</select></label>
      <NumberField label="Bloom" value={draft.bloomStage} min={0} max={5} onChange={(bloomStage) => setDraft((value) => ({ ...value, bloomStage: bloomStage as SavedCardState['bloomStage'] }))} />
      <NumberField label="Unused Bloom Points" value={draft.bloomPoints} min={0} onChange={(bloomPoints) => setDraft((value) => ({ ...value, bloomPoints }))} />
    </div>
    {adjusted && <div className="inline-alert info">SP Training or partial EXP will be adjusted to match this level.</div>}
  </Modal>
}

export function CardsScreen(): React.JSX.Element {
  const { profile, save, busy, notify } = useProfile()
  const [search, setSearch] = useState('')
  const [attribute, setAttribute] = useState('all')
  const [rarity, setRarity] = useState('all')
  const [editing, setEditing] = useState<{ card: CardCatalogEntry; state: SavedCardState } | null>(null)
  const [adding, setAdding] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')

  const catalogMap = useMemo(() => new Map(progressionManifest.cards.map((card) => [card.id, card])), [])
  const owned = Object.values(profile.cards).filter((state) => {
    const card = catalogMap.get(state.cardId)
    if (!card) return state.nameSnapshot.toLowerCase().includes(search.toLowerCase())
    return `${card.memberName} ${card.cardName}`.toLowerCase().includes(search.toLowerCase()) && (attribute === 'all' || card.attribute === attribute) && (rarity === 'all' || String(card.rarity) === rarity)
  }).sort((a, b) => (catalogMap.get(a.cardId)?.memberName ?? a.nameSnapshot).localeCompare(catalogMap.get(b.cardId)?.memberName ?? b.nameSnapshot))
  const available = progressionManifest.cards.filter((card) => !profile.cards[card.id] && `${card.memberName} ${card.cardName}`.toLowerCase().includes(catalogSearch.toLowerCase())).slice(0, 60)

  const saveCard = async (state: SavedCardState): Promise<void> => {
    await save({ ...profile, cards: { ...profile.cards, [state.cardId]: state } })
    setEditing(null)
    setAdding(false)
    notify('Card saved.')
  }

  const removeCard = async (state: SavedCardState): Promise<void> => {
    if (!window.confirm(`Remove ${state.nameSnapshot} from this profile?`)) return
    const cards = { ...profile.cards }
    delete cards[state.cardId]
    await save({ ...profile, cards, plannerSelection: profile.plannerSelection.cardId === state.cardId ? { cardId: null, targetLevel: null, targetBloomStage: null, useBloomStones: false } : profile.plannerSelection })
    notify('Card removed.')
  }

  return <section className="screen">
    <div className="toolbar panel"><label className="search-box"><Search size={18} /><input aria-label="Search owned cards" placeholder="Search cards" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="Filter by rarity" value={rarity} onChange={(event) => setRarity(event.target.value)}><option value="all">All rarities</option><option value="5">5★</option><option value="4">4★</option><option value="3">3★</option></select><select aria-label="Filter by attribute" value={attribute} onChange={(event) => setAttribute(event.target.value)}><option value="all">All attributes</option><option value="cute">Cute</option><option value="pure">Pure</option><option value="happy">Happy</option></select><button className="primary-button" onClick={() => setAdding(true)}><Plus size={17} />Add card</button></div>
    {owned.length === 0 ? <EmptyState title={Object.keys(profile.cards).length ? 'No cards match these filters' : 'Your card list is empty'} action={<button className="primary-button" onClick={() => setAdding(true)}>Add card</button>} /> : <div className="owned-list">{owned.map((state) => {
      const card = catalogMap.get(state.cardId)
      return <article className="owned-card panel" key={state.cardId}>{card ? <CardIdentity card={card} compact /> : <div className="card-identity"><div className="card-gem removed">?</div><div className="identity-copy"><strong>{state.nameSnapshot}</strong><span>Removed from current catalog</span></div></div>}<div className="owned-stats"><span>Lv.<b>{state.level}</b></span><span>SP <b>{state.trainingStage || '—'}</b></span><span>Bloom <b>{state.bloomStage}/5</b></span>{card && <><Rarity value={card.rarity} /><AttributeChip attribute={card.attribute} /></>}</div><div className="row-actions">{card && <button className="icon-button" onClick={() => setEditing({ card, state })} aria-label={`Edit ${state.nameSnapshot}`}><Edit3 size={18} /></button>}<button className="icon-button danger" disabled={busy} onClick={() => void removeCard(state)} aria-label={`Remove ${state.nameSnapshot}`}><Trash2 size={18} /></button></div></article>
    })}</div>}

    {adding && !editing && <Modal title="Choose a card" onClose={() => setAdding(false)} footer={<button className="ghost-button" onClick={() => setAdding(false)}>Cancel</button>}><label className="search-box modal-search"><Search size={18} /><input autoFocus placeholder="Member or card name" value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} /></label><div className="catalog-list">{available.map((card) => <button key={card.id} onClick={() => setEditing({ card, state: defaultState(card) })}><CardIdentity card={card} compact /><span className="catalog-meta"><Rarity value={card.rarity} /><AttributeChip attribute={card.attribute} /></span></button>)}</div></Modal>}
    {editing && <CardEditor card={editing.card} initial={editing.state} onClose={() => { setEditing(null); if (!profile.cards[editing.state.cardId]) setAdding(false) }} onSave={(state) => void saveCard(state)} />}
  </section>
}
