// tmux 目标 id 的两种口径，混用会被网关直接 400 拒掉：
// - 拓扑编辑（POST /api/panes/move|break|swap）：host 前缀形式 `local:@3` / `local:%5`，
//   网关 parseWindowRef/parsePaneRef 只认这一种；
// - 原生 layout string（/layout-string?windowId=@3）：裸 tmux window id，正则 ^@\d+$。
//
// 前端拿到的 Window.id / Pane.id 已经是 `local:@3` 形式，Window.tmuxWindowId 是裸 `@3`，
// 这两个 helper 负责在发请求前把口径摆正——不要再在调用点手写字符串拼接。

// 已带 host 前缀的拓扑 id 形如 `local:@3` / `local:%5`；跨 host 的值原样放过，
// 由网关自己的 host 校验给出 400/403，前端不做越权判断
const HOST_QUALIFIED_REF = /^[^:/]+:[@%][0-9]+$/

/** 给裸 id 补 host 前缀；已经是 `host:@n` / `host:%n` 的原样返回 */
export function withHostPrefix(hostId: string, ref?: string | null): string {
  const value = (ref || '').trim()
  if (!value) return ''
  if (HOST_QUALIFIED_REF.test(value)) return value
  return hostId ? `${hostId}:${value}` : value
}

/** layout-string 用的裸 window id：优先 Window.tmuxWindowId，否则从 Window.id 剥掉 host 前缀 */
export function tmuxWindowIdOf(
  window: { id?: string; tmuxWindowId?: string } | null | undefined,
  hostId: string,
): string {
  if (!window) return ''
  const explicit = (window.tmuxWindowId || '').trim()
  if (explicit) return explicit
  const id = (window.id || '').trim()
  if (!id) return ''
  return hostId && id.startsWith(`${hostId}:`) ? id.slice(hostId.length + 1) : id
}
