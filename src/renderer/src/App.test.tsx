// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { progressionManifest } from '@shared/manifest'
import { applyPlan, calculatePlan } from '@shared/planner'
import { createDefaultProfile } from '@shared/profile'
import type { AppProfileV1, UpdateStatus } from '@shared/types'
import type { HolodoriApi } from '@shared/api'
import { App } from './App'

function installApi(initial: AppProfileV1): { api: HolodoriApi; current(): AppProfileV1 } {
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
      preview: vi.fn(async (request) => calculatePlan(profile, request, progressionManifest)),
      apply: vi.fn(async (expected, request) => {
        if (expected !== profile.revision) throw new Error('stale')
        profile = applyPlan(profile, calculatePlan(profile, request, progressionManifest))
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
      getInfo: vi.fn(async () => ({ version: '0.1.0', catalogVersion: progressionManifest.metadata.catalogVersion, profilePath: 'C:\\AppData\\holodori Planner\\profile.json', isPackaged: false, projectUrl: 'https://github.com/totallynottuco/holodori-planner' })),
      openProjectPage: vi.fn(async () => undefined)
    }
  }
  Object.defineProperty(window, 'holodori', { configurable: true, value: api })
  return { api, current: () => profile }
}

describe('renderer flows', () => {
  it('adds a card on first run and persists it', async () => {
    const user = userEvent.setup()
    const harness = installApi(createDefaultProfile(progressionManifest.metadata.catalogVersion))
    render(<App />)
    expect(await screen.findByText('Add a card to start planning')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cards' }))
    await user.click(screen.getAllByRole('button', { name: 'Add card' })[0])
    const first = progressionManifest.cards[0]
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: new RegExp(first.cardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }))
    await user.click(screen.getByRole('button', { name: 'Save card' }))
    await waitFor(() => expect(harness.current().cards[first.id]).toBeDefined())
    expect(screen.getByText('Card saved.')).toBeInTheDocument()
  })

  it('edits and saves inventory', async () => {
    const user = userEvent.setup()
    const harness = installApi(createDefaultProfile(progressionManifest.metadata.catalogVersion))
    render(<App />)
    await screen.findByText('Add a card to start planning')
    await user.click(screen.getByRole('button', { name: 'Inventory' }))
    const hologold = screen.getByLabelText('Hologold')
    await user.clear(hologold)
    await user.type(hologold, '125000')
    await user.click(screen.getByRole('button', { name: 'Save inventory' }))
    await waitFor(() => expect(harness.current().inventory.hologold).toBe(125_000))
  })

  it('blocks a short plan and applies a funded plan after confirmation', async () => {
    const user = userEvent.setup()
    const target = progressionManifest.cards.find((card) => card.rarity === 3)!
    const base = createDefaultProfile(progressionManifest.metadata.catalogVersion)
    base.cards[target.id] = { cardId: target.id, nameSnapshot: `${target.memberName} — ${target.cardName}`, level: 1, expIntoLevel: 0, trainingStage: 0, bloomStage: 0, bloomPoints: 0 }
    const shortHarness = installApi(base)
    const firstRender = render(<App />)
    await screen.findByText(target.memberName)
    fireEvent.change(screen.getByLabelText('Target level'), { target: { value: '60' } })
    await screen.findByText('Add missing resources in Inventory')
    expect(screen.getByRole('button', { name: 'Apply plan' })).toBeDisabled()
    firstRender.unmount()

    const funded = structuredClone(base)
    Object.keys(funded.inventory).forEach((key) => { funded.inventory[key as keyof typeof funded.inventory] = 10_000_000 })
    const fundedHarness = installApi(funded)
    render(<App />)
    await screen.findByText(target.memberName)
    fireEvent.change(screen.getByLabelText('Target level'), { target: { value: '60' } })
    const apply = await screen.findByRole('button', { name: 'Apply plan' })
    await waitFor(() => expect(apply).toBeEnabled())
    await user.click(apply)
    expect(screen.getByText('Apply this plan?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm & apply' }))
    await waitFor(() => expect(fundedHarness.current().cards[target.id].level).toBe(60))
    expect(shortHarness.current().cards[target.id].level).toBe(1)
  })
})
