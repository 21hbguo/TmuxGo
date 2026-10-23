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
