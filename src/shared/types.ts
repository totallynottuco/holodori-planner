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
  assetId: string
  memberName: string
  cardName: string
  rarity: Rarity
  attribute: Attribute
}

export interface ProgressionManifest {
  schemaVersion: 2
  metadata: {
    sourceRepository: string
    sourceCommit: string
    masterDataVersion: string
    importedAt: string
    catalogVersion: string
    assetSourceRepository: string
    assetSourceCommit: string
    assetCatalogRevision: number
  }
  cumulativeExperience: number[]
  rarities: Record<'3' | '4' | '5', RarityProgression>
  bloom: {
    maxStage: 5
    fiveStarStoneItemId: string
    effects: Record<'3' | '4' | '5', string[]>
  }
  resourceAssets: Record<ResourceKey | 'bloomPoints', {
    sourceAssetName: string
    fileName: string
  }>
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
  goal: CardGoal
}

export interface CardGoal {
  targetLevel: number
  targetBloomStage: 0 | 1 | 2 | 3 | 4 | 5
  useBloomStones: boolean
}

export interface AppProfileV2 {
  schemaVersion: 2
  revision: number
  catalogVersionLastSeen: string
  inventory: Inventory
  cards: Record<string, SavedCardState>
  plannerSelection: {
    cardId: string | null
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

export interface AggregatePlanResult {
  plans: PlanResult[]
  requirements: RequirementLine[]
  canApplyAll: boolean
}

export interface ProfileLoadResult {
  profile: AppProfileV2
  recoveryNotice: string | null
}

export interface ImportPreview {
  token: string
  fileName: string
  profile: AppProfileV2
  summary: {
    cards: number
    inventoryUnits: number
    revision: number
    activeGoals: number
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
  gpu: {
    mode: 'hardware-required'
    device: string
    features: Record<'gpu_compositing' | 'rasterization' | 'webgl' | 'webgl2', string>
  }
}
