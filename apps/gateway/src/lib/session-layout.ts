import type { SessionTemplateLayout } from './template-utils.js'

// 版本化 session layout 文档：导出/导入/分享/迁移的唯一交换格式。
// 默认导出不含 env、命令行参数与 pane 输出，避免泄露 token/密钥。
export const SESSION_LAYOUT_KIND = 'tmuxgo.session-layout'
export const SESSION_LAYOUT_VERSION = 1
export const sessionLayoutWindowLimit = 8
export const sessionLayoutPaneLimit = 8
const layoutPresets = ['tiled', 'even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical'] as const
type LayoutPreset = (typeof layoutPresets)[number]
const splitDirections = ['horizontal', 'vertical'] as const
type SplitDirection = (typeof splitDirections)[number]
// pane_current_command 为 shell 时不导出为新窗格启动命令（新窗格自带 shell，重放会产生嵌套 shell）
const shellCommands = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'nu',
  'xonsh',
  'tmux',
  'screen',
  'login',
])
export interface SessionLayoutDocument {
  kind: typeof SESSION_LAYOUT_KIND
  version: typeof SESSION_LAYOUT_VERSION
  name: string
  exportedAt?: string
  sourceHostId?: string
  windows: SessionTemplateLayout['windows']
}
export interface SessionLayoutPaneRow {
  index: number
  cwd?: string
  command?: string
  width?: number
  height?: number
  left?: number
  top?: number
}
export interface SessionLayoutWindowRows {
  name: string
  panes: SessionLayoutPaneRow[]
}
function safeString(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function invalid(reason: string): never {
  throw new Error(`Invalid session layout: ${reason}`)
}
function isShellCommand(command: string) {
  const base = command.trim().toLowerCase().split(/[\\/]/).pop() || ''
  return shellCommands.has(base)
}
// 分栏方向推断：pane 共享同一 left 说明纵向堆叠（split -v 产物），否则横向并列；
// 几何信息缺失时不臆测，回退 horizontal
function inferSplitDirection(panes: SessionLayoutPaneRow[]): SplitDirection {
  if (panes.length <= 1) return 'horizontal'
  const lefts = new Set(panes.map((pane) => pane.left).filter((value): value is number => value !== undefined))
  if (!lefts.size) return 'horizontal'
  return lefts.size === 1 ? 'vertical' : 'horizontal'
}
// 布局预设推断：纵向堆叠且等宽→纵向均分，横向并列且等高→横向均分，
// 其余（含几何缺失）回退 tiled（重建时最接近原状）
function inferLayoutPreset(panes: SessionLayoutPaneRow[]): LayoutPreset {
  if (panes.length <= 1) return 'tiled'
  const lefts = new Set(panes.map((pane) => pane.left).filter((value): value is number => value !== undefined))
  const widths = new Set(panes.map((pane) => pane.width).filter((value): value is number => value !== undefined))
  const heights = new Set(panes.map((pane) => pane.height).filter((value): value is number => value !== undefined))
  if (!lefts.size || !widths.size || !heights.size) return 'tiled'
  if (lefts.size === 1) return widths.size === 1 ? 'even-vertical' : 'tiled'
  return heights.size === 1 ? 'even-horizontal' : 'tiled'
}
export function paneRowToLayoutPane(pane: SessionLayoutPaneRow) {
  const command = pane.command?.trim()
  return {
    ...(command && !isShellCommand(command) ? { command: command.slice(0, 4096) } : {}),
    ...(pane.cwd?.trim() ? { cwd: pane.cwd.trim().slice(0, 1024) } : {}),
  }
}
export function buildSessionLayoutDocument(input: {
  sessionName: string
  hostId?: string
  windows: SessionLayoutWindowRows[]
  exportedAt?: string
}): SessionLayoutDocument {
  const windows = input.windows.map((window, index) => {
    const panes = [...window.panes].sort((left, right) => left.index - right.index)
    return {
      name: window.name.trim() || `win-${index + 1}`,
      panes: panes.map(paneRowToLayoutPane),
      splitDirection: inferSplitDirection(panes),
      layoutPreset: inferLayoutPreset(panes),
    }
  })
  return {
    kind: SESSION_LAYOUT_KIND,
    version: SESSION_LAYOUT_VERSION,
    name: input.sessionName.trim(),
    exportedAt: input.exportedAt || new Date().toISOString(),
    ...(input.hostId ? { sourceHostId: input.hostId } : {}),
    windows,
  }
}
export function normalizeSessionLayoutDocument(input: unknown): SessionLayoutDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('document must be an object')
  const raw = input as Record<string, unknown>
  if (raw.kind !== undefined && raw.kind !== SESSION_LAYOUT_KIND) invalid(`unsupported kind: ${String(raw.kind)}`)
  if (raw.version !== undefined && raw.version !== SESSION_LAYOUT_VERSION)
    invalid(`unsupported version: ${String(raw.version)}`)
  const windowsRaw = raw.windows
  if (!Array.isArray(windowsRaw) || !windowsRaw.length) invalid('windows must be a non-empty array')
  if (windowsRaw.length > sessionLayoutWindowLimit) invalid(`windows exceeds limit ${sessionLayoutWindowLimit}`)
  const windows: SessionTemplateLayout['windows'] = windowsRaw.map((item, windowIndex) => {
    const window = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null
    if (!window) invalid(`windows[${windowIndex}] must be an object`)
    const name = safeString(window.name, 64)
    if (!name) invalid(`windows[${windowIndex}].name is required`)
    const splitDirection = window.splitDirection
    if (splitDirection !== undefined && !splitDirections.includes(splitDirection as SplitDirection))
      invalid(`windows[${windowIndex}].splitDirection must be horizontal or vertical`)
    const layoutPreset = window.layoutPreset
    if (layoutPreset !== undefined && !layoutPresets.includes(layoutPreset as LayoutPreset))
      invalid(`windows[${windowIndex}].layoutPreset is not a supported preset`)
    const panesRaw = window.panes
    if (!Array.isArray(panesRaw) || !panesRaw.length) invalid(`windows[${windowIndex}].panes must be a non-empty array`)
    if (panesRaw.length > sessionLayoutPaneLimit)
      invalid(`windows[${windowIndex}].panes exceeds limit ${sessionLayoutPaneLimit}`)
    const panes = panesRaw.map((item, paneIndex) => {
      const pane = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null
      if (!pane) invalid(`windows[${windowIndex}].panes[${paneIndex}] must be an object`)
      const command = safeString(pane.command, 4096)
      const cwd = safeString(pane.cwd, 1024)
      const envRaw =
        pane.env && typeof pane.env === 'object' && !Array.isArray(pane.env)
          ? (pane.env as Record<string, unknown>)
          : {}
      const env: Record<string, string> = {}
      for (const [key, envValue] of Object.entries(envRaw).slice(0, 20)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          invalid(`windows[${windowIndex}].panes[${paneIndex}].env key invalid`)
        if (typeof envValue !== 'string')
          invalid(`windows[${windowIndex}].panes[${paneIndex}].env.${key} must be string`)
        env[key] = envValue.slice(0, 1024)
      }
      return {
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      }
    })
    return {
      name,
      panes,
      splitDirection: (splitDirection as SplitDirection | undefined) || 'horizontal',
      layoutPreset: (layoutPreset as LayoutPreset | undefined) || 'tiled',
    }
  })
  const name = safeString(raw.name, 64) || 'layout'
  return {
    kind: SESSION_LAYOUT_KIND,
    version: SESSION_LAYOUT_VERSION,
    name,
    ...(safeString(raw.exportedAt, 64) ? { exportedAt: safeString(raw.exportedAt, 64) } : {}),
    ...(safeString(raw.sourceHostId, 128) ? { sourceHostId: safeString(raw.sourceHostId, 128) } : {}),
    windows,
  }
}
export function sessionLayoutToTemplateLayout(doc: SessionLayoutDocument): SessionTemplateLayout {
  return { windows: doc.windows }
}
