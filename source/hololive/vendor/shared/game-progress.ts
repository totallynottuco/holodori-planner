import {z} from 'zod'

// Additive, reviewed account tables. Keep source integers exact and independent
// of catalog maxima so a newer compatible game can retain unknown rows.
const id=z.string().min(1).max(160)
const integer=z.number().int().min(0).max(2147483647)
const signed=z.number().int().min(-2147483648).max(2147483647)
const exact=z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v=>BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER))
const ids=z.array(id).max(1000).refine(v=>new Set(v).size===v.length)
export const boardPresetSchema=z.object({characterId:id,number:integer,name:z.string().max(1000),userMemo:z.string().max(10000),releasedSkillTreeNodeGroupIds:ids,connectedSkillTreeNodeGroupIds:ids,connectedSkillTreeNodeCardIds:z.array(id).max(1000),lastSavedTime:exact}).passthrough().refine(v=>v.connectedSkillTreeNodeGroupIds.length===v.connectedSkillTreeNodeCardIds.length,'Preset Connect arrays are inconsistent')
const unique=<T extends z.ZodType>(schema:T,keys:string[],max=50000)=>z.array(schema).max(max).refine(rows=>new Set(rows.map(row=>JSON.stringify(keys.map(key=>(row as Record<string,unknown>)[key])))).size===rows.length,'Account progress records must be unique')
export const gameProgressTables={
  boardPresets:unique(boardPresetSchema,['characterId','number'],10000),
  challengeLive:unique(z.object({liveTowerId:id,clearedStageNumber:integer,lastPlayedMusicDifficultyType:integer}).passthrough(),['liveTowerId']),
  fishingBaits:unique(z.object({parkFishingBaitId:id,quantity:exact,notificationReadTime:exact}).passthrough(),['parkFishingBaitId']),
  fishingFish:unique(z.object({parkFishingFishId:id,caughtCount:exact,maxWeight:exact,maxWeightUpdatedTime:exact}).passthrough(),['parkFishingFishId']),
  fishing:z.array(z.object({currentParkFishingRodLevel:integer,receivedTotalCaughtRewardMaxFishUniqueCount:integer}).passthrough()).max(1),
  pukaStages:unique(z.object({shogiId:id,isCleared:z.boolean(),playCount:exact,winCount:exact,lastPlayedTime:exact,npcLeaderCharacterId:z.string().max(160)}).passthrough(),['shogiId']),
  pukaMembers:unique(z.object({shogiId:id,characterId:id,playCount:exact,winCount:exact}).passthrough(),['shogiId','characterId']),
  pukaPieces:unique(z.object({pieceType:integer,characterId:id}).passthrough(),['pieceType']),
  pukaPieceStats:unique(z.object({pieceType:integer,takeCount:exact,takenCount:exact}).passthrough(),['pieceType']),
  pukaSummary:z.array(z.object({singleRating:integer,multiRating:integer,multiMatchCount:integer,lastMultiRatingChange:signed,challengeContinuousWinCount:integer,challengeHighestContinuousWinCount:integer}).passthrough()).max(1),
  liveSettings:z.array(z.object({rewardUpStaminaConsumptionSettingQuantity:exact}).passthrough()).max(1),
  minigameSettings:unique(z.object({miniGameType:integer,consumptionSettingQuantity:exact}).passthrough(),['miniGameType']),
}
export const gameProgressKeys=Object.keys(gameProgressTables) as Array<keyof typeof gameProgressTables>
export const gameProgressSchema=z.object(gameProgressTables).partial()
export const gameProgressStateSchema=gameProgressSchema.extend({coverage:z.record(id,z.literal('complete')).optional()})
export type GameProgress=z.infer<typeof gameProgressStateSchema>
const identities:Record<keyof typeof gameProgressTables,string[]>={boardPresets:['characterId','number'],challengeLive:['liveTowerId'],fishingBaits:['parkFishingBaitId'],fishingFish:['parkFishingFishId'],fishing:[],pukaStages:['shogiId'],pukaMembers:['shogiId','characterId'],pukaPieces:['pieceType'],pukaPieceStats:['pieceType'],pukaSummary:[],liveSettings:[],minigameSettings:['miniGameType']}

/** A supplied complete list replaces that list, including deliberate empty
 * lists (deleted presets). Older/partial observations update supplied rows only.
 * An unavailable singleton never manufactures an all-zero account record. */
export function mergeGameProgress(previous:GameProgress|undefined,tables:GameProgress,coverage:Record<string,unknown>={}):GameProgress {
  const result:Record<string,unknown>={...previous}
  const known={...previous?.coverage}
  for(const key of gameProgressKeys){
    const rows=tables[key]
    if(rows===undefined)continue
    const keys=identities[key]
    if(coverage[key]==='complete'&&(keys.length||rows.length))known[key]='complete'
    if(!keys.length){if(rows.length)result[key]=structuredClone(rows);continue}
    if(coverage[key]==='complete'){result[key]=structuredClone(rows);continue}
    const identity=(row:unknown)=>JSON.stringify(keys.map(k=>(row as Record<string,unknown>)[k]))
    const merged=new Map((previous?.[key]??[]).map(row=>[identity(row),row]))
    for(const row of rows)merged.set(identity(row),row)
    result[key]=structuredClone([...merged.values()])
  }
  if(Object.keys(known).length)result.coverage=known
  return result as GameProgress
}
