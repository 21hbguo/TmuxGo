// 多端视角（grouped session）的命名与 id 规范化：纯函数，不碰 tmux。
//
// 为什么单独一层：view 名会同时出现在 attach 参数、list-sessions 输出、会话过滤和
// 生命周期清理里；如果各处自己拼字符串，迟早出现「前端传的 viewId 与后端清理时算出的
// 名字不一致」这类幽灵会话。这里固定唯一算法，并用 session option 标记归属——
// 名字只用于寻址，**判定一个 session 是不是 view 必须看 @tmuxgo_view_base**，
// 因为用户完全可能自己建一个同名前缀的 session。

import { createHash } from 'crypto'

export const VIEW_SESSION_PREFIX = 'tmuxgo-view-'
export const VIEW_BASE_OPTION = '@tmuxgo_view_base'
export const VIEW_CLIENT_OPTION = '@tmuxgo_view_client'

// viewId 由浏览器 localStorage 生成：只允许 URL 安全字符，长度限制避免把整段
// 用户输入塞进 tmux 名字或日志。短于 8 的 id 碰撞概率不可接受，直接拒绝。
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function normalizeViewId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return VIEW_ID_PATTERN.test(value) ? value : null
}

/** 稳定、无歧义的 view session 名：同 host + base + viewId 永远得到同一个名字 */
export function viewSessionName(hostId: string, baseSession: string, viewId: string): string {
  const digest = createHash('sha1').update(`${hostId}\0${baseSession}\0${viewId}`).digest('hex')
  return `${VIEW_SESSION_PREFIX}${digest.slice(0, 16)}`
}

/** 仅用于日志/诊断的前缀判定；是否隐藏会话以 session option 为准 */
export function hasViewSessionPrefix(name: string): boolean {
  return name.startsWith(VIEW_SESSION_PREFIX)
}
