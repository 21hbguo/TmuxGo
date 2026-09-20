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
// resync 边界序列：DECSTR 复位模式/滚动区/SGR（不清屏不留滚动历史损失），
// ED 清可见屏 + CUP 归位，随后由 tmux 真实重绘恢复完整画面
export const RESYNC_RESET_SEQ = '\u001b[!p\u001b[2J\u001b[H'
export const STREAM_COMPRESS_ENABLED = process.env.TMUXGO_STREAM_COMPRESS !== '0'
export const STREAM_COMPRESS_THRESHOLD = Math.max(0, Number(process.env.TMUXGO_STREAM_COMPRESS_THRESHOLD || 256) || 256)
export const STREAM_CELL_ENABLED = process.env.TMUXGO_STREAM_CELL === '1'
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
