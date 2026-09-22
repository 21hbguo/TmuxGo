import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const root = process.cwd()
const hostAddress = requireEnv('TMUXGO_SSH_E2E_HOST')
const hostUser = requireEnv('TMUXGO_SSH_E2E_USER')
const authMode = process.env.TMUXGO_SSH_E2E_AUTH === 'key' ? 'key' : 'agent'
const privateKeyPath = process.env.TMUXGO_SSH_E2E_PRIVATE_KEY_PATH?.trim() || ''
const jumpHost = process.env.TMUXGO_SSH_E2E_JUMP_HOST?.trim() || ''
const port = Number(process.env.TMUXGO_SSH_E2E_PORT || 22)
const knownHostsPolicy = process.env.TMUXGO_SSH_E2E_KNOWN_HOSTS_POLICY || 'strict'
const hostId = 'ssh-e2e'
const sessionName = `tmuxgo_ssh_e2e_${Date.now()}`
let configDir = ''
let gateway: ChildProcess | undefined
let cleaned = false

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for SSH E2E`)
  return value
}
function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    throw new Error(`Unsupported Node.js ${process.version}. Need ^20.19 || ^22.12 || >=24 (nvm use with .nvmrc)`)
  }
}
function resolveBin(name: string) {
  const candidates = [
    join(root, 'node_modules', '.bin', name),
    join(root, 'apps', 'gateway', 'node_modules', '.bin', name),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`Unable to resolve ${name} binary (looked in node_modules/.bin and workspace bins)`)
  return found
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to reserve SSH E2E port'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}
async function waitFor(url: string, process: ChildProcess) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${url} exited before becoming ready`)
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await delay(200)
  }
  throw new Error(`${url} did not become ready`)
}
async function stop(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([new Promise<void>((resolve) => process.once('exit', () => resolve())), delay(5000)])
  if (process.exitCode === null) process.kill('SIGKILL')
}
function startGateway(apiPort: number) {
  return spawn(resolveBin('tsx'), ['apps/gateway/src/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(apiPort),
      TMUXGO_CONFIG_DIR: configDir,
      TMUXGO_PREFERENCES_DIR: join(configDir, 'preferences'),
      TMUXGO_TMP_DIR: join(configDir, 'tmp'),
      TMUXGO_AUTH_USERNAME: '',
      TMUXGO_AUTH_PASSWORD: '',
    },
  })
}
async function request(apiUrl: string, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${method} ${path} failed: ${JSON.stringify(result)}`)
  return result
}
async function verifyTerminal(apiUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const marker = `TMUXGO-SSH-E2E-${Date.now()}`
    const socket = new WebSocket(`${apiUrl.replace(/^http/, 'ws')}/api/stream`)
    let outputSeen = false
    let resizeSeen = false
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      socket.close()
      if (error) reject(error)
      else resolve()
    }
    const complete = () => {
      if (outputSeen && resizeSeen) finish()
    }
    const timeout = setTimeout(() => finish(new Error('SSH terminal attach timed out')), 30000)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'attach', hostId, sessionName, exclusive: true, cols: 80, rows: 24 })))
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: string; message?: string }
        if (message.type === 'attached') {
          socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
          socket.send(JSON.stringify({ type: 'input', data: `printf '${marker}\\n'\r` }))
        }
        if (message.type === 'resized') {
          resizeSeen = true
          complete()
        }
        if ((message.type === 'output' || message.type === 'output_resync') && message.data?.includes(marker)) {
          outputSeen = true
          complete()
        }
        if (message.type === 'error') finish(new Error(message.message || 'SSH terminal error'))
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid SSH terminal output'))
      }
    })
    socket.on('error', (error) => finish(error))
  })
}
async function cleanup(apiUrl: string) {
  if (cleaned) return
  cleaned = true
  try {
    await request(apiUrl, `/api/hosts/${hostId}/sessions/${encodeURIComponent(`session-${hostId}-${sessionName}`)}`, 'DELETE')
  } catch {}
  await stop(gateway)
  if (configDir) await rm(configDir, { recursive: true, force: true })
}
async function main() {
  assertSupportedNode()
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TMUXGO_SSH_E2E_PORT must be a valid port')
  if (knownHostsPolicy !== 'strict') throw new Error('TMUXGO_SSH_E2E_KNOWN_HOSTS_POLICY must be strict')
  if (authMode === 'key' && !privateKeyPath) throw new Error('TMUXGO_SSH_E2E_PRIVATE_KEY_PATH is required when TMUXGO_SSH_E2E_AUTH=key')
  if (authMode === 'agent' && privateKeyPath) throw new Error('TMUXGO_SSH_E2E_PRIVATE_KEY_PATH must be unset when TMUXGO_SSH_E2E_AUTH=agent')
  if (authMode === 'agent' && !process.env.SSH_AUTH_SOCK) throw new Error('SSH_AUTH_SOCK is required when TMUXGO_SSH_E2E_AUTH=agent')
  configDir = await mkdtemp(join(tmpdir(), 'tmuxgo-ssh-e2e-'))
  const apiPort = await availablePort()
  const apiUrl = `http://127.0.0.1:${apiPort}`
  try {
    gateway = startGateway(apiPort)
    await waitFor(`${apiUrl}/health`, gateway)
    const host = await request(apiUrl, '/api/hosts', 'POST', {
      id: hostId,
      name: 'SSH E2E',
      address: hostAddress,
      user: hostUser,
      port,
      privateKeyPath: authMode === 'key' ? privateKeyPath : undefined,
      useAgent: authMode === 'agent',
      jumpHost: jumpHost || undefined,
      knownHostsPolicy,
    }) as { knownHostsPolicy?: string; usesAgent?: boolean; hasPrivateKey?: boolean }
    assert.equal(host.knownHostsPolicy, 'strict')
    assert.equal(host.usesAgent, authMode === 'agent')
    assert.equal(host.hasPrivateKey, authMode === 'key')
    const connectivity = await request(apiUrl, `/api/hosts/${hostId}/test`, 'POST') as { ok?: boolean; mode?: string }
    assert.equal(connectivity.ok, true)
    assert.equal(connectivity.mode, authMode)
    const session = await request(apiUrl, `/api/hosts/${hostId}/sessions`, 'POST', { name: sessionName }) as { id?: string; name?: string }
    assert.equal(session.name, sessionName)
    await verifyTerminal(apiUrl)
    await stop(gateway)
    gateway = startGateway(apiPort)
    await waitFor(`${apiUrl}/health`, gateway)
    await verifyTerminal(apiUrl)
  } finally {
    await cleanup(apiUrl)
  }
}
void main().catch(async (error) => {
  console.error(error)
  if (configDir && !cleaned) await rm(configDir, { recursive: true, force: true }).catch(() => undefined)
  await stop(gateway)
  process.exitCode = 1
})
