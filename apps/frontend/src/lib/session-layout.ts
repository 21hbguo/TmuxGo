import type { SessionLayoutDocument, SessionTemplate } from '@/types'

// 导入前的最小体检：JSON 形状、kind/version、窗口/面板非空；
// 字段级严格校验在 gateway normalizeSessionLayoutDocument 做
export function parseSessionLayoutDocument(text: string): SessionLayoutDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Layout must be an object')
  const doc = raw as Record<string, unknown>
  if (doc.kind !== undefined && doc.kind !== 'tmuxgo.session-layout')
    throw new Error(`Unsupported layout kind: ${String(doc.kind)}`)
  if (doc.version !== undefined && doc.version !== 1)
    throw new Error(`Unsupported layout version: ${String(doc.version)}`)
  const windows = doc.windows
  if (!Array.isArray(windows) || !windows.length) throw new Error('Layout has no windows')
  for (const item of windows) {
    const window = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null
    if (!window) throw new Error('Invalid window entry')
    if (typeof window.name !== 'string' || !window.name.trim()) throw new Error('Window missing name')
    if (!Array.isArray(window.panes) || !window.panes.length) throw new Error(`Window ${window.name} has no panes`)
  }
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim().slice(0, 64) : 'layout'
  return { ...doc, kind: 'tmuxgo.session-layout', version: 1, name, windows } as SessionLayoutDocument
}
export function sessionLayoutToTemplate(doc: SessionLayoutDocument): SessionTemplate {
  const now = new Date().toISOString()
  return {
    id: `layout-${Date.now().toString(36)}`,
    name: doc.name,
    description: 'Imported session layout',
    layout: { windows: doc.windows },
    createdAt: now,
    updatedAt: now,
  }
}
