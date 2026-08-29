import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  Attribute,
  CardCatalogEntry,
  ProgressionManifest,
  Rarity,
  RarityProgression,
  TrainingCost
} from '../src/shared/types'

type WrappedRow = { id?: string; group_id?: string; level?: number; limit_break_count?: number; data: Record<string, unknown> }

const checkout = resolve(process.argv[2] ?? process.env.HOLODORI_DB_PATH ?? '')
if (!process.argv[2] && !process.env.HOLODORI_DB_PATH) {
  throw new Error('Usage: npm run data:import -- <path-to-holodori-db-eng-diff>')
}

function rows(file: string): WrappedRow[] {
  const parsed = JSON.parse(readFileSync(resolve(checkout, file), 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array`)
  return parsed as WrappedRow[]
}

function uniqueById(source: WrappedRow[], file: string): Map<string, WrappedRow> {
  const result = new Map<string, WrappedRow>()
  for (const row of source) {
    const id = String(row.id ?? row.data.id ?? '')
    if (!id) throw new Error(`${file} contains a row without an ID`)
    if (result.has(id)) throw new Error(`${file} contains duplicate ID ${id}`)
    result.set(id, row)
  }
  return result
}

function parseRarity(value: unknown): Rarity {
  const match = String(value).match(/_(3|4|5)$/)
  if (!match) throw new Error(`Invalid rarity ${String(value)}`)
  return Number(match[1]) as Rarity
}

function parseAttribute(value: unknown): Attribute {
  const match = String(value).match(/_(1|2|3)$/)
  if (!match) throw new Error(`Invalid attribute ${String(value)}`)
  return ({ '1': 'cute', '2': 'pure', '3': 'happy' } as const)[match[1] as '1' | '2' | '3']
}

function buildExperience(): number[] {
  const groups = new Map<string, Map<number, number>>()
  for (const row of rows('CardLevel.json')) {
    const groupId = String(row.group_id ?? row.data.groupId ?? '')
    const level = Number(row.level ?? row.data.level)
    const exp = level === 1 && row.data.exp === undefined ? 0 : Number(row.data.exp)
    if (!groupId || !Number.isInteger(level) || !Number.isInteger(exp)) throw new Error('Invalid CardLevel row')
    const group = groups.get(groupId) ?? new Map<number, number>()
    if (group.has(level)) throw new Error(`Duplicate CardLevel ${groupId}/${level}`)
    group.set(level, exp)
    groups.set(groupId, group)
  }

  const complete = [...groups.entries()].find(([, values]) => [...Array(80)].every((_, index) => values.has(index + 1)))
  if (!complete) throw new Error('No complete Lv.1–80 EXP curve was found')
  const curve = [...Array(80)].map((_, index) => complete[1].get(index + 1) as number)
  if (curve[0] !== 0 || curve.some((value, index) => index > 0 && value <= curve[index - 1])) {
    throw new Error('EXP curve must begin at zero and increase at every level')
  }
  for (const [groupId, values] of groups) {
    for (const [level, exp] of values) {
      if (level <= 80 && curve[level - 1] !== exp) throw new Error(`Mismatched EXP prefix in ${groupId} at Lv.${level}`)
    }
  }
  return curve
}

function stageCost(consumptions: unknown, expectedAttribute: number): TrainingCost {
  const cost: TrainingCost = { beads: 0, crystals: 0, hologold: 0, hololium: 0 }
  if (!Array.isArray(consumptions)) return cost
  for (const item of consumptions as Array<Record<string, unknown>>) {
    const id = String(item.resourceId)
    const quantity = Number(item.quantity)
    if (!Number.isInteger(quantity) || quantity < 0) throw new Error(`Invalid material quantity for ${id}`)
    if (id === 'item-gold') cost.hologold += quantity
    else if (id === 'item-card_limit_break-cmn-sr') cost.hololium += quantity
    else if (id === `item-card_limit_break-attribute_${expectedAttribute}-1`) cost.beads += quantity
    else if (id === `item-card_limit_break-attribute_${expectedAttribute}-2`) cost.crystals += quantity
    else throw new Error(`Unexplained SP Training material change: ${id}`)
  }
  return cost
}

function buildRarities(): Record<'3' | '4' | '5', RarityProgression> {
  const source = rows('CardLevelLimit.json')
  const output = {} as Record<'3' | '4' | '5', RarityProgression>
  for (const rarity of [3, 4, 5] as const) {
    let reference: RarityProgression | null = null
    for (const attribute of [1, 2, 3] as const) {
      const groupId = `rarity_${rarity}-attribute_${attribute}`
      const group = source
        .filter((row) => String(row.group_id ?? row.data.groupId) === groupId)
        .sort((a, b) => Number(a.limit_break_count ?? a.data.limitBreakCount ?? 0) - Number(b.limit_break_count ?? b.data.limitBreakCount ?? 0))
      if (group.length !== 5) throw new Error(`${groupId} must define its initial cap and four SP stages`)
      const progression: RarityProgression = {
        initialLevelCap: Number(group[0].data.levelLimit),
        maxLevel: Number(group[4].data.levelLimit),
        trainingStages: group.slice(1).map((row, index) => ({
          stage: (index + 1) as 1 | 2 | 3 | 4,
          levelCap: Number(row.data.levelLimit),
          cost: stageCost(row.data.consumptions, attribute)
        }))
      }
      if (progression.initialLevelCap !== rarity * 10 - 10 || progression.maxLevel !== rarity * 10 + 30) {
        throw new Error(`Unexpected caps for ${groupId}`)
      }
      if (reference && JSON.stringify(reference) !== JSON.stringify(progression)) {
        throw new Error(`Attribute SP costs do not match for rarity ${rarity}`)
      }
      reference = progression
    }
    output[String(rarity) as '3' | '4' | '5'] = reference as RarityProgression
  }
  return output
}

function bloomLabel(effectType: string, value: number, rarity: Rarity, stage: number): string {
  if (effectType.endsWith('ACTIVE_SKILL_LEVEL_UP')) return `Active Skill Lv.${value}`
  if (effectType.endsWith('SPECIAL_SKILL_LEVEL_UP')) return `Special Skill Lv.${value}`
  if (effectType.endsWith('PASSIVE_SKILL_LEVEL_UP')) return `Passive Skill Lv.${value}`
  if (effectType.endsWith('CONNECT_EFFECT_LEVEL_UP')) return `Connect Effect Lv.${value}`
  if (effectType.endsWith('ALL_PARAMETER_UP_PERMIL_UP')) {
    const percent = value / 10
    return rarity === 3 && stage === 5 ? `All parameters +${percent}% (total +15%)` : `All parameters +${percent}%`
  }
  throw new Error(`Unexplained Bloom effect: ${effectType}`)
}

function buildBloom(): ProgressionManifest['bloom'] {
  const source = rows('CardPotential.json')
  const effects = {} as Record<'3' | '4' | '5', string[]>
  for (const rarity of [3, 4, 5] as const) {
    const groupId = `card_potential_grp-rarity_${rarity}`
    const group = source
      .filter((row) => String(row.group_id ?? row.data.groupId) === groupId)
      .sort((a, b) => Number(a.data.upgradeCount) - Number(b.data.upgradeCount))
    if (group.length !== 5) throw new Error(`${groupId} must define five Bloom stages`)
    effects[String(rarity) as '3' | '4' | '5'] = group.map((row, index) =>
      bloomLabel(String(row.data.effectType), Number(row.data.value), rarity, index + 1)
    )
  }

  const alternative = rows('CardPotentialUpgradeItem.json').find((row) => parseRarity(row.data.rarity) === 5)
  if (!alternative || alternative.data.itemId !== 'item-card-potential-upgrade-cmn') {
    throw new Error('Unexpected 5★ Bloom Stone mapping')
  }
  return { maxStage: 5, fiveStarStoneItemId: String(alternative.data.itemId), effects }
}

function buildCards(): CardCatalogEntry[] {
  const cards = uniqueById(rows('Card.json'), 'Card.json')
  const characters = uniqueById(rows('Character.json'), 'Character.json')
  const localizedNames = uniqueById(rows('LangCard_Eng.json'), 'LangCard_Eng.json')
  const output: CardCatalogEntry[] = []
  for (const [id, row] of cards) {
    const characterId = String(row.data.characterId)
    const character = characters.get(characterId)
    if (!character) throw new Error(`Card ${id} references missing character ${characterId}`)
    const nameLangId = String(row.data.nameLangId)
    const localizedName = localizedNames.get(nameLangId)
    if (!localizedName) throw new Error(`Card ${id} references missing English name ${nameLangId}`)
    const memberName = String(character.data.nameEng ?? '').trim()
    const cardName = String(localizedName.data.text ?? '').trim()
    if (!memberName || !cardName) throw new Error(`Card ${id} has an empty English label`)
    output.push({ id, memberName, cardName, rarity: parseRarity(row.data.rarity), attribute: parseAttribute(row.data.attributeType) })
  }
  return output.sort((a, b) => a.memberName.localeCompare(b.memberName) || b.rarity - a.rarity || a.cardName.localeCompare(b.cardName))
}

const sourceCommit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const masterDataVersion = readFileSync(resolve(checkout, 'version.txt'), 'utf8').trim()
if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-f0-9]{64}$/.test(masterDataVersion)) {
  throw new Error('Invalid source commit or master-data version')
}

const manifest: ProgressionManifest = {
  schemaVersion: 1,
  metadata: {
    sourceRepository: 'https://github.com/HolodoriDB/holodori-db-eng-diff',
    sourceCommit,
    masterDataVersion,
    importedAt: new Date().toISOString(),
    catalogVersion: masterDataVersion.slice(0, 12)
  },
  cumulativeExperience: buildExperience(),
  rarities: buildRarities(),
  bloom: buildBloom(),
  cards: buildCards()
}

const destination = resolve('src/data/progression.json')
mkdirSync(resolve('src/data'), { recursive: true })
writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(
  `Wrote ${destination}\n${manifest.cards.length} cards · ${manifest.cumulativeExperience.length} EXP levels · data ${manifest.metadata.catalogVersion}\n`
)
