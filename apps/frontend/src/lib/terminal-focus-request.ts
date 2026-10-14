// 终端聚焦请求双通道：window 事件让已挂载的终端当场聚焦；新建 session 的
// TerminalPane 挂载晚于派发时刻，短挂单由 runtime 在订阅重建（sessionName
// 已落地）时消费兜底——两条通道都只认 detail 匹配的会话，分屏/共享网格
// 里并存的其他终端不响应
const PENDING_FOCUS_TTL_MS = 5000

interface PendingTerminalFocus {
  hostId: string
  sessionName: string
  expiresAt: number
}

let pendingTerminalFocus: PendingTerminalFocus | null = null

export function requestTerminalFocus(hostId: string, sessionName: string) {
  if (!sessionName) return
  pendingTerminalFocus = { hostId, sessionName, expiresAt: Date.now() + PENDING_FOCUS_TTL_MS }
  window.dispatchEvent(new CustomEvent('tmuxgo-focus-terminal', { detail: { hostId, sessionName } }))
}

export function consumePendingTerminalFocus(hostId: string, sessionName: string | null | undefined) {
  const pending = pendingTerminalFocus
  if (!pending || !sessionName || pending.expiresAt < Date.now()) return false
  if (pending.hostId !== hostId || pending.sessionName !== sessionName) return false
  pendingTerminalFocus = null
  return true
}
