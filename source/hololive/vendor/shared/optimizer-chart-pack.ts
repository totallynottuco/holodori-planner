// Shared chart codec. Application callers enter through loadVerifiedOptimizerChartPack.
export const OPTIMIZER_CHART_PACK_SCHEMA_VERSION = 3 as const
export const OPTIMIZER_CHART_EVENT_BLOB_MAGIC = 'HDOCHRT3'
export const OPTIMIZER_CHART_EVENT_BLOB_HEADER_BYTES = 16
export const OPTIMIZER_CHART_EVENT_RECORD_BYTES = 5

export const REVIEWED_CHART_PACK = Object.freeze({
  indexSha256: '2cd1caa51b2f79b7515dbe5129523d41dbae065b38ba5fe309ccb7ec4ca00044',
  eventBlobSha256: '54af29f92adfc1c52eabc5d5c31f619bd26f141ea271e17e6844556b6e3eb345',
  receiptSha256: 'f6a2d05a4f3a6da96403986910d841dce2d68bfb740c6baf8bcf30ff969e3e58',
  assetRevision: 69,
  downloaderCommit: '13f150fe9dfbd367be53e5ea1c0a4ceb258b74f2'
})

export const OPTIMIZER_CHART_DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const
export type OptimizerDifficulty = (typeof OPTIMIZER_CHART_DIFFICULTIES)[number]
export type OptimizerChartDifficultyCode = 0 | 1 | 2 | 3
export type OptimizerChartPlatform = 'mobile' | 'pc'

export type OptimizerChartSpecialPoints = [
  number | null,
  number | null,
  number | null,
  number | null,
  number | null
]

/** Event offsets address fixed-width records in the companion binary blob. */
export type PackedOptimizerChartV3 = [
  musicIndex: number,
  difficulty: OptimizerChartDifficultyCode,
  difficultyLevel: number,
  officialChartHash: string,
  durationMicroseconds: number,
  fullComboCount: number,
  normalCount: number,
  flickCount: number,
  longStartCount: number,
  longRelayCount: number,
  longContinuationCount: number,
  longEndCount: number,
  longFlickEndCount: number,
  ghostCount: number,
  specialPointsMicroseconds: OptimizerChartSpecialPoints,
  eventRecordOffset: number,
  eventCount: number
]

export type OptimizerChartNoteTypeDefinition = [
  officialType: number,
  name: string,
  mobilePerfectWeightPermil: number,
  pcPerfectWeightPermil: number
]

export interface OptimizerChartPackV3 {
  schemaVersion: typeof OPTIMIZER_CHART_PACK_SCHEMA_VERSION
  metadata: {
    generatedAt: string
    catalogVersion: string
    sources: {
      holodoriDb: { repository: string; commit: string }
      officialAssetCatalog: {
        revision: number
        downloader: string
        downloaderVersion: string
        downloaderCommit: string
        acquisitionReceiptSha256: string
        digestVerification: 'MusicDifficultyChart.chartHash == catalog MD5 == deterministically re-encrypted raw resource MD5'
          | 'official asset catalog MD5 and independent master chart counts'
        rawChartsIncluded: false
      }
    }
    transform: {
      timingResolution: 'microseconds'
      eventRecord: 'uint32le-delta-microseconds,uint8-official-note-type'
      continuationRule: 'global-eighth-note-grid'
      simultaneousOrdering: 'tick-note-type-lane-source'
      strippedFields: string[]
      redistributionReviewRequired: true
    }
    coverage: {
      songs: number
      charts: number
      scoringEvents: number
      officialNormalEvents: number
      ghostEventsExcluded: number
      missingSpecialSlots: number
      minimumDifficultyLevel: number
      maximumDifficultyLevel: number
    }
    integrity: {
      algorithm: 'SHA-256'
      indexSha256: string
      eventBlobSha256: string
      eventBlobBytes: number
    }
  }
  noteTypes: OptimizerChartNoteTypeDefinition[]
  musicIds: string[]
  charts: PackedOptimizerChartV3[]
}

export interface OptimizerChartPackRuntime {
  index: OptimizerChartPackV3
  eventBlob: Uint8Array
  /** Mobile PERFECT coefficients retained as the corpus default. */
  noteWeightsPermil: ReadonlyMap<number, number>
  mobileNoteWeightsPermil: ReadonlyMap<number, number>
  pcNoteWeightsPermil: ReadonlyMap<number, number>
  rowsByKey: ReadonlyMap<string, PackedOptimizerChartV3>
}

export interface OptimizerDecodedChart {
  key: string
  platform: OptimizerChartPlatform
  identity: {
    chartKey: string
    platform: OptimizerChartPlatform
    schemaVersion: 3
    indexSha256: string
    eventBlobSha256: string
    catalogVersion: string
    sourceRepository: string
    sourceCommit: string
    assetRevision: number
  }
  /** Exact event corpus digest bound into the reported score-model version. */
  chartPackEventBlobSha256: string
  music_id: string
  difficulty: OptimizerDifficulty
  difficultyLevel: number
  officialChartHash: string
  durationMicroseconds: number
  duration: number
  total_notes: number
  specialPointsMicroseconds: OptimizerChartSpecialPoints
  special_points: Array<number | null>
  counts: {
    normal: number
    flick: number
    longStart: number
    longEnd: number
    longFlickEnd: number
    longRelay: number
    longContinuation: number
    ghost: number
  }
  /** Absolute event time in integer microseconds. */
  eventTimesMicroseconds: Uint32Array
  /** Official `LiveNoteType` numeric values (1-7). */
  eventNoteTypes: Uint8Array
  /** Platform-selected PERFECT coefficient, materialized for the selected chart only. */
  eventWeightsPermil: Uint16Array
  /** Prefix sum of PERFECT event weights; element 0 is the empty prefix. */
  cumulativeEventWeightsPermil: Float64Array
  /** Prefix sum of event weight × official multiplier for combo indexes 1..N. */
  cumulativeComboWeightedEventWeightsPermilSquared: Float64Array
}

export interface OptimizerChartEvent {
  timeMicroseconds: number
  time: number
  noteType: number
  weightPermil: number
  comboIndex: number
}

function fail(message: string): never {
  throw new Error(`Invalid optimizer chart pack: ${message}`)
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`)
  return value
}

function fixedTuple(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) fail(`${label} must contain exactly ${length} values`)
  return value
}

function noteTypeMaps(noteTypes: unknown): { mobile: Map<number, number>; pc: Map<number, number> } {
  if (!Array.isArray(noteTypes) || noteTypes.length !== 7) fail('noteTypes must define the seven score-bearing official types')
  const mobile = new Map<number, number>()
  const pc = new Map<number, number>()
  for (const [index, raw] of noteTypes.entries()) {
    const entry = fixedTuple(raw, 4, `noteTypes[${index}]`)
    const type = integer(entry[0], `noteTypes[${index}].type`, 1)
    const mobileWeight = integer(entry[2], `noteTypes[${index}].mobileWeight`, 1)
    const pcWeight = integer(entry[3], `noteTypes[${index}].pcWeight`, 1)
    if (type > 7) fail(`unknown official note type ${type}`)
    if (mobileWeight > 65_535 || pcWeight > 65_535) fail('note coefficient exceeds uint16 range')
    if (typeof entry[1] !== 'string' || !entry[1]) fail(`noteTypes[${index}].name must be present`)
    if (mobile.has(type)) fail(`duplicate note type ${type}`)
    mobile.set(type, mobileWeight)
    pc.set(type, pcWeight)
  }
  return { mobile, pc }
}

function countFields(row: PackedOptimizerChartV3): number[] {
  return row.slice(6, 13) as number[]
}

function blobView(blob: ArrayBuffer | ArrayBufferView): Uint8Array {
  return blob instanceof ArrayBuffer
    ? new Uint8Array(blob)
    : new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)
}

function readMagic(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(0, OPTIMIZER_CHART_EVENT_BLOB_MAGIC.length))
}

function rowKey(pack: OptimizerChartPackV3, row: PackedOptimizerChartV3): string {
  return `${pack.musicIds[row[0]]}_${OPTIMIZER_CHART_DIFFICULTIES[row[1]]}`
}

/** Official Live Combo score multiplier at a one-based combo index. */
export function officialComboMultiplierPermil(comboIndex: number): number {
  if (!Number.isSafeInteger(comboIndex) || comboIndex < 1) fail('combo index must be a positive integer')
  return 1_000 + Math.min(10, Math.floor(comboIndex / 100)) * 10
}

export function optimizerChartPackIndexDigestSource(pack: Pick<OptimizerChartPackV3, 'noteTypes' | 'musicIds' | 'charts'>): string {
  return JSON.stringify([pack.noteTypes, pack.musicIds, pack.charts])
}

export function decodeOptimizerChartPack(
  raw: unknown,
  rawEventBlob: ArrayBuffer | ArrayBufferView
): OptimizerChartPackRuntime {
  if (!raw || typeof raw !== 'object') fail('root must be an object')
  const pack = raw as OptimizerChartPackV3
  if (pack.schemaVersion !== OPTIMIZER_CHART_PACK_SCHEMA_VERSION) fail(`unsupported schema ${String(pack.schemaVersion)}`)
  if (!pack.metadata || typeof pack.metadata !== 'object') fail('metadata is missing')
  if (!Array.isArray(pack.musicIds) || new Set(pack.musicIds).size !== pack.musicIds.length
    || pack.musicIds.some((id) => typeof id !== 'string' || !/^m\d{4}$/u.test(id))) fail('musicIds are invalid or duplicated')
  if (!Array.isArray(pack.charts)) fail('charts must be an array')
  const noteWeights = noteTypeMaps(pack.noteTypes)
  const weights = noteWeights.mobile
  const eventBlob = blobView(rawEventBlob)
  if (eventBlob.byteLength < OPTIMIZER_CHART_EVENT_BLOB_HEADER_BYTES
    || readMagic(eventBlob) !== OPTIMIZER_CHART_EVENT_BLOB_MAGIC) fail('event blob magic is invalid')
  const header = new DataView(eventBlob.buffer, eventBlob.byteOffset, OPTIMIZER_CHART_EVENT_BLOB_HEADER_BYTES)
  const headerEventCount = header.getUint32(8, true)
  const headerChartCount = header.getUint32(12, true)
  if (headerChartCount !== pack.charts.length) fail('event blob chart count does not match the index')
  if (eventBlob.byteLength !== OPTIMIZER_CHART_EVENT_BLOB_HEADER_BYTES + headerEventCount * OPTIMIZER_CHART_EVENT_RECORD_BYTES) {
    fail('event blob byte length does not match its header')
  }

  const rowsByKey = new Map<string, PackedOptimizerChartV3>()
  let expectedRecordOffset = 0
  let eventTotal = 0
  let normalTotal = 0
  let ghostTotal = 0
  let missingSpecialSlots = 0
  const data = new DataView(eventBlob.buffer, eventBlob.byteOffset, eventBlob.byteLength)

  for (const [chartIndex, rawRow] of pack.charts.entries()) {
    const row = fixedTuple(rawRow, 17, `charts[${chartIndex}]`) as unknown as PackedOptimizerChartV3
    const musicIndex = integer(row[0], `charts[${chartIndex}].musicIndex`)
    const difficultyCode = integer(row[1], `charts[${chartIndex}].difficulty`)
    if (musicIndex >= pack.musicIds.length || difficultyCode > 3) fail(`charts[${chartIndex}] has an invalid key index`)
    const difficultyLevel = integer(row[2], `charts[${chartIndex}].difficultyLevel`, 1)
    if (difficultyLevel > 30) fail(`charts[${chartIndex}].difficultyLevel must be <= 30`)
    if (typeof row[3] !== 'string' || !/^[0-9a-f]{32}$/u.test(row[3])) fail(`charts[${chartIndex}] has an invalid official hash`)
    const durationMicroseconds = integer(row[4], `charts[${chartIndex}].duration`, 1)
    if (durationMicroseconds > 0xffff_ffff) fail('duration exceeds uint32 range')
    const fullCombo = integer(row[5], `charts[${chartIndex}].fullCombo`, 1)
    const counts = countFields(row).map((value, index) => integer(value, `charts[${chartIndex}].count[${index}]`))
    const ghost = integer(row[13], `charts[${chartIndex}].ghost`)
    fixedTuple(row[14], 5, `charts[${chartIndex}].specialPoints`).forEach((value, index) => {
      if (value === null) {
        missingSpecialSlots += 1
        return
      }
      const point = integer(value, `charts[${chartIndex}].specialPoints[${index}]`)
      if (point > durationMicroseconds) fail(`charts[${chartIndex}] has an SP point beyond its duration`)
    })
    const recordOffset = integer(row[15], `charts[${chartIndex}].eventRecordOffset`)
    const eventCount = integer(row[16], `charts[${chartIndex}].eventCount`, 1)
    if (recordOffset !== expectedRecordOffset) fail(`charts[${chartIndex}] event slice is not contiguous`)
    if (eventCount !== fullCombo || counts.reduce((sum, value) => sum + value, 0) !== fullCombo) {
      fail(`charts[${chartIndex}] official count total is inconsistent`)
    }
    if (recordOffset + eventCount > headerEventCount) fail(`charts[${chartIndex}] event slice exceeds the blob`)

    const actualCounts = new Map<number, number>()
    let timeMicroseconds = 0
    for (let record = recordOffset; record < recordOffset + eventCount; record += 1) {
      const byteOffset = OPTIMIZER_CHART_EVENT_BLOB_HEADER_BYTES + record * OPTIMIZER_CHART_EVENT_RECORD_BYTES
      timeMicroseconds += data.getUint32(byteOffset, true)
      if (!Number.isSafeInteger(timeMicroseconds) || timeMicroseconds > durationMicroseconds || timeMicroseconds > 0xffff_ffff) fail(`chart ${chartIndex} event timing exceeds its duration or uint32 range`)
      const type = data.getUint8(byteOffset + 4)
      if (!weights.has(type)) fail(`chart ${chartIndex} uses unknown note type ${type}`)
      actualCounts.set(type, (actualCounts.get(type) ?? 0) + 1)
    }
    for (let type = 1; type <= 7; type += 1) {
      if ((actualCounts.get(type) ?? 0) !== counts[type - 1]) fail(`charts[${chartIndex}] note type ${type} count is inconsistent`)
    }

    const key = rowKey(pack, row)
    if (rowsByKey.has(key)) fail(`duplicate chart ${key}`)
    rowsByKey.set(key, row)
    expectedRecordOffset += eventCount
    eventTotal += eventCount
    normalTotal += counts[0]
    ghostTotal += ghost
  }
  if (expectedRecordOffset !== headerEventCount) fail('event blob contains an unindexed tail')
  const coverage = pack.metadata.coverage
  if (!coverage || coverage.songs !== pack.musicIds.length || coverage.charts !== pack.charts.length
    || coverage.scoringEvents !== eventTotal || coverage.officialNormalEvents !== normalTotal
    || coverage.ghostEventsExcluded !== ghostTotal || coverage.missingSpecialSlots !== missingSpecialSlots
    || coverage.minimumDifficultyLevel !== Math.min(...pack.charts.map((row) => row[2]))
    || coverage.maximumDifficultyLevel !== Math.max(...pack.charts.map((row) => row[2]))) {
    fail('coverage metadata is inconsistent')
  }
  const integrity = pack.metadata.integrity
  if (!integrity || integrity.algorithm !== 'SHA-256'
    || !/^[0-9a-f]{64}$/u.test(integrity.indexSha256)
    || !/^[0-9a-f]{64}$/u.test(integrity.eventBlobSha256)
    || integrity.eventBlobBytes !== eventBlob.byteLength) fail('integrity metadata is invalid')
  const assetSource = pack.metadata.sources?.officialAssetCatalog
  if (!assetSource || !Number.isSafeInteger(assetSource.revision) || assetSource.revision < 1
    || assetSource.downloader !== 'https://github.com/HolodoriDB/holodori-asset-tools'
    || typeof assetSource.downloaderVersion !== 'string' || !assetSource.downloaderVersion
    || !/^[0-9a-f]{40}$/u.test(assetSource.downloaderCommit)
    || !/^[0-9a-f]{64}$/u.test(assetSource.acquisitionReceiptSha256)
    || !['MusicDifficultyChart.chartHash == catalog MD5 == deterministically re-encrypted raw resource MD5',
      'official asset catalog MD5 and independent master chart counts'].includes(assetSource.digestVerification)
    || assetSource.rawChartsIncluded !== false) fail('official chart acquisition provenance is invalid')
  return {
    index: pack,
    eventBlob,
    noteWeightsPermil: noteWeights.mobile,
    mobileNoteWeightsPermil: noteWeights.mobile,
    pcNoteWeightsPermil: noteWeights.pc,
    rowsByKey
  }
}

/** Decode one selected chart into cache-friendly typed arrays. */
export function decodeOptimizerChart(
  pack: OptimizerChartPackRuntime,
  key: string,
  platform: OptimizerChartPlatform
): OptimizerDecodedChart {
  if (platform !== 'mobile' && platform !== 'pc') fail(`unsupported platform ${String(platform)}`)
  const row = pack.rowsByKey.get(key)
  if (!row) fail(`unknown chart ${key}`)
  const eventCount = row[16]
  const times = new Uint32Array(eventCount)
  const types = new Uint8Array(eventCount)
  const weights = new Uint16Array(eventCount)
  const cumulativeWeights = new Float64Array(eventCount + 1)
  const cumulativeComboWeights = new Float64Array(eventCount + 1)
  const view = new DataView(pack.eventBlob.buffer, pack.eventBlob.byteOffset, pack.eventBlob.byteLength)
  const noteWeights = platform === 'pc' ? pack.pcNoteWeightsPermil : pack.mobileNoteWeightsPermil
  let timeMicroseconds = 0
  for (let index = 0; index < eventCount; index += 1) {
    const record = row[15] + index
    const offset = OPTIMIZER_CHART_EVENT_BLOB_HEADER_BYTES + record * OPTIMIZER_CHART_EVENT_RECORD_BYTES
    timeMicroseconds += view.getUint32(offset, true)
    if (!Number.isSafeInteger(timeMicroseconds) || timeMicroseconds > row[4] || timeMicroseconds > 0xffff_ffff) fail(`chart ${key} event timing exceeds its duration or uint32 range`)
    const type = view.getUint8(offset + 4)
    const weight = noteWeights.get(type)
    if (type < 1 || type > 7 || !weight) fail(`chart ${key} uses unknown note type ${type}`)
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 65_535) fail('note coefficient exceeds uint16 range')
    const prefixWeight = cumulativeWeights[index] + weight
    const prefixComboWeight = cumulativeComboWeights[index] + weight * officialComboMultiplierPermil(index + 1)
    if (!Number.isSafeInteger(prefixWeight) || !Number.isSafeInteger(prefixComboWeight)) fail('event prefix sum exceeds the safe integer range')
    times[index] = timeMicroseconds
    types[index] = type
    weights[index] = weight
    cumulativeWeights[index + 1] = prefixWeight
    cumulativeComboWeights[index + 1] = prefixComboWeight
  }
  const special = [...row[14]] as OptimizerChartSpecialPoints
  const musicId = pack.index.musicIds[row[0]]
  const difficulty = OPTIMIZER_CHART_DIFFICULTIES[row[1]]
  return {
    key,
    platform,
    identity: {
      chartKey: key, platform, schemaVersion: pack.index.schemaVersion,
      indexSha256: pack.index.metadata.integrity.indexSha256,
      eventBlobSha256: pack.index.metadata.integrity.eventBlobSha256,
      catalogVersion: pack.index.metadata.catalogVersion,
      sourceRepository: pack.index.metadata.sources.holodoriDb.repository,
      sourceCommit: pack.index.metadata.sources.holodoriDb.commit,
      assetRevision: pack.index.metadata.sources.officialAssetCatalog.revision
    },
    chartPackEventBlobSha256: pack.index.metadata.integrity.eventBlobSha256,
    music_id: musicId,
    difficulty,
    difficultyLevel: row[2],
    officialChartHash: row[3],
    durationMicroseconds: row[4],
    duration: row[4] / 1_000_000,
    total_notes: row[5],
    specialPointsMicroseconds: special,
    special_points: special.map((point) => point === null ? null : point / 1_000_000),
    counts: {
      normal: row[6], flick: row[7], longStart: row[8], longRelay: row[9],
      longContinuation: row[10], longEnd: row[11], longFlickEnd: row[12], ghost: row[13]
    },
    eventTimesMicroseconds: times,
    eventNoteTypes: types,
    eventWeightsPermil: weights,
    cumulativeEventWeightsPermil: cumulativeWeights,
    cumulativeComboWeightedEventWeightsPermilSquared: cumulativeComboWeights
  }
}

export function forEachOptimizerChartEvent(
  chart: OptimizerDecodedChart,
  visit: (event: OptimizerChartEvent) => void
): void {
  for (let index = 0; index < chart.eventTimesMicroseconds.length; index += 1) {
    const timeMicroseconds = chart.eventTimesMicroseconds[index]
    visit({
      timeMicroseconds,
      time: timeMicroseconds / 1_000_000,
      noteType: chart.eventNoteTypes[index],
      weightPermil: chart.eventWeightsPermil[index],
      comboIndex: index + 1
    })
  }
}

async function sha256(value: string | Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) fail('Web Crypto is unavailable for chart-pack verification')
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

export async function verifyOptimizerChartPackIntegrity(pack: OptimizerChartPackRuntime): Promise<void> {
  const [indexDigest, blobDigest] = await Promise.all([
    sha256(optimizerChartPackIndexDigestSource(pack.index)),
    sha256(pack.eventBlob)
  ])
  if (indexDigest !== pack.index.metadata.integrity.indexSha256) fail('index integrity digest does not match')
  if (blobDigest !== pack.index.metadata.integrity.eventBlobSha256) fail('event-blob integrity digest does not match')
}

export interface ChartCatalogIdentity {
  catalogVersion: string
  sourceRepository: string
  sourceCommit: string
}

/** The single runtime boundary: copy inputs, validate all records and provenance, then verify bytes. */
export async function loadVerifiedOptimizerChartPack(raw: unknown, blob: ArrayBuffer | ArrayBufferView, catalog: ChartCatalogIdentity,
  approved: {indexSha256:string; eventBlobSha256:string; receiptSha256:string; assetRevision:number; downloaderCommit:string} = REVIEWED_CHART_PACK): Promise<OptimizerChartPackRuntime> {
  const pack = decodeOptimizerChartPack(structuredClone(raw), Uint8Array.from(blobView(blob)))
  const metadata = pack.index.metadata
  if (metadata.catalogVersion !== catalog.catalogVersion
    || metadata.sources.holodoriDb?.repository !== catalog.sourceRepository
    || metadata.sources.holodoriDb?.commit !== catalog.sourceCommit) fail('catalog/source revision mismatch')
  const asset = metadata.sources.officialAssetCatalog
  if (metadata.integrity.indexSha256 !== approved.indexSha256
    || metadata.integrity.eventBlobSha256 !== approved.eventBlobSha256
    || asset.acquisitionReceiptSha256 !== approved.receiptSha256
    || asset.revision !== approved.assetRevision
    || asset.downloaderCommit !== approved.downloaderCommit) fail('reviewed chart-pack identity changed')
  const transform = metadata.transform
  if (transform?.timingResolution !== 'microseconds'
    || transform.eventRecord !== 'uint32le-delta-microseconds,uint8-official-note-type'
    || transform.continuationRule !== 'global-eighth-note-grid'
    || transform.simultaneousOrdering !== 'tick-note-type-lane-source'
    || transform.redistributionReviewRequired !== true
    || !Array.isArray(transform.strippedFields)
    || !['lane', 'width', 'slideGeometry', 'slideTopology', 'bpmMap', 'rawSus'].every((field) => transform.strippedFields.includes(field))) fail('unsupported chart transform')
  await verifyOptimizerChartPackIntegrity(pack)
  return pack
}

export interface ChartSummary {
  key: string
  musicId: string
  difficulty: OptimizerDifficulty
  difficultyLevel: number
  durationMicroseconds: number
  totalNotes: number
}
