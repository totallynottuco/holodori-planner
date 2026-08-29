import { readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const releaseDirectory = resolve('release')
const disposableArtifact = /^(?:holodori-Planner-Setup(?:-[0-9]+\.[0-9]+\.[0-9]+)?\.exe(?:\.blockmap)?|latest\.yml)$/

let entries = []
try {
  entries = await readdir(releaseDirectory, { withFileTypes: true })
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
}

const removed = []
for (const entry of entries) {
  if (!entry.isFile() || !disposableArtifact.test(entry.name)) continue
  await rm(resolve(releaseDirectory, entry.name), { force: true })
  removed.push(entry.name)
}

if (removed.length > 0) process.stdout.write(`Removed superseded release artifacts: ${removed.join(', ')}\n`)
