// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { progressionManifest } from '@shared/manifest'
import { applyAggregatePlan, applyPlan, calculateAggregatePlan, calculateGoalPlan } from '@shared/planner'
import { createDefaultCardState, createDefaultProfile } from '@shared/profile'
import type { AppProfileV2, UpdateStatus } from '@shared/types'
import type { HolodoriApi } from '@shared/api'
import { App } from './App'

function installApi(initial: AppProfileV2): { api: HolodoriApi; current(): AppProfileV2 } {
  let profile = structuredClone(initial)
  const api: HolodoriApi = {
    profile: {
      load: vi.fn(async () => ({ profile: structuredClone(profile), recoveryNotice: null })),
      save: vi.fn(async (expected, candidate) => {
        if (expected !== profile.revision) throw new Error('stale')
        profile = { ...structuredClone(candidate), revision: expected + 1 }
        return structuredClone(profile)
      }),
      export: vi.fn(async () => ({ canceled: false, path: 'backup.json' })),
      importPreview: vi.fn(async () => null),
      importCommit: vi.fn(async () => structuredClone(profile))
    },
    planner: {
      preview: vi.fn(async () => calculateAggregatePlan(profile, progressionManifest)),
      applyCard: vi.fn(async (expected, cardId) => {
        if (expected !== profile.revision) throw new Error('stale')
        profile = applyPlan(profile, calculateGoalPlan(profile, cardId, progressionManifest))
        return structuredClone(profile)
      }),
      applyAll: vi.fn(async (expected) => {
        if (expected !== profile.revision) throw new Error('stale')
        profile = applyAggregatePlan(profile, calculateAggregatePlan(profile, progressionManifest))
        return structuredClone(profile)
      })
    },
    updates: {
      check: vi.fn(async () => undefined),
      download: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
      onStatus: vi.fn((_callback: (status: UpdateStatus) => void) => () => undefined)
    },
    app: {
      getInfo: vi.fn(async () => ({ version: '0.2.0', catalogVersion: progressionManifest.metadata.catalogVersion, profilePath: 'C:\\AppData\\holodori Planner\\profile.json', isPackaged: false, projectUrl: 'https://github.com/totallynottuco/holodori-planner', gpu: { mode: 'hardware-required' as const, device: '0x10de:0x2684', features: { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled', webgl2: 'enabled' } } })),
      openProjectPage: vi.fn(async () => undefined)
    }
  }
  Object.defineProperty(window, 'holodori', { configurable: true, value: api })
  return { api, current: () => profile }
}

function trackedCard(cardId: string): AppProfileV2 {
  const card = progressionManifest.cards.find((item) => item.id === cardId)!
  const profile = createDefaultProfile(progressionManifest.metadata.catalogVersion)
  profile.cards[card.id] = createDefaultCardState(card.id, `${card.memberName} — ${card.cardName}`)
  return profile
}

describe('renderer flows', () => {
  it('exposes and adds the final card in the complete catalog', async () => {
    const user = userEvent.setup()
    const harness = installApi(createDefaultProfile(progressionManifest.metadata.catalogVersion))
    render(<App />)
    expect(await screen.findByText('Add a card to start planning')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Characters' }))
    await user.click(screen.getAllByRole('button', { name: 'Add cards' })[0])
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/178 available/)).toBeInTheDocument()
    const last = progressionManifest.cards.at(-1)!
    await user.type(within(dialog).getByLabelText('Search card catalog'), `${last.memberName} ${last.cardName}`)
    await user.click(within(dialog).getByRole('button', { name: new RegExp(`${last.memberName}.*${last.cardName}`) }))
    await user.click(screen.getByRole('button', { name: 'Save card' }))
    await waitFor(() => expect(harness.current().cards[last.id]).toBeDefined())
    expect(harness.current().cards[last.id].goal).toEqual({ targetLevel: 1, targetBloomStage: 0, useBloomStones: false })
  })

  it('filters inventory groups and saves direct numeric edits', async () => {
    const user = userEvent.setup()
    const harness = installApi(createDefaultProfile(progressionManifest.metadata.catalogVersion))
    render(<App />)
    await screen.findByText('Add a card to start planning')
    await user.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Inventory' }))
    await user.click(screen.getByRole('tab', { name: 'General' }))
    expect(screen.queryByLabelText('Cute Beads')).not.toBeInTheDocument()
    const hologold = screen.getByLabelText('Hologold')
    await user.clear(hologold)
    await user.type(hologold, '125000')
    await user.click(screen.getByRole('button', { name: 'Save inventory' }))
    await waitFor(() => expect(harness.current().inventory.hologold).toBe(125_000))
  })

  it('blocks a short goal and applies a funded card after confirmation', async () => {
    const user = userEvent.setup()
    const target = progressionManifest.cards.find((card) => card.rarity === 3)!
    const base = trackedCard(target.id)
    base.cards[target.id].goal.targetLevel = 60
    const shortHarness = installApi(base)
    const firstRender = render(<App />)
    await screen.findByText(target.memberName)
    expect(screen.getByRole('button', { name: 'Apply all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    firstRender.unmount()

    const funded = structuredClone(base)
    Object.keys(funded.inventory).forEach((key) => { funded.inventory[key as keyof typeof funded.inventory] = 10_000_000 })
    const fundedHarness = installApi(funded)
    render(<App />)
    await screen.findByText(target.memberName)
    await user.click(await screen.findByRole('button', { name: 'Apply' }))
    expect(screen.getByText('Apply this plan?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }))
    await waitFor(() => expect(fundedHarness.current().cards[target.id].level).toBe(60))
    expect(shortHarness.current().cards[target.id].level).toBe(1)
  })

  it('cancels and then applies an affordable aggregate plan', async () => {
    const user = userEvent.setup()
    const first = progressionManifest.cards.find((card) => card.rarity === 3)!
    const second = progressionManifest.cards.find((card) => card.rarity === 4)!
    const profile = trackedCard(first.id)
    profile.cards[first.id].goal.targetLevel = 20
    profile.cards[second.id] = createDefaultCardState(second.id, `${second.memberName} — ${second.cardName}`)
    profile.cards[second.id].goal.targetLevel = 30
    Object.keys(profile.inventory).forEach((key) => { profile.inventory[key as keyof typeof profile.inventory] = 10_000_000 })
    const harness = installApi(profile)
    render(<App />)
    await screen.findByText('2 cards')
    await user.click(screen.getByRole('button', { name: 'Apply all' }))
    expect(screen.getByText('Apply 2 plans?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(harness.current().cards[first.id].level).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Apply all' }))
    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }))
    await waitFor(() => expect(harness.current().cards[second.id].level).toBe(30))
    expect(harness.current().revision).toBe(1)
  })
})
