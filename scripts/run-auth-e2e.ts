import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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
function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    throw new Error(`Unsupported Node.js ${process.version}. Need ^20.19 || ^22.12 || >=24 (nvm use with .nvmrc)`)
  }
}
function resolveBin(name: string) {
  const candidates = [
    join(root, 'node_modules', '.bin', name),
    join(root, 'apps', 'frontend', 'node_modules', '.bin', name),
    join(root, 'apps', 'gateway', 'node_modules', '.bin', name),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`Unable to resolve ${name} binary (looked in node_modules/.bin and workspace bins)`)
  return found
}
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
  assertSupportedNode()
  configDir = await mkdtemp(join(tmpdir(), 'tmuxgo-auth-e2e-'))
  frontendDist = await mkdtemp(join(tmpdir(), 'tmuxgo-auth-e2e-frontend-'))
  tmuxDir = await mkdtemp(join(tmpdir(), 'tmuxgo-auth-e2e-tmux-'))
  try {
    const apiPort = await port()
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const appUrl = apiUrl
    const username = process.env.TMUXGO_AUTH_E2E_USERNAME || 'e2e-user'
    const password = process.env.TMUXGO_AUTH_E2E_PASSWORD || 'e2e-password'
    const testFiles = process.env.TMUXGO_AUTH_E2E_TESTS?.split(',').filter(Boolean) || ['e2e/auth.spec.ts']
    const restartTests = process.env.TMUXGO_AUTH_E2E_RESTART_TESTS?.split(',').filter(Boolean) || []
    const viteBin = resolveBin('vite')
    const tsxBin = resolveBin('tsx')
    const playwrightBin = resolveBin('playwright')
    if (await run(viteBin, ['build', '--outDir', frontendDist, '--emptyOutDir'], { cwd: join(root, 'apps/frontend'), env: { ...process.env, VITE_API_URL: apiUrl } }) !== 0) throw new Error('Authentication E2E frontend build failed')
    if (await run('tmux', ['new-session', '-d', '-s', 'auth-e2e'], { cwd: root, env: { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir } }) !== 0) throw new Error('Authentication E2E tmux startup failed')
    const gatewayEnv = {
      ...process.env,
      PORT: String(apiPort),
      TMUX: '',
      TMUX_TMPDIR: tmuxDir,
      TMUXGO_CONFIG_DIR: configDir,
      TMUXGO_PREFERENCES_DIR: join(configDir, 'preferences'),
      TMUXGO_TMP_DIR: join(configDir, 'tmp'),
      TMUXGO_AUTH_USERNAME: username,
      TMUXGO_AUTH_PASSWORD: password,
      TMUXGO_FRONTEND_DIST: frontendDist,
    }
    const startGateway = async () => {
      gateway = spawn(tsxBin, ['apps/gateway/src/index.ts'], { cwd: root, stdio: 'inherit', env: gatewayEnv })
      await waitFor(`${apiUrl}/health`, gateway)
      await waitFor(appUrl, gateway)
    }
    const testEnv = {
      ...process.env,
      TMUXGO_PLUGIN_E2E_URL: appUrl,
      TMUXGO_AUTH_E2E_URL: appUrl,
      TMUXGO_AUTH_E2E_API_URL: apiUrl,
      TMUXGO_AUTH_E2E_USERNAME: username,
      TMUXGO_AUTH_E2E_PASSWORD: password,
      TMUXGO_AUTH_E2E_STORAGE: join(configDir, 'restart-storage.json'),
      TMUXGO_CONFIG_DIR: configDir,
      TMUXGO_PREFERENCES_DIR: join(configDir, 'preferences'),
      TMUXGO_TMP_DIR: join(configDir, 'tmp'),
    }
    const runPlaywright = (files: string[]) => new Promise<number>((resolve, reject) => {
      const child = spawn(playwrightBin, ['test', ...files], { cwd: root, stdio: 'inherit', env: testEnv })
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
    await startGateway()
    const result = await runPlaywright(testFiles)
    if (result === 0 && restartTests.length) {
      await stop(gateway)
      gateway = undefined
      await startGateway()
      process.exitCode = await runPlaywright(restartTests)
    } else {
      process.exitCode = result
    }
  } finally {
    await cleanup()
  }
}
void main().catch(async (error) => {
  console.error(error)
  await cleanup()
  process.exitCode = 1
})
