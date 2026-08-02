import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const root = process.cwd()
let configDir = ''
let tmuxDir = ''
let gateway: ChildProcess | undefined
let agent: ChildProcess | undefined
let cleaned = false
const username = 'agent-e2e-user'
const password = 'agent-e2e-password'
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function port() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to reserve E2E port'))
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
async function login(apiUrl: string) {
  const response = await fetch(`${apiUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  if (!response.ok) throw new Error(`Agent E2E login failed: HTTP ${response.status}`)
  const result = await response.json() as { accessToken?: string }
  if (!result.accessToken) throw new Error('Agent E2E login did not return an access token')
  return result.accessToken
}
async function getWebSocketTicket(apiUrl: string, accessToken: string) {
  const response = await fetch(`${apiUrl}/api/auth/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new Error(`Agent E2E ticket failed: HTTP ${response.status}`)
  const result = await response.json() as { ticket?: string }
  if (!result.ticket) throw new Error('Agent E2E ticket response is invalid')
  return result.ticket
}
async function waitForAgent(apiUrl: string, process: ChildProcess, hostId: string, accessToken: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('Agent exited before registering')
    try {
      const response = await fetch(`${apiUrl}/api/hosts/${hostId}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (response.ok && (await response.json() as { connectionMode?: string; agent?: { online?: boolean } }).connectionMode === 'agent') return
    } catch {}
    await delay(200)
  }
  throw new Error('Agent did not register')
}
async function stop(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([new Promise<void>((resolve) => process.once('exit', () => resolve())), delay(5000)])
  if (process.exitCode === null) process.kill('SIGKILL')
}
async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
function startGateway(bin: string, apiPort: number, tmuxEnv: NodeJS.ProcessEnv) {
  return spawn(join(bin, 'tsx'), ['apps/gateway/src/index.ts'], { cwd: root, stdio: 'inherit', env: { ...tmuxEnv, PORT: String(apiPort), TMUXGO_CONFIG_DIR: configDir, TMUXGO_AUTH_USERNAME: username, TMUXGO_AUTH_PASSWORD: password } })
}
async function verifyTerminal(url: string, hostId: string) {
  return new Promise<void>((resolve, reject) => {
    const marker = `TMUXGO-AGENT-E2E-${Date.now()}`
    const socket = new WebSocket(url)
    let outputSeen = false
    let resizeSeen = false
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      socket.close()
      if (error) reject(error)
      else resolve()
    }
    const complete = () => {
      if (outputSeen && resizeSeen) finish()
    }
    const timeout = setTimeout(() => finish(new Error('Agent terminal attach timed out')), 30000)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'attach', hostId, sessionName: 'agent-e2e', exclusive: true, cols: 80, rows: 24 })))
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: string; message?: string }
        if (message.type === 'attached') {
          socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
          socket.send(JSON.stringify({ type: 'input', data: `printf '${marker}\\n'\n` }))
        }
        if (message.type === 'resized') {
          resizeSeen = true
          complete()
        }
        if ((message.type === 'output' || message.type === 'output_resync') && message.data?.includes(marker)) {
          outputSeen = true
          complete()
        }
        if (message.type === 'error') finish(new Error(message.message || 'Agent terminal error'))
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Invalid Agent terminal output'))
      }
    })
    socket.on('error', (error) => finish(error))
  })
}
async function cleanup() {
  if (cleaned) return
  cleaned = true
  await stop(agent)
  await stop(gateway)
  if (tmuxDir) await run('tmux', ['kill-server'], { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir }).catch(() => undefined)
  if (configDir) await rm(configDir, { recursive: true, force: true })
  if (tmuxDir) await rm(tmuxDir, { recursive: true, force: true })
}
async function main() {
  configDir = await mkdtemp(join(tmpdir(), 'tmuxgo-agent-e2e-'))
  tmuxDir = await mkdtemp(join(tmpdir(), 'tmuxgo-agent-e2e-tmux-'))
  try {
    const apiPort = await port()
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const hostId = 'agent-e2e'
    const bin = join(root, 'node_modules', '.bin')
    const tmuxEnv = { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir }
    if (await run('tmux', ['new-session', '-d', '-s', 'agent-e2e'], tmuxEnv) !== 0) throw new Error('Agent E2E tmux startup failed')
    gateway = startGateway(bin, apiPort, tmuxEnv)
    await waitFor(`${apiUrl}/health`, gateway)
    const accessToken = await login(apiUrl)
    agent = spawn(join(bin, 'tsx'), ['apps/agent/src/index.ts'], { cwd: root, stdio: 'inherit', env: { ...tmuxEnv, GATEWAY_URL: `ws://127.0.0.1:${apiPort}/api/stream`, GATEWAY_USERNAME: username, GATEWAY_PASSWORD: password, HOST_ID: hostId, HOST_NAME: 'agent-e2e' } })
    await waitForAgent(apiUrl, agent, hostId, accessToken)
    const ticket = await getWebSocketTicket(apiUrl, accessToken)
    await verifyTerminal(`ws://127.0.0.1:${apiPort}/api/stream?ticket=${encodeURIComponent(ticket)}`, hostId)
    await stop(gateway)
    gateway = startGateway(bin, apiPort, tmuxEnv)
    await waitFor(`${apiUrl}/health`, gateway)
    await waitForAgent(apiUrl, agent, hostId, accessToken)
    const recoveredTicket = await getWebSocketTicket(apiUrl, accessToken)
    await verifyTerminal(`ws://127.0.0.1:${apiPort}/api/stream?ticket=${encodeURIComponent(recoveredTicket)}`, hostId)
  } finally {
    await cleanup()
  }
}
void main().catch(async (error) => {
  console.error(error)
  await cleanup()
  process.exitCode = 1
})
