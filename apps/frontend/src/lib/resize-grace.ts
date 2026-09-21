import { STREAM_EVENT, subscribeStreamEvent } from './stream-events'

// pane 分隔条松手后，tmux resize-pane 会重绘整个 client（所有 pane+边框）且
// 各 pane 内 TUI 再各自 SIGWINCH 重画——打到写调度器上是一次性有界突发，
// 缓冲的字节本身就是最终正确帧，与持续拥塞（缓冲是无效中间态）语义不同。
// 宽限窗内抑制 stream_backpressure high 上报即可避免误触发 resync 白闪；
// 窗口长度取 400ms：需覆盖 80ms latest-wins 提交 + 远端 SSH resize + 突发回流
export const RESIZE_BACKPRESSURE_GRACE_MS = 400

let graceUntil = Number.NEGATIVE_INFINITY

subscribeStreamEvent(STREAM_EVENT.resizeGesture, (detail) => {
  if (detail?.phase === 'end') graceUntil = performance.now() + RESIZE_BACKPRESSURE_GRACE_MS
})

export function isResizeBackpressureGraceActive(now = performance.now()) {
  return now < graceUntil
}

// 测试辅助：直接重置窗口状态，避免跨用例泄漏
export function resetResizeBackpressureGrace() {
  graceUntil = Number.NEGATIVE_INFINITY
}
