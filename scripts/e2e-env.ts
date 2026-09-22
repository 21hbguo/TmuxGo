import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface E2EEnvironment {
  root: string
  apiUrl: string
  frontendDist: string
  // tmux/gateway 用的隔离环境（TMUX_TMPDIR 独立 server、空 HOME、独立 config）
  tmuxEnv: NodeJS.ProcessEnv
  // playwright 用的隔离环境（不改 HOME，浏览器在 ~/.cache/ms-playwright）
  playwrightEnv: NodeJS.ProcessEnv
  gateway: ChildProcess
  cleanup: () => Promise<void>
}

export function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    throw new Error(`Unsupported Node.js ${process.version}. Need ^20.19 || ^22.12 || >=24 (nvm use with .nvmrc)`)
  }
}

export function resolveBin(root: string, name: string) {
  const candidates = [
    join(root, 'node_modules', '.bin', name),
    join(root, 'apps', 'frontend', 'node_modules', '.bin', name),
    join(root, 'apps', 'gateway', 'node_modules', '.bin', name),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`Unable to resolve ${name} binary (looked in node_modules/.bin and workspace bins)`)
  return found
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function freePort() {
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

export async function waitFor(url: string, process: ChildProcess) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${url} exited before becoming ready`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // 服务未就绪继续等到 deadline
    }
    await delay(200)
  }
  throw new Error(`${url} did not become ready`)
}

export async function stop(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([new Promise<void>((resolve) => process.once('exit', () => resolve())), delay(5000)])
  if (process.exitCode === null) process.kill('SIGKILL')
}

export async function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

// 构建前端到临时 dist、起隔离 tmux server 的 test session、起 gateway。
// 与 scripts/run-e2e.ts 原内联实现一致：真实 tmux 行为只允许在隔离 server 的
// test session 内进行（AGENTS.md），清理只 kill 该临时 server
export async function bootstrapE2E(root: string): Promise<E2EEnvironment> {
  const configDir = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-'))
  const frontendDist = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-frontend-'))
  const tmuxDir = await mkdtemp(join(tmpdir(), 'tmuxgo-e2e-tmux-'))
  let gateway: ChildProcess | undefined
  let cleaned = false
  const cleanup = async () => {
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
  try {
    const apiPort = await freePort()
    const apiUrl = `http://127.0.0.1:${apiPort}`
    const viteBin = resolveBin(root, 'vite')
    const tsxBin = resolveBin(root, 'tsx')
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
    if ((await run('tmux', ['new-session', '-d', '-s', 'test'], { cwd: root, env: tmuxEnv })) !== 0)
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
    return {
      root,
      apiUrl,
      frontendDist,
      tmuxEnv,
      playwrightEnv: { ...isolatedEnv, TMUXGO_E2E_URL: apiUrl, TMUXGO_E2E_API_URL: apiUrl, TMUXGO_E2E_WORKERS: '1' },
      gateway,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
