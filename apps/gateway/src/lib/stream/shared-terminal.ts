import { recordStreamMetric, updateStreamMetric } from '../perf-metrics.js'
import { createTerminalAttachment } from '../terminal-attachment.js'
import { createTerminalOutputSanitizer, hasSubstantiveTerminalContent } from '../terminal-output.js'
import type { TerminalProcess } from './stream-config.js'
import { PaneMirror } from './pane-mirror.js'
import { execTmux } from '../tmux-executor.js'
import { isMirrorEnabled } from './stream-config.js'

// 会话级输出 fan-out 枢纽：同一 host+session 只保留一份 tmux attach PTY，
// sanitize 一次后扇出给全部 StreamSession 订阅者；各端仍走自己的
// flush/profile/编码/压缩/backpressure 路径（fan-out 边界在 sanitize 之后）。
// PTY 创建模式固定 exclusive-capable（不带 ignore-size），这样 exclusive owner
// 的 resize 能驱动 window size；shared 首订者用当前 window 尺寸起附着，
// 避免 attach 即抢 window。非 owner 端永不调用 resizePty（见 StreamSession）。
// 最后一个订阅者离开后 hub 的存活宽限：期内重连能复用同一份 PTY + 镜像（吃增量），
// 到期再销毁。孤儿风险是真约束——每个挂起 hub = 一条活 tmux client + 镜像内存
// （~0.5MB），所以只做有限宽限，绝不无限期保活
const DEFAULT_HUB_GRACE_MS = 30000
function readHubGraceMs() {
  const raw = process.env.TMUXGO_HUB_GRACE_MS
  if (raw === undefined || raw === '') return DEFAULT_HUB_GRACE_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HUB_GRACE_MS
}
let hubGraceMs = readHubGraceMs()
// 测试缝：0 = 立即销毁（旧行为）
export function setHubGraceMsForTest(value: number | null) {
  hubGraceMs = value ?? readHubGraceMs()
}

export function sharedTerminalKey(hostId: string, sessionName: string) {
  return `${hostId}\0${sessionName}`
}

// ---- 无订阅者虚拟视口 ------------------------------------------------------
// 最后一个订阅者离开后 hub 仍活到宽限期结束，但 tmux window 会停在最后一端
// fit 出来的尺寸：全屏程序按它重排，重连后再重排一次，纯抖动。herdr 的做法是
// 「没人看就退回虚拟终端尺寸」（headless_cols/rows = 120x40），这里做等价实现。
// 只在「本 hub 是该 session 唯一 client」时才敢钉：window 尺寸是会话级共享属性，
// `window-size latest` 下我们一 resize，旁边真终端会被一起改小。这次 list-clients
// 是只读查询，老 tmux 也支持；查不出来就跳过本次（保持旧行为），绝不抛错。
// 远端 host（SSH / agent 通道）同样生效：list-clients 与 resize 都走既有 execTmux
// 路由，本地和远端是同一条代码路径；远端 tmux 不认参数时按下面 unsupported 表降级。
const DEFAULT_HEADLESS_COLS = 120
const DEFAULT_HEADLESS_ROWS = 40
function parseHeadlessDimension(raw: string | undefined, fallback: number) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}
function readHeadlessViewport(): { cols: number; rows: number } | null {
  // TMUXGO_HEADLESS_COLS=0 是显式关闭开关（想完全沿用最后一端尺寸的部署用）
  if ((process.env.TMUXGO_HEADLESS_COLS || '').trim() === '0') return null
  return {
    cols: parseHeadlessDimension(process.env.TMUXGO_HEADLESS_COLS, DEFAULT_HEADLESS_COLS),
    rows: parseHeadlessDimension(process.env.TMUXGO_HEADLESS_ROWS, DEFAULT_HEADLESS_ROWS),
  }
}
let headlessViewport = readHeadlessViewport()
// 钉之前先等一小会儿：切标签/切 session 常是「断开几十毫秒再连回来」，立刻钉会把
// window 先改成 120x40 再改回 fit，反而多两次重排（正是要消除的抖动）。等到确认
// 真没人回来再钉；宽限期本身远长于这个延迟，不影响最终结果。
const DEFAULT_HEADLESS_PIN_DELAY_MS = 300
function readHeadlessPinDelayMs() {
  const value = Number(process.env.TMUXGO_HEADLESS_PIN_DELAY_MS)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_HEADLESS_PIN_DELAY_MS
}
let headlessPinDelayMs = readHeadlessPinDelayMs()
export function setHeadlessPinDelayForTest(value: number | null) {
  headlessPinDelayMs = value ?? readHeadlessPinDelayMs()
}
export function setHeadlessViewportForTest(value: { cols: number; rows: number } | null) {
  headlessViewport = value ?? readHeadlessViewport()
}
export function peekHeadlessViewport() {
  return headlessViewport
}
type AttachedClientCounter = (hostId: string, sessionName: string) => Promise<number>
async function defaultCountAttachedClients(hostId: string, sessionName: string) {
  const { stdout } = await execTmux(hostId, ['list-clients', '-t', sessionName, '-F', '#{client_name}'])
  return stdout.split('\n').filter((line) => line.trim()).length
}
let countAttachedClientsImpl: AttachedClientCounter = defaultCountAttachedClients
export function setCountAttachedClientsForTest(fn: AttachedClientCounter | null) {
  countAttachedClientsImpl = fn ?? defaultCountAttachedClients
}
// 老 tmux 不认 `list-clients -F`（1.8 之前）时记一次 host 级标记后不再查，与
// tmux-hooks 的 unsupportedHookEvents 同款降级：不报错、不刷日志、每次少一条命令
const headlessPinUnsupported = new Set<string>()
export async function pinHeadlessViewport(hub: SharedTerminal): Promise<boolean> {
  const target = headlessViewport
  if (!target || hub.dead || hub.subscribers.size) return false
  // 尺寸已经等于目标：不用碰 PTY（省一次 window 重排与整屏重绘）
  if (hub.cols === target.cols && hub.rows === target.rows) return false
  if (headlessPinUnsupported.has(hub.hostId)) return false
  let clients: number
  try {
    clients = await countAttachedClientsImpl(hub.hostId, hub.sessionName)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/unknown (command|option)|usage:/i.test(message)) headlessPinUnsupported.add(hub.hostId)
    recordStreamMetric('hubHeadlessPinSkipped')
    return false
  }
  // 查询期间可能已有新订阅者（或 hub 被销毁/被替换）：重新确认再动 PTY
  if (hub.dead || hub.subscribers.size || sharedTerminals.get(hub.key) !== hub) return false
  if (clients > 1) {
    recordStreamMetric('hubHeadlessPinSkipped')
    return false
  }
  hub.resizePty(target.cols, target.rows)
  recordStreamMetric('hubHeadlessPinned')
  return true
}

export interface SharedTerminalSubscriber {
  onSharedOutput(filtered: string): void
  onSharedExit(exitCode: number): void
  // 广播重绘边界回调：某订阅者的 refresh-client 重绘即将经 hub 扇出，
  // 先收 output_resync 边界帧做原子替换（见 broadcastRedrawBoundary）
  onSharedRedrawBoundary(): void
}

export class SharedTerminal {
  readonly subscribers = new Set<SharedTerminalSubscriber>()
  // pane 镜像挂在这里而不是 StreamSession：多客户端共享一份，客户端全断也不影响
  // 镜像活着（hub 还在时其他端的输出继续喂它），重连才能拿到精确画面
  readonly mirror: PaneMirror
  cols: number
  rows: number
  private sanitize = createTerminalOutputSanitizer()
  // hub 创建即 attach 边界：首轮 heavy 完整清洗，实质输出确认后回 light 稳态
  private sanitizeMode: 'light' | 'heavy' = 'heavy'
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
    this.mirror = new PaneMirror(hostId, sessionName, cols, rows)
    pty.onData((chunk: string) => this.handleData(chunk))
    pty.onExit((exitCode: number) => this.handleExit(exitCode))
  }
  get pid() {
    return this.pty.pid
  }
  private headlessPinTimer: ReturnType<typeof setTimeout> | null = null
  subscribe(sub: SharedTerminalSubscriber) {
    this.subscribers.add(sub)
    // 有人回来了：取消在途的钉尺寸，连回来的人自己会 fit
    this.cancelScheduledHeadlessPin()
  }
  unsubscribe(sub: SharedTerminalSubscriber) {
    this.subscribers.delete(sub)
    // 最后一个订阅者离开：不立刻销毁，先进宽限期——短期内重连能复用同一份
    // PTY + 镜像（配合 lastSeq 只补增量）；宽限 0 时 scheduleIdleDestroy 立即销毁，
    // 等价于旧行为
    if (!this.subscribers.size && sharedTerminals.get(this.key) === this) {
      scheduleIdleDestroy(this.key)
      // 宽限期内没人看：把 window 钉回虚拟尺寸；grace=0 时 hub 立刻销毁，不必钉
      if (hubGraceMs > 0) this.scheduleHeadlessPin()
    }
  }
  scheduleHeadlessPin() {
    if (this.dead || this.subscribers.size || !headlessViewport) return
    this.cancelScheduledHeadlessPin()
    const timer = setTimeout(() => {
      this.headlessPinTimer = null
      void pinHeadlessViewport(this)
    }, headlessPinDelayMs)
    timer.unref?.()
    this.headlessPinTimer = timer
  }
  cancelScheduledHeadlessPin() {
    if (!this.headlessPinTimer) return
    clearTimeout(this.headlessPinTimer)
    this.headlessPinTimer = null
  }
  resizePty(cols: number, rows: number) {
    if (this.dead) return
    this.pty.resize(cols, rows)
    this.cols = cols
    this.rows = rows
    this.mirror.resize(cols, rows)
  }
  write(data: string) {
    if (this.dead) return
    this.pty.write(data)
  }
  // 广播重绘边界：单 tmux client 的 refresh-client 无法只刷新订者——重绘
  // 字节进共享 PTY 后必然扇出全部订阅者，普通 output 路径无 reset 语义，
  // 旧端整屏叠加即花屏。调用方必须在 refresh 前调用本方法：给除 except
  // 外的每个订阅者补发 output_resync 边界，各端按原子替换处理
  broadcastRedrawBoundary(except?: SharedTerminalSubscriber) {
    if (this.dead) return
    for (const sub of this.subscribers) if (sub !== except) sub.onSharedRedrawBoundary()
  }
  // sanitize 只在 hub 做一次（含跨 chunk carry）；订阅者收到的已是过滤后字节
  private handleData(chunk: string) {
    if (this.dead) return
    recordStreamMetric('sanitizeCalls')
    recordStreamMetric('sanitizeChars', chunk.length)
    const filtered = this.sanitize(chunk, this.sanitizeMode)
    if (!filtered) return
    if (this.sanitizeMode === 'heavy' && hasSubstantiveTerminalContent(filtered)) {
      this.sanitizeMode = 'light'
    }
    // 镜像喂点：唯一一处 hook，在 sanitize 之后、扇出之前
    this.mirror.feed(filtered)
    for (const sub of this.subscribers) sub.onSharedOutput(filtered)
  }
  private handleExit(exitCode: number) {
    if (this.dead) return
    // PTY 自己退了：宽限不救回，定时器一并摘掉（免得到期时对已删 hub 再删一次）
    cancelGraceTimer(this.key)
    this.cancelScheduledHeadlessPin()
    const subs = [...this.subscribers]
    this.dead = true
    this.mirror.dispose()
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
// 挂起的宽限销毁定时器：key 与 hub 同键，任何一次 attach/kill/销毁都要先摘掉它
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelGraceTimer(key: string) {
  const timer = graceTimers.get(key)
  if (!timer) return
  clearTimeout(timer)
  graceTimers.delete(key)
}

// 宽限到期销毁走既有 destroy 路径（不另写一套清理），并且 unref：
// 进程退出时挂起的定时器不该拖着事件循环
function scheduleIdleDestroy(key: string) {
  if (hubGraceMs <= 0) {
    destroySharedTerminal(key)
    return
  }
  cancelGraceTimer(key)
  const timer = setTimeout(() => {
    graceTimers.delete(key)
    recordStreamMetric('hubGraceExpired')
    destroySharedTerminal(key)
  }, hubGraceMs)
  timer.unref?.()
  graceTimers.set(key, timer)
}

// 关停路径：挂起的宽限定时器全部清掉，别在快照/关 server 期间突然杀 PTY
export function clearSharedTerminalGraceTimers() {
  for (const timer of graceTimers.values()) clearTimeout(timer)
  graceTimers.clear()
}

export function countSharedTerminalGraceTimers() {
  return graceTimers.size
}
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
  headlessPinUnsupported.clear()
  clearSharedTerminalGraceTimers()
  for (const hub of [...sharedTerminals.values()]) {
    sharedTerminals.delete(hub.key)
    try {
      hub.dead = true
      hub.mirror.dispose()
      hub.pty.kill()
    } catch {
      // kill 失败可忽略
    }
  }
  updateStreamMetric('sharedTerminals', 0)
}

function destroySharedTerminal(key: string) {
  // 幂等：宽限到期与 handleExit 可能先后到达，第二次直接返回
  cancelGraceTimer(key)
  const hub = sharedTerminals.get(key)
  if (!hub) return
  sharedTerminals.delete(key)
  updateStreamMetric('sharedTerminals', sharedTerminals.size)
  hub.cancelScheduledHeadlessPin()
  hub.dead = true
  hub.mirror.dispose()
  try {
    hub.pty.kill()
  } catch {
    // kill 失败可忽略
  }
}

// 冷启动基线：hub 刚建、PTY 首屏重绘还没到时，镜像里什么都没有。用 capture-pane
// 带 -e（保留 SGR）和 -S -（含历史）灌一份，attach 才不会拿到残缺画面。
// 注意不能覆盖 live 输出：只要 mirror 已经收到过字节就放弃回填（首屏重绘才是权威）
async function seedMirrorBaseline(hub: SharedTerminal) {
  if (!isMirrorEnabled()) return
  try {
    const { stdout } = await execTmux(hub.hostId, ['capture-pane', '-p', '-e', '-S', '-', '-t', hub.sessionName])
    if (hub.dead || !stdout) return
    if (hub.mirror.seq > 0) return
    hub.mirror.seedBaseline(stdout)
    recordStreamMetric('mirrorBaselines')
  } catch {
    // 回填是尽力而为：失败就保持冷镜像，attach 自动回退重绘路径
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
    // 宽限期内的 hub：取消销毁、原地复活。镜像还在，客户端报 lastSeq 就能只补增量
    if (graceTimers.has(key)) {
      cancelGraceTimer(key)
      recordStreamMetric('hubGraceReused')
    }
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
    void seedMirrorBaseline(hub)
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
