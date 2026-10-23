import '../test-env.js'
import assert from 'node:assert/strict'
import net from 'net'
import test, { type TestContext } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installShims, type Shims } from '../test-shims.js'
import { upsertRemoteHost, type HostInput } from '../lib/hosts.js'

// auth 开关在模块加载时读取环境变量，先置空密码再走免 ticket 路径
process.env.TMUXGO_AUTH_PASSWORD = ''
const { vncRoutes } = await import('./vnc.js')

// 找一个 5900-5999 内的空闲端口做假 RFB 服务；全被占用则跳过
async function findVncPort(): Promise<number | null> {
  for (let port = 5920; port < 6000; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  return null
}

// VNC 探测/安装脚本一律经 ssh 通道下发，用假 ssh 桩接管：stdout 由用例给定，
// 既能断言命令构造（脚本内容进了 argv），又不需要真装服务
async function withVncHost(
  t: TestContext,
  hosts: HostInput[] = [{ id: 'devbox', address: '192.0.2.110', user: 'dev', port: 22, useAgent: false }],
) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-vnc-route-'))
  const previous = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = configDir
  t.after(async () => {
    if (previous === undefined) delete process.env.TMUXGO_CONFIG_DIR
    else process.env.TMUXGO_CONFIG_DIR = previous
    await rm(configDir, { recursive: true, force: true })
  })
  for (const host of hosts) await upsertRemoteHost(host)
  return configDir
}

function shimStdout(stdout: string, exitCode = 0) {
  process.env.SHIM_SSH_STDOUT = stdout
  process.env.SHIM_SSH_STDERR = ''
  process.env.SHIM_SSH_EXIT = String(exitCode)
}

// 每次 ssh 调用的 argv（shim 以 tab 分隔记录）。VNC 脚本本身含换行，日志会把它拆成多行，
// 这里按「SSHPASS= 结尾」切分调用并把续行拼回最后一个参数
function sshCalls(shims: Shims) {
  const calls: string[][] = []
  for (const line of shims.readLog()) {
    if (line.startsWith('ssh\t')) {
      calls.push(line.split('\t').slice(1))
      continue
    }
    const current = calls[calls.length - 1]
    if (!current || line.startsWith('SSHPASS=')) continue
    current[current.length - 1] += `\n${line}`
  }
  return calls
}

async function buildApp(t: TestContext) {
  const app = Fastify()
  await app.register(websocket)
  await app.register(vncRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(() => app.close())
  const address = app.server.address()
  return { app, gatewayPort: typeof address === 'object' && address ? address.port : 0 }
}

test('vnc route pipes binary WebSocket frames to the loopback VNC server', async (t) => {
  const vncPort = await findVncPort()
  if (vncPort === null) return t.skip('no free port in VNC range')
  const received: Buffer[] = []
  const server = net.createServer((socket) => {
    socket.write('RFB 003.008\n')
    socket.on('data', (chunk) => {
      received.push(chunk)
      socket.write('ack')
    })
  })
  await new Promise<void>((resolve) => server.listen(vncPort, '127.0.0.1', resolve))
  const app = Fastify()
  await app.register(websocket)
  await app.register(vncRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const gatewayPort = typeof address === 'object' && address ? address.port : 0
  t.after(async () => {
    await app.close()
    server.close()
  })
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/vnc?hostId=local&port=${vncPort}`)
  ws.binaryType = 'arraybuffer'
  const greeting = await new Promise<ArrayBuffer>((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(event.data as ArrayBuffer), { once: true })
    ws.addEventListener('close', (event) => reject(new Error(`closed ${event.code} ${event.reason}`)), { once: true })
  })
  assert.equal(Buffer.from(greeting).toString(), 'RFB 003.008\n')
  const ack = new Promise<ArrayBuffer>((resolve) =>
    ws.addEventListener('message', (event) => resolve(event.data as ArrayBuffer), { once: true }),
  )
  ws.send(Buffer.from('hello'))
  assert.equal(Buffer.from(await ack).toString(), 'ack')
  assert.equal(received[0]?.toString(), 'hello')
  ws.close()
})

test('vnc route rejects ports outside the display range', async (t) => {
  const app = Fastify()
  await app.register(websocket)
  await app.register(vncRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const gatewayPort = typeof address === 'object' && address ? address.port : 0
  t.after(() => app.close())
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/vnc?hostId=local&port=80`)
  const code = await new Promise<number>((resolve) =>
    ws.addEventListener('close', (event) => resolve(event.code), { once: true }),
  )
  assert.equal(code, 1008)
})

test('vnc setup probe reports a host without any VNC server as needing install', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('os=Linux\nsession=x11\n')
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/setup?hostId=devbox' })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { status: Record<string, unknown>; manualCommand: string }
  assert.deepEqual(body.status, {
    os: 'Linux',
    server: null,
    session: 'x11',
    listening: false,
    sudo: false,
    supported: true,
    hint: 'need-install',
  })
  // 手动安装命令随响应下发，前端可直接复制
  assert.match(body.manualCommand, /apt-get install -y x11vnc/)
  // 探测走 ssh 通道，脚本内容必须原样到达（只读探测，不含安装动作）
  const calls = sshCalls(shims)
  assert.equal(calls.length, 1)
  const command = calls[0].join(' ')
  assert.match(command, /command -v x11vnc/)
  assert.match(command, /echo "os=\$\(uname -s\)"/)
  assert.doesNotMatch(command, /apt-get install/)
})

test('vnc setup probe reports a running server as ready and surfaces sudo availability', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('os=Linux\nsession=x11\nserver=x11vnc\nlistening=1\nrunning=1\nsudo=ok\n')
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/setup?hostId=devbox' })
  assert.equal(response.statusCode, 200)
  const status = (response.json() as { status: Record<string, unknown> }).status
  assert.equal(status.server, 'x11vnc')
  assert.equal(status.listening, true)
  assert.equal(status.sudo, true)
  // 已有 server 且非 wayland：无需任何提示
  assert.equal(status.hint, '')
})

test('vnc setup probe reports a wayland session as compositor-bound', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('os=Linux\nsession=wayland\nwayvnc=1\n')
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/setup?hostId=devbox' })
  const status = (response.json() as { status: Record<string, unknown> }).status
  assert.equal(status.server, 'wayvnc')
  assert.equal(status.session, 'wayland')
  // x11vnc 贴不上 wayland 会话，前端据此给合成器方案
  assert.equal(status.hint, 'wayland-compositor')
})

test('vnc setup probe maps an ssh failure to 502 without echoing raw transport detail', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  process.env.SHIM_SSH_STDOUT = ''
  process.env.SHIM_SSH_STDERR = 'dev@192.0.2.110: Permission denied (publickey).'
  process.env.SHIM_SSH_EXIT = '255'
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/setup?hostId=devbox' })
  assert.equal(response.statusCode, 502)
  const body = response.json() as { error: string }
  // 归一化成动作级原因，不把 ssh 原始 stderr（含用户@地址）直接回显给前端
  assert.equal(body.error, 'SSH authentication failed')
  assert.doesNotMatch(body.error, /dev@|publickey/)
})

test('vnc setup install sends the install script with the long timeout and reports the fresh probe', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('__installed__\nsome apt noise\n')
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/setup',
    payload: { hostId: 'devbox', action: 'install' },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    ok: boolean
    needSudo: boolean
    status: { server: string | null }
    output: string
    manualCommand: string
  }
  assert.equal(body.ok, true)
  assert.equal(body.needSudo, false)
  assert.match(body.output, /some apt noise/)
  assert.match(body.manualCommand, /x11vnc/)
  // 安装 + 安装后复探各一条 ssh：前者含包管理器分支，后者是只读探测
  const calls = sshCalls(shims)
  assert.equal(calls.length, 2)
  assert.match(calls[0].join(' '), /apt-get install -y x11vnc/)
  assert.match(calls[0].join(' '), /__need_sudo__/)
  assert.match(calls[1].join(' '), /command -v x11vnc/)
  // 探测输出里没写 server=，说明服务还没起来，status 必须是未安装形态
  assert.equal(body.status.server, null)
})

test('vnc setup install surfaces the sudo requirement instead of a hard failure', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  // 脚本以 exit 0 + 标记位表达「缺 sudo」，execHostShell 不会 throw，前端据 needSudo 给指引
  shimStdout('__need_sudo__\n')
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/setup',
    payload: { hostId: 'devbox', action: 'install' },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { ok: boolean; needSudo: boolean }
  assert.equal(body.ok, false)
  assert.equal(body.needSudo, true)
})

test('vnc setup start uses the start script and truncates noisy output', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout(`__started__\n${'x'.repeat(4000)}`)
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/setup',
    payload: { hostId: 'devbox', action: 'start' },
  })
  const body = response.json() as { ok: boolean; output: string }
  assert.equal(body.ok, true)
  // 输出进响应前截断，避免把整段 apt/服务日志灌给前端
  assert.equal(body.output.length, 2000)
  const calls = sshCalls(shims)
  assert.match(calls[0].join(' '), /-localhost -forever -shared -bg/)
  assert.doesNotMatch(calls[0].join(' '), /apt-get install/)
})

test('vnc setup rejects an unknown action before touching the host', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/setup',
    payload: { hostId: 'devbox', action: 'reboot' },
  })
  assert.equal(response.statusCode, 400)
  // 错误形态是 { error }，与其他路由的 { message, code } 不同，前端按 error 取值
  assert.deepEqual(response.json(), { error: 'Invalid VNC setup action' })
  assert.equal(sshCalls(shims).length, 0)
})

test('vnc setup maps a failed install to 502 with the normalized reason', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  process.env.SHIM_SSH_STDOUT = ''
  process.env.SHIM_SSH_STDERR = 'ssh: connect to host 192.0.2.110 port 22: Connection refused'
  process.env.SHIM_SSH_EXIT = '255'
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/setup',
    payload: { hostId: 'devbox', action: 'install' },
  })
  assert.equal(response.statusCode, 502)
  assert.equal((response.json() as { error: string }).error, 'SSH network is unreachable')
})

const DISPLAYS_STDOUT = [
  'LISTEN 0      5          127.0.0.1:5903      0.0.0.0:*    users:(("Xtigervnc",pid=4242,fd=5))',
  'LISTEN 0      5          127.0.0.1:5905      0.0.0.0:*',
  '__procs__',
  '  4242       1 Xtigervnc Xtigervnc :3 121000',
  '  4300    4242 Xtigervnc Xtigervnc helper 9000',
].join('\n')

test('vnc displays lists listening ports with process ownership and aggregated rss', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout(DISPLAYS_STDOUT)
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/displays?hostId=devbox' })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { displays: Record<string, unknown>[] }
  assert.deepEqual(body.displays, [
    // server 进程 + 子进程树合计（121000 + 9000），前端用它显示单屏内存占用
    { display: 3, port: 5903, process: 'Xtigervnc', pid: 4242, rssKB: 130000 },
    // ss 没给出 users:(...) 时（无权限）仍列出端口，进程信息留空
    { display: 5, port: 5905, process: null, pid: null },
  ])
  assert.match(sshCalls(shims)[0].join(' '), /sport >= :5900 and sport <= :5999/)
})

test('vnc displays maps a scan failure to 502', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  process.env.SHIM_SSH_STDOUT = ''
  process.env.SHIM_SSH_STDERR = 'ssh: Could not resolve hostname devbox: Name or service not known'
  process.env.SHIM_SSH_EXIT = '255'
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/displays?hostId=devbox' })
  assert.equal(response.statusCode, 502)
  assert.equal((response.json() as { error: string }).error, 'SSH network is unreachable')
})

test('vnc displays rejects display numbers outside 0-99 before running anything', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  const { app } = await buildApp(t)
  for (const display of [100, -1, 1.5]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vnc/displays',
      payload: { hostId: 'devbox', display, action: 'start' },
    })
    assert.equal(response.statusCode, 400, `display=${display}`)
    // 5900-5999 是唯一允许的 RFB 端口带，越界即拒，避免被当作任意 TCP 目标
    assert.deepEqual(response.json(), { error: 'Invalid display number' })
  }
  assert.equal(sshCalls(shims).length, 0)
})

test('vnc displays rejects an unknown action', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/displays',
    payload: { hostId: 'devbox', display: 3, action: 'restart' },
  })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'Invalid display action' })
  assert.equal(sshCalls(shims).length, 0)
})

test('vnc displays start reports an already-listening display instead of starting a second server', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  // 重复创建：脚本发现端口已在监听就只回 __running__，不会起第二个进程
  shimStdout(`__running__\n${DISPLAYS_STDOUT}`)
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/displays',
    payload: { hostId: 'devbox', display: 3, action: 'start' },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { ok: boolean; needPassword: boolean; noServer: boolean; displays: unknown[] }
  assert.equal(body.ok, true)
  assert.equal(body.needPassword, false)
  assert.equal(body.noServer, false)
  assert.equal(body.displays.length, 2)
  const startScript = sshCalls(shims)[0].join(' ')
  // display 号注入成 n，端口一律由 5900+n 推导，不接受调用方直接给端口
  assert.match(startScript, /n=3/)
  assert.match(startScript, /port=\$\(\(5900\+n\)\)/)
  assert.match(startScript, /__running__/)
})

test('vnc displays start reports the missing password file the server would silently reject', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('__need_password__\n')
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/displays',
    payload: { hostId: 'devbox', display: 4, action: 'start' },
  })
  const body = response.json() as { ok: boolean; needPassword: boolean; noServer: boolean }
  assert.equal(body.ok, false)
  assert.equal(body.needPassword, true)
  assert.equal(body.noServer, false)
})

test('vnc displays start reports a host without any Xvnc binary', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('__no_server__\n')
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/displays',
    payload: { hostId: 'devbox', display: 4, action: 'start' },
  })
  const body = response.json() as { ok: boolean; noServer: boolean }
  assert.equal(body.ok, false)
  assert.equal(body.noServer, true)
})

test('vnc displays stop kills by listening port and reports the freed display', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  shimStdout('__stopped__\n__procs__\n')
  const { app } = await buildApp(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/vnc/displays',
    payload: { hostId: 'devbox', display: 3, action: 'stop' },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { ok: boolean; displays: unknown[] }
  assert.equal(body.ok, true)
  assert.deepEqual(body.displays, [])
  const stopScript = sshCalls(shims)[0].join(' ')
  // 按端口找 pid，拿不到再退 fuser：两条路径都得在脚本里
  assert.match(stopScript, /port=5903/)
  assert.match(stopScript, /fuser -k/)
})

test('vnc route falls back to an ssh tunnel and reports the failure reason when the agent is offline', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  // 隧道 ssh 立刻失败：stderr 归一化成动作级原因后拼进 close reason（截 80 字符）
  process.env.SHIM_SSH_STDOUT = ''
  process.env.SHIM_SSH_STDERR = 'ssh: connect to host 192.0.2.110 port 22: Connection refused'
  process.env.SHIM_SSH_EXIT = '255'
  const { gatewayPort } = await buildApp(t)
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/vnc?hostId=devbox&port=5900`)
  const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: String(event.reason) }), {
      once: true,
    }),
  )
  // 1011：服务端内部故障（agent 不在线且隧道失败），不是 1008 的鉴权/参数拒绝
  assert.equal(closed.code, 1011)
  assert.match(closed.reason, /^Agent offline; SSH tunnel failed: /)
  assert.doesNotMatch(closed.reason, /192\.0\.2\.110|Connection refused/)
  const args = sshCalls(shims)[0].join(' ')
  // 隧道把远端 loopback 的 5900 映射到本机随机高位端口，只监听 127.0.0.1
  assert.match(args, /-L 127\.0\.0\.1:\d+:127\.0\.0\.1:5900/)
})

test('vnc route rejects an invalid port before attempting any remote connection', async (t) => {
  const shims = installShims(['ssh'])
  t.after(shims.restore)
  await withVncHost(t)
  const { gatewayPort } = await buildApp(t)
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/vnc?hostId=devbox&port=22`)
  const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: String(event.reason) }), {
      once: true,
    }),
  )
  assert.equal(closed.code, 1008)
  assert.equal(closed.reason, 'Invalid VNC port')
  // 端口先于中继/隧道判定：参数不合法时不该留下任何 ssh 进程
  assert.equal(sshCalls(shims).length, 0)
})

test('vnc ping answers without touching any host', async (t) => {
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/ping' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ok: true })
})

test('vnc client-module serves the prebuilt rfb chunk without caching', async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-vnc-dist-'))
  const previousDist = process.env.TMUXGO_FRONTEND_DIST
  process.env.TMUXGO_FRONTEND_DIST = dist
  t.after(async () => {
    if (previousDist === undefined) delete process.env.TMUXGO_FRONTEND_DIST
    else process.env.TMUXGO_FRONTEND_DIST = previousDist
    await rm(dist, { recursive: true, force: true })
  })
  await mkdir(path.join(dist, '.vite'), { recursive: true })
  await mkdir(path.join(dist, 'assets'), { recursive: true })
  await writeFile(path.join(dist, 'assets', 'rfb-abc123.js'), 'export const rfb = 1\n')
  await writeFile(
    path.join(dist, '.vite', 'manifest.json'),
    JSON.stringify({ 'node_modules/@novnc/novnc/lib/rfb.js': { file: 'assets/rfb-abc123.js' } }),
  )
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/client-module' })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'] as string, /text\/javascript/)
  // chunk hash 随构建变化，必须 no-store，否则移动端会拿到旧模块
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body, 'export const rfb = 1\n')
})

test('vnc client-module falls back to the rfb glob when the manifest is missing', async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-vnc-dist-'))
  const previousDist = process.env.TMUXGO_FRONTEND_DIST
  process.env.TMUXGO_FRONTEND_DIST = dist
  t.after(async () => {
    if (previousDist === undefined) delete process.env.TMUXGO_FRONTEND_DIST
    else process.env.TMUXGO_FRONTEND_DIST = previousDist
    await rm(dist, { recursive: true, force: true })
  })
  await mkdir(path.join(dist, 'assets'), { recursive: true })
  await writeFile(path.join(dist, 'assets', 'rfb-deadbeef.js'), 'export const rfb = 2\n')
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/client-module' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body, 'export const rfb = 2\n')
})

test('vnc client-module answers 404 when the frontend build has no rfb chunk', async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-vnc-dist-'))
  const previousDist = process.env.TMUXGO_FRONTEND_DIST
  process.env.TMUXGO_FRONTEND_DIST = dist
  t.after(async () => {
    if (previousDist === undefined) delete process.env.TMUXGO_FRONTEND_DIST
    else process.env.TMUXGO_FRONTEND_DIST = previousDist
    await rm(dist, { recursive: true, force: true })
  })
  await mkdir(path.join(dist, 'assets'), { recursive: true })
  const { app } = await buildApp(t)
  const response = await app.inject({ method: 'GET', url: '/api/vnc/client-module' })
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { message: 'vnc client module not built' })
})

// VNC 记忆密码的窄口在 hosts.ts（/hosts/:id/vnc/password），不在 vnc.ts：
// 这里覆盖它的存储位置与「只回密码、不回整包凭据」的脱敏边界
async function buildHostApp(t: TestContext) {
  const { hostRoutes } = await import('./hosts.js')
  const { describeZodError } = await import('../lib/request-validation.js')
  const { ZodError } = await import('zod')
  const app = Fastify()
  // 与 index.ts 的 setErrorHandler 等价（该处已有单测覆盖），这里只为让 ZodError 落成 400
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ message: describeZodError(error), code: 'INVALID_REQUEST' })
    return reply.send(error)
  })
  // index.ts 里以 /api 前缀注册；测试直挂根前缀，故下面用 /hosts/... 访问
  await app.register(hostRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(() => app.close())
  return app
}

test('vnc password narrow endpoints persist per display and never drip the credential bundle', async (t) => {
  const configDir = await withVncHost(t)
  const app = await buildHostApp(t)
  const created = await app.inject({
    method: 'PUT',
    url: '/hosts/devbox/vnc/password',
    payload: { display: 3, password: 'rfb-secret' },
  })
  assert.equal(created.statusCode, 200)
  assert.deepEqual(created.json(), { success: true })

  // 落盘位置：host-credentials.json 的 vncDisplays.<display>.password（与 ssh 凭据同库不同子键）
  const stored = JSON.parse(await readFile(path.join(configDir, 'host-credentials.json'), 'utf8')) as {
    credentials: Record<string, { vncDisplays?: Record<string, { password?: string }> }>
  }
  assert.equal(stored.credentials.devbox?.vncDisplays?.['3']?.password, 'rfb-secret')

  const read = await app.inject({ method: 'GET', url: '/hosts/devbox/vnc/password?display=3' })
  assert.equal(read.statusCode, 200)
  // 窄口只回 password 一个字段：地址/用户/私钥路径等其它凭据字段一个都不下发
  assert.deepEqual(read.json(), { password: 'rfb-secret' })
  assert.deepEqual(Object.keys(read.json() as object), ['password'])

  const other = await app.inject({ method: 'GET', url: '/hosts/devbox/vnc/password?display=4' })
  assert.deepEqual(other.json(), {})

  const removed = await app.inject({
    method: 'DELETE',
    url: '/hosts/devbox/vnc/password',
    payload: { display: 3 },
  })
  assert.deepEqual(removed.json(), { success: true })
  assert.deepEqual((await app.inject({ method: 'GET', url: '/hosts/devbox/vnc/password?display=3' })).json(), {})
  const afterDelete = JSON.parse(await readFile(path.join(configDir, 'host-credentials.json'), 'utf8')) as {
    credentials: Record<string, unknown>
  }
  // 只有 VNC 密码的宿主清空后整条剔除，文件不留空壳
  assert.equal(afterDelete.credentials.devbox, undefined)
})

test('vnc password narrow endpoints reject display numbers outside 0-99', async (t) => {
  await withVncHost(t)
  const app = await buildHostApp(t)
  for (const display of [100, -1]) {
    const response = await app.inject({
      method: 'GET',
      url: `/hosts/devbox/vnc/password?display=${display}`,
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { message: 'Invalid display', code: 'INVALID_REQUEST' })
  }
})

test('vnc password narrow endpoints reject an empty password before it reaches the store', async (t) => {
  const configDir = await withVncHost(t)
  const app = await buildHostApp(t)
  for (const password of ['', undefined]) {
    const response = await app.inject({
      method: 'PUT',
      url: '/hosts/devbox/vnc/password',
      payload: { display: 3, password },
    })
    assert.equal(response.statusCode, 400, `password=${String(password)}`)
    const body = response.json() as { code: string; message: string }
    assert.equal(body.code, 'INVALID_REQUEST')
    assert.match(body.message, /^password: /)
  }
  // 校验失败不该写盘：store 里连 vncDisplays 子键都不该出现
  const store = JSON.parse(await readFile(path.join(configDir, 'host-credentials.json'), 'utf8')) as {
    credentials: Record<string, { vncDisplays?: Record<string, unknown> }>
  }
  assert.equal(store.credentials.devbox?.vncDisplays, undefined)
})
