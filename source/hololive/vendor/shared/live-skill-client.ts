import { exactFraction } from './chart-timeline'
export { advanceClientSkillCheck, clientActivationProbability, clientActiveCooldown, clientSkillScoreRatio, type ClientScoreEffect } from './live-skill-arithmetic'

const F = Math.fround

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
