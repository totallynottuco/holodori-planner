export const resourceKeys = [
  'lessonPoints',
  'cuteBeads',
  'cuteCrystals',
  'pureBeads',
  'pureCrystals',
  'happyBeads',
  'happyCrystals',
  'hololium',
  'redCube',
  'redHexa',
  'blueCube',
  'blueHexa',
  'yellowCube',
  'yellowHexa',
  'greenCube',
  'greenHexa',
  'hologold',
  'harmonyGardenCoin',
  'megaSphereCoin',
  'bloomStones'
] as const

export type ResourceKey = (typeof resourceKeys)[number]
export const diamondInventoryIds = {free:'freeDiamonds',paid:'paidDiamonds'} as const
export function isGameInventoryId(id:unknown):id is string {
  return typeof id==='string' && (id===diamondInventoryIds.free || id===diamondInventoryIds.paid || /^item-[a-z0-9][a-z0-9_-]{0,154}$/i.test(id))
}
export type Attribute = 'cute' | 'pure' | 'happy'
export type CardStat = 'performance' | 'technique' | 'sense'
export type Rarity = 3 | 4 | 5
export type CardAnimationPreference = 'inherit' | 'on' | 'off'
export type ThemePreference = 'light' | 'dark' | 'auto'
export type WindowMode = 'windowed' | 'fullscreen' | 'borderless'

export interface WindowStateInfo {
  mode: WindowMode
  width: number
  height: number
  isMaximized: boolean
  isFullScreen: boolean
}

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
  catalogOrder?: number
  assetId: string
  memberName: string
  cardName: string
  rarity: Rarity
  attribute: Attribute
  stat: CardStat
  groupId: string
  groupLabel: string
  animation: {
    fullVariants: [0, 1]
    signature: true
  } | null
}

export interface ProgressionManifest {
  schemaVersion: 5
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
  hidden: boolean
  inactive?: boolean
  favorite?: boolean
  notes?: string
  level: number
  expIntoLevel: number
  trainingStage: 0 | 1 | 2 | 3 | 4
  bloomStage: 0 | 1 | 2 | 3 | 4 | 5
  bloomPoints: number
  goal: CardGoal
  artworkPreferences: {
    animation: CardAnimationPreference
    signature: CardAnimationPreference
  }
}

export interface CardGoal {
  active: boolean
  targetLevel: number
  targetTrainingStage: 0 | 1 | 2 | 3 | 4
  targetBloomStage?: 0 | 1 | 2 | 3 | 4 | 5
}

export interface AccountBoardState {
  characterExp?: string
  layoutKnown?: boolean
  pointBalance?: {quantity:number;rank:number;spent:number}
  characterId: string
  characterLevel: number
  unlockedNodeIds: string[]
  connectAssignments: Record<string, string | null>
}

export interface AccountState {
  ownedSongIds?: string[]
  storyProgress: {
    chapter: number
    episode: number
  }
  playerLevel: number
  memoriesCollected: number
  memoryBonusPermil?: number
  upgradeBonusPermyriad?: number
  /** Members the player has actually unlocked. */
  unlockedCharacterIds: string[]
  boards: Record<string, AccountBoardState>
  ownedCostumeIds: string[]
  selectedCostumeIds: Record<string, string>
  playAssumption: {
    mode: 'all-perfect'
  }
}

/** A bounded, decoded local Steam capture. Int64 values remain decimal strings. */
export interface GameAccountCardSource {
  cardId: string
  exp: string
  levelLimitBreakCount: number
  potentialUpgradeCount: number
  potentialUpgradePointQuantity: number
  level: number
  maxLevel: number
  rarity: number
  cardName?: string
  memberName?: string
  master?: { id: string; assetId: string; characterId: string; rarity: number; [key: string]: unknown }
  levelStats?: { performance: string; technique: string; sense: string; [key: string]: unknown }
  cachedTotalStats?: { performance: string; technique: string; sense: string; totalPower: string; [key: string]: unknown }
  [key: string]: unknown
}
export interface GameAccountMemberSource {
  characterId: string
  exp: string
  level: number
  [key: string]: unknown
}
export interface GameAccountItemSource {
  itemId: string
  expiredTime: string
  quantity: string
  [key: string]: unknown
}
export interface GameAccountIdentity {
  publicUserId: string
  name: string
}
export interface GameAccountStatus {
  identity: GameAccountIdentity | null
  boosts: {
    minigame: {amount:number;lastRecoveryTimeMs:string} | null
    live: {amount:number;lastRecoveryTimeMs:string} | null
  }
  holoPassport: {active:boolean;expiresAtMs:string|null} | null
  serverTimeMs: string
  observedAt: string
}
export interface GameAccountSnapshot {
  schema: 'holodori-steam-account-v1'
  source: string
  pid: number
  capturedAt: string
  accountStatus?: GameAccountStatus
  progress?: {
    quest?: AccountState['storyProgress'] | null
    dreamRank?: number
    memoriesCollected?: number
    memoryBonusPermil?: number
    upgradeBonusPermyriad?: number
  }
  process: {
    pid: number
    steamAppId: '4282500'
    steamBuildId: string
    executablePath: string
    executableSha256: string
    gameAssemblySha256: string
    [key: string]: unknown
  }
  tables: {
    cards: GameAccountCardSource[]
    members: GameAccountMemberSource[]
    items: GameAccountItemSource[]
    ownedItems: Array<{ itemId: string; [key: string]: unknown }>
    boards?: Array<{characterId:string;releasedSkillTreeNodeGroupIds:string[];connectedSkillTreeNodeGroupIds:string[];connectedSkillTreeNodeCardIds:string[];[key:string]:unknown}>
    boardPoints?: Array<{skillTreePointId:string;quantity:string;[key:string]:unknown}>
    missions?: Array<{missionId:string;missionPassId:string;progress:string;rewardReceivedThresholds:string[];lastProgressTime:string;ttlBaseTime:string;[key:string]:unknown}>
    counts?: Array<{countType:number;totalCount:string;dailyCount:string;lastUpdatedTime:string;[key:string]:unknown}>
    songs?: Array<{musicId:string;releasedTime:string}>
    costumes?: Array<{costumeId:string}>
    [key: string]: unknown
  }
  versions: { cards: number; members: number; items: number; ownedItems: number; boards?:number;boardPoints?:number;missions?:number;counts?:number; [key: string]: unknown }
  balances: { free: number | null; paid: number | null; gachaPoints?: Record<string,number | string>; gachaPointsObservedAt?: string; [key: string]: unknown }
  [key: string]: unknown
}
export interface GameAccountImportState {
  schemaVersion: 1
  /** Retains unknown cards, member EXP, exact stats, balances and unmapped items. */
  snapshot: GameAccountSnapshot
  /** Stable profile binding survives captures where identity is unavailable. */
  identity?: GameAccountIdentity
  /** Source ownership is separate from merely having a planned card entry. */
  ownedCardIds: string[]
  /** Only these resources were authoritatively replaced by this capture. */
  materialKeys: ResourceKey[]
  /** Separate from raw native facts; computed only when Boards resolve exactly. */
  calculatedTotalStats?:Record<string,{performance:string;technique:string;sense:string;totalPower:string}>
  calculationSource?:{schemaVersion:1;source:'planner-derived';method:'resolveAccountCardParameters-v1';catalogVersion:string;accountSourceCommit:string;inputs:'native-owned-card-progress-and-boards';capturedAt:string}
}

export interface AppProfileV12 {
  boosts?: import('../../boosts').Boosts
  tasks?: import('../../tasks').PlannerTask[]
  gameAccountImport?: GameAccountImportState
  savedBoards?: Record<string,{nodes:string[];cards:Record<string,string>}>
  /** Layout each still-pending plan started from, for three-way import review. */
  savedBoardBases?: AppProfileV12['savedBoards']
  currentDataVersion?: 1
  gachaPoints?: Record<string,number|string>
  achievementProgress?: AppProfileV12['achievementEdits']
  achievementProgressKnown?: boolean
  upgradeBonusManual?: boolean
  memoryBonusManual?: boolean
  boardEdits?: AppProfileV12['savedBoards']
  boardProgressVersion?: 1
  dreamRankManuallySet?: boolean
  cardOwnership?: Record<string,boolean>
  gachaPointEdits?: Record<string,number>
  achievementEdits?: Record<string,{progress:string;rewardReceivedThresholds:string[]}>
  schemaVersion: 12
  revision: number
  catalogVersionLastSeen: string
  inventory: Inventory
  gameInventory?: Record<string,number>
  cards: Record<string, SavedCardState>
  account: AccountState
  plannerSelection: {
    cardId: string | null
  }
  preferences: {
    language: 'en'
    autoCheckUpdates: boolean
    cardAnimationsDefault: boolean
    showHiddenCards: boolean
    theme: ThemePreference
  }
}

/** Current persisted profile. The historical name is retained for preload consumers. */
export type AppProfileV2 = AppProfileV12

export interface RequirementLine {
  key: ResourceKey | 'bloomPoints'
  required: number
  available: number
  shortage: number
}

export interface MaterialConversion {
  from: ResourceKey
  to: ResourceKey
  input: number
  output: number
  fee: {
    key: ResourceKey
    amount: number
  }
}

export interface PlannerRequest {
  cardId: string
  targetLevel: number
  targetTrainingStage: number
}

export interface PlanResult {
  card: CardCatalogEntry
  current: SavedCardState
  target: {
    level: number
    trainingStage: number
  }
  experienceRequired: number
  requirements: RequirementLine[]
  conversions: MaterialConversion[]
  isComplete: boolean
  canApply: boolean
}

export interface AggregatePlanResult {
  plans: PlanResult[]
  requirements: RequirementLine[]
  conversions: MaterialConversion[]
  canApplyAll: boolean
}

export interface ProfileLoadResult {
  profile: AppProfileV2
  recoveryNotice: string | null
}

export interface BoardRepairSummary {
  characterId: string
  removedNodeIds: string[]
  removedAssignmentIds: string[]
}

export interface ImportPreview {
  token: string
  fileName: string
  profile: AppProfileV2
  boardRepairs: BoardRepairSummary[]
  summary: {
    cards: number
    inventoryUnits: number
    revision: number
    activeGoals: number
  }
}

export interface ScreenshotImportDetection {
  cardId: string
  level: number
  bloomStage: 0 | 1 | 2 | 3 | 4 | 5
}

export interface ScreenshotImportApplyRequest {
  expectedRevision: number
  detections: ScreenshotImportDetection[]
}

export interface ScreenshotImportApplyResult {
  profile: AppProfileV2
  added: number
  updated: number
  unchanged: number
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
}
