import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
let configDir = ''
let frontendDist = ''
let tmuxDir = ''
let gateway: ChildProcess | undefined
let cleaned = false
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
async function stop(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([new Promise<void>((resolve) => process.once('exit', () => resolve())), delay(5000)])
  if (process.exitCode === null) process.kill('SIGKILL')
}
async function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
async function cleanup() {
  if (cleaned) return
  cleaned = true
  await stop(gateway)
  if (tmuxDir) await run('tmux', ['kill-server'], { cwd: root, env: { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir } }).catch(() => undefined)
  if (configDir) await rm(configDir, { recursive: true, force: true })
  if (frontendDist) await rm(frontendDist, { recursive: true, force: true })
  if (tmuxDir) await rm(tmuxDir, { recursive: true, force: true })
}
function handleSignal(code: number) {
  void cleanup().finally(() => process.exit(code))
}
process.once('SIGINT', () => handleSignal(130))
process.once('SIGTERM', () => handleSignal(143))
async function main() {
  configDir = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-'))
  frontendDist = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-frontend-'))
  tmuxDir = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-tmux-'))
  try {
    const apiPort = await port()
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const bin = join(root, 'node_modules', '.bin')
    const tmuxEnv = { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir }
    if (await run(join(bin, 'vite'), ['build', '--outDir', frontendDist, '--emptyOutDir'], { cwd: join(root, 'apps/frontend'), env: { ...tmuxEnv, VITE_API_URL: apiUrl } }) !== 0) throw new Error('E2E frontend build failed')
    if (await run('tmux', ['new-session', '-d', '-s', 'tmuxgo-e2e'], { cwd: root, env: tmuxEnv }) !== 0) throw new Error('E2E tmux startup failed')
    gateway = spawn(join(bin, 'tsx'), ['apps/gateway/src/index.ts'], { cwd: root, stdio: 'inherit', env: { ...tmuxEnv, PORT: String(apiPort), TMUXGO_CONFIG_DIR: configDir, TMUXGO_AUTH_USERNAME: '', TMUXGO_AUTH_PASSWORD: '', TMUXGO_FRONTEND_DIST: frontendDist } })
    await waitFor(`${apiUrl}/health`, gateway)
    const result = await run(join(bin, 'playwright'), ['test', ...process.argv.slice(2)], { cwd: root, env: { ...tmuxEnv, TMUXGO_E2E_URL: apiUrl, TMUXGO_E2E_API_URL: apiUrl, TMUXGO_E2E_WORKERS: '1' } })
    process.exitCode = result
  } finally {
    await cleanup()
  }
}
void main().catch(async (error) => {
  console.error(error)
  await cleanup()
  process.exitCode = 1
})
