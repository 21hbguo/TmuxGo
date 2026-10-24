import { createRequire } from 'node:module'
import { SerializeAddon } from '@xterm/addon-serialize'
import { RESYNC_RESET_SEQ } from './stream-config.js'
import type { Terminal as XtermTerminal } from '@xterm/headless'

// @xterm/headless 是纯 CJS（main 指向 UMD 包，无 exports 字段），ESM 具名导入在
// Node 下解析不出 Terminal；用 createRequire 取再断言类型
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as {
  Terminal: typeof XtermTerminal
}

// pane 镜像：session 级（host+session）常驻一份 headless 终端，attach 时直接序列化
// 出精确画面，替代 refresh-client 重绘的近似还原。
//
// 为什么不 per-connection：镜像的全部价值是「连接死了画面还在」，挂 WS 连接上等于
// attach 断开即丢；挂 SharedTerminal（已经存在、多客户端共享、生命周期与 PTY 对齐）
// 才是唯一合理的宿主——数据源（sanitize 后的 PTY 输出）本来就在那里。
//
// 为什么是 session 级而非严格每 pane：PTY 只吐当前可见 pane 的字节，其他 pane 要另
// 走 pipe-pane/control-mode 才有数据。而 attach 要恢复的正是「这个 session 此刻可见
// 的那一屏」，所以 session 级镜像与 attach 语义完全对齐。
//
// 用 @xterm/headless + addon-serialize 而不是复用 stream-cell 的 TerminalGrid：
// cell 那套只记 cells/cursor，丢 alt-screen、DEC 模式位、字符集等状态，序列化结果
// 喂回真 xterm 会错屏；镜像的唯一用途是「喂回真终端」，保真优先。
const RING_LIMIT_BYTES = Math.max(4096, Number(process.env.TMUXGO_MIRROR_RING_BYTES || 256 * 1024) || 256 * 1024)
const SCROLLBACK_LINES = Math.max(0, Number(process.env.TMUXGO_MIRROR_SCROLLBACK || 1000) || 0)

export class PaneMirror {
  readonly term: XtermTerminal
  private readonly serializer = new SerializeAddon()
  // 增量环：只存最近 RING_LIMIT_BYTES 的输出，够覆盖「断线几秒」的重连补发
  private ring: { seq: number; data: string }[] = []
  private ringBytes = 0
  private ringFirstSeq = 1
  private pending: Promise<void> = Promise.resolve()
  private disposed = false
  // 输出序号：每个 feed 自增，客户端记住收到过的最大 seq 即可请求增量
  seq = 0
  // 是否有可用内容（收到过输出或回填过基线）
  fedBytes = 0
  private cols: number
  private rows: number
  constructor(
    readonly hostId: string,
    readonly sessionName: string,
    cols: number,
    rows: number,
    private readonly ringLimit = RING_LIMIT_BYTES,
  ) {
    this.cols = Math.max(1, cols || 80)
    this.rows = Math.max(1, rows || 24)
    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    this.term.loadAddon(this.serializer)
  }
  get warm() {
    return this.fedBytes > 0
  }
  get size() {
    return { cols: this.cols, rows: this.rows }
  }
  matches(cols: number, rows: number) {
    return this.cols === Math.max(1, cols || 80) && this.rows === Math.max(1, rows || 24)
  }
  // 正常输出：进终端 + 进增量环
  feed(data: string) {
    if (this.disposed || !data) return
    this.seq += 1
    this.fedBytes += data.length
    this.ring.push({ seq: this.seq, data })
    this.ringBytes += data.length
    while (this.ringBytes > this.ringLimit && this.ring.length > 1) {
      const dropped = this.ring.shift()
      if (!dropped) break
      this.ringBytes -= dropped.data.length
      this.ringFirstSeq = dropped.seq + 1
    }
    this.write(data)
  }
  // 冷启动基线：capture-pane 的整屏快照。不进增量环——它不是「某一段输出」，
  // 而是整屏状态，按增量补发会重复叠加；也不动 seq（客户端 seq 语义只跟 live 输出走）
  seedBaseline(data: string) {
    if (this.disposed || !data) return
    this.fedBytes += data.length
    this.write(RESYNC_RESET_SEQ + data)
  }
  resize(cols: number, rows: number) {
    if (this.disposed) return
    const nextCols = Math.max(1, cols || 80)
    const nextRows = Math.max(1, rows || 24)
    if (nextCols === this.cols && nextRows === this.rows) return
    this.cols = nextCols
    this.rows = nextRows
    this.term.resize(nextCols, nextRows)
  }
  // 精确画面：前置复位序列让客户端按原子替换处理（与 output_resync 边界同语义）
  async snapshot(): Promise<string> {
    await this.pending
    if (this.disposed) return ''
    return RESYNC_RESET_SEQ + this.serializer.serialize()
  }
  // 增量：客户端报出的 lastSeq 之后的原始字节。null = 环里已经没有这段，只能整快照
  since(lastSeq: number): string | null {
    if (!Number.isFinite(lastSeq) || lastSeq < 0) return null
    // seq 为 0 表示只有回填基线、没有 live 输出：没有可补的增量，必须整快照
    if (this.seq === 0) return null
    if (lastSeq >= this.seq) return ''
    if (lastSeq + 1 < this.ringFirstSeq) return null
    const parts: string[] = []
    for (const item of this.ring) if (item.seq > lastSeq) parts.push(item.data)
    return parts.join('')
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.ring = []
    this.ringBytes = 0
    try {
      this.term.dispose()
    } catch {
      // dispose 失败可忽略（进程退出路径）
    }
  }
  private write(data: string) {
    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.disposed) return resolve()
          this.term.write(data, () => resolve())
        }),
    )
  }
}
