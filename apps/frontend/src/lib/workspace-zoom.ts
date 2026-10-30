// 终端区 / 其他区（UI 外壳）的独立缩放。编辑区沿用 editor-view-prefs.fontScale。
// 三套比例互不影响：终端只改 xterm 字号，UI 只 zoom 外壳；编辑区内容在外壳 zoom 下反向抵消。
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '@/lib/persist-storage'
import { FONT_SCALE_STEPS, stepFontScale, useEditorViewPrefs } from '@/lib/editor-view-prefs'

export type ZoomZone = 'editor' | 'terminal' | 'ui'

const MIN_SCALE = FONT_SCALE_STEPS[0]
const MAX_SCALE = FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1]

export function clampWorkspaceScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

interface WorkspaceZoomState {
  terminalScale: number
  uiScale: number
  zoomTerminal: (direction: 1 | -1) => void
  zoomUi: (direction: 1 | -1) => void
  resetTerminal: () => void
  resetUi: () => void
  reset: () => void
}

export const DEFAULT_WORKSPACE_ZOOM = { terminalScale: 1, uiScale: 1 }

export function sanitizeWorkspaceZoom(input: unknown): { terminalScale: number; uiScale: number } {
  const raw = (input || {}) as Partial<Record<'terminalScale' | 'uiScale', unknown>>
  return {
    terminalScale: clampWorkspaceScale(Number(raw.terminalScale ?? 1)),
    uiScale: clampWorkspaceScale(Number(raw.uiScale ?? 1)),
  }
}

export const useWorkspaceZoom = create<WorkspaceZoomState>()(
  persist(
    (set) => ({
      ...DEFAULT_WORKSPACE_ZOOM,
      zoomTerminal: (direction) => set((state) => ({ terminalScale: stepFontScale(state.terminalScale, direction) })),
      zoomUi: (direction) => set((state) => ({ uiScale: stepFontScale(state.uiScale, direction) })),
      resetTerminal: () => set({ terminalScale: 1 }),
      resetUi: () => set({ uiScale: 1 }),
      reset: () => set({ ...DEFAULT_WORKSPACE_ZOOM }),
    }),
    {
      name: 'tmuxgo-workspace-zoom',
      storage: createJSONStorage(() => createDebouncedStorage(120)),
      partialize: (state) => ({ terminalScale: state.terminalScale, uiScale: state.uiScale }),
      merge: (persisted, current) => ({ ...current, ...sanitizeWorkspaceZoom(persisted) }),
    },
  ),
)

// 三区路由：终端 > 编辑区 > 其他。data-terminal-pane 包住 pane 头，避免点标题时误判成 UI。
export function zoomZoneForTarget(target: EventTarget | null): ZoomZone {
  if (target instanceof Element) {
    if (target.closest('[data-terminal-pane], [data-terminal], .xterm')) return 'terminal'
    if (target.closest('[data-editor-pane]')) return 'editor'
  }
  return 'ui'
}

export function zoomZoneForFocus(root: Document = document): ZoomZone {
  const active = root.activeElement
  if (active instanceof Element) {
    if (active.closest('[data-terminal-pane], [data-terminal], .xterm')) return 'terminal'
    if (active.closest('[data-editor-pane]')) return 'editor'
  }
  return 'ui'
}

// fixed 菜单的 left/top 是 CSS px，但 event.clientX 是物理 px；UI zoom 后要除回缩放，
// 否则菜单会以指针的 1.25 倍偏移出现。仅适用于位于 zoom 外壳内的 fixed 元素。
export function zoomCssPoint(x: number, y: number): { x: number; y: number } {
  const scale = useWorkspaceZoom.getState().uiScale
  return scale === 1 ? { x, y } : { x: x / scale, y: y / scale }
}

export function isZoomShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
  const key = event.key.toLowerCase()
  return key === '=' || key === '+' || key === '-' || key === '_' || key === '0'
}

export function applyZoneZoom(zone: ZoomZone, direction: 1 | -1): void {
  if (zone === 'terminal') {
    useWorkspaceZoom.getState().zoomTerminal(direction)
    return
  }
  if (zone === 'ui') {
    useWorkspaceZoom.getState().zoomUi(direction)
    return
  }
  const editor = useEditorViewPrefs.getState()
  if (direction === 1) editor.zoomIn()
  else editor.zoomOut()
}

export function resetZoneZoom(zone: ZoomZone): void {
  if (zone === 'terminal') useWorkspaceZoom.getState().resetTerminal()
  else if (zone === 'ui') useWorkspaceZoom.getState().resetUi()
  else useEditorViewPrefs.getState().zoomReset()
}
