import { recordStreamMetric, updateStreamMetric } from '../perf-metrics.js'
import { createTerminalAttachment } from '../terminal-attachment.js'
import { createTerminalOutputSanitizer } from '../terminal-output.js'
import type { TerminalProcess } from './stream-config.js'

// 会话级输出 fan-out 枢纽：同一 host+session 只保留一份 tmux attach PTY，
// sanitize 一次后扇出给全部 StreamSession 订阅者；各端仍走自己的
// flush/profile/编码/压缩/backpressure 路径（fan-out 边界在 sanitize 之后）。
// PTY 创建模式固定 exclusive-capable（不带 ignore-size），这样 exclusive owner
// 的 resize 能驱动 window size；shared 首订者用当前 window 尺寸起附着，
// 避免 attach 即抢 window。非 owner 端永不调用 resizePty（见 StreamSession）。
export function sharedTerminalKey(hostId: string, sessionName: string) {
  return `${hostId}\0${sessionName}`
}

export interface SharedTerminalSubscriber {
  onSharedOutput(filtered: string): void
  onSharedExit(exitCode: number): void
}

export class SharedTerminal {
  readonly subscribers = new Set<SharedTerminalSubscriber>()
  cols: number
  rows: number
  private sanitize = createTerminalOutputSanitizer()
  dead = false
  constructor(
    readonly key: string,
    readonly hostId: string,
    readonly sessionName: string,
    readonly pty: TerminalProcess,
    cols: number,
    rows: number,
  ) {
    this.cols = cols
    this.rows = rows
    pty.onData((chunk: string) => this.handleData(chunk))
    pty.onExit((exitCode: number) => this.handleExit(exitCode))
  }
  get pid() {
    return this.pty.pid
  }
  subscribe(sub: SharedTerminalSubscriber) {
    this.subscribers.add(sub)
  }
  unsubscribe(sub: SharedTerminalSubscriber) {
    this.subscribers.delete(sub)
    // 最后一个订阅者离开 → 销毁 hub（含 PTY），避免孤儿 attach 挂着 tmux client
    if (!this.subscribers.size && sharedTerminals.get(this.key) === this) destroySharedTerminal(this.key)
  }
  resizePty(cols: number, rows: number) {
    if (this.dead) return
    this.pty.resize(cols, rows)
    this.cols = cols
    this.rows = rows
  }
  write(data: string) {
    if (this.dead) return
    this.pty.write(data)
  }
  // sanitize 只在 hub 做一次（含跨 chunk carry）；订阅者收到的已是过滤后字节
  private handleData(chunk: string) {
    if (this.dead) return
    recordStreamMetric('sanitizeCalls')
    recordStreamMetric('sanitizeChars', chunk.length)
    const filtered = this.sanitize(chunk)
    if (!filtered) return
    for (const sub of this.subscribers) sub.onSharedOutput(filtered)
  }
  private handleExit(exitCode: number) {
    if (this.dead) return
    const subs = [...this.subscribers]
    this.dead = true
    if (sharedTerminals.get(this.key) === this) sharedTerminals.delete(this.key)
    updateStreamMetric('sharedTerminals', sharedTerminals.size)
    try {
      this.pty.kill()
    } catch {
      // exit 路径 kill 失败可忽略
    }
    for (const sub of subs) sub.onSharedExit(exitCode)
  }
}

const sharedTerminals = new Map<string, SharedTerminal>()
// 并发 attach 同一 key 时串行化 PTY 创建：两个首订者同时 miss 会各起一条 attach
const pendingAcquires = new Map<string, Promise<{ hub: SharedTerminal; reused: boolean }>>()

export function getSharedTerminal(hostId: string, sessionName: string) {
  return sharedTerminals.get(sharedTerminalKey(hostId, sessionName)) ?? null
}

export function countSharedTerminals() {
  return sharedTerminals.size
}

export function resetSharedTerminalsForTest() {
  pendingAcquires.clear()
  for (const hub of [...sharedTerminals.values()]) {
    sharedTerminals.delete(hub.key)
    try {
      hub.dead = true
      hub.pty.kill()
    } catch {
      // kill 失败可忽略
    }
  }
  updateStreamMetric('sharedTerminals', 0)
}

function destroySharedTerminal(key: string) {
  const hub = sharedTerminals.get(key)
  if (!hub) return
  sharedTerminals.delete(key)
  updateStreamMetric('sharedTerminals', sharedTerminals.size)
  hub.dead = true
  try {
    hub.pty.kill()
  } catch {
    // kill 失败可忽略
  }
}

export async function acquireSharedTerminal(opts: {
  hostId: string
  sessionName: string
  cols: number
  rows: number
}): Promise<{ hub: SharedTerminal; reused: boolean }> {
  const key = sharedTerminalKey(opts.hostId, opts.sessionName)
  const existing = sharedTerminals.get(key)
  if (existing) {
    recordStreamMetric('sharedPtyReuses')
    return { hub: existing, reused: true }
  }
  const pending = pendingAcquires.get(key)
  if (pending) {
    const result = await pending
    recordStreamMetric('sharedPtyReuses')
    return { hub: result.hub, reused: true }
  }
  const create = (async () => {
    // hub 级 PTY 恒为 exclusive attach：window 仲裁只认这一条 client 的 resize
    const pty = await createTerminalAttachment({
      hostId: opts.hostId,
      sessionName: opts.sessionName,
      cols: opts.cols,
      rows: opts.rows,
      exclusive: true,
    })
    // 创建期间可能已被并发路径抢装或重置（测试 teardown），以 map 现状为准
    const raced = sharedTerminals.get(key)
    if (raced) {
      try {
        pty.kill()
      } catch {
        // 竞态弃用 PTY kill 失败可忽略
      }
      return { hub: raced, reused: true }
    }
    const hub = new SharedTerminal(key, opts.hostId, opts.sessionName, pty, opts.cols, opts.rows)
    sharedTerminals.set(key, hub)
    updateStreamMetric('sharedTerminals', sharedTerminals.size)
    return { hub, reused: false }
  })()
  pendingAcquires.set(key, create)
  try {
    return await create
  } finally {
    pendingAcquires.delete(key)
  }
}
