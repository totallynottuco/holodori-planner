import { loadVerifiedChartDenominators, type VerifiedChartDenominators } from '../hololive/vendor/shared/chart-denominators'
import {
  loadVerifiedOptimizerChartPack,
  OPTIMIZER_CHART_DIFFICULTIES,
  type ChartSummary,
  type OptimizerChartPackRuntime,
  REVIEWED_CHART_PACK,
} from '../hololive/vendor/shared/optimizer-chart-pack'
import { scoringDataSchema, validateScoringData, type ScoringData } from '../hololive/vendor/shared/scoring-data'
import type { AccountManifestShape } from '../hololive/vendor/shared/account-data'
import { LIVE_SCORE_CLIENT } from '../hololive/vendor/shared/live-score'
import { validateGameOptimizerEvents, type GameOptimizerEvent } from './game-optimizer-event-types'
import { validateChallengeStages, type ChallengeStage } from './challenge-stages'

export interface OptimizerResources {
  pack: OptimizerChartPackRuntime
  denominators: VerifiedChartDenominators
  data: ScoringData
  songs: Array<{ id: string; title: string; charts: ChartSummary[] }>
  account?: AccountManifestShape
  gameEvents?: GameOptimizerEvent[]
  challengeStages?: ChallengeStage[]
  previewHits?: unknown
  previewGeometry?: unknown
  previewSongStarts?: Readonly<Record<string, number>>
  optimizerSongRules?: Readonly<Record<string, { rateTarget: boolean; autoGiven: boolean }>>
  revision: number
  releaseId?: string
}

export type MobileScoringSource = { id: string; url: string; publicKey: string }
let pending: Promise<OptimizerResources> | undefined
let active: { source: MobileScoringSource; resources: Promise<OptimizerResources> } | undefined
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

async function fetchChartAsset(filename: string): Promise<Response> {
  const response = await fetch(`/assets/team-optimizer/${filename}`)
  if (!response.ok) throw new Error(`Unable to load ${filename} (${response.status})`)
  return response
}

const bundledReleaseSha256 = '5f770fa6e08b3bd79ca4fc04f11c5bd804b5c4a357bad4a487f416c772976426'

async function loadResources(): Promise<OptimizerResources> {
  const bytes = await (await fetchChartAsset('game-scoring-release.json')).arrayBuffer()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  if (Array.from(digest, byte => byte.toString(16).padStart(2,'0')).join('') !== bundledReleaseSha256)
    throw Error('The bundled game scoring release checksum did not verify.')
  return decodeRelease(new TextDecoder().decode(bytes))
}

async function assemble(data:ScoringData,index:unknown,blob:ArrayBuffer|Uint8Array,rawDenominators:unknown,
  release?: {account:AccountManifestShape;revision:number;chartIdentity:Parameters<typeof loadVerifiedOptimizerChartPack>[3];
    gameEvents?:unknown;challengeStages?:unknown;previewHits?:unknown;previewGeometry?:unknown;previewSongStarts?:unknown;optimizerSongRules?:unknown}) {
  const pack = await loadVerifiedOptimizerChartPack(index, blob, data.metadata, release?.chartIdentity)
  const mobileWeights=[1000,1050,1000,100,100,1000,1000]
  if(release&&mobileWeights.some((weight,index)=>pack.mobileNoteWeightsPermil.get(index+1)!==weight))
    throw Error('The Mobile scoring release changes the reviewed note coefficients.')
  const integrity = pack.index.metadata.integrity
  if (data.metadata.chartIndexSha256 !== integrity.indexSha256
    || data.metadata.chartBlobSha256 !== integrity.eventBlobSha256) {
    throw new Error('Scoring and chart identities do not match')
  }

  const chartMusicIds = new Set(pack.index.musicIds)
  const songsById = new Map<string, OptimizerResources['songs'][number]>()
  for (const [id, song] of Object.entries(data.songs)) {
    if (song.id !== id || !chartMusicIds.has(id)) throw new Error('Scoring and chart song coverage does not match')
    songsById.set(id, { id, title: song.title, charts: [] })
  }
  if (songsById.size !== chartMusicIds.size) throw new Error('Scoring and chart song coverage does not match')

  for (const [key, row] of pack.rowsByKey) {
    const musicId = pack.index.musicIds[row[0]]
    songsById.get(musicId)!.charts.push({
      key, musicId, difficulty: OPTIMIZER_CHART_DIFFICULTIES[row[1]],
      difficultyLevel: row[2], durationMicroseconds: row[4], totalNotes: row[5],
    })
  }

  const denominators = await loadVerifiedChartDenominators(rawDenominators, pack, !!release)
  const songs = [...songsById.values()].sort((left, right) => left.title.localeCompare(right.title))
  const gameEvents = validateGameOptimizerEvents(release?.gameEvents, chartMusicIds)
  const challengeStages = release?.challengeStages === undefined ? undefined : validateChallengeStages(release.challengeStages)
  const rawStarts = release?.previewSongStarts
  const previewSongStarts = rawStarts && typeof rawStarts === 'object' && !Array.isArray(rawStarts)
    ? Object.fromEntries(Object.entries(rawStarts).filter(([id, time]) => chartMusicIds.has(id) &&
      typeof time === 'number' && Number.isSafeInteger(time) && time > 0 && time <= 8.64e15)) : undefined
  const rawRules = release?.optimizerSongRules
  const optimizerSongRules = rawRules && typeof rawRules === 'object' && !Array.isArray(rawRules)
    ? Object.fromEntries(Object.entries(rawRules).flatMap(([id, rule]) => chartMusicIds.has(id) &&
      typeof rule?.rateTarget === 'boolean' && typeof rule.autoGiven === 'boolean' ?
      [[id,{rateTarget:rule.rateTarget as boolean,autoGiven:rule.autoGiven as boolean}]] : [])) : undefined
  return { pack, denominators, data, songs, account:release?.account, gameEvents, challengeStages, previewHits:release?.previewHits,
    previewGeometry:release?.previewGeometry, previewSongStarts, optimizerSongRules, revision:release?.revision??0 }
}

async function readSignedRelease(source:MobileScoringSource):Promise<OptimizerResources> {
  const response=await fetch(source.url)
  if(!response.ok)throw Error('The Mobile scoring release is unavailable.')
  const text=await response.text()
  if(text.length>18_000_000)throw Error('The Mobile scoring release is too large.')
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))
  if(Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('')!==source.id)
    throw Error('The Mobile scoring release checksum did not verify.')
  const {payload,signature}=JSON.parse(text)
  if(typeof payload!=='string'||typeof signature!=='string')throw Error('Invalid Mobile scoring release.')
  const bytes=new TextEncoder().encode(payload)
  const key=await crypto.subtle.importKey('raw',decode(source.publicKey),'Ed25519',false,['verify'])
  if(!await crypto.subtle.verify('Ed25519',key,decode(signature),bytes))throw Error('Mobile scoring release signature did not verify.')
  return {...await decodeRelease(payload),releaseId:source.id}
}

async function decodeRelease(payload:string):Promise<OptimizerResources> {
  const {schema,revision,client,account,scoring,index,events,denominators,gameEvents,challengeStages,previewHits,previewGeometry,
    previewSongStarts,optimizerSongRules}=JSON.parse(payload)
  if(schema!==1||!Number.isSafeInteger(revision)||revision<1||
    client?.nativeSha256!==LIVE_SCORE_CLIENT.nativeSha256||
    client?.settingSha256!==LIVE_SCORE_CLIENT.settingSha256||client?.liveNoteSha256!==LIVE_SCORE_CLIENT.liveNoteSha256)
    throw Error('This Mobile scoring release requires a different scoring model.')
  const data=scoringDataSchema.parse(scoring)
  const asset=index?.metadata?.sources?.officialAssetCatalog
  const chartIdentity={...index?.metadata?.integrity,receiptSha256:asset?.acquisitionReceiptSha256,
    assetRevision:asset?.revision,downloaderCommit:asset?.downloaderCommit}
  if(data.metadata.sourceRepository!=='https://github.com/HolodoriDB/holodori-db-eng-diff'||
    !/^[0-9a-f]{40}$/.test(data.metadata.sourceCommit)||!asset||
    chartIdentity.downloaderCommit!==REVIEWED_CHART_PACK.downloaderCommit||
    account?.metadata?.sourceRepository!==data.metadata.sourceRepository)
    throw Error('Unsupported Mobile scoring source.')
  validateScoringData(data,{metadata:data.metadata,cards:Object.keys(data.cards).map(id=>({id}))},index.musicIds,account)
  return assemble(data,index,decode(events),denominators,{account,revision,chartIdentity,gameEvents,challengeStages,previewHits,previewGeometry,
    previewSongStarts,optimizerSongRules})
}

export async function verifyMobileScoringRelease(source:MobileScoringSource, previous?:MobileScoringSource) {
  const [candidate, bundled, last]=await Promise.all([readSignedRelease(source),loadOptimizerResources(),
    previous?readSignedRelease(previous).catch(()=>null):null])
  for(const base of [bundled,last]){
    if(!base)continue
    if(candidate.revision<=base.revision)throw Error('The Mobile scoring release is older than the local copy.')
    if(Object.keys(base.data.cards).some(id=>!candidate.data.cards[id])||
      [...base.pack.rowsByKey.keys()].some(id=>!candidate.pack.rowsByKey.has(id)))
      throw Error('The Mobile scoring release loses verified coverage.')
  }
  return candidate
}

export function loadOptimizerResources(source?:MobileScoringSource): Promise<OptimizerResources> {
  if(source){
    if(active?.source.id!==source.id||active?.source.publicKey!==source.publicKey)
      active={source,resources:Promise.all([readSignedRelease(source).catch(()=>null),loadOptimizerResources()])
        .then(([candidate,bundled])=>candidate && candidate.revision>=bundled.revision &&
          Object.keys(bundled.data.cards).every(id=>candidate.data.cards[id]) &&
          [...bundled.pack.rowsByKey.keys()].every(key=>candidate.pack.rowsByKey.has(key)) ? candidate : bundled)}
    return active.resources
  }
  pending ??= loadResources().catch(error => {
    pending = undefined
    throw error
  })
  return pending
}
