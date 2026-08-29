import sharp from 'sharp'
import { resolve } from 'node:path'

const source = resolve('src/renderer/public/assets/cards/00006-5-uniq-0074-00.webp')
const destination = resolve('resources/icon.png')

await sharp(source).resize(512, 512, { fit: 'contain' }).png().toFile(destination)
process.stdout.write('Generated resources/icon.png from 00006-5-uniq-0074-00.webp\n')
