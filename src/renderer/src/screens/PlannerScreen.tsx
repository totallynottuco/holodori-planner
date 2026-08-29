import { AlertTriangle, ArrowRight, Check, LockKeyhole, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { progressionManifest } from '@shared/manifest'
import { t, type TranslationKey } from '@shared/i18n'
import type { PlanResult, PlannerRequest } from '@shared/types'
import type { Screen } from '../App'
import { AttributeChip, CardIdentity, EmptyState, Modal, Rarity } from '../components'
import { useProfile } from '../profile-context'

const format = new Intl.NumberFormat('en-US')

export function PlannerScreen({ onNavigate }: { onNavigate(screen: Screen): void }): React.JSX.Element {
  const { profile, replace, setBusy, busy, notify } = useProfile()
  const owned = useMemo(
    () => progressionManifest.cards.filter((card) => profile.cards[card.id]).sort((a, b) => a.memberName.localeCompare(b.memberName)),
    [profile.cards]
  )
  const initialId = profile.plannerSelection.cardId && profile.cards[profile.plannerSelection.cardId]
    ? profile.plannerSelection.cardId
    : owned[0]?.id ?? ''
  const [cardId, setCardId] = useState(initialId)
  const state = profile.cards[cardId]
  const card = progressionManifest.cards.find((item) => item.id === cardId)
  const maxLevel = card ? progressionManifest.rarities[String(card.rarity) as '3' | '4' | '5'].maxLevel : 1
  const [targetLevel, setTargetLevel] = useState(
    initialId === profile.plannerSelection.cardId && profile.plannerSelection.targetLevel
      ? profile.plannerSelection.targetLevel
      : state?.level ?? 1
  )
  const [targetBloom, setTargetBloom] = useState(
    initialId === profile.plannerSelection.cardId && profile.plannerSelection.targetBloomStage !== null
      ? profile.plannerSelection.targetBloomStage
      : state?.bloomStage ?? 0
  )
  const [useStones, setUseStones] = useState(profile.plannerSelection.useBloomStones)
  const [plan, setPlan] = useState<PlanResult | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const request: PlannerRequest | null = card && state
    ? { cardId, targetLevel, targetBloomStage: targetBloom, useBloomStones: card.rarity === 5 && useStones }
    : null

  useEffect(() => {
    if (!request) {
      setPlan(null)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      void window.holodori.planner.preview(request).then((value) => {
        if (active) {
          setPlan(value)
          setPlanError(null)
        }
      }).catch((reason: unknown) => {
        if (active) {
          setPlan(null)
          setPlanError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    }, 120)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [cardId, targetLevel, targetBloom, useStones])

  const selectCard = (nextId: string): void => {
    const nextState = profile.cards[nextId]
    setCardId(nextId)
    setTargetLevel(nextState.level)
    setTargetBloom(nextState.bloomStage)
    setUseStones(false)
  }

  const apply = async (): Promise<void> => {
    if (!request || !plan?.canApply) return
    setBusy(true)
    try {
      const saved = await window.holodori.planner.apply(profile.revision, request)
      replace(saved)
      setConfirming(false)
      notify(`${plan.card.memberName} was updated.`)
    } finally {
      setBusy(false)
    }
  }

  if (owned.length === 0) {
    return <section className="screen"><EmptyState title="Add a card to start planning" action={<button className="primary-button" onClick={() => onNavigate('cards')}>Add card</button>} /></section>
  }

  return (
    <section className="screen planner-grid">
      <div className="panel selector-panel span-2">
        <label className="select-label"><span>Card</span><select value={cardId} onChange={(event) => selectCard(event.target.value)}>{owned.map((item) => <option key={item.id} value={item.id}>{item.memberName} — {item.cardName}</option>)}</select></label>
        {card && <div className="selector-meta"><Rarity value={card.rarity} /><AttributeChip attribute={card.attribute} /></div>}
      </div>

      {card && state && (
        <>
          <div className="panel current-panel">
            <div className="panel-title"><h2>Current</h2><span className="status-chip neutral">Saved</span></div>
            <CardIdentity card={card} />
            <div className="stat-strip">
              <div><span>Level</span><strong>{state.level}</strong></div>
              <div><span>SP</span><strong>{state.trainingStage || '—'}</strong></div>
              <div><span>Bloom</span><strong>{state.bloomStage}/5</strong></div>
            </div>
            {state.expIntoLevel > 0 && <div className="inline-detail"><span>Partial EXP</span><strong>{format.format(state.expIntoLevel)}</strong></div>}
            <div className="inline-detail"><span>Card Bloom Points</span><strong>{format.format(state.bloomPoints)}</strong></div>
          </div>

          <div className="panel target-panel">
            <div className="panel-title"><h2>Targets</h2>{plan && <span className={`status-chip ${plan.canApply ? 'ready' : 'short'}`}>{plan.canApply ? 'Ready' : 'Short'}</span>}</div>
            <label className="range-field"><span><b>Level</b><strong>{targetLevel}</strong></span><input aria-label="Target level" type="range" min={state.level} max={maxLevel} value={targetLevel} onChange={(event) => setTargetLevel(Number(event.target.value))} /></label>
            <div className="stepper" role="group" aria-label="Target level shortcuts">
              {[state.level, ...progressionManifest.rarities[String(card.rarity) as '3' | '4' | '5'].trainingStages.map((stage) => stage.levelCap)].filter((level, index, all) => level >= state.level && all.indexOf(level) === index).map((level) => <button key={level} className={targetLevel === level ? 'active' : ''} onClick={() => setTargetLevel(level)}>{level}</button>)}
            </div>
            <label className="range-field"><span><b>Bloom</b><strong>{targetBloom}/5</strong></span><input aria-label="Target Bloom" type="range" min={state.bloomStage} max="5" value={targetBloom} onChange={(event) => setTargetBloom(Number(event.target.value))} /></label>
            {card.rarity === 5 && <label className="toggle-row"><span><b>Use Bloom Stones</b><small>After card points</small></span><input type="checkbox" checked={useStones} onChange={(event) => setUseStones(event.target.checked)} /></label>}
          </div>

          <div className="panel requirements-panel span-2">
            <div className="panel-title"><h2>Requirements</h2>{plan && <div className="path-pill"><span>Lv.{state.level}</span><ArrowRight size={15} /><span>Lv.{plan.target.level}</span><i /><span>SP {plan.target.trainingStage || 'Base'}</span><i /><span>Bloom {plan.target.bloomStage}</span></div>}</div>
            {planError && <div className="inline-alert"><AlertTriangle size={17} />{planError}</div>}
            {plan && plan.requirements.length === 0 && <div className="all-set"><Check size={20} />This card is already at the selected targets.</div>}
            {plan && plan.requirements.length > 0 && (
              <div className="requirements-table" role="table" aria-label="Plan requirements">
                <div className="table-head" role="row"><span>Resource</span><span>Available</span><span>Required</span><span>Shortage</span></div>
                {plan.requirements.map((item) => <div className={`table-row ${item.shortage ? 'has-shortage' : ''}`} role="row" key={item.key}><strong>{t(`resource.${item.key}` as TranslationKey)}</strong><span>{format.format(item.available)}</span><span>{format.format(item.required)}</span><span>{item.shortage ? `−${format.format(item.shortage)}` : <Check size={17} aria-label="Enough" />}</span></div>)}
              </div>
            )}
            <div className="apply-row"><div>{plan && !plan.canApply && <span className="shortage-note"><LockKeyhole size={16} />Add missing resources in Inventory</span>}</div><button className="primary-button apply-button" disabled={!plan?.canApply || plan.requirements.length === 0 || busy} onClick={() => setConfirming(true)}><Sparkles size={18} />Apply plan</button></div>
          </div>
        </>
      )}

      {confirming && plan && (
        <Modal title="Apply this plan?" onClose={() => setConfirming(false)} footer={<><button className="ghost-button" onClick={() => setConfirming(false)}>Cancel</button><button className="primary-button" onClick={() => void apply()} disabled={busy}>Confirm & apply</button></>}>
          <CardIdentity card={plan.card} compact />
          <div className="confirmation-result"><span>Result</span><strong>Lv.{plan.target.level} · SP {plan.target.trainingStage || 'Base'} · Bloom {plan.target.bloomStage}/5</strong></div>
          <div className="deduction-list">{plan.requirements.map((item) => <div key={item.key}><span>{t(`resource.${item.key}` as TranslationKey)}</span><strong>−{format.format(item.required)}</strong></div>)}</div>
        </Modal>
      )}
    </section>
  )
}
