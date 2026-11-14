import { LIVE_SCORE_CLIENT } from './live-score'
import { REVIEWED_CHART_PACK, type OptimizerDecodedChart } from './optimizer-chart-pack'
import type { ScoringData, ScoringTrigger } from './scoring-data'
import type { Resolution, SkillReport } from './team-parameters'
import type { VerifiedChartDenominators } from './chart-denominators'

/** See docs/live-score-client.md#life-during-ap-and-full-combo. Board LIFE UP
 * can increase the maximum: 1000 is a lower bound, not the team's exact LIFE. */
export const LIVE_LIFE_RULES = Object.freeze({
  version: 'android-1.1.0-ap-fc-life-v1', minimumStartingLife: 1000,
  scope: 'manual-PERFECT-or-GREAT-only', state: 'remains-at-starting-maximum',
  sourceCommit: LIVE_SCORE_CLIENT.sourceCommit, settingSha256: LIVE_SCORE_CLIENT.settingSha256,
  liveNoteSha256: LIVE_SCORE_CLIENT.liveNoteSha256
})

const unresolved = <T>(reasons: string[]): Resolution<T> => ({ status: 'unresolved', value: null, reasons })
const resolved = <T>(value: T): Resolution<T> => ({ status: 'resolved', value })

/** Called only by the manual AP / restricted FC model, with verified inputs.
 * Unknown future charts/effects must not silently inherit the no-damage rule. */
export function resolveLiveLife(chart: OptimizerDecodedChart, skills: SkillReport[], data: ScoringData, identity?: VerifiedChartDenominators['identity']) {
  const reasons: string[] = []
  const commit=identity?.sourceCommit ?? LIVE_LIFE_RULES.sourceCommit
  if (chart.identity.sourceCommit !== commit
    || data.metadata.sourceCommit !== commit
    || chart.identity.indexSha256 !== (identity?.chartIndexSha256 ?? REVIEWED_CHART_PACK.indexSha256)
    || chart.identity.eventBlobSha256 !== (identity?.chartBlobSha256 ?? REVIEWED_CHART_PACK.eventBlobSha256)) reasons.push('LIFE rule requires the reviewed chart corpus and source')
  if (chart.eventNoteTypes.some(type => type < 1 || type > 7)) reasons.push('LIFE loss for this note type is unreviewed')
  for (const skill of skills.filter(row => row.kind === 'active' || row.kind === 'special')) {
    for (const branch of skill.branches) {
      const effects = data.activeEffects[branch.effectGroupId]
      if (!effects || effects.some(effect => !['SCORE_UP_PERMIL_UP', 'JUDGEMENT_ENHANCE', 'LIFE_RECOVERY', 'SCORE_UP_EFFECT_UP_PERMIL_UP', 'LIVE_ACTIVE_SKILL_ACTIVATION_PROBABILITY_UP_PERMIL_UP'].includes(effect.type)
        || !Number.isSafeInteger(effect.value) || effect.value < 0)) reasons.push(`Unreviewed LIFE impact: ${branch.effectGroupId}`)
    }
  }
  const minimum = reasons.length ? unresolved<number>([...new Set(reasons)]) : resolved(LIVE_LIFE_RULES.minimumStartingLife)
  const conditions = skills.filter(skill => skill.kind === 'active' || skill.kind === 'special').flatMap(skill => skill.branches.flatMap(branch =>
    (branch.triggerGroupId ? data.triggers[branch.triggerGroupId] ?? [] : []).filter(trigger => trigger.type === 'LIFE_GTE' || trigger.type === 'LIFE_LTE').map(trigger => ({
      ownerId: skill.ownerId, skillId: skill.skillId, skillKind: skill.kind, branchKind: branch.kind, triggerGroupId: branch.triggerGroupId!,
      description: trigger.description, result: resolveLifeCondition(trigger, minimum)
    }))))
  return { rules: { ...LIVE_LIFE_RULES }, minimum, conditions,
    recovery: minimum.status === 'resolved' ? 'Healing is capped at the starting maximum and cannot change LIFE in this play scope' : 'LIFE recovery impact unresolved' }
}

export function resolveLifeCondition(trigger: ScoringTrigger, minimum: Resolution<number>): Resolution<boolean> {
  if (minimum.status === 'unresolved') return unresolved(minimum.reasons)
  if (trigger.type === 'LIFE_GTE' && trigger.threshold <= minimum.value) return resolved(true)
  if (trigger.type === 'LIFE_LTE' && trigger.threshold < minimum.value) return resolved(false)
  // Higher gates, including LIFE <= 1000, require the actual Board LIFE bonus.
  return unresolved(['Exact starting LIFE, including Board LIFE UP, is required for this threshold'])
}
