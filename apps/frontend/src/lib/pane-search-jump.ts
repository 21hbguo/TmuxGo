import { api } from './api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { PaneSearchHit, Pane, SessionSnapshot } from '@/types'

// 命中跳转：先让 tmux 切到目标 pane（必要时先切 window），再等前端终端拿到新
// buffer，最后按「距末尾行数」定位——capture-pane 的绝对行号和 xterm buffer 的
// 行号起点不同，只有从末尾倒数才是两边都稳定的锚点。
type TerminalLike = {
  buffer?: { active?: { length: number } }
  scrollToLine?: (line: number) => void
}
function activeTerminal(): TerminalLike | null {
  if (typeof window === 'undefined') return null
  return (window as typeof window & { __tmuxgoTerminal?: TerminalLike }).__tmuxgoTerminal || null
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface PaneSearchJumpOptions {
  // 跳转后滚动的目标行距末尾的行数（PaneSearchHit.lineFromEnd）
  lineFromEnd: number
  timeoutMs?: number
}

export async function jumpToPaneSearchHit(hit: PaneSearchHit, options: PaneSearchJumpOptions) {
  const separator = hit.paneId.indexOf(':')
  if (separator <= 0) throw new Error('Invalid pane id')
  const hostId = hit.paneId.slice(0, separator)
  const sessionId = useConsoleStore.getState().activeSessionId || ''
  if (!sessionId) throw new Error('No active session')
  // 快照里查 pane 的 window，跨 window 命中要先切窗口（select-pane 跨 window 会隐式切，
  // 但显式切能把前端 snapshot 的 activeWindowId 一起对齐）
  const snapshot = await api.snapshot.get(hostId, sessionId).catch(() => null as SessionSnapshot | null)
  const targetPane = snapshot?.panes?.find?.((pane: Pane) => pane.id === hit.paneId)
  if (targetPane?.windowId && snapshot && targetPane.windowId !== snapshot.activeWindowId)
    await api.windows.select(hostId, sessionId, targetPane.windowId)
  await api.panes.select(hit.paneId)
  const store = useConsoleStore.getState()
  if (store.activeHostId !== hostId) store.setActiveHost(hostId)
  store.setActiveSession(sessionId)
  store.setActivePane(hit.paneId)
  // 终端重挂载/buffer 补齐是异步的：轮询到位再滚动，超时就放弃（跳转本身已成功）
  const deadline = Date.now() + (options.timeoutMs ?? 2500)
  while (Date.now() < deadline) {
    const terminal = activeTerminal()
    const length = terminal?.buffer?.active?.length || 0
    if (terminal?.scrollToLine && length > options.lineFromEnd) {
      terminal.scrollToLine(Math.max(0, length - options.lineFromEnd))
      return { scrolled: true }
    }
    await sleep(80)
  }
  return { scrolled: false }
}
