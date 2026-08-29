import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { progressionManifest } from '@shared/manifest'
import { createDefaultProfile } from '@shared/profile'
import { ProfileStore } from './profile-store'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'holodori-planner-test-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileStore', () => {
  it('creates and round-trips defaults through an atomic profile file', async () => {
    const directory = await temporaryDirectory()
    const store = new ProfileStore(directory, progressionManifest)
    const loaded = await store.load()
    expect(loaded.profile.schemaVersion).toBe(2)
    expect(loaded.profile.revision).toBe(0)
    expect(JSON.parse(await readFile(store.profilePath, 'utf8'))).toEqual(loaded.profile)
  })

  it('increments revisions, writes backups, and rejects stale changes', async () => {
    const directory = await temporaryDirectory()
    const store = new ProfileStore(directory, progressionManifest)
    const initial = (await store.load()).profile
    initial.inventory.hologold = 123
    const saved = await store.save(0, initial)
    expect(saved.revision).toBe(1)
    expect(JSON.parse(await readFile(store.backupPath, 'utf8')).revision).toBe(0)
    await expect(store.save(0, saved)).rejects.toThrow(/changed in another window/)
  })

  it('recovers a corrupt primary from backup and preserves the corrupt file', async () => {
    const directory = await temporaryDirectory()
    const first = new ProfileStore(directory, progressionManifest)
    const initial = (await first.load()).profile
    initial.inventory.lessonPoints = 500
    await first.save(0, initial)
    await writeFile(first.profilePath, '{broken', 'utf8')

    const recovered = await new ProfileStore(directory, progressionManifest).load()
    expect(recovered.profile.revision).toBe(0)
    expect(recovered.recoveryNotice).toMatch(/backup was restored/)
    expect((await readdir(directory)).some((name) => name.startsWith('profile.json.corrupt-'))).toBe(true)
  })

  it('preserves both corrupt files and starts clean when recovery fails', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'profile.json'), 'bad primary', 'utf8')
    await writeFile(join(directory, 'profile.json.bak'), 'bad backup', 'utf8')
    const loaded = await new ProfileStore(directory, progressionManifest).load()
    expect(loaded.profile.revision).toBe(0)
    expect(loaded.recoveryNotice).toMatch(/could not be recovered/)
    const files = await readdir(directory)
    expect(files.filter((name) => name.includes('.corrupt-'))).toHaveLength(2)
  })

  it('previews and commits a validated replacement import', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = join(directory, 'backup.json')
    const store = new ProfileStore(directory, progressionManifest)
    await store.load()
    const imported = createDefaultProfile(progressionManifest.metadata.catalogVersion)
    imported.inventory.hololium = 9
    await writeFile(sourcePath, JSON.stringify(imported), 'utf8')
    const preview = await store.previewImport(sourcePath)
    expect(preview.summary.inventoryUnits).toBe(9)
    const committed = await store.commitImport(preview.token, 0)
    expect(committed.inventory.hololium).toBe(9)
    expect(committed.revision).toBe(1)
  })

  it('rejects invalid imports and unknown profile schemas', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = join(directory, 'invalid.json')
    const store = new ProfileStore(directory, progressionManifest)
    await store.load()
    await writeFile(sourcePath, JSON.stringify({ schemaVersion: 99 }), 'utf8')
    await expect(store.previewImport(sourcePath)).rejects.toThrow(/Unsupported profile schema/)
  })

  it('keeps fallback labels for catalog entries removed after a release', async () => {
    const directory = await temporaryDirectory()
    const removed = progressionManifest.cards[0]
    const oldProfile = createDefaultProfile('older-catalog')
    oldProfile.cards[removed.id] = {
      cardId: removed.id,
      nameSnapshot: `${removed.memberName} — ${removed.cardName}`,
      level: 1,
      expIntoLevel: 0,
      trainingStage: 0,
      bloomStage: 0,
      bloomPoints: 0,
      goal: { targetLevel: 1, targetBloomStage: 0, useBloomStones: false }
    }
    await writeFile(join(directory, 'profile.json'), JSON.stringify(oldProfile), 'utf8')
    const newerManifest = structuredClone(progressionManifest)
    newerManifest.cards = newerManifest.cards.filter((card) => card.id !== removed.id)
    const loaded = await new ProfileStore(directory, newerManifest).load()
    expect(loaded.profile.cards[removed.id].nameSnapshot).toContain(removed.memberName)
  })

  it('migrates v1 cards and preserves the selected planner target', async () => {
    const directory = await temporaryDirectory()
    const selected = progressionManifest.cards.find((card) => card.rarity === 5)!
    const legacy = {
      schemaVersion: 1,
      revision: 7,
      catalogVersionLastSeen: 'legacy',
      inventory: createDefaultProfile('legacy').inventory,
      cards: {
        [selected.id]: {
          cardId: selected.id,
          nameSnapshot: `${selected.memberName} — ${selected.cardName}`,
          level: 12,
          expIntoLevel: 0,
          trainingStage: 0,
          bloomStage: 1,
          bloomPoints: 2
        }
      },
      plannerSelection: {
        cardId: selected.id,
        targetLevel: 40,
        targetBloomStage: 4,
        useBloomStones: true
      },
      preferences: { language: 'en', autoCheckUpdates: true }
    }
    await writeFile(join(directory, 'profile.json'), JSON.stringify(legacy), 'utf8')
    const loaded = await new ProfileStore(directory, progressionManifest).load()
    expect(loaded.profile.schemaVersion).toBe(2)
    expect(loaded.profile.revision).toBe(7)
    expect(loaded.profile.cards[selected.id].goal).toEqual({
      targetLevel: 40,
      targetBloomStage: 4,
      useBloomStones: true
    })
  })
})
