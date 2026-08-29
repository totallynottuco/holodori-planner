export const resourceKeys = [
  'lessonPoints',
  'hologold',
  'hololium',
  'bloomStones',
  'cuteBeads',
  'cuteCrystals',
  'pureBeads',
  'pureCrystals',
  'happyBeads',
  'happyCrystals'
] as const

export type ResourceKey = (typeof resourceKeys)[number]
export type Attribute = 'cute' | 'pure' | 'happy'
export type Rarity = 3 | 4 | 5

export interface TrainingCost {
  beads: number
  crystals: number
  hologold: number
  hololium: number
}

export interface TrainingStage {
  stage: 1 | 2 | 3 | 4
  levelCap: number
  cost: TrainingCost
}

export interface RarityProgression {
  initialLevelCap: number
  maxLevel: number
  trainingStages: TrainingStage[]
}

export interface CardCatalogEntry {
  id: string
  memberName: string
  cardName: string
  rarity: Rarity
  attribute: Attribute
}

export interface ProgressionManifest {
  schemaVersion: 1
  metadata: {
    sourceRepository: string
    sourceCommit: string
    masterDataVersion: string
    importedAt: string
    catalogVersion: string
  }
  cumulativeExperience: number[]
  rarities: Record<'3' | '4' | '5', RarityProgression>
  bloom: {
    maxStage: 5
    fiveStarStoneItemId: string
    effects: Record<'3' | '4' | '5', string[]>
  }
  cards: CardCatalogEntry[]
}

export type Inventory = Record<ResourceKey, number>

export interface SavedCardState {
  cardId: string
  nameSnapshot: string
  level: number
  expIntoLevel: number
  trainingStage: 0 | 1 | 2 | 3 | 4
  bloomStage: 0 | 1 | 2 | 3 | 4 | 5
  bloomPoints: number
}

export interface AppProfileV1 {
  schemaVersion: 1
  revision: number
  catalogVersionLastSeen: string
  inventory: Inventory
  cards: Record<string, SavedCardState>
  plannerSelection: {
    cardId: string | null
    targetLevel: number | null
    targetBloomStage: number | null
    useBloomStones: boolean
  }
  preferences: {
    language: 'en'
    autoCheckUpdates: boolean
  }
}

export interface RequirementLine {
  key: ResourceKey | 'bloomPoints'
  required: number
  available: number
  shortage: number
}

export interface PlannerRequest {
  cardId: string
  targetLevel: number
  targetBloomStage: number
  useBloomStones: boolean
}

export interface PlanResult {
  card: CardCatalogEntry
  current: SavedCardState
  target: {
    level: number
    trainingStage: number
    bloomStage: number
  }
  experienceRequired: number
  bloomPointsSpent: number
  bloomStonesSpent: number
  requirements: RequirementLine[]
  canApply: boolean
}

export interface ProfileLoadResult {
  profile: AppProfileV1
  recoveryNotice: string | null
}

export interface ImportPreview {
  token: string
  fileName: string
  profile: AppProfileV1
  summary: {
    cards: number
    inventoryUnits: number
    revision: number
  }
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'not-available' }
  | { state: 'available'; version: string; releaseNotes: string }
  | { state: 'downloading'; percent: number; version: string }
  | { state: 'downloaded'; version: string; releaseNotes: string }
  | { state: 'error'; message: string; background: boolean }

export interface AppInfo {
  version: string
  catalogVersion: string
  profilePath: string
  isPackaged: boolean
  projectUrl: string
}
