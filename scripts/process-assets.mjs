import { mkdir, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const extracted = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node scripts/process-assets.mjs <extracted-asset-directory>')

const manifest = JSON.parse(await readFile(resolve('src/data/progression.json'), 'utf8'))
const cardsDirectory = resolve('src/renderer/public/assets/cards')
const materialsDirectory = resolve('src/renderer/public/assets/materials')
await mkdir(cardsDirectory, { recursive: true })
await mkdir(materialsDirectory, { recursive: true })

const extractedEntries = new Set(await readdir(extracted))
const expectedNames = [
  ...manifest.cards.map((card) => `img_card_thumb_${card.assetId}`),
  ...Object.values(manifest.resourceAssets).map((asset) => asset.sourceAssetName)
]
if (new Set(expectedNames).size !== expectedNames.length) throw new Error('Asset manifest contains duplicate source names')
const missing = expectedNames.filter((name) => !extractedEntries.has(name))
if (missing.length > 0) throw new Error(`Missing extracted assets: ${missing.join(', ')}`)

for (const card of manifest.cards) {
  const sourceName = `img_card_thumb_${card.assetId}`
  const source = resolve(extracted, sourceName, `${sourceName}.png`)
  const destination = resolve(cardsDirectory, `${card.assetId}.webp`)
  const image = sharp(source, { failOn: 'error' })
  const metadata = await image.metadata()
  if (metadata.width !== 512 || metadata.height !== 512) {
    throw new Error(`${sourceName} changed dimensions: ${metadata.width}x${metadata.height}`)
  }
  await image.webp({ quality: 90, effort: 6, smartSubsample: true }).toFile(destination)
}

for (const asset of Object.values(manifest.resourceAssets)) {
  const source = resolve(extracted, asset.sourceAssetName, `${asset.sourceAssetName}.png`)
  const destination = resolve(materialsDirectory, asset.fileName)
  const image = sharp(source, { failOn: 'error' })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height || metadata.width > 2048 || metadata.height > 2048) {
    throw new Error(`${asset.sourceAssetName} has invalid dimensions`)
  }
  await image.webp({ lossless: true, effort: 6 }).toFile(destination)
}

process.stdout.write(`Imported ${manifest.cards.length} card thumbnails and ${Object.keys(manifest.resourceAssets).length} material icons.\n`)
