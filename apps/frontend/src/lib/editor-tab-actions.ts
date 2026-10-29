// tab 批量关闭与「重开已关闭编辑器」栈的纯逻辑：与 store 解耦，便于单测。
export const CLOSED_EDITOR_STACK_LIMIT = 10

// 关闭其它：保留 keepId，其余全部关闭（顺序沿用组内 tab 顺序，便于批量处理）
export function idsToCloseOthers(order: string[], keepId: string): string[] {
  return order.filter((id) => id !== keepId)
}

// 关闭右侧：anchorId 之后（不含）的 tab
export function idsToCloseToRight(order: string[], anchorId: string): string[] {
  const index = order.indexOf(anchorId)
  return index < 0 ? [] : order.slice(index + 1)
}

// 关闭已保存：只关不脏的。
// 脏文件留在原位，调用方据此提示「N 个未保存的 tab 被保留」
export function idsToCloseSaved(order: string[], isDirty: (id: string) => boolean): string[] {
  return order.filter((id) => !isDirty(id))
}

interface ClosedEntry {
  id: string
}

// 入栈：同 id 先去重（重开过又被关，栈里只留最新一次），再按上限截断
export function pushClosedEntry<T extends ClosedEntry>(stack: T[], entry: T, limit = CLOSED_EDITOR_STACK_LIMIT): T[] {
  const next = [...stack.filter((item) => item.id !== entry.id), entry]
  return next.length > limit ? next.slice(next.length - limit) : next
}

// 出栈：栈顶是最新关闭的（LIFO），无可用条目时返回 null 并保持原栈
export function takeClosedEntry<T>(stack: T[]): { entry: T | null; rest: T[] } {
  if (!stack.length) return { entry: null, rest: stack }
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) }
}
