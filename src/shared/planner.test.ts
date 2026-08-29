import { progressionManifest } from './manifest'
import { applyPlan, calculatePlan, minimumTrainingStage, normalizeCardState } from './planner'
import { createDefaultProfile } from './profile'
import type { CardCatalogEntry, SavedCardState } from './types'

const manifest = progressionManifest

function card(rarity: 3 | 4 | 5, attribute: 'cute' | 'pure' | 'happy' = 'cute'): CardCatalogEntry {
  const result = manifest.cards.find((item) => item.rarity === rarity && item.attribute === attribute)
  if (!result) throw new Error('Test card not found')
  return result
}

function profileWith(target: CardCatalogEntry, state?: Partial<SavedCardState>) {
  const profile = createDefaultProfile(manifest.metadata.catalogVersion)
  profile.cards[target.id] = {
    cardId: target.id,
    nameSnapshot: `${target.memberName} — ${target.cardName}`,
    level: 1,
    expIntoLevel: 0,
    trainingStage: 0,
    bloomStage: 0,
    bloomPoints: 0,
    ...state
  }
  return profile
}

describe('progression calculator', () => {
  it.each([
    [3, 60, 404_150],
    [4, 70, 661_650],
    [5, 80, 1_122_650]
  ] as const)('calculates canonical %s★ maximum EXP', (rarity, level, expected) => {
    const target = card(rarity)
    const plan = calculatePlan(profileWith(target), { cardId: target.id, targetLevel: level, targetBloomStage: 0, useBloomStones: false }, manifest)
    expect(plan.experienceRequired).toBe(expected)
  })

  it.each([
    [3, [20, 30, 40, 50, 60], [0, 1, 2, 3, 4]],
    [4, [30, 40, 50, 60, 70], [0, 1, 2, 3, 4]],
    [5, [40, 50, 60, 70, 80], [0, 1, 2, 3, 4]]
  ] as const)('uses every %s★ SP gate', (rarity, levels, stages) => {
    const target = card(rarity)
    levels.forEach((level, index) => expect(minimumTrainingStage(target, level, manifest)).toBe(stages[index]))
  })

  it.each([
    [3, 1_300, 300, 0, 400_000],
    [4, 2_000, 700, 1, 700_000],
    [5, 900, 1_950, 4, 1_500_000]
  ] as const)('totals all %s★ SP materials', (rarity, beads, crystals, hololium, hologold) => {
    const target = card(rarity, 'pure')
    const profile = profileWith(target)
    Object.keys(profile.inventory).forEach((key) => { profile.inventory[key as keyof typeof profile.inventory] = 10_000_000 })
    const rules = manifest.rarities[String(rarity) as '3' | '4' | '5']
    const plan = calculatePlan(profile, { cardId: target.id, targetLevel: rules.maxLevel, targetBloomStage: 0, useBloomStones: false }, manifest)
    const required = Object.fromEntries(plan.requirements.map((item) => [item.key, item.required]))
    expect(required.pureBeads).toBe(beads)
    expect(required.pureCrystals).toBe(crystals)
    expect(required.hololium ?? 0).toBe(hololium)
    expect(required.hologold).toBe(hologold)
    expect(required.cuteBeads).toBeUndefined()
  })

  it('subtracts partial EXP from the exact cumulative target', () => {
    const target = card(5)
    const profile = profileWith(target, { level: 20, expIntoLevel: 750 })
    const plan = calculatePlan(profile, { cardId: target.id, targetLevel: 21, targetBloomStage: 0, useBloomStones: false }, manifest)
    expect(plan.experienceRequired).toBe(1_350)
  })

  it('automatically raises an impossible SP stage and clears EXP at max level', () => {
    const target = card(3)
    const normalized = normalizeCardState(profileWith(target).cards[target.id] = { ...profileWith(target).cards[target.id], level: 60, expIntoLevel: 99 }, target, manifest)
    expect(normalized.trainingStage).toBe(4)
    expect(normalized.expIntoLevel).toBe(0)
  })

  it('spends 5★ card points before optional Bloom Stones', () => {
    const target = card(5)
    const profile = profileWith(target, { bloomPoints: 2 })
    profile.inventory.bloomStones = 3
    const plan = calculatePlan(profile, { cardId: target.id, targetLevel: 1, targetBloomStage: 5, useBloomStones: true }, manifest)
    expect(plan.bloomPointsSpent).toBe(2)
    expect(plan.bloomStonesSpent).toBe(3)
    expect(plan.canApply).toBe(true)
    const applied = applyPlan(profile, plan)
    expect(applied.cards[target.id].bloomStage).toBe(5)
    expect(applied.cards[target.id].bloomPoints).toBe(0)
    expect(applied.inventory.bloomStones).toBe(0)
  })

  it('never permits Bloom Stones on 3★ or 4★ cards', () => {
    const target = card(4)
    expect(() => calculatePlan(profileWith(target), { cardId: target.id, targetLevel: 1, targetBloomStage: 1, useBloomStones: true }, manifest)).toThrow(/only be used on 5/)
  })

  it('reports shortages and blocks deductions', () => {
    const target = card(5)
    const plan = calculatePlan(profileWith(target), { cardId: target.id, targetLevel: 80, targetBloomStage: 0, useBloomStones: false }, manifest)
    expect(plan.canApply).toBe(false)
    expect(plan.requirements.find((item) => item.key === 'lessonPoints')?.shortage).toBe(1_122_650)
    expect(() => applyPlan(profileWith(target), plan)).toThrow(/shortages/)
  })
})
