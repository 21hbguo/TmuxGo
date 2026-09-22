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
      server.close((error) => (error ? reject(error) : resolve(address.port)))
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
  if (tmuxDir)
    await run('tmux', ['kill-server'], { cwd: root, env: { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir } }).catch(
      () => undefined,
    )
  // gateway 停止后仍可能延迟写入 configDir，rm 需重试避免 ENOTEMPTY 假失败
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }
  if (configDir) await rm(configDir, rmOpts)
  if (frontendDist) await rm(frontendDist, rmOpts)
  if (tmuxDir) await rm(tmuxDir, rmOpts)
}
function handleSignal(code: number) {
  void cleanup().finally(() => process.exit(code))
}
process.once('SIGINT', () => handleSignal(130))
process.once('SIGTERM', () => handleSignal(143))
async function main() {
  assertSupportedNode()
  configDir = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-'))
  frontendDist = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-frontend-'))
  tmuxDir = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-tmux-'))
  try {
    const apiPort = await port()
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const viteBin = resolveBin('vite')
    const tsxBin = resolveBin('tsx')
    const playwrightBin = resolveBin('playwright')
    const isolatedEnv = {
      ...process.env,
      TMUX: '',
      TMUX_TMPDIR: tmuxDir,
      TMUXGO_CONFIG_DIR: configDir,
      TMUXGO_PREFERENCES_DIR: join(configDir, 'preferences'),
      TMUXGO_TMP_DIR: join(configDir, 'tmp'),
    }
    // tmux server 会 source $HOME/.tmux.conf：用户 conf 中的失效选项会让 server 起在
    // config-error 屏吞掉输入。tmux/gateway 进程用空 HOME；playwright 不能改 HOME
    // （浏览器在 ~/.cache/ms-playwright），故单独派生 tmuxEnv
    const tmuxEnv = { ...isolatedEnv, HOME: configDir }
    if (
      (await run(viteBin, ['build', '--outDir', frontendDist, '--emptyOutDir'], {
        cwd: join(root, 'apps/frontend'),
        env: { ...isolatedEnv, VITE_API_URL: apiUrl },
      })) !== 0
    )
      throw new Error('E2E frontend build failed')
    if ((await run('tmux', ['new-session', '-d', '-s', 'tmuxgo-e2e'], { cwd: root, env: tmuxEnv })) !== 0)
      throw new Error('E2E tmux startup failed')
    gateway = spawn(tsxBin, ['apps/gateway/src/index.ts'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...tmuxEnv,
        PORT: String(apiPort),
        TMUXGO_AUTH_USERNAME: '',
        TMUXGO_AUTH_PASSWORD: '',
        TMUXGO_FRONTEND_DIST: frontendDist,
      },
    })
    await waitFor(`${apiUrl}/health`, gateway)
    const result = await run(playwrightBin, ['test', ...process.argv.slice(2)], {
      cwd: root,
      env: { ...isolatedEnv, TMUXGO_E2E_URL: apiUrl, TMUXGO_E2E_API_URL: apiUrl, TMUXGO_E2E_WORKERS: '1' },
    })
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
