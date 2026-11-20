import { z } from 'zod'
import {
  resourceKeys,
  isGameInventoryId,
  type AccountState,
  type AppProfileV2,
  type BoardRepairSummary,
  type CardGoal,
  type GameAccountImportState,
  type Inventory,
  type ProgressionManifest,
  type SavedCardState
} from './types'
import {
  accountCharactersById,
  accountManifest,
  boardPointsForMemberLevel,
  boardPointsSpent,
  connectedBoardNodeIds,
  maximumMemoryCount,
  maximumPlayerLevel,
  maximumStoryEpisode,
  minimumMemberLevelForBoardPoints,
  resolveBoardConnectEffect,
  resolveBoardNodes
} from './account-data'

const nonNegativeInteger = z.number().int().nonnegative()
const bloomStageSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)
])
const trainingStageSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)
])
const animationPreferenceSchema = z.enum(['inherit', 'on', 'off'])
const themePreferenceSchema = z.enum(['light', 'dark', 'auto'])
const legacyExactCardParametersSchema = z.object({
  performance: nonNegativeInteger,
  technique: nonNegativeInteger,
  sense: nonNegativeInteger
})
const legacyAccountBoardStateSchema = z.object({
  characterId: z.string().min(1),
  characterLevel: z.number().int().min(1).max(50),
  boardPoints: nonNegativeInteger,
  unlockedNodeIds: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, 'Board nodes must be unique'),
  connectAssignments: z.record(z.string(), z.string().min(1).nullable())
})
const legacyAccountStateSchema = z.object({
  playerLevel: z.number().int().min(1).max(999),
  calibration: z.object({
    statScale: z.number().finite().positive().max(10),
    baseline: z.number().finite().min(0).max(1_000_000_000)
  }),
  memoryBonusPermyriad: nonNegativeInteger.max(100_000),
  memberEnhancementBonus: nonNegativeInteger.max(1_000_000_000),
  exactCardParameters: z.record(z.string(), legacyExactCardParametersSchema),
  boards: z.record(z.string(), legacyAccountBoardStateSchema),
  ownedCostumeIds: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, 'Owned outfits must be unique'),
  playAssumption: z.object({ mode: z.literal('all-perfect') })
})
const accountBoardStateSchema = z.object({
  characterExp:z.string().regex(/^\d{1,20}$/).optional(),
  layoutKnown:z.boolean().optional(),
  pointBalance:z.object({quantity:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),rank:z.number().int().min(1).max(2147483647),spent:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).optional(),
  characterId: z.string().min(1),
  characterLevel: z.number().int().min(1).max(50),
  unlockedNodeIds: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, 'Board nodes must be unique'),
  connectAssignments: z.record(z.string(), z.string().min(1).nullable())
})
const accountStateV6Schema = z.object({
  playerLevel: z.number().int().min(1).max(maximumPlayerLevel),
  boards: z.record(z.string(), accountBoardStateSchema),
  ownedCostumeIds: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, 'Owned outfits must be unique'),
  playAssumption: z.object({ mode: z.literal('all-perfect') })
})
const accountStateV7Schema = accountStateV6Schema.extend({
  storyProgress: z.object({
    chapter: z.union([z.literal(1), z.literal(2)]),
    episode: z.number().int().min(1).max(24)
  }).superRefine((progress, context) => {
    const maximumEpisode = maximumStoryEpisode(progress.chapter)
    if (progress.episode > maximumEpisode) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['episode'], message: `Chapter ${progress.chapter} ends at Episode ${maximumEpisode}` })
    }
  }),
  memoriesCollected: z.number().int().min(0).max(maximumMemoryCount)
})
const accountStateV8Schema = accountStateV7Schema.extend({
  selectedCostumeIds: z.record(z.string(), z.string().min(1))
})
const accountStateV9Schema = accountStateV8Schema.extend({
  memberAvailability: z.object({
    mode: z.enum(['all', 'selected']),
    unlockedCharacterIds: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, 'Unlocked members must be unique')
  })
})
export const accountStateSchema = accountStateV8Schema.extend({
  ownedSongIds:z.array(z.string().regex(/^m\d{4}$/)).max(50000).optional(),
  storyProgress: z.object({chapter: z.number().int().min(1).max(2147483647), episode: z.number().int().min(0).max(2147483647)}),
  playerLevel: z.number().int().min(1).max(2147483647),
  memoriesCollected: z.number().int().min(0).max(50000),
  memoryBonusPermil: z.number().int().min(0).max(2147483647).optional(),
  upgradeBonusPermyriad: z.number().int().min(0).max(5000).optional(),
  unlockedCharacterIds: z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, 'Unlocked members must be unique')
})
const artworkPreferencesSchema = z.object({
  animation: animationPreferenceSchema,
  signature: animationPreferenceSchema
})
const legacyPreferencesSchema = z.object({ language: z.literal('en'), autoCheckUpdates: z.boolean() })

export const inventorySchema = z.object(
  Object.fromEntries(resourceKeys.map((key) => [key, nonNegativeInteger.default(0)])) as Record<
    (typeof resourceKeys)[number],
    ReturnType<typeof nonNegativeInteger.default>
  >
)

export const cardGoalSchema = z.object({
  active: z.boolean(),
  targetLevel: z.number().int().min(1).max(80),
  targetTrainingStage: trainingStageSchema,
  targetBloomStage: bloomStageSchema.optional()
})

const savedCardBaseSchema = z.object({
  cardId: z.string().min(1),
  nameSnapshot: z.string().min(1),
  level: z.number().int().min(1).max(80),
  expIntoLevel: nonNegativeInteger,
  trainingStage: trainingStageSchema,
  bloomStage: bloomStageSchema,
  bloomPoints: nonNegativeInteger
})

export const savedCardSchema = savedCardBaseSchema.extend({
  hidden: z.boolean().default(false),
  inactive: z.boolean().default(false),
  favorite: z.boolean().default(false),
  notes: z.string().max(10000).default(''),
  goal: cardGoalSchema,
  artworkPreferences: artworkPreferencesSchema
})

const appProfileV4Schema = z.object({
  schemaVersion: z.literal(4),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardSchema),
  plannerSelection: z.object({ cardId: z.string().min(1).nullable() }),
  preferences: legacyPreferencesSchema.extend({
    cardAnimationsDefault: z.boolean(),
    showHiddenCards: z.boolean().default(true),
    theme: themePreferenceSchema.default('auto')
  })
})

const appProfileV5Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(5),
  account: legacyAccountStateSchema
})

const appProfileV6Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(6),
  account: accountStateV6Schema
})

const appProfileV7Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(7),
  account: accountStateV7Schema
})

const appProfileV8Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(8),
  account: accountStateV8Schema
})

const appProfileV9Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(9),
  account: accountStateV9Schema
})

const appProfileV10Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(10),
  account: accountStateSchema
})

const appProfileV11Schema = appProfileV4Schema.extend({
  schemaVersion: z.literal(11),
  account: accountStateSchema
})

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const accountInt64Schema = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'Account value exceeds the exact integer range')
const sourceId = z.string().min(1).max(160)
const gameAccountIdentitySchema = z.object({publicUserId:sourceId,name:z.string().max(1000)})
const gameAccountBoostSchema = z.object({amount:z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),lastRecoveryTimeMs:accountInt64Schema})
const nativeStats = z.object({ performance: accountInt64Schema, technique: accountInt64Schema, sense: accountInt64Schema }).passthrough()
const sourceCard = z.object({
  cardId: sourceId, exp: accountInt64Schema,
  levelLimitBreakCount: safeInteger.max(4), potentialUpgradeCount: safeInteger.max(5), potentialUpgradePointQuantity: safeInteger,
  level: safeInteger.min(1).max(2147483647), maxLevel: safeInteger.min(1).max(2147483647), rarity: z.number().int().min(3).max(5),
  cardName: z.string().max(1000).optional(), memberName: z.string().max(1000).optional(),
  master: z.object({id:sourceId,assetId:sourceId,characterId:sourceId,rarity:z.number().int().min(3).max(5)}).passthrough().optional(),
  levelStats: nativeStats.optional(), cachedTotalStats: nativeStats.extend({totalPower:accountInt64Schema}).optional(),
}).passthrough()
// Whitelisted native fields are typed above; additive capture metadata is kept
// only when it is bounded plain JSON. No functions, prototypes or unsafe numbers.
function boundedAccountJson(value:unknown):boolean {
  let nodes=0
  function visit(item:unknown,depth:number):boolean {
    // The complete public reference currently occupies ~227k nodes / 7.2MB.
    // Keep room for future master rows without accepting unbounded metadata.
    if (++nodes>500000 || depth>12) return false
    if (item===null || typeof item==='boolean') return true
    if (typeof item==='string') return item.length<=10000
    if (typeof item==='number') return Number.isFinite(item) && Math.abs(item)<=Number.MAX_SAFE_INTEGER
    if (Array.isArray(item)) return item.length<=50000 && item.every(child=>visit(child,depth+1))
    if (typeof item!=='object' || !item || ![Object.prototype,null].includes(Object.getPrototypeOf(item))) return false
    return Object.entries(item).every(([key,child])=>key.length<=160 && !['__proto__','constructor','prototype'].includes(key) && visit(child,depth+1))
  }
  if (!visit(value,0)) return false
  try { return new TextEncoder().encode(JSON.stringify(value)).length<=16000000 } catch { return false }
}
export const gameAccountSnapshotSchema = z.object({
  schema:z.literal('holodori-steam-account-v1'), source:z.string().min(1).max(200), pid:safeInteger.min(1).max(2147483647), capturedAt:z.iso.datetime(),
  progress:z.object({
    quest:accountStateSchema.shape.storyProgress.extend({episode:safeInteger.min(1).max(2147483647)}).nullable().optional(),
    dreamRank:accountStateSchema.shape.playerLevel.optional(),
    memoriesCollected:accountStateSchema.shape.memoriesCollected.optional(),
    memoryBonusPermil:accountStateSchema.shape.memoryBonusPermil,
    upgradeBonusPermyriad:accountStateSchema.shape.upgradeBonusPermyriad,
  }).optional(),
  accountStatus:z.object({
    identity:gameAccountIdentitySchema.nullable(),
    boosts:z.object({minigame:gameAccountBoostSchema.nullable(),live:gameAccountBoostSchema.nullable()}),
    holoPassport:z.object({active:z.boolean(),expiresAtMs:accountInt64Schema.nullable()}).nullable(),
    serverTimeMs:accountInt64Schema,observedAt:z.iso.datetime(),
  }).optional(),
  process:z.object({pid:safeInteger.min(1).max(2147483647),steamAppId:z.literal('4282500'),steamBuildId:z.string().regex(/^\d{1,20}$/),executablePath:z.string().min(1).max(4096),executableSha256:z.string().regex(/^[a-fA-F0-9]{64}$/),gameAssemblySha256:z.string().regex(/^[a-fA-F0-9]{64}$/)}).passthrough(),
  tables:z.object({
    cards:z.array(sourceCard).min(1,'The game account has not finished loading its cards').max(5000),
    members:z.array(z.object({characterId:sourceId,exp:accountInt64Schema,level:safeInteger.min(1).max(2147483647)}).passthrough()).min(1,'The game account has not finished loading its Holomem').max(2000),
    items:z.array(z.object({itemId:sourceId,expiredTime:accountInt64Schema,quantity:accountInt64Schema}).passthrough()).max(50000),
    ownedItems:z.array(z.object({itemId:sourceId}).passthrough()).max(50000),
    boards:z.array(z.object({characterId:sourceId,releasedSkillTreeNodeGroupIds:z.array(sourceId).max(1000),connectedSkillTreeNodeGroupIds:z.array(sourceId).max(1000),connectedSkillTreeNodeCardIds:z.array(sourceId).max(1000)}).passthrough()).max(2000).optional(),
    boardPoints:z.array(z.object({skillTreePointId:sourceId,quantity:accountInt64Schema}).passthrough()).max(5000).optional(),
    missions:z.array(z.object({missionId:sourceId,missionPassId:z.string().max(160),progress:accountInt64Schema,rewardReceivedThresholds:z.array(accountInt64Schema).max(1000),lastProgressTime:accountInt64Schema,ttlBaseTime:accountInt64Schema}).passthrough()).max(50000).optional(),
    counts:z.array(z.object({countType:z.number().int().min(-2147483648).max(2147483647),totalCount:accountInt64Schema,dailyCount:accountInt64Schema,lastUpdatedTime:accountInt64Schema}).passthrough()).max(50000).optional(),
    songs:z.array(z.object({musicId:sourceId,releasedTime:accountInt64Schema})).max(50000).optional(),
    costumes:z.array(z.object({costumeId:sourceId})).max(50000).optional(),
  }).passthrough(),
  versions:z.object({cards:safeInteger,members:safeInteger,items:safeInteger,ownedItems:safeInteger,boards:safeInteger.optional(),boardPoints:safeInteger.optional(),missions:safeInteger.optional(),counts:safeInteger.optional()}).passthrough(),
  balances:z.object({free:safeInteger.nullable(),paid:safeInteger.nullable(),
    gachaPoints:z.record(z.string().regex(/^gacha_point-[a-z0-9_-]{1,100}$/),z.union([safeInteger,accountInt64Schema])).optional(),
    gachaPointsObservedAt:z.iso.datetime().optional(),
  }).passthrough(),
}).passthrough().superRefine((value,context)=>{
  if (!boundedAccountJson(value)) context.addIssue({code:'custom',message:'Account capture exceeds the supported JSON limits'})
  if (value.pid!==value.process.pid) context.addIssue({code:'custom',message:'Account capture process identity is inconsistent'})
  for (const key of ['boards','boardPoints','missions','counts','songs','costumes'] as const) if(value.tables[key]!==undefined&&value.versions[key]===undefined)context.addIssue({code:'custom',message:`Account ${key} collection version is missing`})
  for (const board of value.tables.boards||[]) if(board.connectedSkillTreeNodeGroupIds.length!==board.connectedSkillTreeNodeCardIds.length)context.addIssue({code:'custom',message:'Account board connection arrays are inconsistent'})
  for (const [rows,key] of [[value.tables.cards,'cardId'],[value.tables.members,'characterId'],[value.tables.ownedItems,'itemId']] as const) {
    const ids=rows.map(row=>String((row as Record<string,unknown>)[key]))
    if (new Set(ids).size!==ids.length) context.addIssue({code:'custom',message:`Account ${key} records must be unique`})
  }
  for (const card of value.tables.cards) if (card.level>card.maxLevel || (card.master && (card.master.id!==card.cardId || card.master.rarity!==card.rarity))) context.addIssue({code:'custom',message:'Account card getter/master values are inconsistent'})
})
const untrustedGameAccountImportSchema = z.object({
  schemaVersion:z.literal(1), snapshot:gameAccountSnapshotSchema,
  identity:gameAccountIdentitySchema.optional(),
  ownedCardIds:z.array(sourceId).max(5000).refine(ids=>new Set(ids).size===ids.length,'Owned card identifiers must be unique'),
  materialKeys:z.array(z.enum(resourceKeys)).max(resourceKeys.length).refine(keys=>new Set(keys).size===keys.length,'Imported material keys must be unique'),
  calculatedTotalStats:z.record(sourceId,z.object({performance:accountInt64Schema,technique:accountInt64Schema,sense:accountInt64Schema,totalPower:accountInt64Schema})).optional(),
  calculationSource:z.object({schemaVersion:z.literal(1),source:z.literal('planner-derived'),method:z.literal('resolveAccountCardParameters-v1'),catalogVersion:z.string().min(1).max(200),accountSourceCommit:z.string().min(1).max(200),inputs:z.literal('native-owned-card-progress-and-boards'),capturedAt:z.iso.datetime()}).optional(),
}).superRefine((value,context)=>{
  if(value.identity&&value.snapshot.accountStatus?.identity&&value.identity.publicUserId!==value.snapshot.accountStatus.identity.publicUserId)context.addIssue({code:'custom',message:'Saved account identity disagrees with the retained source capture'})
  const source=new Set(value.snapshot.tables.cards.map(card=>card.cardId))
  if (source.size!==value.ownedCardIds.length || value.ownedCardIds.some(id=>!source.has(id))) context.addIssue({code:'custom',message:'Imported ownership must match the retained source capture'})
  if(!!value.calculatedTotalStats!==!!value.calculationSource||Object.keys(value.calculatedTotalStats||{}).some(id=>!source.has(id))||value.calculationSource?.capturedAt&&value.calculationSource.capturedAt!==value.snapshot.capturedAt)context.addIssue({code:'custom',message:'Derived card totals must identify the retained native capture'})
  for(const stats of Object.values(value.calculatedTotalStats||{}))if(BigInt(stats.performance)+BigInt(stats.technique)+BigInt(stats.sense)!==BigInt(stats.totalPower))context.addIssue({code:'custom',message:'Derived card total does not match its parameters'})
})
const trustedGameAccountImports = new WeakSet<object>()
function ownImmutableAccountImport(input:unknown):GameAccountImportState {
  // Zod passthrough retains additive master-table object references. Take
  // ownership before freezing so validation never freezes the caller's input.
  const owned=JSON.parse(JSON.stringify(input)) as GameAccountImportState
  function freeze(value:unknown):void {
    if (!value || typeof value!=='object' || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(owned);trustedGameAccountImports.add(owned);return owned
}
const gameAccountImportSchema = z.union([
  z.custom<GameAccountImportState>(value=>!!value&&typeof value==='object'&&trustedGameAccountImports.has(value)),
  untrustedGameAccountImportSchema.transform(ownImmutableAccountImport),
])
/** Only this validator can mint an immutable, previously validated source.
 * Object identity is the fast path; untrusted inputs always take full parsing. */
export function validateGameAccountImport(input:unknown):GameAccountImportState {
  return gameAccountImportSchema.parse(input)
}

const boardLayoutsSchema=z.record(z.string().regex(/^chr-\d+$/),z.object({
    nodes:z.array(z.string().min(1).max(100)).max(1000),
    cards:z.record(z.string().min(1).max(100),z.string().regex(/^card-[a-z\d-]+$/)),
}));
export const appProfileSchema = z.object({
  currentDataVersion:z.literal(1).optional(),
  gachaPoints:z.record(z.string().regex(/^gacha_point-[a-z0-9_-]{1,100}$/),z.union([safeInteger,accountInt64Schema])).optional(),
  achievementProgress:z.record(sourceId,z.object({progress:accountInt64Schema,rewardReceivedThresholds:z.array(accountInt64Schema).max(1000)})).optional(),
  achievementProgressKnown:z.boolean().optional(),
  upgradeBonusManual:z.boolean().optional(),
  memoryBonusManual:z.boolean().optional(),
  gameAccountImport:gameAccountImportSchema.optional(),
  savedBoards:boardLayoutsSchema.optional(),
  savedBoardBases:boardLayoutsSchema.optional(),
  boardEdits:boardLayoutsSchema.optional(),
  boardProgressVersion:z.literal(1).optional(),
  dreamRankManuallySet:z.boolean().optional(),
  cardOwnership:z.record(z.string().regex(/^card-[a-z\d-]+$/),z.boolean()).optional(),
  gachaPointEdits:z.record(z.string().regex(/^gacha_point-[a-z0-9_-]{1,100}$/),safeInteger).optional(),
  achievementEdits:z.record(sourceId,z.object({progress:accountInt64Schema,rewardReceivedThresholds:z.array(accountInt64Schema).max(1000)})).optional(),
  gameInventory:z.record(z.string().refine(isGameInventoryId),nonNegativeInteger).optional(),
  boosts: z.object({minigame:z.object({amount:z.number().int().min(0).max(200),at:z.number().int().nonnegative()}).nullable(),live:z.object({amount:z.number().int().min(0).max(20),at:z.number().int().nonnegative()}).nullable(),holoPassport:z.boolean()}).default({minigame:null,live:null,holoPassport:false}),
  tasks: z.array(z.object({id:z.string().min(1).max(100),title:z.string().min(1).max(200),notes:z.string().max(2000),category:z.enum(['permanent','events','custom']),repeat:z.enum(['none','daily','weekly']),dueAt:z.iso.datetime().nullable(),doneAt:z.iso.datetime().nullable(),snoozedUntil:z.iso.datetime().nullable(),recurrenceDays:z.number().int().min(1).max(7).optional(),recurrenceMode:z.enum(['original','completed']).optional()})).max(1000).default([]),
  schemaVersion: z.literal(12),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardSchema),
  account: accountStateSchema,
  plannerSelection: z.object({ cardId: z.string().min(1).nullable() }),
  preferences: legacyPreferencesSchema.extend({
    cardAnimationsDefault: z.boolean(),
    showHiddenCards: z.boolean().default(true),
    theme: themePreferenceSchema.default('auto')
  })
})

const appProfileV3Schema = z.object({
  schemaVersion: z.literal(3),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardBaseSchema.extend({ goal: cardGoalSchema })),
  plannerSelection: z.object({ cardId: z.string().min(1).nullable() }),
  preferences: legacyPreferencesSchema
})

const savedCardV1Schema = savedCardBaseSchema
const appProfileV1Schema = z.object({
  schemaVersion: z.literal(1),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardV1Schema),
  plannerSelection: z.object({
    cardId: z.string().min(1).nullable(),
    targetLevel: z.number().int().min(1).max(80).nullable(),
    targetBloomStage: z.number().int().min(0).max(5).nullable(),
    useBloomStones: z.boolean()
  }),
  preferences: legacyPreferencesSchema
})

const legacyCardGoalSchema = z.object({
  targetLevel: z.number().int().min(1).max(80),
  targetBloomStage: bloomStageSchema,
  useBloomStones: z.boolean()
})
const appProfileV2Schema = z.object({
  schemaVersion: z.literal(2),
  revision: nonNegativeInteger,
  catalogVersionLastSeen: z.string().min(1),
  inventory: inventorySchema,
  cards: z.record(z.string(), savedCardBaseSchema.extend({ goal: legacyCardGoalSchema })),
  plannerSelection: z.object({ cardId: z.string().min(1).nullable() }),
  preferences: legacyPreferencesSchema
})

export function emptyInventory(): Inventory {
  return Object.fromEntries(resourceKeys.map((key) => [key, 0])) as Inventory
}

export function createDefaultGoal(
  level = 1,
  trainingStage: CardGoal['targetTrainingStage'] = 0,
  active = false
): CardGoal {
  return { active, targetLevel: level, targetTrainingStage: trainingStage }
}

export function createDefaultCardState(cardId: string, nameSnapshot: string): SavedCardState {
  return {
    cardId,
    nameSnapshot,
    hidden: false,
    inactive: false,
    level: 1,
    expIntoLevel: 0,
    trainingStage: 0,
    bloomStage: 0,
    bloomPoints: 0,
    goal: createDefaultGoal(),
    artworkPreferences: { animation: 'inherit', signature: 'inherit' }
  }
}

export function createDefaultAccountState(): AccountState {
  return {
    storyProgress: { chapter: 1, episode: 1 },
    playerLevel: 1,
    memoriesCollected: 0,
    unlockedCharacterIds: [],
    boards: {},
    ownedCostumeIds: [],
    selectedCostumeIds: {},
    playAssumption: { mode: 'all-perfect' }
  }
}

export function createDefaultProfile(catalogVersion: string): AppProfileV2 {
  return {
    schemaVersion: 12,
    revision: 0,
    catalogVersionLastSeen: catalogVersion,
    inventory: emptyInventory(),
    cards: {},
    account: createDefaultAccountState(),
    plannerSelection: { cardId: null },
    preferences: {
      language: 'en',
      autoCheckUpdates: true,
      cardAnimationsDefault: false,
      showHiddenCards: true,
      theme: 'auto'
    }
  }
}

export function hasActiveGoal(state: SavedCardState): boolean {
  return state.goal.active
}

export function validateProfileForManifest(
  input: unknown,
  manifest: ProgressionManifest,
  allowRemovedCards = true
): AppProfileV2 {
  return validateParsedProfileForManifest(appProfileSchema.parse(input), manifest, allowRemovedCards)
}

function validateParsedProfileForManifest(
  profile: AppProfileV2,
  manifest: ProgressionManifest,
  allowRemovedCards = true
): AppProfileV2 {
  const catalog = new Map(manifest.cards.map((card) => [card.id, card]))

  for (const [key, state] of Object.entries(profile.cards)) {
    if (key !== state.cardId) throw new Error(`Card map key does not match ${state.cardId}`)
    const card = catalog.get(state.cardId)
    if (!card) {
      if (!allowRemovedCards) throw new Error(`Unknown card ID: ${state.cardId}`)
      if (state.goal.targetLevel < state.level || state.goal.targetTrainingStage < state.trainingStage) {
        throw new Error(`${state.nameSnapshot} has targets below its current state`)
      }
      continue
    }
    const rules = manifest.rarities[String(card.rarity) as '3' | '4' | '5']
    if (state.level > rules.maxLevel) throw new Error(`${card.cardName} exceeds its level cap`)
    const cap = state.trainingStage === 0
      ? rules.initialLevelCap
      : rules.trainingStages[state.trainingStage - 1].levelCap
    if (state.level > cap) throw new Error(`${card.cardName} needs a higher SP Training stage`)
    if (state.level === rules.maxLevel && state.expIntoLevel !== 0) {
      throw new Error(`${card.cardName} cannot have partial EXP at maximum level`)
    }
    if (state.level < rules.maxLevel) {
      const next = manifest.cumulativeExperience[state.level] - manifest.cumulativeExperience[state.level - 1]
      if (state.expIntoLevel >= next) throw new Error(`${card.cardName} partial EXP reaches the next level`)
    }
    if (state.goal.targetLevel < state.level || state.goal.targetLevel > rules.maxLevel) {
      throw new Error(`${card.cardName} has an invalid level target`)
    }
    if (state.goal.targetTrainingStage < state.trainingStage || state.goal.targetTrainingStage > 4) {
      throw new Error(`${card.cardName} has an invalid SP Training target`)
    }
    const targetCap = state.goal.targetTrainingStage === 0
      ? rules.initialLevelCap
      : rules.trainingStages[state.goal.targetTrainingStage - 1].levelCap
    if (state.goal.targetLevel > targetCap) {
      throw new Error(`${card.cardName} needs a higher target SP Training stage`)
    }
  }

  if (profile.plannerSelection.cardId && !profile.cards[profile.plannerSelection.cardId]) {
    throw new Error('Planner selection must reference a saved card')
  }

  const costumes = new Set(accountManifest.costumes.map((costume) => costume.id))
  for (const costumeId of profile.account.ownedCostumeIds) {
    if (!costumes.has(costumeId)&&profile.currentDataVersion!==1) throw new Error(`Unknown outfit ID: ${costumeId}`)
  }
  const characterIds = new Set(accountManifest.characters.map((character) => character.id))
  for (const characterId of profile.account.unlockedCharacterIds) {
    if (!characterIds.has(characterId)&&profile.currentDataVersion!==1) throw new Error(`Unknown unlocked member ID: ${characterId}`)
  }
  for (const [characterId, costumeId] of Object.entries(profile.account.selectedCostumeIds)) {
    const costume = accountManifest.costumes.find((entry) => entry.id === costumeId)
    if (!characterIds.has(characterId) || !costume || costume.characterId !== characterId) throw new Error(`Invalid selected outfit for ${characterId}`)
    if (!costume.isDefault && !profile.cards[costume.sourceCardId] && !profile.account.ownedCostumeIds.includes(costume.id)) {
      throw new Error(`Selected outfit is not owned: ${costumeId}`)
    }
  }
  const connectedCards = new Set<string>()
  for (const [characterId, board] of Object.entries(profile.account.boards)) {
    if (characterId !== board.characterId) throw new Error(`Board map key does not match ${board.characterId}`)
    if(board.layoutKnown===false){
      for(const id of Object.values(board.connectAssignments))if(id){
        if(connectedCards.has(id))throw new Error(`Card ${id} is assigned to more than one Connect node`)
        connectedCards.add(id)
      }
      continue
    }
    const character = accountCharactersById.get(characterId)
    if (!character) throw new Error(`Unknown Board member ID: ${characterId}`)
    if (board.characterLevel > character.maximumLevel) throw new Error(`${character.name} exceeds the member level cap`)
    const nodes = resolveBoardNodes(characterId)
    const nodeIds = new Set(nodes.map((node) => node.groupId))
    const connectIds = new Set(nodes.filter((node) => node.type === 'connect').map((node) => node.groupId))
    const connectedIds = connectedBoardNodeIds(nodes, board.unlockedNodeIds)
    for (const nodeId of board.unlockedNodeIds) {
      if (!nodeIds.has(nodeId)) throw new Error(`Unknown ${character.name} Board node: ${nodeId}`)
      if (!connectedIds.has(nodeId)) throw new Error(`${character.name} Board node ${nodeId} is not connected to the Board origin`)
    }
    const spentPoints = boardPointsSpent(characterId, board.unlockedNodeIds)
    const earnedPoints = boardPointsForMemberLevel(characterId, board.characterLevel)
    if (spentPoints > earnedPoints) throw new Error(`${character.name} Board spends more Board Pt than its member level has earned`)
    for (const [nodeId, cardId] of Object.entries(board.connectAssignments)) {
      if (!connectIds.has(nodeId)) throw new Error(`Board connection ${nodeId} is not a Connect node`)
      if (!connectedIds.has(nodeId)) throw new Error(`Board connection ${nodeId} is not connected to the Board origin`)
      if (cardId === null) continue
      if (!catalog.has(cardId)) throw new Error(`Board connection references an unknown card: ${cardId}`)
      if (!resolveBoardConnectEffect(cardId, profile.cards[cardId]?.bloomStage ?? 0)) throw new Error(`Card ${cardId} has no Connect effect`)
      if (connectedCards.has(cardId)) throw new Error(`Card ${cardId} is assigned to more than one Connect node`)
      connectedCards.add(cardId)
    }
  }
  return profile
}

function currentPreferences(
  preferences: {
    language: 'en'
    autoCheckUpdates: boolean
    cardAnimationsDefault: boolean
    showHiddenCards: boolean
    theme: 'light' | 'dark' | 'auto'
  }
): AppProfileV2['preferences'] {
  return {
    language: preferences.language,
    autoCheckUpdates: preferences.autoCheckUpdates,
    cardAnimationsDefault: preferences.cardAnimationsDefault,
    showHiddenCards: preferences.showHiddenCards,
    theme: preferences.theme
  }
}

function finalizeLegacyProfile(profile: z.infer<typeof appProfileV11Schema>): AppProfileV2 {
  return {
    ...profile,
    schemaVersion: 12,
    preferences: currentPreferences(profile.preferences)
  }
}

function migrateV1(input: unknown, manifest: ProgressionManifest): AppProfileV2 {
  const old = appProfileV1Schema.parse(input)
  const cards = Object.fromEntries(Object.entries(old.cards).map(([cardId, state]) => {
    const selected = old.plannerSelection.cardId === cardId
    const card = manifest.cards.find((entry) => entry.id === cardId)
    const targetLevel = selected && old.plannerSelection.targetLevel !== null
      ? Math.max(state.level, old.plannerSelection.targetLevel)
      : state.level
    const rules = card ? manifest.rarities[String(card.rarity) as '3' | '4' | '5'] : null
    const requiredTraining = !rules || targetLevel <= rules.initialLevelCap
      ? state.trainingStage
      : rules.trainingStages.find((stage) => targetLevel <= stage.levelCap)?.stage ?? state.trainingStage
    const targetTrainingStage = Math.max(state.trainingStage, requiredTraining) as CardGoal['targetTrainingStage']
    return [cardId, {
      ...state,
      hidden: false,
      goal: createDefaultGoal(targetLevel, targetTrainingStage, selected && targetLevel > state.level),
      artworkPreferences: { animation: 'inherit' as const, signature: 'inherit' as const }
    }]
  }))
  return {
    schemaVersion: 12,
    revision: old.revision,
    catalogVersionLastSeen: old.catalogVersionLastSeen,
    inventory: old.inventory,
    cards,
    account: createDefaultAccountState(),
    plannerSelection: { cardId: old.plannerSelection.cardId },
    preferences: {
      ...old.preferences,
      cardAnimationsDefault: false,
      showHiddenCards: true,
      theme: 'auto'
    }
  }
}

function migrateV2(input: unknown): AppProfileV2 {
  const old = appProfileV2Schema.parse(input)
  return {
    schemaVersion: 12,
    revision: old.revision,
    catalogVersionLastSeen: old.catalogVersionLastSeen,
    inventory: old.inventory,
    cards: Object.fromEntries(Object.entries(old.cards).map(([cardId, state]) => [cardId, {
      ...state,
      hidden: false,
      goal: createDefaultGoal(state.level, state.trainingStage),
      artworkPreferences: { animation: 'inherit' as const, signature: 'inherit' as const }
    }])),
    account: createDefaultAccountState(),
    plannerSelection: old.plannerSelection,
    preferences: {
      ...old.preferences,
      cardAnimationsDefault: false,
      showHiddenCards: true,
      theme: 'auto'
    }
  }
}

function migrateV3(input: unknown): AppProfileV2 {
  const old = appProfileV3Schema.parse(input)
  return {
    ...old,
    schemaVersion: 12,
    cards: Object.fromEntries(Object.entries(old.cards).map(([cardId, state]) => [cardId, {
      ...state,
      hidden: false,
      artworkPreferences: { animation: 'inherit' as const, signature: 'inherit' as const }
    }])),
    account: createDefaultAccountState(),
    preferences: {
      ...old.preferences,
      cardAnimationsDefault: false,
      showHiddenCards: true,
      theme: 'auto'
    }
  }
}

function migrateV4(input: unknown): AppProfileV2 {
  const old = appProfileV4Schema.parse(input)
  return {
    ...old,
    schemaVersion: 12,
    account: createDefaultAccountState(),
    preferences: currentPreferences(old.preferences)
  }
}

function migrateV5(input: unknown): AppProfileV2 {
  const old = appProfileV5Schema.parse(input)
  const boards = Object.fromEntries(Object.entries(old.account.boards).map(([characterId, board]) => {
    const character = accountCharactersById.get(characterId)
    if (!character) return [characterId, {
      characterId,
      characterLevel: board.characterLevel,
      unlockedNodeIds: board.unlockedNodeIds,
      connectAssignments: board.connectAssignments
    }]
    const spent = boardPointsSpent(characterId, board.unlockedNodeIds)
    const requiredLevel = minimumMemberLevelForBoardPoints(characterId, spent)
    return [characterId, {
      characterId,
      characterLevel: Math.min(character.maximumLevel, Math.max(board.characterLevel, requiredLevel)),
      unlockedNodeIds: board.unlockedNodeIds,
      connectAssignments: board.connectAssignments
    }]
  }))
  return {
    ...old,
    schemaVersion: 12,
    account: {
      storyProgress: { chapter: 1, episode: 1 },
      playerLevel: Math.min(maximumPlayerLevel, old.account.playerLevel),
      memoriesCollected: 0,
      unlockedCharacterIds: [],
      boards,
      ownedCostumeIds: old.account.ownedCostumeIds,
      selectedCostumeIds: {},
      playAssumption: old.account.playAssumption
    },
    preferences: currentPreferences(old.preferences)
  }
}

function migrateV6(input: unknown): AppProfileV2 {
  const old = appProfileV6Schema.parse(input)
  return {
    ...old,
    schemaVersion: 12,
    account: {
      ...old.account,
      storyProgress: { chapter: 1, episode: 1 },
      memoriesCollected: 0,
      unlockedCharacterIds: [],
      selectedCostumeIds: {}
    },
    preferences: currentPreferences(old.preferences)
  }
}

function migrateV7(input: unknown): AppProfileV2 {
  const old = appProfileV7Schema.parse(input)
  return {
    ...old,
    schemaVersion: 12,
    account: { ...old.account, selectedCostumeIds: {}, unlockedCharacterIds: [] },
    preferences: currentPreferences(old.preferences)
  }
}

function migrateV8(input: unknown): AppProfileV2 {
  const old = appProfileV8Schema.parse(input)
  return {
    ...old,
    schemaVersion: 12,
    account: { ...old.account, unlockedCharacterIds: [] },
    preferences: currentPreferences(old.preferences)
  }
}

function migrateV9(input: unknown): AppProfileV2 {
  const old = appProfileV9Schema.parse(input)
  const { memberAvailability, ...account } = old.account
  return {
    ...old,
    schemaVersion: 12,
    account: {
      ...account,
      unlockedCharacterIds: memberAvailability.mode === 'selected'
        ? [...memberAvailability.unlockedCharacterIds]
        : []
    },
    preferences: currentPreferences(old.preferences)
  }
}

function migrateV10(input: unknown): AppProfileV2 {
  const old = appProfileV10Schema.parse(input)
  return {
    ...old,
    schemaVersion: 12,
    preferences: currentPreferences(old.preferences)
  }
}

function migrateProfileShape(input: unknown, manifest: ProgressionManifest): AppProfileV2 {
  if (!input || typeof input !== 'object') throw new Error('Profile must be an object')
  const record = input as Record<string, unknown>
  if (record.schemaVersion === 1) return migrateV1(input, manifest)
  if (record.schemaVersion === 2) return migrateV2(input)
  if (record.schemaVersion === 3) return migrateV3(input)
  if (record.schemaVersion === 4) return migrateV4(input)
  if (record.schemaVersion === 5) return migrateV5(input)
  if (record.schemaVersion === 6) return migrateV6(input)
  if (record.schemaVersion === 7) return migrateV7(input)
  if (record.schemaVersion === 8) return migrateV8(input)
  if (record.schemaVersion === 9) return migrateV9(input)
  if (record.schemaVersion === 10) return migrateV10(input)
  if (record.schemaVersion === 11) {
    const old = appProfileV11Schema.parse(input)
    return finalizeLegacyProfile(old)
  }
  if (record.schemaVersion === 12) return appProfileSchema.parse(input)
  throw new Error(`Unsupported profile schema: ${String(record.schemaVersion)}`)
}

/** Preparation is pure: callers choose the authoritative source before writing repairs. */
export function prepareProfile(input: unknown, manifest: ProgressionManifest): { profile: AppProfileV2; boardRepairs: BoardRepairSummary[] } {
  const current = input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion === 12
  const profile = current ? appProfileSchema.parse(input) : appProfileSchema.parse(migrateProfileShape(input, manifest))
  const boardRepairs: BoardRepairSummary[] = []
  const catalogIds = new Set(manifest.cards.map((card) => card.id))
  const assignedCards = new Set<string>()
  for (const [characterId, board] of Object.entries(profile.account.boards)) {
    if(board.layoutKnown===false){
      for(const id of Object.values(board.connectAssignments))if(id){
        if(assignedCards.has(id))throw new Error(`Card ${id} is assigned to more than one Connect node`)
        assignedCards.add(id)
      }
      continue
    }
    if (!accountCharactersById.has(characterId)) throw new Error(`Unknown Board member ID: ${characterId}`)
    const nodes = resolveBoardNodes(characterId)
    const byId = new Map(nodes.map((node) => [node.groupId, node]))
    // Do not hide unknown identifiers or malformed assignment types as repairs.
    for (const id of board.unlockedNodeIds) if (!byId.has(id)) throw new Error(`Unknown Board node: ${id}`)
    for (const id of Object.keys(board.connectAssignments)) if (byId.get(id)?.type !== 'connect') throw new Error(`Board connection ${id} is not a Connect node`)
    for (const cardId of Object.values(board.connectAssignments)) {
      if (cardId === null) continue
      if (!catalogIds.has(cardId)) throw new Error(`Board connection references an unknown card: ${cardId}`)
      if (!resolveBoardConnectEffect(cardId, profile.cards[cardId]?.bloomStage ?? 0)) throw new Error(`Card ${cardId} has no Connect effect`)
      if (assignedCards.has(cardId)) throw new Error(`Card ${cardId} is assigned to more than one Connect node`)
      assignedCards.add(cardId)
    }
    const connected = connectedBoardNodeIds(nodes, board.unlockedNodeIds)
    const removedNodeIds = board.unlockedNodeIds.filter((id) => !connected.has(id))
    const removedAssignmentIds = Object.keys(board.connectAssignments).filter((id) => !connected.has(id))
    if (!removedNodeIds.length && !removedAssignmentIds.length) continue
    board.unlockedNodeIds = board.unlockedNodeIds.filter((id) => connected.has(id))
    board.connectAssignments = Object.fromEntries(Object.entries(board.connectAssignments).filter(([id]) => connected.has(id)))
    boardRepairs.push({ characterId, removedNodeIds, removedAssignmentIds })
  }
  return { profile: validateParsedProfileForManifest(profile, manifest), boardRepairs }
}

export function migrateProfile(input: unknown, manifest: ProgressionManifest): AppProfileV2 {
  return prepareProfile(input, manifest).profile
}
