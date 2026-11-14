import type { Resolution, TeamParameterReport } from './team-parameters'

export const OVERALL_POWER_MODEL_VERSION = 'overall-power-v1'
export const powerComponents = ['memberParameters', 'boardBonus', 'memoryBonus', 'outfitSkill', 'passiveSkill', 'memberPowerUpBonus'] as const
export type PowerComponent = typeof powerComponents[number]
type Member = Pick<TeamParameterReport['members'][number], 'inherentStats' | 'inherentAndBoardStats' | 'formationStages'>
const known = (value: number): Resolution<number> => ({ status: 'resolved', value })

function sum(values: Resolution<number>[]): Resolution<number> {
  const reasons = values.flatMap(value => value.status === 'unresolved' ? value.reasons : [])
  if (values.some(value => value.status === 'unresolved')) return { status: 'unresolved', value: null, reasons: [...new Set(reasons)] }
  let result = 0n
  for (const value of values) {
    if (!Number.isSafeInteger(value.value) || value.value! < 0) throw new Error('Overall Power requires nonnegative safe integer components')
    result += BigInt(value.value!)
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Overall Power exceeds safe integer range')
  return known(Number(result))
}

/** Aggregate the existing member stages without introducing another rounding step. */
export function resolveOverallPower(members: readonly Member[]) {
  if (members.length !== 5) throw new Error('Overall Power requires five members')
  const boardBonuses = members.flatMap(member => (['performance', 'technique', 'sense'] as const).map(stat => {
    const board = member.inherentAndBoardStats[stat]
    return board.status === 'resolved' ? known(board.value - member.inherentStats[stat]) : board
  }))
  const bonus = (system: 'leader' | 'passive' | 'memory') => sum(members.flatMap(member => Object.values(member.formationStages.bonuses[system])))
  const components: Record<PowerComponent, Resolution<number>> = {
    memberParameters: sum(members.flatMap(member => Object.values(member.inherentStats).map(known))),
    boardBonus: sum(boardBonuses), memoryBonus: bonus('memory'), outfitSkill: bonus('leader'), passiveSkill: bonus('passive'),
    memberPowerUpBonus: sum(members.map(member => member.formationStages.rosterIncrease))
  }
  return { modelVersion: OVERALL_POWER_MODEL_VERSION, components, total: sum(Object.values(components)) }
}
