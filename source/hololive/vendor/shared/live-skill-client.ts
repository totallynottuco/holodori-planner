import { exactFraction } from './chart-timeline'

/** Android 1.1.0 ActiveSkillEffectDataCollection / LiveActiveSkillData.
 * See docs/live-score-client.md for method addresses and binary identity.
 * Inputs describe effects already admitted by the trigger/activation engine.
 */
const F = Math.fround
const MAX = 2_147_483_647
function integer(value: number, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX) throw new Error(`Invalid ${label}`)
}
function coefficient(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > MAX) throw new Error('Invalid client skill coefficient')
  return F(value)
}
const permil = (value: number) => F(coefficient(value) / 1000)
function maximum(values: readonly number[]) {
  return values.reduce((result, value) => Math.max(result, coefficient(value)), 0)
}

/** Exact serialization of an already rounded client float32, not a replacement
 * of the client's float arithmetic with rational arithmetic.
 */
export function clientFloatFraction(value: number) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(F(value))) throw new Error('Invalid client float')
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  const bits = view.getUint32(0), exponent = (bits >>> 23) & 255
  const mantissa = BigInt((bits & 0x7fffff) + (exponent ? 0x800000 : 0))
  const shift = exponent ? exponent - 150 : -149
  return shift >= 0 ? exactFraction(mantissa << BigInt(shift), 1n) : exactFraction(mantissa, 1n << BigInt(-shift))
}

export function clientActivationProbability(basePermil: number, cardUpPermil: number, activeUpPermil: readonly number[], specialUpPermil: readonly number[]) {
  integer(basePermil, 'base activation probability')
  if (basePermil > 1000) throw new Error('Invalid base activation probability')
  const boostPermil = F(F(F(1000 + maximum(activeUpPermil)) + maximum(specialUpPermil)) + coefficient(cardUpPermil))
  const raw = F(F(boostPermil * F(basePermil)) / 1000)
  const effectivePermil = Math.trunc(raw)
  integer(effectivePermil, 'adjusted activation probability')
  // The client compares NextDouble() <= FloatFromPermil(effectivePermil).
  // This is the threshold, not a claim about PRNG independence/finite sampling.
  const lotteryThreshold = permil(effectivePermil)
  return { effectivePermil, lotteryThreshold, bernoulliProbability: Math.min(1, lotteryThreshold) }
}

export function clientActiveCooldown(baseMilliseconds: number, cardUpPermil: number, activeUpPermil: readonly number[] = [], specialUpPermil: readonly number[] = []) {
  integer(baseMilliseconds, 'Active cooldown', 1)
  const divisor = F(permil(cardUpPermil) + F(F(1 + permil(maximum(activeUpPermil))) + permil(maximum(specialUpPermil))))
  const milliseconds = Math.floor(F(F(baseMilliseconds) / divisor))
  integer(milliseconds, 'adjusted Active cooldown', 1)
  return { milliseconds, seconds: permil(milliseconds) }
}

/** SetNextSkillActivationCheckTime adds to the previous scheduled time, even
 * after a failed check. The caller supplies any freshly resolved cooldown.
 */
export function advanceClientSkillCheck(previousSeconds: number, cooldownSeconds: number) {
  const previous = coefficient(previousSeconds), interval = coefficient(cooldownSeconds)
  const next = F(previous + interval)
  if (!Number.isFinite(next) || next <= previous) throw new Error('Client skill schedule cannot advance')
  return next
}

export interface ClientScoreEffect {
  category: 'active' | 'special'
  scoreUpPermil: number
  cardSupportPermil: number
}

/** Supported maxima are selected separately for Active and SP, then added.
 * Overlapping support effects also use one maximum per category.
 */
export function clientSkillScoreRatio(effects: readonly ClientScoreEffect[], activeSupportPermil: readonly number[], specialSupportPermil: readonly number[]) {
  const supportRatio = F(permil(maximum(specialSupportPermil)) + permil(maximum(activeSupportPermil)))
  let active = 0, special = 0
  for (const effect of effects) {
    if (effect.category !== 'active' && effect.category !== 'special') throw new Error('Invalid skill category')
    const factor = F(F(supportRatio + permil(effect.cardSupportPermil)) + 1)
    const strength = F(factor * permil(effect.scoreUpPermil))
    if (!Number.isFinite(strength)) throw new Error('Skill strength exceeds the client range')
    if (effect.category === 'active') active = Math.max(active, strength)
    else special = Math.max(special, strength)
  }
  const total = F(special + active)
  if (!Number.isFinite(total)) throw new Error('Combined skill strength exceeds the client range')
  return { active, special, total }
}
