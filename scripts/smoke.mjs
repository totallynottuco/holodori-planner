import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const executable = resolve('release', 'win-unpacked', 'holodori Planner.exe')
await access(executable)
const smokeDirectory = await mkdtemp(join(tmpdir(), 'holodori-planner-smoke-'))

try {
  const code = await new Promise((resolveCode, reject) => {
    let output = ''
    const child = spawn(executable, ['--smoke'], {
      env: { ...process.env, HOLODORI_SMOKE_DIR: smokeDirectory, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Packaged smoke test timed out after 30 seconds.\n${output}`))
    }, 30_000)
    child.once('error', (error) => reject(new Error(`${error.message}\n${output}`)))
    child.once('exit', (exitCode) => {
      clearTimeout(timeout)
      resolveCode(exitCode)
    })
  })
  if (code !== 0) throw new Error(`Packaged smoke test exited with code ${code}`)
  process.stdout.write('Packaged smoke test passed: manifest and profile service loaded.\n')
} finally {
  await rm(smokeDirectory, { recursive: true, force: true })
}
