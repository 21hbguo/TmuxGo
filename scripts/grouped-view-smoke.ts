// 一次性 grouped-view 真机冒烟：隔离 tmux server + 真 gateway + 真 WS attach。
// 验证：列表隐藏 view、两个 view 各看各的 current window、select 只动本 view、
// 协议 sessionName 始终 base、detach 后 view 保留、base 消失后 sweep 清孤儿。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { prepareTmuxSocketDir, tmuxSocketPath, tmuxTestEnv } from './tmux-isolation'

const root = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'tmuxgo-grouped-smoke-'))
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
prepareTmuxSocketDir(dir)
const socket = tmuxSocketPath(dir)
const tmuxEnv = { ...tmuxTestEnv(dir), HOME: dir }
const tmux = (args: string[]) => {
  const result = spawnSync('tmux', ['-S', socket, ...args], { env: tmuxEnv, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

let gateway: ChildProcess | undefined
const sockets: WebSocket[] = []
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no port'))
      server.close(() => resolve(address.port))
    })
  })
}

function attach(port: number, viewId: string) {
  return new Promise<{ ws: WebSocket; frame: Record<string, unknown> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`)
    sockets.push(ws)
    const timer = setTimeout(() => reject(new Error(`attach timeout for ${viewId}`)), 15000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'attach',
          hostId: 'local',
          sessionName: 'test',
          viewId,
          cols: 100,
          rows: 30,
        }),
      ),
    )
    ws.on('message', (raw) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (frame.type === 'error') {
        clearTimeout(timer)
        reject(new Error(`attach error: ${String(frame.message || frame.error)}`))
      }
      if (frame.type === 'attached') {
        clearTimeout(timer)
        resolve({ ws, frame })
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

type WindowRow = { id: string; index: number; active: boolean; sessionId: string }
type SnapshotRow = {
  sessionId: string
  sessionName: string
  activeWindowId: string
  windows: WindowRow[]
}
async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const body = (await response.json()) as T
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`)
  return body
}

function viewNames() {
  return tmux(['list-sessions', '-F', '#{session_name}\t#{@tmuxgo_view_base}\t#{@tmuxgo_view_client}'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter((row) => row[1])
}
function currentWindow(target: string) {
  return Number(tmux(['display-message', '-p', '-t', target, '#{window_index}']))
}

async function main() {
  tmux(['new-session', '-d', '-s', 'test', '-x', '100', '-y', '30'])
  tmux(['set-option', '-s', '-g', 'default-shell', '/bin/sh'])
  tmux(['new-window', '-t', 'test:1', '-n', 'two'])
  tmux(['select-window', '-t', 'test:0'])
  tmux(['send-keys', '-l', '-t', 'test:0', 'clear; echo VIEW-ZERO'])
  tmux(['send-keys', '-t', 'test:0', 'Enter'])
  tmux(['send-keys', '-l', '-t', 'test:1', 'clear; echo VIEW-ONE'])
  tmux(['send-keys', '-t', 'test:1', 'Enter'])
  assert(currentWindow('test') === 0, 'base starts on window 0')

  const port = await freePort()
  gateway = spawn(join(root, 'node_modules/.bin/tsx'), ['apps/gateway/src/index.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...tmuxEnv,
      PORT: String(port),
      TMUXGO_HOST: '127.0.0.1',
      TMUXGO_AUTH_USERNAME: '',
      TMUXGO_AUTH_PASSWORD: '',
      TMUXGO_FOLD_SAME_MACHINE_AGENT: '0',
      TMUXGO_HUB_GRACE_MS: '500',
      TMUXGO_FRONTEND_DIST: join(root, 'apps/frontend/dist'),
      TMUXGO_CONFIG_DIR: configDir,
      TMUXGO_PREFERENCES_DIR: join(configDir, 'preferences'),
      TMUXGO_TMP_DIR: join(configDir, 'tmp'),
    },
  })
  gateway.stdout?.on('data', (chunk) => process.stdout.write(`[gw] ${chunk}`))
  gateway.stderr?.on('data', (chunk) => process.stderr.write(`[gw] ${chunk}`))
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
    } catch {}
    if (i === 149) throw new Error('gateway did not become ready')
    await delay(200)
  }

  const sessionId = 'session-local-test'
  const base = `/api/hosts/local/sessions/${encodeURIComponent(sessionId)}`
  const windowsUrl = `${base}/windows`
  const snapshotUrl = `${base}/snapshot`
  const panesUrl = `${base}/panes`

  // 首屏竞态：view 未建时带 viewId 读，必须回退 base 而不是 404
  const early = await api<WindowRow[]>(port, `${windowsUrl}?viewId=earlyview01`)
  assert(early.find((w) => w.active)?.index === 0, 'pre-attach read falls back to base')

  const first = await attach(port, 'e2eview01')
  assert(first.frame.sessionName === 'test', `attached sessionName must be base, got ${first.frame.sessionName}`)
  const firstView = viewNames().find((row) => row[2] === 'e2eview01')?.[0]
  assert(firstView, 'view 1 created')
  assert(currentWindow(firstView!) === 0, 'view 1 inherits base current window')

  const windows = await api<WindowRow[]>(port, `${windowsUrl}?viewId=e2eview01`)
  assert(windows.find((w) => w.active)?.index === 0, 'view 1 starts active 0')
  const baseWindows = await api<WindowRow[]>(port, windowsUrl)
  assert(baseWindows.find((w) => w.active)?.index === 0, 'base still active 0')

  const selected = await api<{ windows: WindowRow[] }>(port, `${windowsUrl}/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windowId: 'local:@1', viewId: 'e2eview01' }),
  })
  assert(selected.windows.find((w) => w.active)?.index === 1, 'view 1 switches to 1')
  assert(currentWindow(firstView!) === 1, 'tmux view 1 current is 1')
  assert(currentWindow('test') === 0, 'base current stays 0 after view select')

  const second = await attach(port, 'e2eview02')
  assert(second.frame.sessionName === 'test', 'second attach reports base name')
  const secondView = viewNames().find((row) => row[2] === 'e2eview02')?.[0]
  assert(secondView, 'view 2 created')
  assert(currentWindow(secondView!) === 0, 'view 2 inherits base 0, not view 1')

  const windows2 = await api<WindowRow[]>(port, `${windowsUrl}?viewId=e2eview02`)
  assert(windows2.find((w) => w.active)?.index === 0, 'view 2 sees its own active 0')
  assert(currentWindow(firstView!) === 1, 'view 1 keeps active 1')

  const snapshot = await api<SnapshotRow>(port, `${snapshotUrl}?viewId=e2eview02`)
  assert(snapshot.sessionName === 'test', 'snapshot sessionName base')
  assert(snapshot.sessionId === sessionId, 'snapshot sessionId base id')
  assert(snapshot.windows.find((w) => w.active)?.index === 0, 'snapshot active follows view 2')

  const panes = await api<unknown[]>(port, `${panesUrl}?viewId=e2eview02`)
  assert(Array.isArray(panes) && panes.length === 2, `view 2 lists 2 panes, got ${panes.length}`)

  const sessions = await api<{ name: string }[]>(port, '/api/hosts/local/sessions')
  const names = sessions.map((s) => s.name)
  assert(names.includes('test'), 'base listed')
  assert(!names.some((name: string) => name.startsWith('tmuxgo-view-')), 'view sessions hidden from list')

  // 关掉 view 1 的 WS：view 不立即销毁，10 分钟内重连还能保住 current window
  first.ws.close()
  await delay(500)
  assert(currentWindow(firstView!) === 1, 'detached view survives grace')

  // 两端都 detach 后 TTL=0 的 sweep 必须清掉两个 view，base 原样保留
  second.ws.close()
  await delay(1500)
  // 本进程也要连到同一个隔离 server：继承的 TMUX 会让 tmux CLI 忽略 TMUX_TMPDIR
  process.env.TMUX = ''
  process.env.TMUX_TMPDIR = dir
  process.env.HOME = dir
  process.env.TMUXGO_CONFIG_DIR = configDir
  const { sweepViewSessions } = await import('../apps/gateway/src/lib/view-sessions.js')
  const killed = await sweepViewSessions('local', { ttlMs: 0 })
  assert(killed.length === 2, `sweep clears both detached views, got ${killed.length}`)
  assert(viewNames().length === 0, 'no view sessions left')
  assert(currentWindow('test') === 0, 'base survives view sweep')
  tmux(['kill-session', '-t', 'test'])

  console.log('\nGROUPED_VIEW_SMOKE=PASS', { firstView, secondView, killed })
}

main()
  .catch((error) => {
    console.error('\nGROUPED_VIEW_SMOKE=FAIL', error)
    process.exitCode = 1
  })
  .finally(async () => {
    for (const ws of sockets) ws.terminate()
    if (gateway && gateway.exitCode === null) {
      gateway.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => gateway!.once('exit', resolve)), delay(3000)])
      if (gateway.exitCode === null) gateway.kill('SIGKILL')
    }
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env: tmuxEnv })
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
