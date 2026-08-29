import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const executable = process.argv[2]
const profilePath = process.argv[3]
const expectedFrom = process.argv[4]
const expectedTo = process.argv[5]
const port = 19_317

if (!executable || !profilePath || !expectedFrom || !expectedTo) {
  throw new Error('Usage: node scripts/live-update-e2e.mjs <installed-exe> <profile-json> <from-version> <to-version>')
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const deadline = (seconds) => Date.now() + seconds * 1_000

async function waitForTarget(until) {
  let lastError
  while (Date.now() < until) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch (error) {
      lastError = error
    }
    await delay(300)
  }
  throw new Error(`Timed out waiting for the installed app debug target: ${String(lastError ?? '')}`)
}

function connect(url) {
  const socket = new WebSocket(url)
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return {
    socket,
    ready,
    async call(method, params = {}) {
      await ready
      const requestId = ++id
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        socket.send(JSON.stringify({ id: requestId, method, params }))
      })
    }
  }
}

async function evaluate(client, expression) {
  const response = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
  return response.result.value
}

async function waitForStatus(client, wanted, seconds) {
  const until = deadline(seconds)
  while (Date.now() < until) {
    const statuses = await evaluate(client, 'window.__holodoriUpdateStatuses ?? []')
    const failed = statuses.findLast((status) => status.state === 'error')
    if (failed) throw new Error(failed.message)
    const found = statuses.findLast((status) => status.state === wanted)
    if (found) return found
    await delay(500)
  }
  throw new Error(`Timed out waiting for updater state ${wanted}`)
}

const appProcess = spawn(executable, [`--remote-debugging-port=${port}`], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true
})
appProcess.unref()

const target = await waitForTarget(deadline(20))
const client = connect(target.webSocketDebuggerUrl)
await client.ready
await client.call('Runtime.enable')

const current = await evaluate(client, 'window.holodori.app.getInfo()')
if (current.version !== expectedFrom) throw new Error(`Expected installed ${expectedFrom}, found ${current.version}`)
await evaluate(
  client,
  "window.__holodoriUpdateStatuses = []; window.__stopHolodoriUpdateStatus?.(); window.__stopHolodoriUpdateStatus = window.holodori.updates.onStatus((status) => window.__holodoriUpdateStatuses.push(status)); true"
)
await evaluate(client, 'window.holodori.updates.check()')
const available = await waitForStatus(client, 'available', 30)
if (available.version !== expectedTo) throw new Error(`Expected update ${expectedTo}, found ${available.version}`)
await evaluate(client, 'window.holodori.updates.download()')
const downloaded = await waitForStatus(client, 'downloaded', 300)
if (downloaded.version !== expectedTo) throw new Error(`Downloaded unexpected version ${downloaded.version}`)

const profileHash = createHash('sha256').update(await readFile(profilePath)).digest('hex')
await evaluate(client, "setTimeout(() => void window.holodori.updates.install(), 150); 'install-commanded'")
await delay(1_500)
client.socket.close()

process.stdout.write(`${JSON.stringify({ from: current.version, available: available.version, downloaded: downloaded.version, profileHash }, null, 2)}\n`)
