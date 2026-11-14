import type { CardCatalogEntry, CardAnimationPreference, SavedCardState } from './types'

export interface EffectiveCardAnimations {
  animation: boolean
  signature: boolean
}

function resolvePreference(preference: CardAnimationPreference, defaultEnabled: boolean): boolean {
  if (preference === 'on') return true
  if (preference === 'off') return false
  return defaultEnabled
}

export function effectiveCardAnimations(
  card: CardCatalogEntry,
  state: SavedCardState,
  defaultEnabled: boolean
): EffectiveCardAnimations {
  if (!card.animation) return { animation: false, signature: false }
  return {
    animation: resolvePreference(state.artworkPreferences.animation, defaultEnabled),
    signature: resolvePreference(state.artworkPreferences.signature, defaultEnabled)
  }
}
