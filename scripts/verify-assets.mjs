import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const manifest = JSON.parse(await readFile(resolve('src/data/progression.json'), 'utf8'))
if (manifest.schemaVersion !== 2) throw new Error('Progression manifest must use schema version 2')
if (manifest.cards.length !== 178) throw new Error(`Expected 178 cards, received ${manifest.cards.length}`)
if (new Set(manifest.cards.map((card) => card.assetId)).size !== manifest.cards.length) {
  throw new Error('Card asset IDs are not unique')
}

const cardsDirectory = resolve('src/renderer/public/assets/cards')
const materialsDirectory = resolve('src/renderer/public/assets/materials')
const expectedCards = new Set(manifest.cards.map((card) => `${card.assetId}.webp`))
const actualCards = new Set((await readdir(cardsDirectory)).filter((name) => name.endsWith('.webp')))
const expectedMaterials = new Set(Object.values(manifest.resourceAssets).map((asset) => asset.fileName))
const actualMaterials = new Set((await readdir(materialsDirectory)).filter((name) => name.endsWith('.webp')))

const compare = (label, expected, actual) => {
  const missing = [...expected].filter((name) => !actual.has(name))
  const extra = [...actual].filter((name) => !expected.has(name))
  if (missing.length || extra.length) throw new Error(`${label} mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`)
}
compare('Card assets', expectedCards, actualCards)
compare('Material assets', expectedMaterials, actualMaterials)

for (const name of [...expectedCards].map((fileName) => resolve(cardsDirectory, fileName))) {
  const metadata = await sharp(name, { failOn: 'error' }).metadata()
  if (metadata.format !== 'webp' || metadata.width !== 512 || metadata.height !== 512) {
    throw new Error(`Invalid card thumbnail: ${name}`)
  }
}
for (const name of [...expectedMaterials].map((fileName) => resolve(materialsDirectory, fileName))) {
  const metadata = await sharp(name, { failOn: 'error' }).metadata()
  if (metadata.format !== 'webp' || !metadata.width || !metadata.height) {
    throw new Error(`Invalid material icon: ${name}`)
  }
}

process.stdout.write(`Verified ${expectedCards.size} card thumbnails and ${expectedMaterials.size} material icons.\n`)
