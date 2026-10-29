// 编辑区光标/选区的旁路状态。
//
// 为什么不放在 EditorWorkbench 的 useState：
// 光标每敲一个键就变一次，放进组件 state 会让整个工作台（tab 条、预览、工具栏）
// 跟着重渲染。这里用外置 store + useSyncExternalStore，只有真正展示光标的地方
// （状态栏、面包屑）订阅，工作台自己不订阅，打字路径上零 React 更新。
//
// 通知按帧合并：框选/全选会在一帧内触发几十次 change 事件，逐次通知没有意义。
import { useSyncExternalStore } from 'react'
import type { EditorSelectionStats } from './editor-status'

export interface EditorCursorSnapshot {
  line: number
  column: number
  lineCount: number
  // 选区数量（多光标时 > 1）
  selections: number
  selection: EditorSelectionStats | null
}

const EMPTY: EditorCursorSnapshot = { line: 1, column: 1, lineCount: 0, selections: 0, selection: null }
const snapshots = new Map<string, EditorCursorSnapshot>()
const listeners = new Set<() => void>()
let flushScheduled = false
let cancelFlush: (() => void) | null = null

function flush() {
  for (const listener of [...listeners]) listener()
}

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      flushScheduled = false
      cancelFlush = null
      flush()
    })
    cancelFlush = () => cancelAnimationFrame(id)
  } else {
    const id = setTimeout(() => {
      flushScheduled = false
      cancelFlush = null
      flush()
    }, 0)
    cancelFlush = () => clearTimeout(id)
  }
}

function isSame(left: EditorCursorSnapshot, right: EditorCursorSnapshot) {
  if (left.line !== right.line || left.column !== right.column || left.lineCount !== right.lineCount) return false
  if (left.selections !== right.selections) return false
  const a = left.selection
  const b = right.selection
  if (!a || !b) return a === b
  return a.lines === b.lines && a.chars === b.chars
}

export function setEditorCursor(editorId: string, snapshot: EditorCursorSnapshot) {
  const previous = snapshots.get(editorId)
  if (previous && isSame(previous, snapshot)) return
  snapshots.set(editorId, snapshot)
  scheduleFlush()
}

export function getEditorCursor(editorId: string): EditorCursorSnapshot | undefined {
  return snapshots.get(editorId)
}

export function clearEditorCursor(editorId: string) {
  if (!snapshots.delete(editorId)) return
  scheduleFlush()
}

// 关闭 tab 后清理：prune 回调返回 false 的快照一次性删掉，避免 store 随会话无限增长
export function pruneEditorCursors(keep: (editorId: string) => boolean) {
  let changed = false
  for (const id of [...snapshots.keys()]) {
    if (keep(id)) continue
    snapshots.delete(id)
    changed = true
  }
  if (changed) scheduleFlush()
}

// 只读订阅：给需要在命令里同步取最新光标的调用方用（如 F12 取当前位置）
export function subscribeEditorCursor(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useEditorCursor(editorId: string | null | undefined): EditorCursorSnapshot {
  return useSyncExternalStore(
    subscribeEditorCursor,
    () => (editorId ? snapshots.get(editorId) ?? EMPTY : EMPTY),
    () => EMPTY,
  )
}

// 测试钩子：清空全部快照（模块级 Map 在用例之间会串味）
export function resetEditorCursorStore() {
  snapshots.clear()
  cancelFlush?.()
  cancelFlush = null
  flushScheduled = false
  listeners.clear()
}
