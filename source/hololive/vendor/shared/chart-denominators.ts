import { z } from 'zod'
import { LIVE_SCORE_CLIENT } from './live-score'
import { REVIEWED_CHART_PACK, type OptimizerChartPackRuntime } from './optimizer-chart-pack'

export const CHART_DENOMINATOR_MODEL_VERSION = 'android-1.1.0-complete-note-set-v1'
export const REVIEWED_DENOMINATORS_SHA256 = '0c4e18e8e6820abbf983b2e70c74cfb994a7ea24f6241e3f447221429e333a26'
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(2_147_483_647)
export const chartDenominatorSchema = z.object({
  officialChartHash: z.string().regex(/^[a-f0-9]{32}$/), rawSourceSha256: sha256,
  difficultyLevel: z.number().int().min(1).max(30), scoringEvents: count,
  scoringEventPerfectSumPermil: count, inactiveHoldRelayCount: count,
  inactiveHoldRelayWeightPermil: z.literal(100), mergedControlMarkerCount: count,
  completePerfectSumPermil: count.positive()
}).strict()
export const chartDenominatorManifestSchema = z.object({
  schemaVersion: z.literal(1), modelVersion: z.literal(CHART_DENOMINATOR_MODEL_VERSION),
  identity: z.object({
    platform: z.literal('mobile'), clientNativeSha256: sha256, sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    catalogVersion: z.string(), chartIndexSha256: sha256, chartBlobSha256: sha256, acquisitionReceiptSha256: sha256
  }).strict(),
  charts: z.record(z.string().regex(/^m\d{4}_(easy|normal|hard|expert)$/), chartDenominatorSchema)
}).strict()
export type ChartDenominator = z.infer<typeof chartDenominatorSchema>
export type ChartDenominatorManifest = z.infer<typeof chartDenominatorManifestSchema>

/** Canonical JSON independent of key ordering, whitespace or machine paths. */
export function chartDenominatorDigestSource(raw: ChartDenominatorManifest): string {
  const parsed = chartDenominatorManifestSchema.parse(raw)
  return JSON.stringify({ ...parsed, charts: Object.fromEntries(Object.entries(parsed.charts).sort(([a], [b]) => a.localeCompare(b))) })
}

export interface VerifiedChartDenominators {
  readonly sha256: string
  readonly modelVersion: typeof CHART_DENOMINATOR_MODEL_VERSION
  readonly identity?: ChartDenominatorManifest['identity']
  get(chartKey: string): ChartDenominator | undefined
}

/** A small companion to the unchanged v3 corpus. No raw chart paths or data
 * cross this runtime boundary. Failed validation is never cached here.
 */
export async function loadVerifiedChartDenominators(raw: unknown, pack: OptimizerChartPackRuntime, signedRelease = false): Promise<VerifiedChartDenominators> {
  const manifest = chartDenominatorManifestSchema.parse(raw), id = manifest.identity
  if (id.clientNativeSha256 !== LIVE_SCORE_CLIENT.nativeSha256 || (!signedRelease && id.sourceCommit !== LIVE_SCORE_CLIENT.sourceCommit)
    || id.sourceCommit !== pack.index.metadata.sources.holodoriDb.commit || id.catalogVersion !== pack.index.metadata.catalogVersion
    || (!signedRelease && (id.chartIndexSha256 !== REVIEWED_CHART_PACK.indexSha256 || id.chartBlobSha256 !== REVIEWED_CHART_PACK.eventBlobSha256))
    || id.chartIndexSha256 !== pack.index.metadata.integrity.indexSha256 || id.chartBlobSha256 !== pack.index.metadata.integrity.eventBlobSha256
    || id.acquisitionReceiptSha256 !== pack.index.metadata.sources.officialAssetCatalog.acquisitionReceiptSha256) throw new Error('Incompatible chart denominator identity')
  if (Object.keys(manifest.charts).length !== pack.rowsByKey.size) throw new Error('Incomplete chart denominator coverage')
  for (const [key, row] of pack.rowsByKey) {
    const evidence = manifest.charts[key]
    if (!evidence || evidence.officialChartHash !== row[3] || evidence.difficultyLevel !== row[2] || evidence.scoringEvents !== row[16]) throw new Error(`Chart denominator evidence mismatch: ${key}`)
    const typeCounts = [row[6], row[7], row[8], row[9], row[10], row[11], row[12]]
    const scoreSum = typeCounts.reduce((total, n, index) => total + n * pack.mobileNoteWeightsPermil.get(index + 1)!, 0)
    if (evidence.scoringEventPerfectSumPermil !== scoreSum || evidence.completePerfectSumPermil !== scoreSum + evidence.inactiveHoldRelayCount * evidence.inactiveHoldRelayWeightPermil) throw new Error(`Chart denominator coefficient mismatch: ${key}`)
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(chartDenominatorDigestSource(manifest))))
  const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  if (!signedRelease && actual !== REVIEWED_DENOMINATORS_SHA256) throw new Error('Chart denominator digest mismatch')
  return Object.freeze({ sha256: actual, modelVersion: CHART_DENOMINATOR_MODEL_VERSION, identity: Object.freeze({...id}),
    get(key: string) { const row = Object.hasOwn(manifest.charts, key) ? manifest.charts[key] : undefined; return row ? { ...row } : undefined } })
}
