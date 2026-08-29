import { AlertTriangle, ArrowRight, Check, Edit3, LockKeyhole, RotateCcw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { progressionManifest } from '@shared/manifest'
import { t, type TranslationKey } from '@shared/i18n'
import type { AggregatePlanResult, PlanResult, SavedCardState } from '@shared/types'
import type { Screen } from '../App'
import { AttributeChip, CardThumbnail, EmptyState, MaterialIcon, Modal, NumberField, Rarity } from '../components'
import { useProfile } from '../profile-context'

const format = new Intl.NumberFormat('en-US')

function GoalEditor({ plan, onClose, onSave }: { plan: PlanResult; onClose(): void; onSave(goal: SavedCardState['goal']): void }): React.JSX.Element {
  const [goal, setGoal] = useState(plan.current.goal)
  const rules = progressionManifest.rarities[String(plan.card.rarity) as '3' | '4' | '5']
  return (
    <Modal title="Edit goal" onClose={onClose} footer={<><button className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => onSave(goal)}>Save goal</button></>}>
      <div className="goal-editor-card"><CardThumbnail card={plan.card} alt="" /><div><strong>{plan.card.memberName}</strong><span>{plan.card.cardName}</span></div></div>
      <div className="editor-grid">
        <NumberField label="Target Level" value={goal.targetLevel} min={plan.current.level} max={rules.maxLevel} onChange={(targetLevel) => setGoal((value) => ({ ...value, targetLevel }))} />
        <NumberField label="Target Bloom" value={goal.targetBloomStage} min={plan.current.bloomStage} max={5} onChange={(targetBloomStage) => setGoal((value) => ({ ...value, targetBloomStage: targetBloomStage as SavedCardState['goal']['targetBloomStage'] }))} />
      </div>
      {plan.card.rarity === 5 && <label className="toggle-row editor-toggle"><span><b>Use Bloom Stones</b></span><input type="checkbox" checked={goal.useBloomStones} onChange={(event) => setGoal((value) => ({ ...value, useBloomStones: event.target.checked }))} /></label>}
      <button className="text-button reset-goal" onClick={() => setGoal({ targetLevel: plan.current.level, targetBloomStage: plan.current.bloomStage, useBloomStones: false })}><RotateCcw size={15} />Reset to current</button>
    </Modal>
  )
}

function RequirementCard({ item }: { item: AggregatePlanResult['requirements'][number] }): React.JSX.Element {
  return (
    <article className={`requirement-card ${item.shortage ? 'has-shortage' : 'ready'}`}>
      <MaterialIcon resource={item.key} />
      <div><strong>{t(`resource.${item.key}` as TranslationKey)}</strong><span>{format.format(item.available)} owned</span></div>
      <div className="requirement-numbers"><b>{format.format(item.required)}</b><small>{item.shortage ? `${format.format(item.shortage)} short` : 'Ready'}</small></div>
    </article>
  )
}

export function PlannerScreen({ onNavigate }: { onNavigate(screen: Screen): void }): React.JSX.Element {
  const { profile, save, replace, setBusy, busy, notify } = useProfile()
  const [aggregate, setAggregate] = useState<AggregatePlanResult | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [editing, setEditing] = useState<PlanResult | null>(null)
  const [confirming, setConfirming] = useState<{ kind: 'card'; plan: PlanResult } | { kind: 'all' } | null>(null)

  useEffect(() => {
    let active = true
    void window.holodori.planner.preview().then((value) => {
      if (active) {
        setAggregate(value)
        setPlanError(null)
      }
    }).catch((reason: unknown) => {
      if (active) setPlanError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [profile.revision])

  const saveGoal = async (plan: PlanResult, goal: SavedCardState['goal']): Promise<void> => {
    const state = profile.cards[plan.card.id]
    await save({ ...profile, cards: { ...profile.cards, [plan.card.id]: { ...state, goal } }, plannerSelection: { cardId: plan.card.id } })
    setEditing(null)
    notify('Goal saved.')
  }

  const applyCard = async (plan: PlanResult): Promise<void> => {
    setBusy(true)
    try {
      replace(await window.holodori.planner.applyCard(profile.revision, plan.card.id))
      setConfirming(null)
      notify(`${plan.card.memberName} was updated.`)
    } catch (reason) {
      setPlanError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  const applyAll = async (): Promise<void> => {
    setBusy(true)
    try {
      replace(await window.holodori.planner.applyAll(profile.revision))
      setConfirming(null)
      notify('All planned cards were updated.')
    } catch (reason) {
      setPlanError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  if (Object.keys(profile.cards).length === 0) {
    return <section className="screen"><EmptyState title="Add a card to start planning" action={<button className="primary-button" onClick={() => onNavigate('characters')}>Add cards</button>} /></section>
  }
  if (!aggregate) return <section className="screen"><div className="planner-loading">Calculating plans…</div></section>
  if (aggregate.plans.length === 0) {
    return <section className="screen"><EmptyState title="No active goals" action={<button className="primary-button" onClick={() => onNavigate('characters')}>Set a goal</button>} /></section>
  }

  const confirmationPlans = confirming?.kind === 'card' ? [confirming.plan] : aggregate.plans
  const confirmationRequirements = confirming?.kind === 'card' ? confirming.plan.requirements : aggregate.requirements

  return (
    <section className="screen aggregate-planner">
      {planError && <div className="inline-alert planner-error"><AlertTriangle size={17} />{planError}</div>}
      <div className="planner-summary panel">
        <div className="summary-heading"><div><span className="section-kicker">Active goals</span><strong>{aggregate.plans.length} {aggregate.plans.length === 1 ? 'card' : 'cards'}</strong></div><span className={`status-chip ${aggregate.canApplyAll ? 'ready' : 'short'}`}>{aggregate.canApplyAll ? 'All ready' : 'Resources short'}</span></div>
        <div className="aggregate-requirements">{aggregate.requirements.map((item) => <RequirementCard item={item} key={item.key} />)}</div>
        <div className="summary-actions"><button className="ghost-button" onClick={() => onNavigate('inventory')}>Edit inventory</button><button className="primary-button" disabled={!aggregate.canApplyAll || busy} onClick={() => setConfirming({ kind: 'all' })}><Sparkles size={17} />Apply all</button></div>
      </div>

      <div className="planned-card-list">
        {aggregate.plans.map((plan) => (
          <article className={`planned-card panel ${plan.canApply ? 'ready' : 'short'}`} key={plan.card.id}>
            <CardThumbnail card={plan.card} alt={`${plan.card.memberName} — ${plan.card.cardName}`} className="planned-card-image" />
            <div className="planned-card-main">
              <div className="planned-card-title"><div><strong>{plan.card.memberName}</strong><span>{plan.card.cardName}</span></div><div><Rarity value={plan.card.rarity} /><AttributeChip attribute={plan.card.attribute} /></div></div>
              <div className="plan-path"><span>Lv.{plan.current.level}</span><ArrowRight size={14} /><b>Lv.{plan.target.level}</b><i /><span>SP {plan.current.trainingStage || 'Base'}</span><ArrowRight size={14} /><b>SP {plan.target.trainingStage || 'Base'}</b><i /><span>Bloom {plan.current.bloomStage}</span><ArrowRight size={14} /><b>Bloom {plan.target.bloomStage}</b></div>
              <div className="plan-resources">{plan.requirements.map((item) => <span className={item.shortage ? 'short' : ''} key={item.key} title={t(`resource.${item.key}` as TranslationKey)}><MaterialIcon resource={item.key} />{format.format(item.required)}{item.shortage > 0 && <em>−{format.format(item.shortage)}</em>}</span>)}</div>
            </div>
            <div className="planned-card-actions"><span className={`status-chip ${plan.canApply ? 'ready' : 'short'}`}>{plan.canApply ? <><Check size={13} />Ready</> : <><LockKeyhole size={13} />Short</>}</span><button className="ghost-button compact" onClick={() => setEditing(plan)}><Edit3 size={14} />Goal</button><button className="primary-button compact" disabled={!plan.canApply || busy} onClick={() => setConfirming({ kind: 'card', plan })}>Apply</button></div>
          </article>
        ))}
      </div>

      {editing && <GoalEditor plan={editing} onClose={() => setEditing(null)} onSave={(goal) => void saveGoal(editing, goal)} />}
      {confirming && (
        <Modal title={confirming.kind === 'all' ? `Apply ${confirmationPlans.length} plans?` : 'Apply this plan?'} onClose={() => setConfirming(null)} footer={<><button className="ghost-button" onClick={() => setConfirming(null)}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void (confirming.kind === 'all' ? applyAll() : applyCard(confirming.plan))}>Confirm & apply</button></>}>
          <div className="confirmation-cards">{confirmationPlans.map((plan) => <div key={plan.card.id}><CardThumbnail card={plan.card} alt="" /><span><strong>{plan.card.memberName}</strong><small>Lv.{plan.target.level} · SP {plan.target.trainingStage || 'Base'} · Bloom {plan.target.bloomStage}</small></span></div>)}</div>
          <div className="deduction-list">{confirmationRequirements.map((item) => <div key={item.key}><span><MaterialIcon resource={item.key} />{t(`resource.${item.key}` as TranslationKey)}</span><strong>−{format.format(item.required)}</strong></div>)}</div>
        </Modal>
      )}
    </section>
  )
}
