import '../test-env.js'
import assert from 'node:assert/strict'
import net from 'net'
import test, { type TestContext } from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { mkdtemp, rm } from 'node:fs/promises'
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
