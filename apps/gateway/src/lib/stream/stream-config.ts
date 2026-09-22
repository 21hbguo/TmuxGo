export const SCROLL_MAX_LINES = 24
export const ATTACH_REDRAW_DELAYS = [48]
export const REQUEST_REDRAW_DELAYS = [48]
// Upper bound on how long a resize ACK may wait for post-resize PTY output
// once the tmux refresh has completed; a quiet pane must not stall the ack.
export const RESIZE_ACK_OUTPUT_WAIT_MS = 150
export const SOCKET_BUFFER_HIGH_WATERMARK = 1048576
export const SOCKET_BUFFER_EXTREME_WATERMARK = 4194304
export const SOCKET_FLUSH_DEFER_MS = 24
export const OUTPUT_BUFFER_MAX_CHARS = 1048576
export const CLIENT_BACKPRESSURE_RESYNC_CHARS = 16384
// 拥塞 resync 迟滞：超限不立即 resync，先记 suppressed 并挂复查——pane resize
// 重绘等一次性突发的缓冲即最终帧，排空后复查不再超限即天然过滤；
// 只有持续超限（真拥塞）才升级 resync
export const RESYNC_HYSTERESIS_MS = 100
// resync 边界序列（刻意不用 DECSTR）：tmux refresh 只重绘画面，不重发未变化的
// 输入模式——DECSTR 会把 ?1 应用光标键/?66 小键盘/?2004 bracketed-paste 清掉且
// tmux 不再补发，画面全等但输入协议悄悄坏掉。这里只重置会破坏重绘本身的状态：
// SGR、插入模式、origin、滚动区、G0/G1 字符集+SI，再 ED 清可见屏（留 scrollback）
// +CUP 归位。输入/鼠标/光标可见性等模式原样保留，由 tmux 自行管理
export const RESYNC_RESET_SEQ = '\u001b[0m\u001b[4l\u001b[?6l\u001b[r\u001b(B\u001b)B\x0f\u001b[2J\u001b[H'
export const STREAM_COMPRESS_ENABLED = process.env.TMUXGO_STREAM_COMPRESS !== '0'
export const STREAM_COMPRESS_THRESHOLD = Math.max(0, Number(process.env.TMUXGO_STREAM_COMPRESS_THRESHOLD || 256) || 256)
export const STREAM_CELL_ENABLED = process.env.TMUXGO_STREAM_CELL === '1'
export const STREAM_COMPACT_ENABLED = process.env.TMUXGO_STREAM_COMPACT !== '0'
// 会话级 PTY 输出 fan-out：默认开；TMUXGO_STREAM_FANOUT=0 回退每连接一条 PTY
export const STREAM_FANOUT_ENABLED = process.env.TMUXGO_STREAM_FANOUT !== '0'
export const CELL_DIRTY_RATIO_SNAPSHOT = 0.55
export const DEDUP_CHUNK_THRESHOLD = Math.max(0, Number(process.env.TMUXGO_DEDUP_CHUNK_THRESHOLD || 512) || 512)
export const FOREGROUND_FLUSH_INTERVAL = Math.max(1, Number(process.env.TMUXGO_FLUSH_INTERVAL || 4) || 4)
export const OUTPUT_PROFILES = {
  foreground: { flushInterval: FOREGROUND_FLUSH_INTERVAL, maxChars: 65536 },
  background: { flushInterval: 32, maxChars: 24576 },
  mobile: { flushInterval: 24, maxChars: 16384 },
} as const
export type OutputProfileName = keyof typeof OUTPUT_PROFILES
export const STREAM_PING_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.TMUXGO_STREAM_PING_INTERVAL_MS || 25000) || 25000,
)
export const STREAM_PONG_TIMEOUT_MS = STREAM_PING_INTERVAL_MS * 3
export interface TerminalProcess {
  pid: number
  resize: (cols: number, rows: number) => void
  write: (data: string) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (exitCode: number) => void) => void
}
