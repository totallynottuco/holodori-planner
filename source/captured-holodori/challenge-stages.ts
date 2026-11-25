export interface ChallengeStage {
  id: string
  towerId: string
  number: number
  songIds: string[]
  clearScore: number
  bonusCharacterIds: string[]
  bonusPermil: number
  startTime: number
  endTime: number
}

function ids(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) && new Set(value).size === value.length &&
    value.every(id => typeof id === 'string' && pattern.test(id))
}
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

export function validateChallengeStages(rows: unknown): ChallengeStage[] {
  if (!Array.isArray(rows)) throw Error('Invalid Challenge Live stage catalog.')
  const keys = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row.towerId !== 'string' || !/^[\w-]+$/.test(row.towerId) ||
      !nonnegative(row.number) || row.number === 0 || row.id !== row.towerId + ':' + row.number || keys.has(row.id) ||
      !ids(row.songIds, /^m\d+$/) || !row.songIds.length || !ids(row.bonusCharacterIds, /^chr-\d+$/) ||
      !nonnegative(row.clearScore) || !nonnegative(row.bonusPermil) || !nonnegative(row.startTime) ||
      !nonnegative(row.endTime) || (row.endTime > 0 && row.endTime <= row.startTime)) {
      throw Error('Invalid Challenge Live stage definition.')
    }
    keys.add(row.id)
  }
  return rows
}

let bundled: Promise<ChallengeStage[]> | undefined
async function loadBundledStages() {
  const response = await fetch('/assets/team-optimizer/challenge-stages.json')
  if (!response.ok) throw Error('Could not load the Challenge Live stage catalog.')
  const catalog = await response.json()
  return validateChallengeStages(catalog.stages)
}

export async function loadChallengeStages(resources?: {challengeStages?: ChallengeStage[]}, now = Date.now()) {
  const stages = resources?.challengeStages ?? await (bundled ??= loadBundledStages().catch(error => {
    bundled = undefined
    throw error
  }))
  return stages.filter(stage => stage.startTime <= now && (!stage.endTime || now < stage.endTime))
}
