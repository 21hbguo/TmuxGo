import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'

// 同 stream.test.ts：ws 只有类型声明文件，运行时类必须显式 require
type WsClient = {
  send(data: string): void
  close(): void
  on(event: 'message', listener: (raw: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  once(event: 'open', listener: () => void): void
  once(event: 'error', listener: (error: Error) => void): void
}
const WsClientImpl = createRequire(import.meta.url)('ws') as new (url: string) => WsClient

process.env.TMUXGO_AUTH_USERNAME = 'heartzone'
process.env.TMUXGO_AUTH_PASSWORD = 'heartzone-pass'

const { streamRoutes } = await import('./stream.js')
const { agentMonitor } = await import('../lib/agent-monitor.js')
const { issueScopedWebSocketTicket } = await import('../lib/auth.js')

type Frame = Record<string, any>
type MonitorEvent = {
  type: string
  hostId?: string
  sessionName?: string
  agents?: Record<string, unknown>[]
} & Record<string, unknown>

// monitor 单例没有 scan/listener 注入缝（AgentMonitor 的注入选项只对自建实例生效），
// 这里直接驱动已注册的扇出监听器——等价于 monitor.emit，专门校验 routes/stream 的 scope 闸
const monitorListeners = (agentMonitor as unknown as { listeners: Set<(event: MonitorEvent) => void> }).listeners

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitFrame(frames: Frame[], match: (frame: Frame) => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = frames.find(match)
    if (hit) return hit
    await delay(10)
  }
  throw new Error(`frame not received: ${JSON.stringify(frames)}`)
}

test('restricted scope only fans out agent events of whitelisted sessions', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-stream-scope-'))
  const previousAudit = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = path.join(dir, 'audit.ndjson')
  const app = Fastify()
  await app.register(websocket)
  await app.register(streamRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => {
    await app.close()
    agentMonitor.stop()
    if (previousAudit === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAudit
    rmSync(dir, { recursive: true, force: true })
  })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const { ticket } = await issueScopedWebSocketTicket('scoped', { hosts: ['local'], sessions: ['a'] })
  const listenersBefore = new Set(monitorListeners)
  const ws = new WsClientImpl(`ws://127.0.0.1:${port}/api/stream?ticket=${encodeURIComponent(ticket)}`)
  const frames: Frame[] = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame))
  ws.on('error', () => {})
  t.after(() => ws.close())
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  await waitFrame(frames, (frame) => frame.type === 'connected')

  const ours = [...monitorListeners].filter((listener) => !listenersBefore.has(listener))
  assert.equal(ours.length, 1, '受限 scope 连接应订阅一路 agent 事件扇出')
  const emit = (event: MonitorEvent) => {
    for (const listener of ours) listener(event)
  }

  // session b 的状态变化不得抵达（原先只过 host 闸，这条会漏）
  emit({
    type: 'agent_status_changed',
    hostId: 'local',
    sessionName: 'b',
    pane: { paneId: 'probe-b' },
  })
  // 白名单内的 session a 正常扇出
  emit({
    type: 'agent_status_changed',
    hostId: 'local',
    sessionName: 'a',
    pane: { paneId: 'probe-a' },
  })
  // host 闸仍然生效：非白名单 host 一律不发
  emit({ type: 'agent_status_changed', hostId: 'remote-x', sessionName: 'a', pane: { paneId: 'probe-remote' } })
  // snapshot 逐 pane 过滤，而不是整帧丢弃
  emit({
    type: 'agent_status_snapshot',
    hostId: 'local',
    agents: [
      { sessionName: 'a', paneId: 'probe-a' },
      { sessionName: 'b', paneId: 'probe-b' },
    ],
  })

  const allowed = await waitFrame(frames, (frame) => frame.type === 'agent_status_changed')
  assert.equal(allowed.sessionName, 'a')
  const snapshot = await waitFrame(frames, (frame) => frame.type === 'agent_status_snapshot')
  assert.deepEqual(
    (snapshot.agents as { paneId: string }[]).map((pane) => pane.paneId),
    ['probe-a'],
  )
  const leaked = frames.filter(
    (frame) => JSON.stringify(frame).includes('probe-b') || JSON.stringify(frame).includes('probe-remote'),
  )
  assert.deepEqual(leaked, [])
})
