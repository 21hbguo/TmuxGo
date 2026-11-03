// 会话列表变更广播：把「tmux 侧 session 增删/改名/window 数/attached 变化」
// 归一成一个 per-host 版本号，供前端长轮询（GET /hosts/:hostId/sessions/changes）等待。
//
// 为什么不是「前端每 2s 拉一次全量列表」：
//   1. 全量列表要付 list-sessions + agents 汇总 + payload，一个页面开着就每秒烧一次；
//   2. 多客户端/多标签时开销是乘法，N 个客户端各拉一遍同一份数据。
// 这里的成本是加法：每个被观察的 host 只有一个后台探针（默认 2s 一次 list-sessions），
// 所有等待者共享同一个版本号；没有等待者时探针立刻停（留一小段宽限给长轮询续期）。
//
// 为什么还要探针而不是纯事件：
//   tmux 确实有 session-created/session-closed 等 hook，但 hook 只能把事件写到
//   **目标主机**的队列文件里；网关要拿到它仍得定时读远端文件（SSH exec），
//   读一次的代价和 list-sessions 基本一样，却要为每个 host 额外装/清理 hook。
//   外部 tmux CLI 建的 session 也必须覆盖，所以「一个廉价的 list-sessions 探针」是
//   覆盖 local + remote + 外部客户端的最短路径。网关自己的增删改走 markChanged() 直接
//   抬版本，不依赖探针节拍。
//
// 签名里刻意不含 lastActiveAt：session_activity 随任意 pane 输出变化，把它算进签名等于
// 让「有人在打字」变成每秒 invalidate。活动时间只在前端兜底轮询里更新。

import { isEmptyTmuxServerError, listUserSessions } from './session-list.js'

export interface SessionChangeSnapshot {
  name: string
  windowCount: number
  attached: boolean
}

export interface SessionChangeResult {
  revision: number
  changed: boolean
}

export interface SessionChangeFeedOptions {
  /** 探针取数实现：默认走 tmux list-sessions，测试可注入假实现 */
  listSessions?: (hostId: string) => Promise<SessionChangeSnapshot[]>
  /** 有等待者时的探针节拍 */
  intervalMs?: number
  /** 连续失败时的退避上限（远端不可达时别每 2s 烧一次 SSH） */
  maxIntervalMs?: number
  /** 最后一个等待者离开后，探针再保留多久——长轮询续期之间有几毫秒空档 */
  watchGraceMs?: number
  /** 同时在观察的 host 上限：防御异常客户端订阅海量 host */
  maxWatchedHosts?: number
}

interface Waiter {
  hostId: string
  since: number
  done: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (result: SessionChangeResult) => void
}

interface Watcher {
  hostId: string
  timer: ReturnType<typeof setTimeout> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  failures: number
}

export const SESSION_CHANGE_WATCH_MS = Math.max(250, Number(process.env.TMUXGO_SESSION_WATCH_MS) || 2000)
const SESSION_CHANGE_MAX_WATCH_MS = 15000
const SESSION_CHANGE_GRACE_MS = 5000
const SESSION_CHANGE_MAX_WATCHED_HOSTS = 64

/** 签名只取「会话区会显示的结构性字段」，名字排序保证与 tmux 输出顺序无关 */
export function sessionChangeSignature(sessions: readonly SessionChangeSnapshot[]): string {
  return sessions
    .map((session) => `${session.name}\t${Number(session.windowCount) || 0}\t${session.attached ? 1 : 0}`)
    .sort()
    .join('\n')
}

async function listSessionSnapshots(hostId: string): Promise<SessionChangeSnapshot[]> {
  try {
    const sessions = await listUserSessions(hostId)
    return sessions.map((session) => ({
      name: session.name,
      windowCount: session.windowCount,
      attached: session.attached,
    }))
  } catch (error) {
    // 「没有 tmux server」= 空列表。抛出去会让探针每轮都进失败退避，
    // 反而让「server 刚起来」这件事延迟十几秒才被发现
    if (isEmptyTmuxServerError(error)) return []
    throw error
  }
}

export class SessionChangeFeed {
  private readonly revisions = new Map<string, number>()
  private readonly signatures = new Map<string, string>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  private readonly watchers = new Map<string, Watcher>()
  private readonly listSessions: (hostId: string) => Promise<SessionChangeSnapshot[]>
  private readonly intervalMs: number
  private readonly maxIntervalMs: number
  private readonly watchGraceMs: number
  private readonly maxWatchedHosts: number
  private disposed = false

  constructor(options: SessionChangeFeedOptions = {}) {
    this.listSessions = options.listSessions || listSessionSnapshots
    this.intervalMs = Math.max(50, options.intervalMs ?? SESSION_CHANGE_WATCH_MS)
    this.maxIntervalMs = Math.max(this.intervalMs, options.maxIntervalMs ?? SESSION_CHANGE_MAX_WATCH_MS)
    this.watchGraceMs = Math.max(0, options.watchGraceMs ?? SESSION_CHANGE_GRACE_MS)
    this.maxWatchedHosts = Math.max(1, options.maxWatchedHosts ?? SESSION_CHANGE_MAX_WATCHED_HOSTS)
  }

  /** 当前版本号；网关重启后从 0 重新计数，等待方按「不等于」而不是「大于」判定变化 */
  getRevision(hostId: string): number {
    return this.revisions.get(hostId) || 0
  }

  get watchedHostIds(): string[] {
    return [...this.watchers.keys()]
  }

  get waiterCount(): number {
    let total = 0
    for (const set of this.waiters.values()) total += set.size
    return total
  }

  /** 收到一份新列表：签名变了就抬版本并唤醒等待者，返回是否发生了变化 */
  noteSessions(hostId: string, sessions: readonly SessionChangeSnapshot[]): boolean {
    const signature = sessionChangeSignature(sessions)
    const previous = this.signatures.get(hostId)
    this.signatures.set(hostId, signature)
    if (previous === undefined || previous === signature) return false
    this.markChanged(hostId)
    return true
  }

  /** 已知的变更（网关自己 create/rename/delete）：直接抬版本，不等探针 */
  markChanged(hostId: string): number {
    const next = this.getRevision(hostId) + 1
    this.revisions.set(hostId, next)
    for (const waiter of [...(this.waiters.get(hostId) || [])]) this.settle(waiter)
    return next
  }

  /**
   * 等到版本号变化或超时。先比对再登记等待者，中间没有 await——
   * 单线程下不会漏掉「刚好在登记前发生」的变更。
   */
  waitForChange(
    hostId: string,
    sinceRevision: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SessionChangeResult> {
    const revision = this.getRevision(hostId)
    if (revision !== sinceRevision) return Promise.resolve({ revision, changed: true })
    if (signal?.aborted) return Promise.resolve({ revision, changed: false })
    if (this.disposed || timeoutMs <= 0) return Promise.resolve({ revision, changed: false })
    this.ensureWatcher(hostId)
    return new Promise<SessionChangeResult>((resolve) => {
      const waiter: Waiter = { hostId, since: sinceRevision, done: false, timer: null, resolve }
      const set = this.waiters.get(hostId) || new Set<Waiter>()
      set.add(waiter)
      this.waiters.set(hostId, set)
      // 不 unref：这条定时器代表「有个客户端正等着这次响应」，它该让进程活着；
      // 关服由 drain() 负责结清，不会让 close 等满整个窗口
      waiter.timer = setTimeout(() => this.settle(waiter), Math.max(0, timeoutMs))
      signal?.addEventListener('abort', () => this.settle(waiter), { once: true })
    })
  }

  /**
   * 关服：挂着的长轮询必须立刻返回，否则 fastify.close() 要等满等待窗；
   * 但不封锁后续使用（同进程里重建 app 的测试还要继续用同一个实例）
   */
  drain() {
    for (const set of [...this.waiters.values()]) for (const waiter of [...set]) this.settle(waiter)
    for (const watcher of this.watchers.values()) {
      if (watcher.timer) clearTimeout(watcher.timer)
      if (watcher.stopTimer) clearTimeout(watcher.stopTimer)
      watcher.timer = null
      watcher.stopTimer = null
    }
    this.watchers.clear()
    this.waiters.clear()
  }

  /** 测试清理：drain 之后再封锁新的等待，避免残留长轮询把用例挂住 */
  dispose() {
    this.drain()
    this.disposed = true
    this.signatures.clear()
    this.revisions.clear()
  }

  private settle(waiter: Waiter) {
    if (waiter.done) return
    waiter.done = true
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.timer = null
    const set = this.waiters.get(waiter.hostId)
    set?.delete(waiter)
    if (set && set.size === 0) {
      this.waiters.delete(waiter.hostId)
      this.scheduleWatcherStop(waiter.hostId)
    }
    const revision = this.getRevision(waiter.hostId)
    waiter.resolve({ revision, changed: revision !== waiter.since })
  }

  private ensureWatcher(hostId: string) {
    const existing = this.watchers.get(hostId)
    if (existing) {
      if (existing.stopTimer) {
        clearTimeout(existing.stopTimer)
        existing.stopTimer = null
      }
      return
    }
    if (this.watchers.size >= this.maxWatchedHosts) return
    const watcher: Watcher = { hostId, timer: null, stopTimer: null, failures: 0 }
    this.watchers.set(hostId, watcher)
    this.scheduleTick(watcher, this.intervalMs)
  }

  private scheduleWatcherStop(hostId: string) {
    const watcher = this.watchers.get(hostId)
    if (!watcher || watcher.stopTimer) return
    const timer = setTimeout(() => {
      watcher.stopTimer = null
      if (this.waiters.has(hostId)) return
      if (watcher.timer) clearTimeout(watcher.timer)
      watcher.timer = null
      this.watchers.delete(hostId)
    }, this.watchGraceMs)
    timer.unref?.()
    watcher.stopTimer = timer
  }

  private scheduleTick(watcher: Watcher, delayMs: number) {
    if (watcher.timer) clearTimeout(watcher.timer)
    const timer = setTimeout(() => {
      watcher.timer = null
      void this.tick(watcher)
    }, delayMs)
    timer.unref?.()
    watcher.timer = timer
  }

  private async tick(watcher: Watcher) {
    if (!this.watchers.has(watcher.hostId)) return
    try {
      const sessions = await this.listSessions(watcher.hostId)
      watcher.failures = 0
      this.noteSessions(watcher.hostId, sessions)
    } catch {
      // 失败只影响节拍，不改版本号：上一次的签名仍是「已知状态」，
      // 恢复后第一轮成功探针会自然把差异抬成一次变更
      watcher.failures += 1
    }
    if (!this.watchers.has(watcher.hostId)) return
    const delay = watcher.failures
      ? Math.min(this.intervalMs * 2 ** Math.min(watcher.failures, 6), this.maxIntervalMs)
      : this.intervalMs
    this.scheduleTick(watcher, delay)
  }
}

export const sessionChangeFeed = new SessionChangeFeed()
