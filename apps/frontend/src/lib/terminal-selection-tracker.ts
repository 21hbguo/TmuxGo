import { api } from './api'
import { writeClipboardText } from './clipboard-text'

type PushToast = (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void

interface PaneRect {
  left: number
  top: number
  cols: number
  rows: number
}

interface SelectionState {
  inCopyMode?: boolean
  present?: boolean
  startX?: number
  startY?: number
  endX?: number
  endY?: number
  rectangle?: boolean
}

interface TerminalTmuxSelectionTrackerOptions {
  container: HTMLElement
  getTerminal: () => any
  getPaneIdAtPoint: (x: number, y: number) => string | null
  getPaneBounds: (paneId: string) => PaneRect | null
  onDragSelection: (info: { chars: number; x: number; y: number; source: 'xterm' | 'tmux' } | null) => void
  pushToast: PushToast
}

const POLL_MS = 160

// tmux 选区坐标是 pane 相对坐标；xterm buffer 是整个 window → 换算回全局行列切片。
// 计数对齐 copy-selection 语义：行选每行右修剪+逐行换行，矩形选按列段原样取。
export function countTmuxSelectionChars(
  terminal: any,
  pane: PaneRect,
  state: { startX?: number; startY?: number; endX?: number; endY?: number; rectangle?: boolean },
) {
  const buffer = terminal?.buffer?.active
  if (!terminal || !buffer) return 0
  const baseY = Number(buffer.baseY) || 0
  let sx = Number(state.startX) || 0
  let sy = Number(state.startY) || 0
  let ex = Number(state.endX) || 0
  let ey = Number(state.endY) || 0
  if (sy > ey || (sy === ey && sx > ex)) {
    ;[sx, ex] = [ex, sx]
    ;[sy, ey] = [ey, sy]
  }
  sy = Math.max(0, Math.min(sy, pane.rows - 1))
  ey = Math.max(0, Math.min(ey, pane.rows - 1))
  if (sy > ey) return 0
  let chars = 0
  if (state.rectangle) {
    const from = pane.left + Math.min(sx, ex)
    const to = pane.left + Math.min(Math.max(sx, ex) + 1, pane.cols)
    for (let y = sy; y <= ey; y += 1) {
      const text = buffer.getLine(baseY + pane.top + y)?.translateToString(false, from, to)
      if (text !== undefined) chars += text.length + (y < ey ? 1 : 0)
    }
    return chars
  }
  for (let y = sy; y <= ey; y += 1) {
    const line = buffer.getLine(baseY + pane.top + y)
    if (!line) continue
    const from = y === sy ? pane.left + sx : pane.left
    const to = y === ey ? pane.left + ex + 1 : pane.left + pane.cols
    chars += (line.translateToString(true, from, Math.min(to, terminal.cols)) || '').length + 1
  }
  return chars
}

// tmux 开 mouse 上报后 xterm 自己的 SelectionService 被禁用：普通拖选产生的选区
// 只存在于 tmux copy-mode 里，松手时 copy-selection-and-cancel 落 paste buffer。
// 浏览器完全感知不到 → 这里补上「拖选实时字符数（轮询坐标+本地 buffer 切片）」
// 和「松手把 tmux buffer 文本写回系统剪贴板 + 成功 toast」两个缺口。
export function createTerminalTmuxSelectionTracker(options: TerminalTmuxSelectionTrackerOptions) {
  const { container } = options
  let paneId: string | null = null
  let sinceBuffer = ''
  let sawSelection = false
  let dragMoved = false
  let released = true
  let tmuxCount = 0
  let lastX = 0
  let lastY = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  const stopPoll = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }
  const hideInfo = () => options.onDragSelection(null)

  const countTmuxSelection = (id: string, state: SelectionState) => {
    const terminal = options.getTerminal()
    const pane = options.getPaneBounds(id)
    if (!pane) return 0
    return countTmuxSelectionChars(terminal, pane, state)
  }

  // 老版本网关/测试 mock 可能缺这两个方法，一律按「不支持」静默降级
  const querySelectionState = (id: string) =>
    Promise.resolve()
      .then(() => api.panes.selectionState?.(id))
      .catch(() => null)
  const queryBuffer = (id: string, opts?: { since?: string; peek?: boolean }) =>
    Promise.resolve()
      .then(() => api.panes.copySelection?.(id, opts))
      .catch(() => null)

  const poll = async () => {
    if (!paneId || released || disposed) return
    const state = await querySelectionState(paneId)
    if (!state?.ok || disposed) return
    if (state.inCopyMode && state.present) {
      sawSelection = true
      const chars = countTmuxSelection(paneId, state)
      tmuxCount = chars
      if (chars > 0) options.onDragSelection({ chars, x: lastX, y: lastY, source: 'tmux' })
      return
    }
    if (tmuxCount > 0) {
      tmuxCount = 0
      hideInfo()
    }
  }

  const point = (event: MouseEvent | TouchEvent) => {
    const src = event instanceof MouseEvent ? event : (event.touches[0] ?? event.changedTouches[0])
    return src ? { x: src.clientX, y: src.clientY } : null
  }

  const arm = (event: MouseEvent | TouchEvent) => {
    if (disposed) return
    if (event instanceof MouseEvent && event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('[data-terminal-overlay]')) return
    const pt = point(event)
    if (!pt) return
    lastX = pt.x
    lastY = pt.y
    const id = options.getPaneIdAtPoint(pt.x, pt.y)
    paneId = id
    sawSelection = false
    dragMoved = false
    tmuxCount = 0
    released = false
    if (!id) return
    // 记录拖选前的最新 buffer 名做基线；release 时等新 buffer 覆盖它（= 这次复制落盘）
    void queryBuffer(id, { peek: true }).then((res) => {
      if (paneId === id && res?.ok) sinceBuffer = res.name || ''
    })
    stopPoll()
    pollTimer = setInterval(() => void poll(), POLL_MS)
  }

  const release = () => {
    if (disposed || released) return
    released = true
    stopPoll()
    hideInfo()
    tmuxCount = 0
    const id = paneId
    paneId = null
    // 快于一个轮询周期的短拖也成立：用「拖动过距离」兜底决定是否等 buffer
    if (!id || (!sawSelection && !dragMoved)) return
    void queryBuffer(id, { since: sinceBuffer }).then(async (res) => {
      if (disposed || !res?.ok || !res.found || !res.text) return
      const result = await writeClipboardText(res.text)
      options.pushToast({
        type: result.unavailable ? 'info' : 'success',
        message: `Copied ${res.text.length} chars (tmux)`,
        durationMs: 1400,
      })
    })
  }

  const notePointer = (event: MouseEvent | TouchEvent) => {
    if (!paneId) return
    const pt = point(event)
    if (!pt) return
    if (Math.abs(pt.x - lastX) > 2 || Math.abs(pt.y - lastY) > 2) dragMoved = true
    lastX = pt.x
    lastY = pt.y
  }

  // Shift+拖选（xterm 侧选区）走这里：与 tmux 计数互斥，tmux 在选时不动 UI
  const noteXtermSelection = (length: number) => {
    if (disposed) return
    if (length > 0 && !released && tmuxCount === 0) {
      options.onDragSelection({ chars: length, x: lastX, y: lastY, source: 'xterm' })
    } else if (length === 0 && tmuxCount === 0) {
      hideInfo()
    }
  }

  const attach = () => {
    container.addEventListener('mousedown', arm)
    container.addEventListener('touchstart', arm, { passive: true })
    container.addEventListener('mousemove', notePointer)
    container.addEventListener('touchmove', notePointer, { passive: true })
    window.addEventListener('mouseup', release)
    window.addEventListener('touchend', release)
    window.addEventListener('touchcancel', release)
    window.addEventListener('blur', release)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopPoll()
    hideInfo()
    container.removeEventListener('mousedown', arm)
    container.removeEventListener('touchstart', arm)
    container.removeEventListener('mousemove', notePointer)
    container.removeEventListener('touchmove', notePointer)
    window.removeEventListener('mouseup', release)
    window.removeEventListener('touchend', release)
    window.removeEventListener('touchcancel', release)
    window.removeEventListener('blur', release)
  }
  return { attach, dispose, noteXtermSelection }
}
