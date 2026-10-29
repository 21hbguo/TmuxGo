// 编辑区视图偏好：换行/缩略图/空白渲染/吸顶/行号/面包屑/状态栏/字体缩放/自动保存。
// 与全局 Preferences 分开存的原因：这些是「编辑器怎么显示」，改动频繁（Alt+Z 一天几十次），
// 走服务端同步的 UiPreferences 会把 schema 撑大；这里沿用 useStatusBarPrefs 的本地持久化模式。
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createDebouncedStorage } from '@/lib/persist-storage'

export type WhitespaceMode = 'none' | 'boundary' | 'all'

export interface EditorViewPrefs {
  wordWrap: boolean
  minimap: boolean
  renderWhitespace: WhitespaceMode
  stickyScroll: boolean
  lineNumbers: boolean
  breadcrumbs: boolean
  statusBar: boolean
  // 编辑器内相对缩放：最终字号 = 全局 preferences.fontSize * fontScale
  fontScale: number
  autoSave: boolean
  autoSaveDelayMs: number
}

export const FONT_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2] as const
export const AUTO_SAVE_DELAY_MIN = 400
export const AUTO_SAVE_DELAY_MAX = 10_000

export const DEFAULT_EDITOR_VIEW_PREFS: EditorViewPrefs = {
  wordWrap: false,
  minimap: false,
  renderWhitespace: 'boundary',
  stickyScroll: true,
  lineNumbers: true,
  breadcrumbs: true,
  statusBar: true,
  fontScale: 1,
  autoSave: false,
  autoSaveDelayMs: 1200,
}

const WHITESPACE_MODES: WhitespaceMode[] = ['none', 'boundary', 'all']

export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1], Math.max(FONT_SCALE_STEPS[0], scale))
}

// 缩放按固定档位走，避免 Ctrl+= 连按出现 1.0000001 这种字号
export function stepFontScale(current: number, direction: 1 | -1): number {
  const clamped = clampFontScale(current)
  const index = FONT_SCALE_STEPS.findIndex((step) => step >= clamped - 1e-6)
  const nextIndex = Math.min(FONT_SCALE_STEPS.length - 1, Math.max(0, (index < 0 ? 2 : index) + direction))
  return FONT_SCALE_STEPS[nextIndex]
}

export function cycleWhitespace(current: WhitespaceMode): WhitespaceMode {
  const index = WHITESPACE_MODES.indexOf(current)
  return WHITESPACE_MODES[(index + 1) % WHITESPACE_MODES.length]
}

export function sanitizeEditorViewPrefs(input: unknown): EditorViewPrefs {
  const raw = (input || {}) as Partial<Record<keyof EditorViewPrefs, unknown>>
  const bool = (key: keyof EditorViewPrefs): boolean =>
    typeof raw[key] === 'boolean'
      ? (raw[key] as boolean)
      : (DEFAULT_EDITOR_VIEW_PREFS[key] as unknown as boolean)
  const whitespace = WHITESPACE_MODES.includes(raw.renderWhitespace as WhitespaceMode)
    ? (raw.renderWhitespace as WhitespaceMode)
    : DEFAULT_EDITOR_VIEW_PREFS.renderWhitespace
  const delay = Number(raw.autoSaveDelayMs)
  return {
    wordWrap: bool('wordWrap'),
    minimap: bool('minimap'),
    renderWhitespace: whitespace,
    stickyScroll: bool('stickyScroll'),
    lineNumbers: bool('lineNumbers'),
    breadcrumbs: bool('breadcrumbs'),
    statusBar: bool('statusBar'),
    fontScale: clampFontScale(Number(raw.fontScale ?? DEFAULT_EDITOR_VIEW_PREFS.fontScale)),
    autoSave: bool('autoSave'),
    autoSaveDelayMs: Number.isFinite(delay)
      ? Math.min(AUTO_SAVE_DELAY_MAX, Math.max(AUTO_SAVE_DELAY_MIN, delay))
      : DEFAULT_EDITOR_VIEW_PREFS.autoSaveDelayMs,
  }
}

type BooleanPrefKey = {
  [K in keyof EditorViewPrefs]: EditorViewPrefs[K] extends boolean ? K : never
}[keyof EditorViewPrefs]

interface EditorViewPrefsState extends EditorViewPrefs {
  toggle: (key: BooleanPrefKey) => void
  setPref: <K extends keyof EditorViewPrefs>(key: K, value: EditorViewPrefs[K]) => void
  cycleWhitespace: () => void
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
  reset: () => void
}

export const useEditorViewPrefs = create<EditorViewPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_EDITOR_VIEW_PREFS,
      toggle: (key) => set((state) => ({ [key]: !state[key] }) as Partial<EditorViewPrefsState>),
      setPref: (key, value) => set({ [key]: value } as Partial<EditorViewPrefsState>),
      cycleWhitespace: () => set((state) => ({ renderWhitespace: cycleWhitespace(state.renderWhitespace) })),
      zoomIn: () => set((state) => ({ fontScale: stepFontScale(state.fontScale, 1) })),
      zoomOut: () => set((state) => ({ fontScale: stepFontScale(state.fontScale, -1) })),
      zoomReset: () => set({ fontScale: 1 }),
      reset: () => set({ ...DEFAULT_EDITOR_VIEW_PREFS }),
    }),
    {
      name: 'tmuxgo-editor-view',
      storage: createJSONStorage(() => createDebouncedStorage(120)),
      // 只持久化偏好字段，函数不落盘；历史脏数据统一走 sanitize 兜底
      partialize: (state) => ({
        wordWrap: state.wordWrap,
        minimap: state.minimap,
        renderWhitespace: state.renderWhitespace,
        stickyScroll: state.stickyScroll,
        lineNumbers: state.lineNumbers,
        breadcrumbs: state.breadcrumbs,
        statusBar: state.statusBar,
        fontScale: state.fontScale,
        autoSave: state.autoSave,
        autoSaveDelayMs: state.autoSaveDelayMs,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeEditorViewPrefs(persisted) }),
    },
  ),
)
