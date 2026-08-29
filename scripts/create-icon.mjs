import sharp from 'sharp'
import { resolve } from 'node:path'

await sharp(resolve('resources/icon.svg')).resize(512, 512).png().toFile(resolve('resources/icon.png'))
process.stdout.write('Generated resources/icon.png\n')
