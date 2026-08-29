import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDefaultProfile, hasActiveGoal, migrateProfile, validateProfileForManifest } from '@shared/profile'
import type { AppProfileV2, ImportPreview, ProfileLoadResult, ProgressionManifest } from '@shared/types'

interface PendingImport {
  profile: AppProfileV2
  fileName: string
  expiresAt: number
}

export class ProfileStore {
  readonly profilePath: string
  readonly backupPath: string
  private currentProfile: AppProfileV2 | null = null
  private recoveryNotice: string | null = null
  private readonly imports = new Map<string, PendingImport>()

  constructor(
    private readonly directory: string,
    private readonly manifest: ProgressionManifest
  ) {
    this.profilePath = join(directory, 'profile.json')
    this.backupPath = join(directory, 'profile.json.bak')
  }

  async load(): Promise<ProfileLoadResult> {
    if (this.currentProfile) return { profile: structuredClone(this.currentProfile), recoveryNotice: this.recoveryNotice }
    await mkdir(this.directory, { recursive: true })
    try {
      this.currentProfile = await this.readValidated(this.profilePath)
      return { profile: structuredClone(this.currentProfile), recoveryNotice: null }
    } catch (primaryError) {
      if ((primaryError as NodeJS.ErrnoException).code === 'ENOENT') {
        this.currentProfile = createDefaultProfile(this.manifest.metadata.catalogVersion)
        await this.writeAtomic(this.currentProfile, false)
        return { profile: structuredClone(this.currentProfile), recoveryNotice: null }
      }
      try {
        const recovered = await this.readValidated(this.backupPath)
        await this.preserveCorrupt(this.profilePath)
        this.currentProfile = recovered
        await this.writeAtomic(recovered, false)
        this.recoveryNotice = 'The main profile was damaged. Your backup was restored and the damaged file was preserved.'
        return {
          profile: structuredClone(recovered),
          recoveryNotice: this.recoveryNotice
        }
      } catch {
        await this.preserveCorrupt(this.profilePath)
        await this.preserveCorrupt(this.backupPath)
        this.currentProfile = createDefaultProfile(this.manifest.metadata.catalogVersion)
        await this.writeAtomic(this.currentProfile, false)
        this.recoveryNotice = 'Profile files could not be recovered. They were preserved and a new profile was created.'
        return {
          profile: structuredClone(this.currentProfile),
          recoveryNotice: this.recoveryNotice
        }
      }
    }
  }

  async getCurrent(): Promise<AppProfileV2> {
    return (await this.load()).profile
  }

  async save(expectedRevision: number, candidate: AppProfileV2): Promise<AppProfileV2> {
    const current = await this.getCurrent()
    this.assertRevision(expectedRevision, current)
    if (candidate.revision !== expectedRevision) throw new Error('Candidate profile revision is stale')
    const validated = validateProfileForManifest(candidate, this.manifest)
    for (const cardId of Object.keys(validated.cards)) {
      const knownNow = this.manifest.cards.some((card) => card.id === cardId)
      const knownBefore = Boolean(current.cards[cardId])
      if (!knownNow && !knownBefore) throw new Error(`Unknown card ID: ${cardId}`)
    }
    const next: AppProfileV2 = {
      ...validated,
      revision: current.revision + 1,
      catalogVersionLastSeen: this.manifest.metadata.catalogVersion
    }
    await this.writeAtomic(next, true)
    this.currentProfile = next
    return structuredClone(next)
  }

  async replace(expectedRevision: number, candidate: AppProfileV2): Promise<AppProfileV2> {
    const current = await this.getCurrent()
    this.assertRevision(expectedRevision, current)
    const validated = validateProfileForManifest(candidate, this.manifest)
    const next: AppProfileV2 = {
      ...validated,
      revision: current.revision + 1,
      catalogVersionLastSeen: this.manifest.metadata.catalogVersion
    }
    await this.writeAtomic(next, true)
    this.currentProfile = next
    return structuredClone(next)
  }

  async exportTo(destination: string): Promise<void> {
    const profile = await this.getCurrent()
    await writeFile(destination, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await writeFile(destination, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    })
  }

  async previewImport(sourcePath: string): Promise<ImportPreview> {
    const source = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
    const profile = migrateProfile(source, this.manifest)
    const token = randomUUID()
    this.imports.set(token, { profile, fileName: basename(sourcePath), expiresAt: Date.now() + 10 * 60_000 })
    return {
      token,
      fileName: basename(sourcePath),
      profile: structuredClone(profile),
      summary: {
        cards: Object.keys(profile.cards).length,
        inventoryUnits: Object.values(profile.inventory).reduce((sum, value) => sum + value, 0),
        revision: profile.revision,
        activeGoals: Object.values(profile.cards).filter(hasActiveGoal).length
      }
    }
  }

  async commitImport(token: string, expectedRevision: number): Promise<AppProfileV2> {
    const pending = this.imports.get(token)
    this.imports.delete(token)
    if (!pending || pending.expiresAt < Date.now()) throw new Error('The import preview expired. Choose the file again.')
    return this.replace(expectedRevision, pending.profile)
  }

  async commitCalculated(expectedRevision: number, next: AppProfileV2): Promise<AppProfileV2> {
    const current = await this.getCurrent()
    this.assertRevision(expectedRevision, current)
    if (next.revision !== current.revision + 1) throw new Error('Invalid calculated profile revision')
    const validated = validateProfileForManifest(next, this.manifest, false)
    await this.writeAtomic(validated, true)
    this.currentProfile = validated
    return structuredClone(validated)
  }

  private assertRevision(expected: number, current: AppProfileV2): void {
    if (expected !== current.revision) throw new Error('This profile changed in another window. Reload and try again.')
  }

  private async readValidated(path: string): Promise<AppProfileV2> {
    return migrateProfile(JSON.parse(await readFile(path, 'utf8')) as unknown, this.manifest)
  }

  private async writeAtomic(profile: AppProfileV2, createBackup: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `profile.json.tmp-${process.pid}-${randomUUID()}`)
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
    try {
      if (createBackup) {
        try {
          await copyFile(this.profilePath, this.backupPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await rename(temporary, this.profilePath)
    } catch (error) {
      try {
        await rename(temporary, `${temporary}.failed`)
      } catch {
        // Preserve the original write failure.
      }
      throw error
    }
  }

  private async preserveCorrupt(path: string): Promise<void> {
    try {
      await rename(path, `${path}.corrupt-${new Date().toISOString().replaceAll(':', '-')}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
