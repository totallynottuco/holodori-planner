import { FORMATION_TOTAL_MODEL_VERSION } from './formation-total'
import { normalizedScoringInputs } from './scoring-inputs'
import type { ScoringData } from './scoring-data'
import type { TeamParameterReport } from './team-parameters'
import type { AppProfileV2, BoardRepairSummary } from './types'

export type ScoringDigest = (value: unknown) => string
export interface ScoringManifestDigests {
  scoringManifestSha256: string
  accountManifestSha256: string
  progressionManifestSha256: string
}

/** Identical read-only report identity for CLI and desktop, independent of paths or revision. */
export function describeScoringInputs(profile: AppProfileV2, sourceSchemaVersion: unknown, boardRepairs: BoardRepairSummary[], team: TeamParameterReport, data: ScoringData, manifests: ScoringManifestDigests, digest: ScoringDigest) {
  const fingerprints = { normalizedInputsSha256: digest(normalizedScoringInputs(profile, team.selection)),
    scoringManifestSha256: manifests.scoringManifestSha256, accountManifestSha256: manifests.accountManifestSha256, progressionManifestSha256: manifests.progressionManifestSha256 }
  return {
    identity: { modelVersion: team.modelVersion, formationModelVersion: FORMATION_TOTAL_MODEL_VERSION, overallPowerModelVersion: team.overallPower.modelVersion,
      sourceRepository: data.metadata.sourceRepository, sourceCommit: data.metadata.sourceCommit, catalogVersion: data.metadata.catalogVersion,
      scoringSchemaVersion: data.schemaVersion, chartIndexSha256: data.metadata.chartIndexSha256, chartBlobSha256: data.metadata.chartBlobSha256, ...fingerprints,
      reportInputsSha256: digest({ ...fingerprints, modelVersion: team.modelVersion, formationModelVersion: FORMATION_TOTAL_MODEL_VERSION, overallPowerModelVersion: team.overallPower.modelVersion }) },
    preparation: { sourceSchemaVersion, normalizedSchemaVersion: profile.schemaVersion, profileRevision: profile.revision,
      notices: sourceSchemaVersion === profile.schemaVersion ? [] : [`Profile schema ${sourceSchemaVersion} normalized to ${profile.schemaVersion} in memory; source unchanged`], boardRepairs }
  }
}
