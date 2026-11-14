import catalog from '../data/progression.json'
import reviewed from '../data/scoring-identity.json'
import { accountManifest } from './account-data'
import { canonicalScoringJson, validateScoringData } from './scoring-data'
import { REVIEWED_CHART_PACK } from './optimizer-chart-pack'
import type { ProgressionManifest } from './types'

/** Runtime and tooling use the same reviewed identities and compatibility checks. */
export function verifyReviewedScoringData(input: unknown, musicIds: readonly string[], digest: (input: unknown) => string) {
  verifyReviewedScoringManifests(accountManifest, catalog, digest)
  const data = validateScoringData(input, catalog as ProgressionManifest, musicIds)
  if (digest(data) !== reviewed.manifestSha256) throw new Error('Scoring manifest digest mismatch')
  if (data.metadata.sourceCommit !== reviewed.sourceCommit || canonicalScoringJson(data.metadata.sourceTableSha256) !== canonicalScoringJson(reviewed.sourceTableSha256)) throw new Error('Scoring source identity mismatch')
  if (data.metadata.chartIndexSha256 !== REVIEWED_CHART_PACK.indexSha256 || data.metadata.chartBlobSha256 !== REVIEWED_CHART_PACK.eventBlobSha256) throw new Error('Scoring/chart identity mismatch')
  return data
}

export function verifyReviewedScoringManifests(account: unknown, progression: unknown, digest: (input: unknown) => string): void {
  if (digest(account) !== reviewed.accountManifestSha256 || digest(progression) !== reviewed.progressionManifestSha256) throw new Error('Scoring input manifest compatibility digest mismatch')
}
