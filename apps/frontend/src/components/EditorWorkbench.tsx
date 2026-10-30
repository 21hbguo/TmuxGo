'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import type { EditorLayoutNode, EditorLayoutSplit } from '@/stores/useConsoleStore'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from '@/hooks/usePreferences'
import { useGitDetect } from '@/hooks/useApi'
import {
  clearActiveDraggedFile,
  FILE_DRAG_MIME,
  getActiveDraggedFile,
  readDraggedFile,
  setActiveDraggedFile,
} from '@/lib/editor-drag'
import { OPEN_EDITOR_LOCATION_EVENT, openFileInEditor } from '@/lib/editor-open'
import type { EditorLocationRestore } from '@/lib/editor-open'
import { ensureTmuxgoTheme, tmuxgoThemeName } from '@/lib/monaco-theme'
import { attachWheelScrollLines } from '@/lib/editor-wheel-scroll'
import { bindHorizontalWheelScroll } from '@/lib/horizontal-wheel-scroll'
import type { Monaco } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { resolveEditorDefinition, warmupCodeNavigation } from '@/lib/code-navigation'
import { useTranslation } from '@/i18n'
import { MARKDOWN_PROSE_CLASS, locatePreviewBlock, renderMarkdown } from '@/lib/markdown'
import { previewKindForPath } from '@/lib/file-preview'
import { buildRawUrl } from '@/lib/raw-url'
import { csvTableLabels } from '@/lib/csv-table-labels'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { Button } from './Button'
import { ZoomSurface } from './ZoomSurface'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffViewer } from './DiffViewer'
import { EditorBreadcrumbs } from './EditorBreadcrumbs'
import { EditorStatusBar } from './EditorStatusBar'
import { EditorQuickPick } from './EditorQuickPick'
import { EditorContextMenu, type EditorMenuAction } from './EditorContextMenu'
import { EditorShortcutsDialog } from './EditorShortcutsDialog'
import { getEditorCursor, pruneEditorCursors, setEditorCursor, subscribeEditorCursor } from '@/lib/editor-cursor'
import {
  computeSelectionStats,
  convertEol,
  detectEol,
  detectIndent,
  type EditorEol,
  type EditorIndentInfo,
} from '@/lib/editor-status'
import { extractOutline, isOutlineSupported } from '@/lib/editor-outline'
import { parseGotoLine } from '@/lib/editor-quickpick'
import { idsToCloseOthers, idsToCloseSaved, idsToCloseToRight } from '@/lib/editor-tab-actions'
import {
  EDITOR_COMMANDS_BY_ID,
  MONACO_ACTIONS,
  formatKeybinding,
  resolveEditorKey,
  CHORD_TIMEOUT_MS,
  type EditorChord,
  type EditorCommandId,
} from '@/lib/editor-commands'
import { useEditorViewPrefs } from '@/lib/editor-view-prefs'
import { isApplePlatform } from '@/lib/terminal-platform'
import { registerEditorCommandHandler } from '@/lib/editor-command-bus'
import dynamic from '@/lib/dynamic'
import { FiArrowLeft, FiArrowRight, FiCode, FiMoreHorizontal } from 'react-icons/fi'

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((mod) => ({ default: mod.default })))
const MonacoDiffEditor = dynamic(() => import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor })))
// CSV 预览仅在打开 csv 预览时用，懒加载避免进主入口静态依赖
const CsvTable = dynamic(() => import('./CsvTable').then((mod) => ({ default: mod.CsvTable })))
const PdfPreview = dynamic(() => import('./PdfPreview').then((mod) => ({ default: mod.PdfPreview })))
const MediaPreview = dynamic(() => import('./MediaPreview').then((mod) => ({ default: mod.MediaPreview })))
// 预览防抖阈值：小文档保持同步渲染（打开即见），超过它就防抖，避免每键重解析卡输入
const PREVIEW_DEBOUNCE_THRESHOLD = 16_384
const AUTO_SCROLL_DEADZONE = 10
const AUTO_SCROLL_MAX_STEP = 42
const EDGE_DROP_RATIO = 0.22
let monacoDefinitionProviderDisabled = false
// Monaco 自带 Ctrl+点击跳转经内置 TS provider 把符号解析到 import 位置，与自定义 resolver 竞争；
// 关闭内置 definitions provider（保留 hover/completion 等其余特性），跳转统一走 goToDefinition
const disableMonacoDefinitionProvider = (monaco: Monaco) => {
  if (monacoDefinitionProviderDisabled) return
  monacoDefinitionProviderDisabled = true
  const ts = (
    monaco.languages as {
      typescript?: {
        typescriptDefaults?: TypeScriptDefaultsLike
        javascriptDefaults?: TypeScriptDefaultsLike
      }
    }
  ).typescript
  for (const defaults of [ts?.typescriptDefaults, ts?.javascriptDefaults])
    defaults?.setModeConfiguration?.({ ...defaults.modeConfiguration, definitions: false })
}
interface TypeScriptDefaultsLike {
  modeConfiguration?: Record<string, unknown>
  setModeConfiguration?: (config: Record<string, unknown>) => void
}
// findController 走 getContribution 拿的是内部实现，只取用到的最小面
interface FindControllerLike {
  getState?(): {
    isRevealed?: boolean
    searchString?: string
    isRegex?: boolean
    wholeWord?: boolean
    matchCase?: boolean
    preserveCase?: boolean
    isReplaceRevealed?: boolean
    onFindReplaceStateChange?(listener: () => void): { dispose(): void } | null | undefined
  }
  start?(options: Record<string, unknown>, searchStateSeed?: Record<string, unknown>): void
}
type DropPlacement = 'center' | 'left' | 'right' | 'top' | 'bottom'
// 'compare' 不在插入序里：它是 tab 中段落区，落下去生成对比视图而不是换位
type TabInsertSide = 'before' | 'after' | 'compare'
interface NavigationEntry {
  id: string
  hostId: string
  rootId: string
  rootLabel: string
  rootPath: string
  path: string
  name: string
  absolutePath: string
  type: 'file'
  line: number
  column: number
  viewState?: EditorLocationRestore
}
function isEditorLayoutSplit(node: EditorLayoutNode): node is EditorLayoutSplit {
  return node.type === 'split'
}
function collectEditorLayoutGroupIds(node: EditorLayoutNode | null): string[] {
  if (!node) return []
  if (!isEditorLayoutSplit(node)) return [node.groupId]
  return [...collectEditorLayoutGroupIds(node.first), ...collectEditorLayoutGroupIds(node.second)]
}
function getParentDir(path: string) {
  const normalized = path.replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}
function getMonacoTheme(theme: string) {
  return tmuxgoThemeName(theme)
}
function getTabSize(language: string) {
  if (language === 'python' || language === 'yaml') return 4
  if (language === 'go') return 4
  return 2
}
function isImagePreviewable(editor: FileEditorDocument) {
  return !!editor.previewUrl
}
// 有右侧预览面的文本语言：md/html 渲染预览，csv 渲染表格
function isPreviewableLanguage(language: string) {
  return language === 'markdown' || language === 'html' || language === 'csv'
}
// 可预览文件的展示模式：preview=整区预览（打开默认）/split=左右分栏/edit=仅编辑器
type EditorPreviewMode = 'edit' | 'preview' | 'split'
function getAutoScrollStep(distance: number) {
  const absDistance = Math.abs(distance)
  if (absDistance <= AUTO_SCROLL_DEADZONE) return 0
  const direction = distance > 0 ? 1 : -1
  const speed = Math.min(AUTO_SCROLL_MAX_STEP, (absDistance - AUTO_SCROLL_DEADZONE) * 0.45)
  return speed * direction
}
function parseGitDiffId(id: string) {
  if (!id.startsWith('git-diff?')) return null
  const params = new URLSearchParams(id.slice('git-diff?'.length))
  const hostId = params.get('hostId') || ''
  const repoPath = params.get('repoPath') || ''
  const filePath = params.get('filePath') || ''
  const commit = params.get('commit') || ''
  if (!hostId || !repoPath) return null
  return { hostId, repoPath, filePath, staged: params.get('staged') === '1', commit: commit || undefined }
}
function decodeDraggedFile(event: DragEvent | ReactDragEvent) {
  return readDraggedFile(event.dataTransfer)
}
function hasDraggedFile(event: DragEvent | ReactDragEvent) {
  const types = event.dataTransfer?.types
  if (types && Array.from(types).includes(FILE_DRAG_MIME)) return true
  return !!getActiveDraggedFile()
}
function getDropPlacement(rect: DOMRect, clientX: number, clientY: number) {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const edgeX = rect.width * EDGE_DROP_RATIO
  const edgeY = rect.height * EDGE_DROP_RATIO
  if (localX <= edgeX) return 'left' as const
  if (localX >= rect.width - edgeX) return 'right' as const
  if (localY <= edgeY) return 'top' as const
  if (localY >= rect.height - edgeY) return 'bottom' as const
  return 'center' as const
}
export function EditorWorkbench({
  onSaveEditor,
  onOpenFile,
  onOpenFileAtPosition = async (file) => file.id,
  onCreateCompare,
}: {
  onSaveEditor: (editor: FileEditorDocument) => Promise<void>
  onOpenFile: (file: FileDocumentHandle, options?: { preserveActive?: boolean }) => Promise<string>
  onOpenFileAtPosition?: (file: FileDocumentHandle, placement: DropPlacement) => Promise<string>
  onCreateCompare: (source: FileDocumentHandle, targetId: string) => Promise<void>
}) {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const activeEditorId = useConsoleStore((state) => state.activeEditorId)
  const editorGroups = useConsoleStore((state) => state.editorGroups)
  const editorLayout = useConsoleStore((state) => state.editorLayout)
  const activeEditorGroupId = useConsoleStore((state) => state.activeEditorGroupId)
  const placeEditorInSplit = useConsoleStore((state) => state.placeEditorInSplit)
  const setEditorSplitRatio = useConsoleStore((state) => state.setEditorSplitRatio)
  const setActiveEditor = useConsoleStore((state) => state.setActiveEditor)
  const moveEditorToGroup = useConsoleStore((state) => state.moveEditorToGroup)
  const closeEditor = useConsoleStore((state) => state.closeEditor)
  const closeEditors = useConsoleStore((state) => state.closeEditors)
  const pushClosedEditor = useConsoleStore((state) => state.pushClosedEditor)
  const takeClosedEditor = useConsoleStore((state) => state.takeClosedEditor)
  const pinEditor = useConsoleStore((state) => state.pinEditor)
  const setEditorContent = useConsoleStore((state) => state.setEditorContent)
  const setEditorSaveError = useConsoleStore((state) => state.setEditorSaveError)
  const ensureGitHostState = useConsoleStore((state) => state.ensureGitHostState)
  const setGitFollowEditorRepo = useConsoleStore((state) => state.setGitFollowEditorRepo)
  const gitByHost = useConsoleStore((state) => state.gitByHost)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { preferences } = usePreferences()
  // 编辑器视图偏好（换行/缩略图/吸顶/行号/面包屑/状态栏/缩放/自动保存）：
  // 与全局 preferences 分开，改动频繁且无需服务端同步
  const viewPrefs = useEditorViewPrefs()
  const { t } = useTranslation()
  const editorRefs = useRef<Record<string, monacoEditor.IStandaloneCodeEditor>>({})
  const monacoRef = useRef<Monaco | null>(null)
  const wheelScrollLinesRef = useRef(preferences.editorWheelScrollLines)
  wheelScrollLinesRef.current = preferences.editorWheelScrollLines
  const wheelScrollDisposersRef = useRef(new Map<string, () => void>())
  const editorViewportRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const openEditorsRef = useRef(openEditors)
  openEditorsRef.current = openEditors
  const autoScrollFrameRef = useRef<number | null>(null)
  const autoScrollStateRef = useRef<{
    active: boolean
    editorId: string | null
    anchorX: number
    anchorY: number
    pointerX: number
    pointerY: number
  }>({ active: false, editorId: null, anchorX: 0, anchorY: 0, pointerX: 0, pointerY: 0 })
  const navigationBackRef = useRef<NavigationEntry[]>([])
  const navigationForwardRef = useRef<NavigationEntry[]>([])
  const navigationPendingRef = useRef(false)
  const definitionAbortRef = useRef<AbortController | null>(null)
  const pendingLocationRef = useRef<
    Record<string, { line: number; column: number; reveal: 'center' | 'preserve'; viewState?: EditorLocationRestore }>
  >({})
  // 每个 tab 最新视图快照：Monaco 卸载分支会 dispose 模型且不存 viewState，remount 恢复靠它
  const viewStateRef = useRef<
    Record<
      string,
      {
        position: { line: number; column: number } | null
        selection: EditorLocationRestore['selection']
        scrollTop: number
        scrollLeft: number
      }
    >
  >({})
  // find widget 绑在单个 Monaco 实例上、随 tab key 重挂载销毁：按 editor group
  // 留存最近一次 find 状态，同组换文件后在新实例上原样恢复（语义对齐 VSCode
  // 的按组 widget：换 tab 后 widget/查询词/开关都还在）
  const findStateByGroupRef = useRef<
    Record<
      string,
      {
        revealed: boolean
        searchString: string
        isRegex: boolean
        wholeWord: boolean
        matchCase: boolean
        preserveCase: boolean
        isReplaceRevealed: boolean
      }
    >
  >({})
  const [pendingCloseEditorId, setPendingCloseEditorId] = useState<string | null>(null)
  const [previewModeById, setPreviewModeById] = useState<Record<string, EditorPreviewMode>>({})
  // 左右分栏里编辑器侧的宽度占比，拖中间分隔条调整
  const [previewSplitRatio, setPreviewSplitRatio] = useState(0.5)
  // 光标不再进 React state：高频移动走 lib/editor-cursor 的 rAF 合并订阅，
  // 只有状态栏/面包屑这类小组件重渲染，工作台本体不参与
  const [quickPickMode, setQuickPickMode] = useState<null | 'goto-line' | 'symbol'>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; editorId: string } | null>(null)
  const [toolbarMenu, setToolbarMenu] = useState<{ x: number; y: number } | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [chord, setChord] = useState<EditorChord | null>(null)
  const chordTimerRef = useRef<number | null>(null)
  const [outline, setOutline] = useState<ReturnType<typeof extractOutline>>([])
  // 用户手改的缩进 / 行尾优先于探测结果，按编辑器 id 记（VSCode 同语义：只影响本文件）
  const [indentOverride, setIndentOverride] = useState<Record<string, EditorIndentInfo>>({})
  const [eolOverride, setEolOverride] = useState<Record<string, EditorEol>>({})
  const [statsInput, setStatsInput] = useState<{ id: string; content: string } | null>(null)
  const [markdownHtml, setMarkdownHtml] = useState<Record<string, string>>({})
  const [autoScrollIndicator, setAutoScrollIndicator] = useState<{ active: boolean; x: number; y: number }>({
    active: false,
    x: 0,
    y: 0,
  })
  const [dropTarget, setDropTarget] = useState<DropPlacement | null>(null)
  const [paneDropTarget, setPaneDropTarget] = useState<{ groupId: string; placement: DropPlacement } | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<{ groupId: string; placement: DropPlacement } | null>(null)
  const [tabInsertionTarget, setTabInsertionTarget] = useState<{
    groupId: string
    editorId: string
    side: TabInsertSide
  } | null>(null)
  // 只用于触发重渲染（工具栏前进/后退的 disabled 读 ref，不读值）
  const [_navigationVersion, setNavigationVersion] = useState(0)
  const [previewSyncEnabled, setPreviewSyncEnabled] = useState(true)
  // onMount/onScroll 回调里读最新值，避免闭包快照
  const previewSyncEnabledRef = useRef(previewSyncEnabled)
  previewSyncEnabledRef.current = previewSyncEnabled
  const previewModeByIdRef = useRef(previewModeById)
  previewModeByIdRef.current = previewModeById
  // 滚动同步回环抑制：程序化写入一侧后，短时间忽略该侧回传的 scroll 事件
  const scrollSyncGuardRef = useRef<Record<string, { side: 'editor' | 'preview'; ts: number }>>({})
  const previewElRefs = useRef<Record<string, HTMLElement | null>>({})
  const previewHighlightRef = useRef<Record<string, HTMLElement | null>>({})
  const splitResizeRef = useRef<{
    active: boolean
    direction: 'horizontal' | 'vertical'
    splitId: string
    container: HTMLDivElement | null
  } | null>(null)
  const previewResizeRef = useRef<{ active: boolean; container: HTMLElement | null } | null>(null)
  const editorById = new Map(openEditors.map((item) => [item.id, item]))
  const groupById = new Map(editorGroups.map((group) => [group.id, group]))
  const orderedGroupIds = collectEditorLayoutGroupIds(editorLayout)
  const activeEditor = activeEditorId
    ? editorById.get(activeEditorId) || null
    : openEditors[openEditors.length - 1] || null
  const gitDiff = activeEditor?.id.startsWith('git-diff?') ? parseGitDiffId(activeEditor.id) : null
  const activePreviewMode: EditorPreviewMode =
    activeEditor && isPreviewableLanguage(activeEditor.language)
      ? (previewModeById[activeEditor.id] ?? 'preview')
      : 'edit'
  const followFilePath = !gitDiff && activeEditor?.absolutePath ? getParentDir(activeEditor.absolutePath) : ''
  const gitMode = activeHostId ? gitByHost[activeHostId]?.mode || 'follow-editor' : 'follow-editor'
  const { data: detectResult } = useGitDetect(activeHostId || '', followFilePath)
  // 主题切换：CSS 变量已由 usePreferences 落到 data-theme，重定义同名主题再 setTheme 生效
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return
    monaco.editor.setTheme(ensureTmuxgoTheme(monaco, preferences.theme))
  }, [preferences.theme])
  const getLegacyGroupName = (groupId: string) => {
    const index = orderedGroupIds.indexOf(groupId)
    if (index === 0) return 'primary'
    if (index === 1) return 'secondary'
    return groupId
  }
  const getGroupEditors = (groupId: string) => {
    const group = groupById.get(groupId)
    return (group?.editorIds || []).map((id) => editorById.get(id) || null).filter(Boolean) as FileEditorDocument[]
  }
  const getGroupActiveEditor = (groupId: string) => {
    const group = groupById.get(groupId)
    if (!group) return null
    if (group.activeEditorId && editorById.has(group.activeEditorId))
      return editorById.get(group.activeEditorId) || null
    const fallbackId = group.editorIds.filter((id) => editorById.has(id)).at(-1) || null
    return fallbackId ? editorById.get(fallbackId) || null : null
  }
  const resolveDropGroupId = (groupId?: string | null) =>
    groupId && groupById.has(groupId)
      ? groupId
      : activeEditorGroupId && groupById.has(activeEditorGroupId)
        ? activeEditorGroupId
        : orderedGroupIds[0] || editorGroups[0]?.id || null
  const isOpenEditorId = (id: string) => openEditors.some((item) => item.id === id)
  // 已打开文件提示 'move' 仅在源端允许 move 时合法：文件树单拖只声明
  // effectAllowed=copy，此时回 'move' 会让 dropEffect 与 effectAllowed 不兼容，
  // 浏览器 veto 后 drop 事件根本不派发——表现为拖已打开文件进编辑区毫无反应
  const getDragDropEffect = (dragged: FileDocumentHandle | null, effectAllowed?: string) => {
    const moveAllowed =
      !effectAllowed ||
      effectAllowed === 'uninitialized' ||
      effectAllowed === 'all' ||
      effectAllowed.includes('Move') ||
      effectAllowed === 'move'
    return dragged && isOpenEditorId(dragged.id) && moveAllowed ? 'move' : 'copy'
  }
  // 三段落区：左右各 30% 维持 before/after 插入，中段 40% 是「生成对比」落区（产品方案 A）。
  // 中段不放宽到整条 tab：拖拽换位是高频操作，误落换位比误落对比更难撤销
  const TAB_INSERT_EDGE_RATIO = 0.3
  const getTabInsertSide = (rect: DOMRect, clientX: number): TabInsertSide => {
    const offset = clientX - rect.left
    if (offset < rect.width * TAB_INSERT_EDGE_RATIO) return 'before'
    if (offset > rect.width * (1 - TAB_INSERT_EDGE_RATIO)) return 'after'
    return 'compare'
  }
  const getNavigationPosition = (editorId: string) => {
    // 存活实例优先：cursor store 是 rAF 合并后的快照，连续操作时可能滞后一拍
    const position = editorRefs.current[editorId]?.getPosition?.()
    if (position) return { line: position.lineNumber, column: position.column }
    const snapshot = getEditorCursor(editorId)
    return snapshot ? { line: snapshot.line, column: snapshot.column } : null
  }
  const syncPreviewToLine = (editorId: string, line: number) => {
    const previewEl = previewElRefs.current[editorId]
    if (!previewEl || !line) return
    const target = locatePreviewBlock(previewEl, line)
    const previous = previewHighlightRef.current[editorId]
    if (previous && previous !== target) previous.classList.remove('md-source-loc')
    previewHighlightRef.current[editorId] = target
    if (!target) return
    target.classList.add('md-source-loc')
    // 同块内移动不重复滚动，nearest 只做不打扰式对齐
    if (target !== previous) {
      scrollSyncGuardRef.current[editorId] = { side: 'preview', ts: Date.now() }
      target.scrollIntoView?.({ block: 'nearest' })
    }
  }
  const jumpPreviewToEditor = (editorId: string) => (event: ReactMouseEvent<HTMLElement>) => {
    const target = (event.target as HTMLElement).closest('[data-line]')
    if (!target) return
    const line = Number(target.getAttribute('data-line'))
    const instance = editorRefs.current[editorId]
    if (!instance || !line) return
    instance.revealLineInCenter?.(line)
    instance.setPosition?.({ lineNumber: line, column: 1 })
    instance.focus?.()
  }
  const getEditorLineHeight = (instance: monacoEditor.IStandaloneCodeEditor | null | undefined) => {
    const option = monacoRef.current?.editor?.EditorOption?.lineHeight
    const value = option !== undefined ? Number(instance?.getOption?.(option)) : 0
    return value > 0 ? value : 20
  }
  // 预览滚动视口即 ZoomSurface 根（className 里带 tmuxgo-scrollbar 的那个祖先）
  const getPreviewScroller = (editorId: string) =>
    (previewElRefs.current[editorId]?.closest('.tmuxgo-scrollbar') as HTMLElement | null) || null
  // 编辑器→预览：首条可见源行映射到预览块并顶对齐；一律走 rect 换算，ZoomSurface transform 下也安全
  const syncPreviewScrollToEditor = (editorId: string) => {
    const article = previewElRefs.current[editorId]
    const scroller = getPreviewScroller(editorId)
    const instance = editorRefs.current[editorId]
    if (!article || !scroller || !instance) return
    const topLine =
      Number(instance.getVisibleRanges?.()?.[0]?.startLineNumber) ||
      Math.floor(Number(instance.getScrollTop?.() || 0) / getEditorLineHeight(instance)) + 1
    const block = locatePreviewBlock(article, topLine)
    if (!block) return
    scrollSyncGuardRef.current[editorId] = { side: 'preview', ts: Date.now() }
    scroller.scrollTop = Math.max(
      0,
      block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8,
    )
  }
  // 预览→编辑器：视口顶命中的预览块 + 块内进度，线性折算回源行滚动位置
  const syncEditorScrollToPreview = (editorId: string) => {
    const article = previewElRefs.current[editorId]
    const scroller = getPreviewScroller(editorId)
    const instance = editorRefs.current[editorId]
    if (!article || !scroller || !instance) return
    const anchor = scroller.getBoundingClientRect().top + 8
    let block: HTMLElement | null = null
    let line = 1
    let nextLine = 0
    for (const el of Array.from(article.querySelectorAll<HTMLElement>('[data-line]'))) {
      if (el.getBoundingClientRect().top <= anchor) {
        block = el
        line = Number(el.getAttribute('data-line')) || line
      } else {
        nextLine = Number(el.getAttribute('data-line')) || 0
        break
      }
    }
    const blockRect = block?.getBoundingClientRect()
    const frac =
      blockRect && blockRect.height > 0 ? Math.min(1, Math.max(0, (anchor - blockRect.top) / blockRect.height)) : 0
    const lineSpan = Math.max(1, (nextLine || line + 1) - line)
    const baseTop = Number(instance.getTopForLineNumber?.(line) ?? 0)
    scrollSyncGuardRef.current[editorId] = { side: 'editor', ts: Date.now() }
    instance.setScrollTop?.(baseTop + frac * lineSpan * getEditorLineHeight(instance))
  }
  const scrollSyncAllowed = (editorId: string) =>
    previewSyncEnabledRef.current && (previewModeByIdRef.current[editorId] ?? 'preview') === 'split'
  const handleEditorScrollSync = (editorId: string) => {
    if (!scrollSyncAllowed(editorId)) return
    const guard = scrollSyncGuardRef.current[editorId]
    if (guard?.side === 'editor' && Date.now() - guard.ts < 120) return
    syncPreviewScrollToEditor(editorId)
  }
  const handlePreviewScroll = (editorId: string) => {
    if (!scrollSyncAllowed(editorId)) return
    const guard = scrollSyncGuardRef.current[editorId]
    if (guard?.side === 'preview' && Date.now() - guard.ts < 120) return
    syncEditorScrollToPreview(editorId)
  }
  // md 预览跟随光标：content 重渲（新 DOM 需重打高亮）、开关/编辑器切换都走这里；
  // 光标变化改走 store 订阅（见下），否则每次移动光标都要重渲染整个工作台
  const previewFollowRef = useRef<() => void>(() => {})
  previewFollowRef.current = () => {
    if (!previewSyncEnabled || !activeEditor || activeEditor.language !== 'markdown') return
    if ((previewModeById[activeEditor.id] ?? 'preview') === 'edit') return
    syncPreviewToLine(activeEditor.id, getEditorCursor(activeEditor.id)?.line || 1)
  }
  useEffect(() => {
    previewFollowRef.current()
  }, [previewSyncEnabled, activeEditor?.id, activeEditor?.language, activeEditor?.content, previewModeById])
  useEffect(() => subscribeEditorCursor(() => previewFollowRef.current()), [])
  // 大纲（面包屑/符号面板）：300ms 防抖，不跟着每次按键重算
  useEffect(() => {
    const target = activeEditor
    if (!target || !isOutlineSupported(target.language)) {
      setOutline((current) => (current.length ? [] : current))
      return
    }
    const timer = window.setTimeout(() => setOutline(extractOutline(target.language, target.content)), 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditor?.id, activeEditor?.language, activeEditor?.content])
  // 行尾/缩进要扫内容，同样防抖；统计结果按 id 落到 statsInput，切换文件时立刻重算
  useEffect(() => {
    if (!activeEditor) {
      setStatsInput(null)
      return
    }
    const target = activeEditor
    const timer = window.setTimeout(() => setStatsInput({ id: target.id, content: target.content }), 250)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditor?.id, activeEditor?.content])
  const detectedStats = useMemo(() => {
    if (!statsInput) return null
    return { eol: detectEol(statsInput.content), indent: detectIndent(statsInput.content) }
  }, [statsInput])
  // 预览 HTML：小文档同步渲染（保持「开箱即见」），大文档 220ms 防抖避免每键重解析
  useEffect(() => {
    if (!activeEditor || activeEditor.language !== 'markdown') return
    const { id, content } = activeEditor
    const apply = () => {
      const html = renderMarkdown(content)
      setMarkdownHtml((current) => (current[id] === html ? current : { ...current, [id]: html }))
    }
    if (content.length <= PREVIEW_DEBOUNCE_THRESHOLD) {
      apply()
      return
    }
    const timer = window.setTimeout(apply, 220)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditor?.id, activeEditor?.language, activeEditor?.content])
  // 自动保存：只跟随当前编辑器，抖动窗口内连续输入只落一次盘
  useEffect(() => {
    if (!viewPrefs.autoSave || !activeEditor?.dirty) return
    if (activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated) return
    if (activeEditor.kind === 'compare' || activeEditor.id.startsWith('git-diff?')) return
    const id = activeEditor.id
    const timer = window.setTimeout(() => {
      const latest = useConsoleStore.getState().openEditors.find((item) => item.id === id)
      if (latest?.dirty && !latest.saving) void onSaveEditor(latest)
    }, viewPrefs.autoSaveDelayMs)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewPrefs.autoSave,
    viewPrefs.autoSaveDelayMs,
    activeEditor?.id,
    activeEditor?.content,
    activeEditor?.dirty,
    activeEditor?.saving,
    activeEditor?.loading,
  ])
  // 刚切进左右分栏时按编辑器当前可见行对齐一次；之后由双向滚动监听接管
  useEffect(() => {
    if (!previewSyncEnabled || !activeEditor || activeEditor.language !== 'markdown') return
    if ((previewModeById[activeEditor.id] ?? 'preview') !== 'split') return
    syncPreviewScrollToEditor(activeEditor.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSyncEnabled, activeEditor?.id, previewModeById])
  const createNavigationEntry = (editor: FileEditorDocument, position?: { line: number; column: number } | null) => {
    const resolvedPosition = position || getNavigationPosition(editor.id)
    if (!resolvedPosition) return null
    // 顺带快照选区/视口：返回/前进据此恢复，不再强制居中
    const instance = editorRefs.current[editor.id]
    const viewState: EditorLocationRestore | undefined = instance
      ? {
          scrollTop: Number(instance.getScrollTop?.() || 0),
          scrollLeft: Number(instance.getScrollLeft?.() || 0),
          selection: instance.getSelection?.() || null,
        }
      : undefined
    return {
      id: editor.id,
      hostId: editor.hostId,
      rootId: editor.rootId,
      rootLabel: editor.rootLabel,
      rootPath: editor.rootPath,
      path: editor.path,
      name: editor.name,
      absolutePath: editor.absolutePath,
      type: 'file' as const,
      line: resolvedPosition.line,
      column: resolvedPosition.column,
      viewState,
    } satisfies NavigationEntry
  }
  const sameNavigationEntry = (left: NavigationEntry | null | undefined, right: NavigationEntry | null | undefined) =>
    !!left && !!right && left.id === right.id && left.line === right.line && left.column === right.column
  const syncNavigationState = () => setNavigationVersion((current) => current + 1)
  // 在途定义搜索作废入口：返回/前进、手动切换、关源文件、显式打开、卸载都使迟到的 resolver 结果失效
  const cancelPendingDefinition = () => {
    definitionAbortRef.current?.abort()
    definitionAbortRef.current = null
  }
  useEffect(() => () => cancelPendingDefinition(), [])
  // 每格滚轮固定行数：attach 一次长期生效，行数变化经 ref 热更新，无需重挂监听
  const releaseEditorWheelScroll = (editorId: string) => {
    wheelScrollDisposersRef.current.get(editorId)?.()
    wheelScrollDisposersRef.current.delete(editorId)
  }
  const attachEditorWheelScroll = (
    editorId: string,
    dom: HTMLElement | null | undefined,
    instance: monacoEditor.IStandaloneCodeEditor | null,
  ) => {
    releaseEditorWheelScroll(editorId)
    if (!dom || !instance) return
    const dispose = attachWheelScrollLines(dom, () => wheelScrollLinesRef.current, {
      getScrollTop: () => Number(instance.getScrollTop?.() || 0),
      getMaxScrollTop: () =>
        Math.max(0, Number(instance.getScrollHeight?.() || 0) - Number(instance.getLayoutInfo?.().height || 0)),
      getLineHeight: () => getEditorLineHeight(instance),
      setScrollTop: (top) => instance.setScrollTop?.(top, monacoRef.current?.editor?.ScrollType?.Smooth),
    })
    wheelScrollDisposersRef.current.set(editorId, dispose)
  }
  useEffect(
    () => () => {
      wheelScrollDisposersRef.current.forEach((dispose) => dispose())
      wheelScrollDisposersRef.current.clear()
    },
    [],
  )
  const openNavigationEntry = async (entry: NavigationEntry) => {
    let failed = false
    await openFileInEditor(
      {
        id: entry.id,
        hostId: entry.hostId,
        rootId: entry.rootId,
        rootLabel: entry.rootLabel,
        rootPath: entry.rootPath,
        path: entry.path,
        name: entry.name,
        absolutePath: entry.absolutePath,
        type: 'file',
      },
      {
        t,
        pushToast,
        position: { line: entry.line, column: entry.column },
        openPanel: true,
        skipReload: true,
        restore: entry.viewState,
        onError: () => {
          failed = true
        },
      },
    )
    return !failed
  }
  const navigateToEntry = async (entry: NavigationEntry, sourceEntry?: NavigationEntry | null) => {
    if (navigationPendingRef.current || sameNavigationEntry(sourceEntry, entry)) return
    navigationPendingRef.current = true
    try {
      const pushedSource =
        sourceEntry &&
        !sameNavigationEntry(navigationBackRef.current[navigationBackRef.current.length - 1], sourceEntry)
      if (pushedSource) navigationBackRef.current.push(sourceEntry)
      // 跳离即把源 preview tab 钉住：否则 openEditor 的预览替换会把目标文件
      // 原位盖掉源 tab（用户在 A 里跳定义到 B，结果 A 的 tab 被 B 覆盖）
      if (sourceEntry) useConsoleStore.getState().pinEditor(sourceEntry.id)
      const forwardSnapshot = navigationForwardRef.current
      navigationForwardRef.current = []
      // 打开失败（删除/权限/读取错误）时回滚栈，历史不丢
      if (!(await openNavigationEntry(entry))) {
        if (pushedSource) navigationBackRef.current.pop()
        navigationForwardRef.current = forwardSnapshot
      }
      syncNavigationState()
    } finally {
      navigationPendingRef.current = false
    }
  }
  const goBackInNavigation = async () => {
    if (navigationPendingRef.current) return
    const entry = navigationBackRef.current.pop()
    if (!entry) return
    // 确认返回后，在途定义搜索的迟到结果不得再导航/改历史；空栈空按不作废搜索
    cancelPendingDefinition()
    const currentEntry = activeEditor && !gitDiff ? createNavigationEntry(activeEditor) : null
    navigationPendingRef.current = true
    try {
      const pushedForward =
        currentEntry &&
        !sameNavigationEntry(navigationForwardRef.current[navigationForwardRef.current.length - 1], currentEntry)
      if (pushedForward) navigationForwardRef.current.push(currentEntry)
      if (!(await openNavigationEntry(entry))) {
        navigationBackRef.current.push(entry)
        if (pushedForward) navigationForwardRef.current.pop()
      }
      syncNavigationState()
    } finally {
      navigationPendingRef.current = false
    }
  }
  const goForwardInNavigation = async () => {
    if (navigationPendingRef.current) return
    const entry = navigationForwardRef.current.pop()
    if (!entry) return
    // 同 goBack：确认前进后才作废在途搜索
    cancelPendingDefinition()
    const currentEntry = activeEditor && !gitDiff ? createNavigationEntry(activeEditor) : null
    navigationPendingRef.current = true
    try {
      const pushedBack =
        currentEntry &&
        !sameNavigationEntry(navigationBackRef.current[navigationBackRef.current.length - 1], currentEntry)
      if (pushedBack) navigationBackRef.current.push(currentEntry)
      if (!(await openNavigationEntry(entry))) {
        navigationForwardRef.current.push(entry)
        if (pushedBack) navigationBackRef.current.pop()
      }
      syncNavigationState()
    } finally {
      navigationPendingRef.current = false
    }
  }
  const goToDefinition = async (editor: FileEditorDocument, position: { line: number; column: number }) => {
    if (
      navigationPendingRef.current ||
      editor.loading ||
      editor.binary ||
      editor.truncated ||
      editor.kind === 'compare'
    )
      return
    const sourceEntry = createNavigationEntry(editor, position)
    if (!sourceEntry) return
    // 不吞点击：上一次跳转仍在跑（如大 root rg 全扫）时取消它，用新位置重新发起
    definitionAbortRef.current?.abort()
    const controller = new AbortController()
    definitionAbortRef.current = controller
    // 慢搜索兜底提示：超过 800ms 未出结果时告知"搜索中"，避免用户感知为点击无反应
    const slowTimer = setTimeout(() => {
      if (definitionAbortRef.current === controller)
        pushToast({ type: 'info', message: t('editor.definitionSearching') })
    }, 800)
    try {
      const result = await resolveEditorDefinition(editor, position, openEditorsRef.current, controller.signal)
      if (controller.signal.aborted) return
      const latestState = useConsoleStore.getState()
      // 搜索期间用户已手动切走或源文件被关闭：迟到的结果不得再导航/改历史/弹提示
      if (!latestState.openEditors.some((item) => item.id === editor.id) || latestState.activeEditorId !== editor.id)
        return
      if (result.status === 'unsupported') {
        pushToast({ type: 'info', message: t('editor.definitionUnsupported') })
        return
      }
      if (result.status !== 'success') {
        pushToast({ type: 'info', message: t('editor.definitionNotFound') })
        return
      }
      await navigateToEntry(result.target, sourceEntry)
    } catch (error) {
      if (controller.signal.aborted) return
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('editor.definitionNotFound') })
    } finally {
      clearTimeout(slowTimer)
      if (definitionAbortRef.current === controller) definitionAbortRef.current = null
    }
  }
  // 全局键位监听是 mount-once 语义：导航函数每次 render 重建（内部读 ref/最新状态），
  // 用 latest-ref 让 handler 始终取到最新实现，避免把它们塞进 effect deps 导致监听每 render 重挂
  const navigationHandlersRef = useRef({
    getNavigationPosition,
    goBackInNavigation,
    goForwardInNavigation,
    goToDefinition,
  })
  navigationHandlersRef.current = { getNavigationPosition, goBackInNavigation, goForwardInNavigation, goToDefinition }
  const resolveTabInsertTargetId = (
    groupEditors: FileEditorDocument[],
    draggedId: string,
    targetId: string,
    side: 'before' | 'after',
  ) => {
    if (side === 'before') return targetId
    const baseIds = groupEditors.map((item) => item.id).filter((item) => item !== draggedId)
    const targetIndex = baseIds.indexOf(targetId)
    return targetIndex >= 0 ? baseIds[targetIndex + 1] || null : null
  }
  const openDraggedFileInGroup = async (dragged: FileDocumentHandle, groupId: string, targetId?: string | null) => {
    // preserveActive：moveEditorToGroup 自己激活目标组；中转打开抢活动会让
    // 活动组的 active 掉到 editorIds.at(-1)（组内正在看的 tab 被换掉）
    const id = await onOpenFile(dragged, { preserveActive: true })
    moveEditorToGroup(id, groupId, targetId)
  }
  const openDraggedFileAtPlacement = async (
    dragged: FileDocumentHandle,
    placement: DropPlacement,
    groupId?: string | null,
  ) => {
    const resolvedGroupId = resolveDropGroupId(groupId)
    if (!resolvedGroupId) {
      await onOpenFileAtPosition(dragged, placement)
      return
    }
    if (placement === 'center') {
      await openDraggedFileInGroup(dragged, resolvedGroupId)
      return
    }
    const id = await onOpenFile(dragged, { preserveActive: true })
    placeEditorInSplit(id, placement, resolvedGroupId)
  }
  const handleGroupDrop = async (dragged: FileDocumentHandle, placement: DropPlacement, groupId?: string | null) => {
    cancelPendingDefinition()
    const resolvedGroupId = resolveDropGroupId(groupId)
    if (isOpenEditorId(dragged.id)) {
      if (!resolvedGroupId) {
        if (placement === 'center') setActiveEditor(dragged.id)
        else placeEditorInSplit(dragged.id, placement)
        return
      }
      if (placement === 'center') moveEditorToGroup(dragged.id, resolvedGroupId)
      else placeEditorInSplit(dragged.id, placement, resolvedGroupId)
      return
    }
    await openDraggedFileAtPlacement(dragged, placement, resolvedGroupId)
  }
  const handleTabButtonDrop = async (
    dragged: FileDocumentHandle,
    groupEditors: FileEditorDocument[],
    groupId: string,
    targetEditor: FileEditorDocument,
    side: TabInsertSide,
  ) => {
    cancelPendingDefinition()
    if (side === 'compare') {
      // source=dragged、target=落点 tab；binary/truncated/loading 的守卫在 onCreateCompare 内统一处理
      await onCreateCompare(dragged, targetEditor.id)
      return
    }
    const insertTargetId = resolveTabInsertTargetId(groupEditors, dragged.id, targetEditor.id, side)
    if (isOpenEditorId(dragged.id)) {
      moveEditorToGroup(dragged.id, groupId, insertTargetId)
      return
    }
    await openDraggedFileInGroup(dragged, groupId, insertTargetId)
  }
  const handleTabStripDrop = async (dragged: FileDocumentHandle, groupId: string, placement: DropPlacement) => {
    cancelPendingDefinition()
    if (placement === 'center') {
      if (isOpenEditorId(dragged.id)) moveEditorToGroup(dragged.id, groupId)
      else await openDraggedFileInGroup(dragged, groupId)
      return
    }
    if (isOpenEditorId(dragged.id)) placeEditorInSplit(dragged.id, placement, groupId)
    else await openDraggedFileAtPlacement(dragged, placement, groupId)
  }
  const stopAutoScroll = () => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current)
      autoScrollFrameRef.current = null
    }
    autoScrollStateRef.current.active = false
    autoScrollStateRef.current.editorId = null
    setAutoScrollIndicator((current) => (current.active ? { ...current, active: false } : current))
  }
  const runAutoScroll = () => {
    if (!autoScrollStateRef.current.active) return
    const editor = autoScrollStateRef.current.editorId ? editorRefs.current[autoScrollStateRef.current.editorId] : null
    if (editor) {
      const horizontalStep = getAutoScrollStep(autoScrollStateRef.current.pointerX - autoScrollStateRef.current.anchorX)
      const verticalStep = getAutoScrollStep(autoScrollStateRef.current.pointerY - autoScrollStateRef.current.anchorY)
      if (horizontalStep) {
        const scrollLeft = Number(editor.getScrollLeft?.() || 0)
        editor.setScrollLeft?.(scrollLeft + horizontalStep)
      }
      if (verticalStep) {
        const scrollTop = Number(editor.getScrollTop?.() || 0)
        editor.setScrollTop?.(scrollTop + verticalStep)
      }
    }
    autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll)
  }
  const startAutoScroll = (editorId: string, clientX: number, clientY: number) => {
    const viewport = editorViewportRefs.current[editorId]
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    autoScrollStateRef.current.active = true
    autoScrollStateRef.current.editorId = editorId
    autoScrollStateRef.current.anchorX = clientX
    autoScrollStateRef.current.anchorY = clientY
    autoScrollStateRef.current.pointerX = clientX
    autoScrollStateRef.current.pointerY = clientY
    setAutoScrollIndicator({ active: true, x: clientX - rect.left, y: clientY - rect.top })
    autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll)
  }
  const handleEditorMouseDown = (editorId: string, event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    if (autoScrollStateRef.current.active) {
      stopAutoScroll()
      return
    }
    startAutoScroll(editorId, event.clientX, event.clientY)
  }
  useEffect(() => {
    if (!autoScrollIndicator.active) return
    const handlePointerMove = (event: PointerEvent) => {
      autoScrollStateRef.current.pointerX = event.clientX
      autoScrollStateRef.current.pointerY = event.clientY
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 1) stopAutoScroll()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopAutoScroll()
    }
    const handleVisibilityChange = () => {
      if (document.hidden) stopAutoScroll()
    }
    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('blur', stopAutoScroll)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('blur', stopAutoScroll)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [autoScrollIndicator.active])
  useEffect(() => () => stopAutoScroll(), [])
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const previewResize = previewResizeRef.current
      if (previewResize?.active && previewResize.container) {
        const rect = previewResize.container.getBoundingClientRect()
        if (rect.width > 0) setPreviewSplitRatio(Math.min(0.8, Math.max(0.2, (event.clientX - rect.left) / rect.width)))
        return
      }
      const resize = splitResizeRef.current
      const container = resize?.container
      if (!resize || !resize.active || !container) return
      const rect = container.getBoundingClientRect()
      if (resize.direction === 'horizontal' && rect.width > 0)
        setEditorSplitRatio(resize.splitId, (event.clientX - rect.left) / rect.width)
      if (resize.direction === 'vertical' && rect.height > 0)
        setEditorSplitRatio(resize.splitId, (event.clientY - rect.top) / rect.height)
    }
    const handlePointerUp = () => {
      if (splitResizeRef.current?.active || previewResizeRef.current?.active)
        emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
      splitResizeRef.current = null
      previewResizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
    // 窗口失焦 pointerup/cancel 可能不送达：blur 统一结算
    window.addEventListener('blur', handlePointerUp)
    return () => {
      // effect 重跑/卸载兜底补 end，否则 burst 抑制永久卡住
      if (splitResizeRef.current?.active || previewResizeRef.current?.active)
        emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      window.removeEventListener('blur', handlePointerUp)
    }
  }, [setEditorSplitRatio])
  useEffect(() => {
    stopAutoScroll()
    setDropTarget(null)
    setPaneDropTarget(null)
    setTabDropTarget(null)
    setTabInsertionTarget(null)
  }, [activeEditor?.id])
  useEffect(() => {
    if (!activeHostId) return
    ensureGitHostState(activeHostId)
  }, [activeHostId, ensureGitHostState])
  useEffect(() => {
    if (!activeHostId || gitMode !== 'follow-editor' || gitDiff) return
    if (!activeEditor?.absolutePath) return
    const repoPath = detectResult?.isGitRepo ? detectResult.rootPath || activeEditor.absolutePath : null
    setGitFollowEditorRepo(activeHostId, repoPath, activeEditor.absolutePath)
  }, [
    activeEditor?.absolutePath,
    activeHostId,
    detectResult?.isGitRepo,
    detectResult?.rootPath,
    gitDiff,
    gitMode,
    setGitFollowEditorRepo,
  ])
  // 隐藏/未布局实例上 reveal/setScrollTop 会静默落空（position 已对但 scroll 不动——
  // openFileInEditor 先 dispatch location 再异步取内容，loading 门恰在此窗内）。
  // 按帧校验视口真实生效、未生效重试；实例被替换或新落位覆盖时作废旧重试
  // 只读写 ref，无组件状态依赖：稳定化后可作为 applyPendingLocation 的稳定依赖
  const retryViewApply = useCallback(
    (
      editorId: string,
      instance: monacoEditor.IStandaloneCodeEditor,
      settled: () => boolean,
      apply: () => void,
      attempts = 60,
    ) => {
      const tick = (left: number) => {
        // 新 pending 出现即让位——新落位自带重试链，旧链继续会与其互抢视口
        if (left <= 0 || editorRefs.current[editorId] !== instance || pendingLocationRef.current[editorId] || settled())
          return
        apply()
        requestAnimationFrame(() => tick(left - 1))
      }
      // 首检也走帧回调：本 pending 删除在 applyPendingLocation 同步段尾，帧前已完成
      requestAnimationFrame(() => tick(attempts))
    },
    [],
  )
  // 落位应用+校验：行列按当前模型范围钳制，setPosition 后 getPosition 未达目标视为实例将销毁/未就绪，
  // 保留 pending 交给 remount 兜底；落位成功即一次性消费——同一导航的 loading/StrictMode 重挂改由
  // viewStateRef 快照恢复，不再用固定时间窗判定所有权，避免覆盖用户之后手动改的位置
  const applyPendingLocation = useCallback(
    (editorId: string, instance: monacoEditor.IStandaloneCodeEditor | undefined) => {
      const pending = pendingLocationRef.current[editorId]
      if (!pending || !instance) return false
      const model = instance.getModel?.()
      const lineCount = model?.getLineCount?.() ?? 0
      const line = lineCount ? Math.min(pending.line, lineCount) : pending.line
      const maxColumn = model?.getLineMaxColumn?.(line) ?? pending.column
      const column = Math.max(1, Math.min(pending.column, maxColumn))
      instance.setPosition?.({ lineNumber: line, column })
      const restore = pending.viewState
      if (pending.reveal === 'preserve') {
        // 返回/前进：还原历史选区与视口，不强制把目标行拉到屏幕中央
        if (restore?.selection) instance.setSelection?.(restore.selection)
        if (restore) {
          instance.setScrollTop?.(restore.scrollTop ?? 0)
          instance.setScrollLeft?.(restore.scrollLeft ?? 0)
          const targetTop = restore.scrollTop ?? 0
          retryViewApply(
            editorId,
            instance,
            () => Math.abs((instance.getScrollTop?.() ?? 0) - targetTop) <= 2,
            () => instance.setScrollTop?.(targetTop),
          )
        }
      } else {
        instance.revealPositionInCenter?.({ lineNumber: line, column })
        const targetInView = () =>
          (instance.getVisibleRanges?.() || []).some(
            (range) => range.startLineNumber <= line && line <= range.endLineNumber,
          )
        retryViewApply(editorId, instance, targetInView, () =>
          instance.revealPositionInCenter?.({ lineNumber: line, column }),
        )
      }
      instance.focus?.()
      if (instance.getPosition?.()?.lineNumber !== line) return false
      delete pendingLocationRef.current[editorId]
      const snapshot = viewStateRef.current[editorId]
      if (snapshot) {
        snapshot.position = { line, column }
        if (pending.reveal === 'preserve' && restore) {
          snapshot.selection = restore.selection ?? null
          snapshot.scrollTop = restore.scrollTop ?? snapshot.scrollTop
          snapshot.scrollLeft = restore.scrollLeft ?? snapshot.scrollLeft
        }
      }
      return true
    },
    [retryViewApply],
  )
  // remount 兜底：无新落位请求时把用户最后的光标/选区/视口恢复到新实例上
  const restoreViewSnapshot = (editorId: string, instance: monacoEditor.IStandaloneCodeEditor | undefined) => {
    const snapshot = viewStateRef.current[editorId]
    if (!snapshot || !instance) return
    const model = instance.getModel?.()
    const lineCount = model?.getLineCount?.() ?? 0
    const position = snapshot.position
    if (position) {
      const line = lineCount ? Math.min(position.line, lineCount) : position.line
      const maxColumn = model?.getLineMaxColumn?.(line) ?? position.column
      instance.setPosition?.({ lineNumber: line, column: Math.min(position.column, maxColumn) })
    }
    if (snapshot.selection) instance.setSelection?.(snapshot.selection)
    // 目标值先取副本：setScrollTop 会同步触发 onDidScrollChange 把当前 scrollLeft(0) 写回快照，
    // 若恢复时仍读 snapshot.scrollLeft 会拿到被覆盖的 0，横向位置永远还原不了
    const targetTop = snapshot.scrollTop
    const targetLeft = snapshot.scrollLeft
    instance.setScrollTop?.(targetTop)
    instance.setScrollLeft?.(targetLeft)
    // 首帧布局未完成时 scrollHeight/scrollWidth 尚未撑开，setScrollTop/setScrollLeft 会被钳回 0：
    // 两个轴向都进校验，按帧补到真实生效
    retryViewApply(
      editorId,
      instance,
      () =>
        Math.abs((instance.getScrollTop?.() ?? 0) - targetTop) <= 2 &&
        Math.abs((instance.getScrollLeft?.() ?? 0) - targetLeft) <= 2,
      () => {
        instance.setScrollTop?.(targetTop)
        instance.setScrollLeft?.(targetLeft)
      },
    )
  }
  useEffect(() => {
    const handleOpenEditorLocation = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          editorId?: string
          line?: number
          column?: number
          restore?: EditorLocationRestore
        }>
      ).detail
      const editorId = detail?.editorId
      const line = Number(detail?.line)
      const column = Number(detail?.column) || 1
      if (!editorId || !Number.isFinite(line) || line < 1) return
      // 显式打开/跳转优先：任何 location 事件都使在途定义搜索的迟到结果失效
      cancelPendingDefinition()
      pendingLocationRef.current[editorId] = {
        line,
        column: Math.max(1, column),
        reveal: detail?.restore ? 'preserve' : 'center',
        viewState: detail?.restore || undefined,
      }
      setActiveEditor(editorId)
      requestAnimationFrame(() => {
        applyPendingLocation(editorId, editorRefs.current[editorId])
      })
    }
    window.addEventListener(OPEN_EDITOR_LOCATION_EVENT, handleOpenEditorLocation as EventListener)
    return () => window.removeEventListener(OPEN_EDITOR_LOCATION_EVENT, handleOpenEditorLocation as EventListener)
  }, [applyPendingLocation, setActiveEditor])
  // 已关闭 tab 的 pending/快照/光标即时作废：定位数据只随打开中的文件存活，重开同一文件不被陈旧落位劫持
  useEffect(() => {
    for (const id of Object.keys(pendingLocationRef.current))
      if (!openEditors.some((item) => item.id === id)) delete pendingLocationRef.current[id]
    for (const id of Object.keys(viewStateRef.current))
      if (!openEditors.some((item) => item.id === id)) delete viewStateRef.current[id]
    pruneEditorCursors((id) => openEditors.some((item) => item.id === id))
  }, [openEditors])
  const renderTab = (editor: FileEditorDocument, groupEditors: FileEditorDocument[], groupId: string) => (
    <div
      key={editor.id}
      className={`tmuxgo-editor-tab group relative flex min-w-[7.5rem] max-w-[15rem] shrink-0 items-center ${editor.id === activeEditor?.id ? 'tmuxgo-editor-tab--active' : ''}`}
    >
      <button
        draggable={editor.kind !== 'compare'}
        onDragStart={(event) => {
          if (editor.kind === 'compare') return
          const handle = {
            id: editor.id,
            hostId: editor.hostId,
            rootId: editor.rootId,
            rootLabel: editor.rootLabel,
            rootPath: editor.rootPath,
            path: editor.path,
            name: editor.name,
            absolutePath: editor.absolutePath,
            type: 'file',
          } satisfies FileDocumentHandle
          setActiveDraggedFile(handle)
          // copyMove：编辑区内仍可 move 换位/分屏，同时允许终端的 copy 落点粘贴路径
          event.dataTransfer.effectAllowed = 'copyMove'
          event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(handle))
        }}
        onDragEnd={() => {
          clearActiveDraggedFile()
          setTabDropTarget(null)
          setTabInsertionTarget(null)
          setPaneDropTarget(null)
          setDropTarget(null)
        }}
        onDragOver={(event) => {
          if (!hasDraggedFile(event) || editor.kind === 'compare') return
          const dragged = decodeDraggedFile(event)
          if (dragged && dragged.id === editor.id) return
          const side = getTabInsertSide(
            (event.currentTarget as HTMLButtonElement).getBoundingClientRect(),
            event.clientX,
          )
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = getDragDropEffect(dragged, event.dataTransfer.effectAllowed)
          setPaneDropTarget(null)
          setTabDropTarget(null)
          setTabInsertionTarget({ groupId, editorId: editor.id, side })
        }}
        onDragLeave={(event) => {
          if (!(event.currentTarget as HTMLButtonElement).contains(event.relatedTarget as Node | null))
            setTabInsertionTarget((current) =>
              current?.editorId === editor.id && current.groupId === groupId ? null : current,
            )
        }}
        onDrop={(event) => {
          const dragged = decodeDraggedFile(event)
          if (!dragged || dragged.id === editor.id || editor.kind === 'compare') return
          const side = getTabInsertSide(
            (event.currentTarget as HTMLButtonElement).getBoundingClientRect(),
            event.clientX,
          )
          event.preventDefault()
          event.stopPropagation()
          clearActiveDraggedFile()
          setTabInsertionTarget(null)
          void handleTabButtonDrop(dragged, groupEditors, groupId, editor, side)
        }}
        onClick={() => {
          cancelPendingDefinition()
          setActiveEditor(editor.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          cancelPendingDefinition()
          setActiveEditor(editor.id)
          setTabMenu({ x: event.clientX, y: event.clientY, editorId: editor.id })
        }}
        className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 text-meta ${editor.id === activeEditor?.id ? 'text-text-1' : 'text-text-2 hover:text-text-1'}`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${editor.dirty ? 'bg-warn' : editor.saving ? 'bg-accent' : 'border border-[var(--line)] bg-transparent'}`}
        />
        <span className={`min-w-0 flex-1 truncate ${editor.preview && !editor.dirty ? 'italic' : ''}`}>
          {editor.name}
        </span>
      </button>
      <Chip
        aria-label={`Close ${editor.name}`}
        className="mr-1.5 shrink-0 opacity-0 group-hover:opacity-100"
        onClick={() => {
          cancelPendingDefinition()
          if (editor.dirty) {
            setPendingCloseEditorId(editor.id)
            return
          }
          closeEditor(editor.id)
        }}
      >
        ×
      </Chip>
      {tabInsertionTarget?.groupId === groupId &&
        tabInsertionTarget.editorId === editor.id &&
        (tabInsertionTarget.side === 'compare' ? (
          // 中段落区：整 tab 底色高亮（对比是"合并两个 tab"的语义，边线表达不出来）
          <span
            data-testid={`tab-compare-target-${editor.id}`}
            className="pointer-events-none absolute inset-0 z-20 rounded-[3px] bg-accent/20 ring-1 ring-inset ring-accent/60"
          />
        ) : (
          <span
            className={`pointer-events-none absolute inset-y-1 z-20 w-[2px] rounded-full bg-accent shadow-[0_0_0_1px_rgba(30,200,255,0.2)] ${tabInsertionTarget.side === 'before' ? 'left-0' : 'right-0'}`}
          />
        ))}
    </div>
  )
  // VSCode 式落点提示：只高亮实际落点区域（分屏半区/整组），不再平铺全部候选区
  const renderDropOverlay = (placement: DropPlacement) => {
    const zoneClass =
      placement === 'left'
        ? 'inset-y-0 left-0 right-1/2'
        : placement === 'right'
          ? 'inset-y-0 right-0 left-1/2'
          : placement === 'top'
            ? 'inset-x-0 top-0 bottom-1/2'
            : placement === 'bottom'
              ? 'inset-x-0 bottom-0 top-1/2'
              : 'inset-0'
    return (
      <div className="pointer-events-none absolute inset-0 z-20">
        <div className={`absolute rounded-apple border-2 border-accent/60 bg-accent/15 ${zoneClass}`} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-full border border-accent/50 bg-bg-0/90 px-4 py-1.5 text-xs tracking-[0.12em] text-accent shadow-lg">
            {t(`editor.drop.${placement}` as never)}
          </div>
        </div>
      </div>
    )
  }
  const renderTabStrip = (editors: FileEditorDocument[], groupId: string) => (
    <div
      ref={bindHorizontalWheelScroll}
      data-testid={`editor-group-${getLegacyGroupName(groupId)}`}
      data-editor-group-id={groupId}
      className={`tmuxgo-scrollbar-subtle relative flex min-h-[30px] items-stretch overflow-x-auto border-b border-[var(--line)] bg-bg-1 ${tabDropTarget?.groupId === groupId ? 'ring-1 ring-accent/40 ring-inset' : ''}`}
      onDragOver={(event) => {
        if (!hasDraggedFile(event)) return
        const dragged = decodeDraggedFile(event)
        event.preventDefault()
        event.dataTransfer.dropEffect = getDragDropEffect(dragged, event.dataTransfer.effectAllowed)
        setPaneDropTarget(null)
        setTabInsertionTarget(null)
        setTabDropTarget({
          groupId,
          placement: getDropPlacement(
            (event.currentTarget as HTMLDivElement).getBoundingClientRect(),
            event.clientX,
            event.clientY,
          ),
        })
      }}
      onDragLeave={(event) => {
        if (!(event.currentTarget as HTMLDivElement).contains(event.relatedTarget as Node | null)) {
          setTabDropTarget((current) => (current?.groupId === groupId ? null : current))
          setTabInsertionTarget((current) => (current?.groupId === groupId ? null : current))
        }
      }}
      onDrop={(event) => {
        const dragged = decodeDraggedFile(event)
        if (!dragged) return
        event.preventDefault()
        event.stopPropagation()
        clearActiveDraggedFile()
        const placement = getDropPlacement(
          (event.currentTarget as HTMLDivElement).getBoundingClientRect(),
          event.clientX,
          event.clientY,
        )
        setTabDropTarget(null)
        setTabInsertionTarget(null)
        void handleTabStripDrop(dragged, groupId, placement)
      }}
    >
      {tabDropTarget?.groupId === groupId && renderDropOverlay(tabDropTarget.placement)}
      {editors.map((editor) => renderTab(editor, editors, groupId))}
    </div>
  )
  const baseMonacoOptions = useMemo(
    () => ({
      automaticLayout: true as const,
      minimap: { enabled: viewPrefs.minimap, renderCharacters: false, maxColumn: 90, scale: 1 },
      fontFamily: preferences.fontFamily,
      fontSize: Math.max(12, Math.round(preferences.fontSize * viewPrefs.fontScale)),
      lineNumbers: viewPrefs.lineNumbers ? ('on' as const) : ('off' as const),
      lineNumbersMinChars: 2,
      lineDecorationsWidth: 0,
      glyphMargin: false,
      folding: true,
      guides: { indentation: true as const, bracketPairs: true },
      bracketPairColorization: { enabled: true },
      matchBrackets: 'always' as const,
      renderLineHighlight: 'line' as const,
      renderValidationDecorations: 'on' as const,
      occurrencesHighlight: 'singleFile' as const,
      selectionHighlight: true,
      codeLens: false,
      contextmenu: true,
      links: true,
      // 编辑器内 Ctrl+滚轮缩放由我们的 fontScale 接管，避免两套缩放互相覆盖
      mouseWheelZoom: false,
      cursorSmoothCaretAnimation: 'on' as const,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: viewPrefs.stickyScroll, maxLineCount: 3, defaultModel: 'outlineModel' as const },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        alwaysConsumeMouseWheel: false,
        useShadows: false,
        verticalHasArrows: false,
        horizontalHasArrows: false,
      },
      overviewRulerBorder: false,
      wordWrap: viewPrefs.wordWrap ? ('on' as const) : ('off' as const),
      wordWrapColumn: 120,
      wrappingIndent: 'same' as const,
      detectIndentation: true,
      formatOnPaste: true,
      formatOnType: true,
      trimAutoWhitespace: true,
      renderWhitespace: (viewPrefs.renderWhitespace === 'none' ? 'none' : viewPrefs.renderWhitespace) as
        'none' | 'boundary' | 'all',
      renderControlCharacters: false,
      smoothScrolling: true,
      cursorBlinking: preferences.cursorBlink ? ('blink' as const) : ('solid' as const),
      cursorStyle: 'line' as const,
      dragAndDrop: false,
      dropIntoEditor: { enabled: false },
      readOnlyMessage: { value: t('editor.readOnly') },
      padding: { top: 16, bottom: 16 },
    }),
    [
      preferences.fontFamily,
      preferences.fontSize,
      preferences.cursorBlink,
      viewPrefs.fontScale,
      viewPrefs.lineNumbers,
      viewPrefs.minimap,
      viewPrefs.renderWhitespace,
      viewPrefs.stickyScroll,
      viewPrefs.wordWrap,
      t,
    ],
  )
  // 按语言缓存完整 options：Monaco 的 options 是引用比较，每次渲染新建对象会导致每键一次 updateOptions
  const optionsCacheRef = useRef<{
    base: typeof baseMonacoOptions | null
    byLanguage: Map<string, typeof baseMonacoOptions & { tabSize: number; insertSpaces: boolean }>
  }>({ base: null, byLanguage: new Map() })
  const optionsForEditor = (target: FileEditorDocument) => {
    const cache = optionsCacheRef.current
    if (cache.base !== baseMonacoOptions) optionsCacheRef.current = { base: baseMonacoOptions, byLanguage: new Map() }
    const override = indentOverride[target.id]
    const tabSize = override?.tabSize ?? getTabSize(target.language)
    const insertSpaces = override?.insertSpaces ?? target.language !== 'go'
    // key 带上缩进：手改缩进后要重建 options，同一语言的不同文件也能各自生效
    const key = `${target.language}:${tabSize}:${insertSpaces}`
    const map = optionsCacheRef.current.byLanguage
    let options = map.get(key)
    if (!options) {
      options = { ...baseMonacoOptions, tabSize, insertSpaces }
      map.set(key, options)
    }
    return options
  }
  // 工具栏「⋯」：把不常用但必须能被发现的能力收进来（命令面板里同样能搜到）
  const buildToolbarMenuActions = (): EditorMenuAction[] => {
    const command = (
      id: EditorCommandId,
      label: string,
      extra?: { separatorBefore?: boolean; disabled?: boolean },
    ): EditorMenuAction => ({
      id,
      label,
      shortcut: shortcutLabel(id),
      disabled: extra?.disabled,
      separatorBefore: extra?.separatorBefore,
      onSelect: () => runEditorCommand(id),
    })
    return [
      command('goto-line', t('editor.cmd.gotoLine')),
      command('goto-symbol', t('editor.cmd.gotoSymbol')),
      command('goto-definition', t('editor.cmd.gotoDefinition'), { disabled: !activeEditor || !!gitDiff }),
      command('save-all', t('editor.cmd.saveAll'), { separatorBefore: true }),
      command('reopen-closed', t('editor.cmd.reopenClosed')),
      command('format-document', t('editor.cmd.formatDocument'), {
        separatorBefore: true,
        disabled: !activeEditor || !!gitDiff,
      }),
      command('replace', t('editor.cmd.replace')),
      command('toggle-word-wrap', t('editor.cmd.toggleWordWrap'), { separatorBefore: true }),
      command('toggle-minimap', t('editor.cmd.toggleMinimap')),
      command('toggle-sticky-scroll', t('editor.cmd.toggleStickyScroll')),
      command('toggle-breadcrumbs', t('editor.cmd.toggleBreadcrumbs')),
      command('toggle-status-bar', t('editor.cmd.toggleStatusBar')),
      command('toggle-auto-save', t('editor.cmd.toggleAutoSave')),
      command('split-down', t('editor.cmd.splitDown'), { separatorBefore: true }),
      command('show-shortcuts', t('editor.cmd.showShortcuts'), { separatorBefore: true }),
    ]
  }
  // 状态栏展示口径：用户手改优先，其次防抖探测结果，最后是按语言推断的默认缩进
  const displayedEol = (target: FileEditorDocument): EditorEol =>
    eolOverride[target.id] ?? (statsInput?.id === target.id && detectedStats ? detectedStats.eol.eol : '\n')
  const displayedEolMixed = (target: FileEditorDocument) =>
    !eolOverride[target.id] && statsInput?.id === target.id && detectedStats ? detectedStats.eol.mixed : false
  const displayedIndent = (target: FileEditorDocument): EditorIndentInfo =>
    indentOverride[target.id] ??
    (statsInput?.id === target.id && detectedStats
      ? detectedStats.indent
      : { tabSize: getTabSize(target.language), insertSpaces: target.language !== 'go' })
  const directorySegments = (path: string) => path.split('/').slice(0, -1).filter(Boolean)
  const isMac = isApplePlatform()
  const shortcutLabel = (commandId: EditorCommandId) =>
    formatKeybinding(EDITOR_COMMANDS_BY_ID.get(commandId)?.keybinding, isMac)
  const buildTabMenuActions = (editorId: string): EditorMenuAction[] => {
    const target = editorById.get(editorId)
    const ids = orderedEditorIds()
    const relative = target ? relativePathOf(target) : null
    const revealInFiles = () => useConsoleStore.getState().setFilePanelOpen(true)
    return [
      {
        id: 'keep-open',
        label: t('editor.menu.keepOpen'),
        disabled: !target?.preview,
        onSelect: () => pinEditor(editorId),
      },
      {
        id: 'copy-path',
        label: t('editor.menu.copyPath'),
        onSelect: () => target && void copyToClipboard(target.absolutePath),
      },
      {
        id: 'copy-relative',
        label: t('editor.menu.copyRelativePath'),
        disabled: !relative,
        onSelect: () => relative && void copyToClipboard(relative),
      },
      { id: 'reveal', label: t('editor.menu.revealInFiles'), onSelect: revealInFiles },
      {
        id: 'split-right',
        label: t('editor.menu.splitRight'),
        shortcut: shortcutLabel('split-right'),
        separatorBefore: true,
        onSelect: () => {
          setActiveEditor(editorId)
          runEditorCommand('split-right')
        },
      },
      {
        id: 'split-down',
        label: t('editor.menu.splitDown'),
        onSelect: () => {
          setActiveEditor(editorId)
          runEditorCommand('split-down')
        },
      },
      {
        id: 'close',
        label: t('editor.menu.close'),
        shortcut: shortcutLabel('close'),
        separatorBefore: true,
        onSelect: () => {
          const doc = editorById.get(editorId)
          if (doc?.dirty) setPendingCloseEditorId(editorId)
          else closeEditorsSafely([editorId])
        },
      },
      {
        id: 'close-others',
        label: t('editor.menu.closeOthers'),
        shortcut: shortcutLabel('close-others'),
        onSelect: () => closeEditorsSafely(idsToCloseOthers(ids, editorId)),
      },
      {
        id: 'close-right',
        label: t('editor.menu.closeToRight'),
        disabled: idsToCloseToRight(ids, editorId).length === 0,
        onSelect: () => closeEditorsSafely(idsToCloseToRight(ids, editorId)),
      },
      {
        id: 'close-saved',
        label: t('editor.menu.closeSaved'),
        onSelect: () =>
          closeEditorsSafely(
            idsToCloseSaved(
              openEditors.map((item) => item.id),
              (id) => !!editorById.get(id)?.dirty,
            ),
          ),
      },
      {
        id: 'close-all',
        label: t('editor.menu.closeAll'),
        shortcut: shortcutLabel('close-all'),
        danger: true,
        onSelect: () => closeEditorsSafely(openEditors.map((item) => item.id)),
      },
    ]
  }
  const renderPane = (groupId: string) => {
    const groupEditors = getGroupEditors(groupId)
    const editor = getGroupActiveEditor(groupId)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {renderTabStrip(groupEditors, groupId)}
        {editor && viewPrefs.breadcrumbs && editor.id === activeEditor?.id && (
          <EditorBreadcrumbs
            editorId={editor.id}
            rootLabel={editor.rootLabel}
            directories={directorySegments(editor.path)}
            fileName={editor.name}
            symbols={outline}
            onOpenSymbolPicker={() => setQuickPickMode('symbol')}
            onRevealDirectory={() => useConsoleStore.getState().setFilePanelOpen(true)}
            onJumpToSymbol={(symbol) => revealPosition(editor.id, symbol.line, symbol.column)}
          />
        )}
        <button
          onClick={(event) => {
            if (!editor) return
            // Ctrl/Cmd+点击本身即定义跳转（Monaco onMouseDown 已启动 resolver），本次 click 不得把它 abort
            if (!event.ctrlKey && !event.metaKey) cancelPendingDefinition()
            setActiveEditor(editor.id)
          }}
          data-testid={`editor-pane-${getLegacyGroupName(groupId)}`}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden text-left"
          onDragOverCapture={(event) => {
            if (!hasDraggedFile(event)) return
            const dragged = decodeDraggedFile(event)
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = getDragDropEffect(dragged, event.dataTransfer.effectAllowed)
            setDropTarget(null)
            setTabDropTarget(null)
            setTabInsertionTarget(null)
            setPaneDropTarget({
              groupId,
              placement: getDropPlacement(
                (event.currentTarget as HTMLButtonElement).getBoundingClientRect(),
                event.clientX,
                event.clientY,
              ),
            })
          }}
          onDragLeave={(event) => {
            if (!(event.currentTarget as HTMLButtonElement).contains(event.relatedTarget as Node | null))
              setPaneDropTarget((current) => (current?.groupId === groupId ? null : current))
          }}
          onDropCapture={(event) => {
            const dragged = decodeDraggedFile(event)
            if (!dragged) return
            event.preventDefault()
            event.stopPropagation()
            clearActiveDraggedFile()
            const placement = getDropPlacement(
              (event.currentTarget as HTMLButtonElement).getBoundingClientRect(),
              event.clientX,
              event.clientY,
            )
            setPaneDropTarget(null)
            void handleGroupDrop(dragged, placement, groupId)
          }}
        >
          {editor ? (
            renderSurface(editor, activeEditor?.id === editor.id, groupId)
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-3">
              {t('editor.drop.center' as never)}
            </div>
          )}
          {/* 单栏时不画整圈强调色描边（像给整个编辑区套了个焦点框）；
              分屏时才需要它回答「哪一栏是激活的」 */}
          {editor && activeEditor?.id === editor.id && editorLayout !== null && isEditorLayoutSplit(editorLayout) && (
            <span className="pointer-events-none absolute inset-0 border border-accent/35" />
          )}
          {paneDropTarget?.groupId === groupId && renderDropOverlay(paneDropTarget.placement)}
        </button>
        {editor && viewPrefs.statusBar && (
          <EditorStatusBar
            editorId={editor.id}
            language={editor.language}
            dirty={editor.dirty}
            readOnly={editor.binary || editor.truncated}
            eol={displayedEol(editor)}
            eolMixed={displayedEolMixed(editor)}
            indent={displayedIndent(editor)}
            chordHint={chord ? formatKeybinding(chord, isMac) : null}
            view={{
              wordWrap: viewPrefs.wordWrap,
              whitespace: viewPrefs.renderWhitespace,
              minimap: viewPrefs.minimap,
              stickyScroll: viewPrefs.stickyScroll,
              autoSave: viewPrefs.autoSave,
              zoomPercent: Math.round(viewPrefs.fontScale * 100),
            }}
            actions={{
              gotoLine: () => setQuickPickMode('goto-line'),
              setIndent: applyIndent,
              toggleEol,
              toggleWordWrap: () => viewPrefs.toggle('wordWrap'),
              cycleWhitespace: viewPrefs.cycleWhitespace,
              toggleMinimap: () => viewPrefs.toggle('minimap'),
              toggleStickyScroll: () => viewPrefs.toggle('stickyScroll'),
              toggleAutoSave: () => runEditorCommand('toggle-auto-save'),
              zoomIn: viewPrefs.zoomIn,
              zoomOut: viewPrefs.zoomOut,
              resetZoom: viewPrefs.zoomReset,
            }}
          />
        )}
      </div>
    )
  }
  const renderLayout = (node: EditorLayoutNode | null): React.ReactNode => {
    if (!node) return null
    if (!isEditorLayoutSplit(node)) return renderPane(node.groupId)
    return (
      <div
        key={node.id}
        data-editor-split={node.direction}
        className={`flex h-full min-h-0 min-w-0 w-full flex-1 ${node.direction === 'horizontal' ? 'flex-row' : 'flex-col'}`}
      >
        <div style={{ flexBasis: `${node.ratio * 100}%` }} className="min-h-0 min-w-0 flex shrink-0 grow-0">
          {renderLayout(node.first)}
        </div>
        <div
          data-testid="editor-split-resizer"
          onPointerDown={(event) => {
            emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
            splitResizeRef.current = {
              active: true,
              direction: node.direction,
              splitId: node.id,
              container: event.currentTarget.parentElement as HTMLDivElement | null,
            }
            document.body.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize'
            document.body.style.userSelect = 'none'
            event.preventDefault()
            event.stopPropagation()
          }}
          className={
            node.direction === 'horizontal'
              ? 'w-1 cursor-col-resize bg-[var(--line)] hover:bg-accent/40'
              : 'h-1 cursor-row-resize bg-[var(--line)] hover:bg-accent/40'
          }
        />
        <div className="min-h-0 min-w-0 flex flex-1">{renderLayout(node.second)}</div>
      </div>
    )
  }
  const renderSurface = (editor: FileEditorDocument, focused: boolean, groupId: string) => {
    const previewMode = isPreviewableLanguage(editor.language) ? (previewModeById[editor.id] ?? 'preview') : 'edit'
    const previewSplit = previewMode === 'split'
    const previewVisible = previewMode !== 'edit'
    const compareLeft = editor.compareLeftId
      ? openEditors.find((item) => item.id === editor.compareLeftId) || null
      : null
    const compareRight = editor.compareRightId
      ? openEditors.find((item) => item.id === editor.compareRightId) || null
      : null
    const diff = editor.id.startsWith('git-diff?') ? parseGitDiffId(editor.id) : null
    if (diff)
      return (
        <DiffViewer
          hostId={diff.hostId}
          repoPath={diff.repoPath}
          filePath={diff.filePath}
          staged={diff.staged}
          commit={diff.commit}
        />
      )
    if (editor.kind === 'compare') {
      return compareLeft && compareRight ? (
        <MonacoDiffEditor
          key={editor.id}
          original={compareLeft.content}
          modified={compareRight.content}
          language={editor.language}
          theme={getMonacoTheme(preferences.theme)}
          beforeMount={(monaco) => {
            monacoRef.current = monaco
            ensureTmuxgoTheme(monaco, preferences.theme)
            disableMonacoDefinitionProvider(monaco)
          }}
          onMount={(diffInstance) => {
            const modified = diffInstance?.getModifiedEditor?.()
            attachEditorWheelScroll(editor.id, diffInstance?.getContainerDomNode?.(), modified)
            diffInstance?.onDidDispose?.(() => releaseEditorWheelScroll(editor.id))
          }}
          options={{
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontFamily: preferences.fontFamily,
            fontSize: Math.max(12, preferences.fontSize),
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            renderOverviewRuler: false,
            lineNumbersMinChars: 2,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-text-3">{t('editor.compareMissing')}</div>
      )
    }
    if (editor.loading)
      return (
        <div className="flex h-full items-center justify-center text-sm text-text-3">
          {t('editor.loading', { name: editor.name })}
        </div>
      )
    if (isImagePreviewable(editor)) {
      return (
        <ZoomSurface
          active={focused}
          resetKey={editor.id}
          image
          className="flex h-full items-center justify-center overflow-hidden bg-bg-0 p-4"
        >
          <img
            src={editor.previewUrl}
            alt={editor.name}
            className="max-h-full max-w-full rounded-apple border border-[var(--line)] bg-bg-1 object-contain select-none"
          />
        </ZoomSurface>
      )
    }
    // PDF/音视频不读文本内容：直接走 /files/raw 内联流（cookie 鉴权），二进制探测不参与
    const mediaKind = previewKindForPath(editor.path)
    if (mediaKind === 'pdf' || mediaKind === 'audio' || mediaKind === 'video') {
      const rawUrl = buildRawUrl(editor.hostId, editor.rootId, editor.path, {
        v: editor.modifiedAt ? String(editor.modifiedAt) : undefined,
      })
      return (
        <div className="flex h-full min-h-0 flex-col bg-bg-0" data-testid={`editor-media-${mediaKind}`}>
          {mediaKind === 'pdf' ? (
            <PdfPreview
              name={editor.name}
              url={rawUrl}
              size={editor.size}
              labels={{
                loading: t('editor.pdfLoading'),
                failed: t('editor.pdfFailed'),
                openNew: t('editor.pdfOpenNew'),
                download: t('editor.pdfDownload'),
                large: t('editor.pdfLarge'),
              }}
            />
          ) : (
            <MediaPreview
              kind={mediaKind}
              name={editor.name}
              url={rawUrl}
              size={editor.size}
              labels={{ failed: t('editor.mediaFailed') }}
            />
          )}
        </div>
      )
    }
    if (editor.problem || editor.binary || editor.truncated)
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-xl rounded-apple border border-[var(--line)] bg-bg-1 p-5">
            <div className="text-sm text-text-1">{editor.name}</div>
            <div className="mt-2 text-sm text-text-3">
              {editor.problem || (editor.binary ? t('editor.binaryNotEditable') : t('editor.largePreviewOnly'))}
            </div>
          </div>
        </div>
      )
    return (
      <div className={`flex h-full min-h-0 ${previewVisible ? 'flex-row' : 'flex-col'}`}>
        <div
          ref={(node) => {
            editorViewportRefs.current[editor.id] = node
          }}
          data-testid={focused ? 'editor-auto-scroll-zone' : undefined}
          onMouseDown={(event) => handleEditorMouseDown(editor.id, event)}
          // 整区预览时保留挂载但隐藏：Monaco 的撤销/光标/滚动状态不丢，切回即原位恢复
          className={`relative ${previewMode === 'preview' ? 'hidden' : previewSplit ? 'min-h-0 min-w-0 shrink-0 grow-0' : 'h-full'}`}
          style={previewSplit ? { flexBasis: `${previewSplitRatio * 100}%` } : undefined}
        >
          <MonacoEditor
            key={editor.id}
            path={editor.absolutePath}
            language={editor.language}
            theme={getMonacoTheme(preferences.theme)}
            beforeMount={(monaco) => {
              monacoRef.current = monaco
              ensureTmuxgoTheme(monaco, preferences.theme)
              disableMonacoDefinitionProvider(monaco)
            }}
            value={editor.content}
            onMount={(instance) => {
              editorRefs.current[editor.id] = instance
              attachEditorWheelScroll(editor.id, instance.getDomNode?.(), instance)
              warmupCodeNavigation()
              const snapshot = (viewStateRef.current[editor.id] ||= {
                position: null,
                selection: null,
                scrollTop: 0,
                scrollLeft: 0,
              })
              const position = instance.getPosition?.()
              // 快照已有位置时不能被新实例的初始 1:1 覆盖，否则 remount 恢复丢掉用户位置
              if (position && !snapshot.position)
                snapshot.position = { line: position.lineNumber, column: position.column }
              const publishCursor = (line: number, column: number) => {
                const selections = instance.getSelections?.() || []
                const primary = selections[0]
                setEditorCursor(editor.id, {
                  line,
                  column,
                  lineCount: instance.getModel?.()?.getLineCount?.() || 0,
                  selections: selections.length || 1,
                  selection:
                    primary && !primary.isEmpty?.()
                      ? computeSelectionStats(
                          {
                            startLineNumber: primary.startLineNumber,
                            startColumn: primary.startColumn,
                            endLineNumber: primary.endLineNumber,
                            endColumn: primary.endColumn,
                          },
                          (lineNumber) => instance.getModel?.()?.getLineContent?.(lineNumber)?.length || 0,
                        )
                      : null,
                })
              }
              if (position) publishCursor(position.lineNumber, position.column)
              instance.onDidChangeCursorPosition?.((event) => {
                snapshot.position = { line: event.position.lineNumber, column: event.position.column }
                snapshot.selection = instance.getSelection?.() || null
                publishCursor(event.position.lineNumber, event.position.column)
                // 预览跟随由上面的 store 订阅统一驱动
              })
              instance.onDidScrollChange?.((event) => {
                snapshot.scrollTop = Number(event?.scrollTop ?? instance.getScrollTop?.() ?? 0)
                snapshot.scrollLeft = Number(event?.scrollLeft ?? instance.getScrollLeft?.() ?? 0)
                handleEditorScrollSync(editor.id)
              })
              // 卸载只清死引用，不读实例补快照：@monaco-editor/react 卸载先 dispose model 再 dispose
              // editor，此处 getScrollTop/getPosition 读到的是死模型值（-1/null），会把 onDidScrollChange
              // 实时维护的快照覆盖成 -1，remount 后被钳回顶部。rAF 落位遇死实例会落空，清掉后走
              // pendingLocation → remount 时 onMount 兜底
              instance.onDidDispose?.(() => {
                releaseEditorWheelScroll(editor.id)
                if (editorRefs.current[editor.id] === instance) delete editorRefs.current[editor.id]
              })
              const pendingPosition = pendingLocationRef.current[editor.id]
              if (pendingPosition) applyPendingLocation(editor.id, instance)
              else {
                restoreViewSnapshot(editor.id, instance)
              }
              instance.onMouseDown?.((event) => {
                const browserEvent = event?.event?.browserEvent
                if (!browserEvent || browserEvent.button !== 0 || (!browserEvent.ctrlKey && !browserEvent.metaKey))
                  return
                const position = event?.target?.position
                if (!position) return
                browserEvent.preventDefault?.()
                browserEvent.stopPropagation?.()
                setActiveEditor(editor.id)
                const currentEditor = openEditorsRef.current.find((item) => item.id === editor.id) || editor
                void goToDefinition(currentEditor, { line: position.lineNumber, column: position.column })
              })
              // find 状态跟随组留存：每次变更（显隐/查询词/开关）都快照，供组内
              // 下一个实例恢复；dispose 时只摘监听，不回写——dispose 途中的状态
              // 若被置灰会覆盖掉刚才的 revealed 快照
              const findController = instance.getContribution?.('editor.contrib.findController') as
                FindControllerLike | null | undefined
              const findReplaceState = findController?.getState?.()
              const findStateListener = findReplaceState?.onFindReplaceStateChange?.(() => {
                findStateByGroupRef.current[groupId] = {
                  revealed: !!findReplaceState.isRevealed,
                  searchString: String(findReplaceState.searchString || ''),
                  isRegex: !!findReplaceState.isRegex,
                  wholeWord: !!findReplaceState.wholeWord,
                  matchCase: !!findReplaceState.matchCase,
                  preserveCase: !!findReplaceState.preserveCase,
                  isReplaceRevealed: !!findReplaceState.isReplaceRevealed,
                }
              })
              instance.onDidDispose?.(() => findStateListener?.dispose?.())
              const savedFind = findStateByGroupRef.current[groupId]
              if (savedFind?.revealed) {
                // 复刻 monaco onDidChangeModel 的重启路径：不从选区播种、不动
                // 光标、不抢焦点——widget 只是"还在"，找下一个仍靠 Enter/F3
                void findController?.start?.(
                  {
                    forceRevealReplace: false,
                    seedSearchStringFromSelection: 'none',
                    seedSearchStringFromNonEmptySelection: false,
                    seedSearchStringFromGlobalClipboard: false,
                    shouldFocus: 0,
                    shouldAnimate: false,
                    updateSearchScope: false,
                    loop: true,
                  },
                  {
                    searchString: savedFind.searchString,
                    isRegex: savedFind.isRegex,
                    wholeWord: savedFind.wholeWord,
                    matchCase: savedFind.matchCase,
                    preserveCase: savedFind.preserveCase,
                    isReplaceRevealed: savedFind.isReplaceRevealed,
                  },
                )
              }
            }}
            onChange={(value) => setEditorContent(editor.id, value || '')}
            options={optionsForEditor(editor)}
          />
          {autoScrollIndicator.active && autoScrollStateRef.current.editorId === editor.id && (
            <span
              data-testid="editor-auto-scroll-indicator"
              className="pointer-events-none absolute z-20 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/70 bg-bg-0/85 shadow-[0_0_0_1px_rgba(30,200,255,0.22)]"
              style={{ left: autoScrollIndicator.x, top: autoScrollIndicator.y }}
            >
              <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-accent/70" />
              <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-accent/70" />
            </span>
          )}
        </div>
        {previewSplit && (
          <div
            data-testid="editor-preview-resizer"
            onPointerDown={(event) => {
              emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
              previewResizeRef.current = {
                active: true,
                container: event.currentTarget.parentElement as HTMLElement,
              }
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
              event.preventDefault()
              event.stopPropagation()
            }}
            className="w-1 shrink-0 cursor-col-resize bg-[var(--line)] hover:bg-accent/40"
          />
        )}
        {previewVisible &&
          (editor.language === 'csv' ? (
            <CsvTable content={editor.content} emptyLabel={t('editor.nothingToPreview')} labels={csvTableLabels(t)} />
          ) : editor.language === 'markdown' ? (
            <ZoomSurface
              active={focused}
              resetKey={editor.id}
              doubleClickZoom={false}
              onScroll={() => handlePreviewScroll(editor.id)}
              className="tmuxgo-scrollbar min-h-0 min-w-0 flex-1 overflow-auto bg-bg-1/60 px-6 py-5"
            >
              <article
                ref={(node) => {
                  previewElRefs.current[editor.id] = node
                }}
                dangerouslySetInnerHTML={{
                  __html:
                    markdownHtml[editor.id] ||
                    renderMarkdown(editor.content) ||
                    `<p>${t('editor.nothingToPreview')}</p>`,
                }}
                className={MARKDOWN_PROSE_CLASS}
                onDoubleClick={jumpPreviewToEditor(editor.id)}
              />
            </ZoomSurface>
          ) : (
            <iframe
              title={editor.name}
              srcDoc={editor.content}
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
              referrerPolicy="no-referrer"
              className="h-full min-h-0 min-w-0 flex-1 border-0 bg-white"
            />
          ))}
      </div>
    )
  }
  // —— 命令层 ——
  // 快捷键、工具栏、tab 右键菜单、命令面板都收敛到 runEditorCommand 一个入口：
  // 键位表在 lib/editor-commands 里单测，这里只做「命令 → 现有能力」的接线
  const notify = (message: string, type: 'success' | 'error' | 'info' = 'info') => pushToast({ type, message })
  const revealPosition = (editorId: string, line: number, column = 1) => {
    const instance = editorRefs.current[editorId]
    if (!instance) return
    instance.revealLineInCenterIfOutsideViewport?.(line)
    instance.setPosition?.({ lineNumber: line, column })
    instance.focus?.()
  }
  const orderedEditorIds = () => orderedGroupIds.flatMap((groupId) => getGroupEditors(groupId).map((item) => item.id))
  const saveAllEditors = async () => {
    const targets = useConsoleStore
      .getState()
      .openEditors.filter(
        (item) =>
          item.dirty &&
          !item.loading &&
          !item.saving &&
          !item.binary &&
          !item.truncated &&
          item.kind !== 'compare' &&
          !item.id.startsWith('git-diff?'),
      )
    if (!targets.length) {
      notify(t('editor.toast.nothingToSave'))
      return
    }
    let failed = 0
    // 串行保存：并行写同一 host 会打满 /files/content 通道，保存态提示也会乱跳
    for (const target of targets) {
      await onSaveEditor(target)
      const latest = useConsoleStore.getState().openEditors.find((item) => item.id === target.id)
      if (latest?.dirty || latest?.saveError) failed += 1
    }
    if (failed) notify(t('editor.toast.saveAllFailed', { count: failed }), 'error')
    else notify(t('editor.toast.savedAll', { count: targets.length }), 'success')
  }
  const closeEditorsSafely = (ids: string[]) => {
    if (!ids.length) return
    const dirty = ids.filter((id) => editorById.get(id)?.dirty)
    const clean = ids.filter((id) => !dirty.includes(id))
    // 关闭前入重开栈（Ctrl+Shift+T 能捞回来）；脏 tab 一律保留，避免静默丢改动
    for (const id of ids) {
      const target = editorById.get(id)
      if (!target || target.kind === 'compare' || id.startsWith('git-diff?')) continue
      const cursor = getEditorCursor(id)
      pushClosedEditor({
        id: target.id,
        hostId: target.hostId,
        rootId: target.rootId,
        rootLabel: target.rootLabel,
        rootPath: target.rootPath,
        path: target.path,
        name: target.name,
        absolutePath: target.absolutePath,
        language: target.language,
        position: cursor ? { line: cursor.line, column: cursor.column } : undefined,
      })
    }
    if (clean.length) closeEditors(clean)
    if (dirty.length) notify(t('editor.toast.dirtyKept', { count: dirty.length }))
    else notify(t('editor.toast.closedEditors', { count: ids.length }))
  }
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(t('editor.toast.copyDone'), 'success')
    } catch {
      notify(t('editor.toast.copyFailed'), 'error')
    }
  }
  const relativePathOf = (target: FileEditorDocument) => {
    const base = (target.rootPath || '').replace(/\/+$/, '')
    if (base && target.absolutePath.startsWith(`${base}/`)) return target.absolutePath.slice(base.length + 1)
    return null
  }
  const reopenLastClosed = () => {
    const entry = takeClosedEditor()
    if (!entry) {
      notify(t('editor.toast.reopenNone'))
      return
    }
    void openFileInEditor(
      {
        id: entry.id,
        hostId: entry.hostId,
        rootId: entry.rootId,
        rootLabel: entry.rootLabel,
        rootPath: entry.rootPath,
        path: entry.path,
        name: entry.name,
        absolutePath: entry.absolutePath,
        type: 'file',
      },
      {
        t,
        pushToast,
        position: entry.position,
        openPanel: false,
        pinned: true,
        onError: (message) => notify(message || t('editor.toast.reopenFailed'), 'error'),
      },
    )
  }
  const applyIndent = (indent: EditorIndentInfo) => {
    if (!activeEditor) return
    // 写进 Monaco model：后续 tab 复用同一 model 时缩进一致，格式化也按它走
    const model = editorRefs.current[activeEditor.id]?.getModel?.()
    model?.updateOptions?.({ tabSize: indent.tabSize, insertSpaces: indent.insertSpaces })
    setIndentOverride((current) => ({ ...current, [activeEditor.id]: indent }))
  }
  const toggleEol = () => {
    if (!activeEditor || activeEditor.loading || activeEditor.binary || activeEditor.truncated) return
    const id = activeEditor.id
    const current = eolOverride[id] ?? detectEol(activeEditor.content).eol
    const next: EditorEol = current === '\n' ? '\r\n' : '\n'
    const converted = convertEol(activeEditor.content, next)
    const instance = editorRefs.current[id]
    const model = instance?.getModel?.()
    if (instance && model) {
      // 走 pushEditOperations 而不是 setEditorContent：整篇替换也能一次 Ctrl+Z 退回
      instance.pushUndoStop?.()
      model.pushEditOperations?.([], [{ range: model.getFullModelRange(), text: converted }], () => null)
      instance.pushUndoStop?.()
    } else setEditorContent(id, converted)
    setEolOverride((value) => ({ ...value, [id]: next }))
  }
  const runMonacoAction = (actionId: string | undefined, fallbackMessage?: string) => {
    if (!activeEditor || !actionId) return false
    const instance = editorRefs.current[activeEditor.id]
    const action = instance?.getAction?.(actionId)
    if (!action) {
      if (fallbackMessage) notify(fallbackMessage)
      return false
    }
    void Promise.resolve(action.run?.()).catch(() => notify(fallbackMessage || t('editor.toast.formatFailed'), 'error'))
    return true
  }
  const runEditorCommand = (id: EditorCommandId) => {
    switch (id) {
      case 'goto-line':
        setQuickPickMode('goto-line')
        return
      case 'goto-symbol':
        // 自研 outline 解析不到（方言/超大文件）时退回 Monaco 原生 symbols 面板
        if (outline.length) setQuickPickMode('symbol')
        else if (!runMonacoAction(MONACO_ACTIONS['quick-outline'])) notify(t('editor.quickpick.noSymbols'))
        return
      case 'goto-definition': {
        if (!activeEditor || gitDiff) return
        const position = getNavigationPosition(activeEditor.id)
        if (position) void goToDefinition(activeEditor, position)
        return
      }
      case 'navigate-back':
        void goBackInNavigation()
        return
      case 'navigate-forward':
        void goForwardInNavigation()
        return
      case 'toggle-word-wrap':
        viewPrefs.toggle('wordWrap')
        return
      case 'toggle-minimap':
        viewPrefs.toggle('minimap')
        return
      case 'toggle-whitespace':
        viewPrefs.cycleWhitespace()
        return
      case 'toggle-sticky-scroll':
        viewPrefs.toggle('stickyScroll')
        return
      case 'toggle-breadcrumbs':
        viewPrefs.toggle('breadcrumbs')
        return
      case 'toggle-status-bar':
        viewPrefs.toggle('statusBar')
        return
      case 'toggle-auto-save': {
        const next = !viewPrefs.autoSave
        viewPrefs.setPref('autoSave', next)
        notify(
          next ? t('editor.toast.autoSaveOn', { delay: viewPrefs.autoSaveDelayMs }) : t('editor.toast.autoSaveOff'),
        )
        return
      }
      case 'format-document':
        if (!runMonacoAction(MONACO_ACTIONS['format-document'], t('editor.toast.formatUnavailable')))
          notify(t('editor.toast.formatUnavailable'))
        return
      case 'find':
        runMonacoAction(MONACO_ACTIONS.find)
        return
      case 'replace':
        runMonacoAction(MONACO_ACTIONS.replace)
        return
      case 'save':
        if (
          activeEditor &&
          !gitDiff &&
          !activeEditor.loading &&
          !activeEditor.saving &&
          !activeEditor.binary &&
          !activeEditor.truncated
        )
          void onSaveEditor(activeEditor)
        return
      case 'save-all':
        void saveAllEditors()
        return
      case 'close':
        if (!activeEditor) return
        cancelPendingDefinition()
        if (activeEditor.dirty) setPendingCloseEditorId(activeEditor.id)
        else closeEditorsSafely([activeEditor.id])
        return
      case 'close-all': {
        const ids = editorById.get(activeEditor?.id || '') ? getGroupEditors(activeEditorGroupId || '') : []
        closeEditorsSafely((ids.length ? ids : openEditors).map((item) => item.id))
        return
      }
      case 'reopen-closed':
        reopenLastClosed()
        return
      case 'split-right':
      case 'split-down': {
        if (!activeEditor) return
        if (orderedGroupIds.length >= 4) {
          notify(t('editor.toast.groupLimit', { count: 4 }))
          return
        }
        placeEditorInSplit(activeEditor.id, id === 'split-right' ? 'right' : 'bottom')
        return
      }
      case 'zoom-in':
        viewPrefs.zoomIn()
        return
      case 'zoom-out':
        viewPrefs.zoomOut()
        return
      case 'zoom-reset':
        viewPrefs.zoomReset()
        return
      case 'select-next-occurrence':
        runMonacoAction(MONACO_ACTIONS['select-next-occurrence'])
        return
      case 'select-all-occurrences':
        runMonacoAction(MONACO_ACTIONS['select-all-occurrences'])
        return
      case 'add-cursor-above':
        runMonacoAction(MONACO_ACTIONS['add-cursor-above'])
        return
      case 'add-cursor-below':
        runMonacoAction(MONACO_ACTIONS['add-cursor-below'])
        return
      case 'next-editor':
      case 'previous-editor': {
        const ids = orderedEditorIds()
        if (!activeEditor || ids.length < 2) return
        const index = ids.indexOf(activeEditor.id)
        const next = ids[(index + (id === 'next-editor' ? 1 : -1) + ids.length) % ids.length]
        if (next) setActiveEditor(next)
        return
      }
      case 'copy-path':
        if (activeEditor) void copyToClipboard(activeEditor.absolutePath)
        return
      case 'copy-relative-path': {
        if (!activeEditor) return
        const relative = relativePathOf(activeEditor)
        if (relative) void copyToClipboard(relative)
        else notify(t('editor.toast.noRelativePath'))
        return
      }
      case 'reveal-in-files':
        useConsoleStore.getState().setFilePanelOpen(true)
        return
      case 'keep-open':
        if (activeEditor) pinEditor(activeEditor.id)
        return
      case 'close-others':
        if (activeEditor) closeEditorsSafely(idsToCloseOthers(orderedEditorIds(), activeEditor.id))
        return
      case 'close-to-right':
        if (activeEditor) closeEditorsSafely(idsToCloseToRight(orderedEditorIds(), activeEditor.id))
        return
      case 'close-saved':
        closeEditorsSafely(
          idsToCloseSaved(
            openEditors.map((item) => item.id),
            (editorId) => !!editorById.get(editorId)?.dirty,
          ),
        )
        return
      case 'show-shortcuts':
        setShortcutsOpen(true)
        return
      default:
        return
    }
  }
  const commandRef = useRef(runEditorCommand)
  commandRef.current = runEditorCommand
  // 命令面板通过总线投递命令：面板是兄弟组件，拿不到这里的闭包
  useEffect(() => registerEditorCommandHandler((command) => commandRef.current(command)), [])
  const chordRef = useRef<EditorChord | null>(null)
  chordRef.current = chord
  const clearChord = () => {
    if (chordTimerRef.current) window.clearTimeout(chordTimerRef.current)
    chordTimerRef.current = null
    if (chordRef.current) setChord(null)
  }
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-terminal],.xterm,.xterm-screen')) return
      // 浮层自己处理 Esc/Enter/↑↓：开着时全局键位让路，避免 Enter 同时触发跳转和原生命令
      if (quickPickMode || shortcutsOpen || tabMenu) return
      const resolution = resolveEditorKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        },
        chordRef.current,
      )
      if (!resolution) {
        if (chordRef.current) clearChord()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (resolution.type === 'chord') {
        setChord(resolution.chord)
        if (chordTimerRef.current) window.clearTimeout(chordTimerRef.current)
        chordTimerRef.current = window.setTimeout(() => clearChord(), CHORD_TIMEOUT_MS)
        return
      }
      clearChord()
      if (resolution.type === 'focus-group') {
        const groupId = orderedGroupIds[resolution.index]
        const focusTarget = groupId ? getGroupActiveEditor(groupId) : null
        if (focusTarget) setActiveEditor(focusTarget.id)
        return
      }
      commandRef.current(resolution.id)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
    // 只依赖「是否开着浮层」：命令、分组、编辑器都由 ref 读最新值，避免每次输入重挂监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPickMode, shortcutsOpen, tabMenu])
  const closeAllEditors = () => {
    cancelPendingDefinition()
    for (const editor of [...openEditors]) closeEditor(editor.id)
  }
  if (!activeEditor) return null
  return (
    <section data-editor-drop className="relative flex h-full min-h-0 flex-col bg-bg-0">
      <div className="tmuxgo-editor-head flex items-center justify-between gap-3 border-b border-[var(--line)] px-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] leading-4 text-text-3" title={activeEditor.absolutePath}>
            {activeEditor.absolutePath}
          </div>
        </div>
        <div className="tmuxgo-editor-tools flex shrink-0 items-center gap-0.5">
          {!gitDiff && (
            <>
              <Button
                size="icon-sm"
                aria-label={t('editor.back')}
                title={t('editor.back')}
                disabled={!navigationBackRef.current.length}
                onClick={() => void goBackInNavigation()}
              >
                <FiArrowLeft aria-hidden="true" size={14} />
              </Button>
              <Button
                size="icon-sm"
                aria-label={t('editor.forward')}
                title={t('editor.forward')}
                disabled={!navigationForwardRef.current.length}
                onClick={() => void goForwardInNavigation()}
              >
                <FiArrowRight aria-hidden="true" size={14} />
              </Button>
              <Button size="sm" onClick={closeAllEditors}>
                {t('editor.clear')}
              </Button>
              <Button
                size="sm"
                onClick={() => void editorRefs.current[activeEditor.id]?.getAction?.('actions.find')?.run?.()}
              >
                {t('editor.find')}
              </Button>
              <Button
                size="icon-sm"
                aria-label={t('editor.definition')}
                title={t('editor.definition')}
                disabled={
                  activeEditor.loading ||
                  activeEditor.binary ||
                  activeEditor.truncated ||
                  activeEditor.kind === 'compare'
                }
                onClick={() => {
                  const position = getNavigationPosition(activeEditor.id)
                  if (position) void goToDefinition(activeEditor, position)
                }}
              >
                <FiCode aria-hidden="true" size={14} />
              </Button>
              {isPreviewableLanguage(activeEditor.language) && (
                <>
                  <Button
                    size="sm"
                    variant={activePreviewMode !== 'edit' ? 'accent' : 'default'}
                    onClick={() =>
                      setPreviewModeById((current) => ({
                        ...current,
                        [activeEditor.id]: activePreviewMode === 'edit' ? 'preview' : 'edit',
                      }))
                    }
                  >
                    {t('editor.preview')}
                  </Button>
                  <Button
                    size="sm"
                    variant={activePreviewMode === 'split' ? 'accent' : 'default'}
                    onClick={() =>
                      setPreviewModeById((current) => ({
                        ...current,
                        [activeEditor.id]: activePreviewMode === 'split' ? 'preview' : 'split',
                      }))
                    }
                  >
                    {t('editor.splitPreview')}
                  </Button>
                  {activeEditor.language === 'markdown' && activePreviewMode === 'split' && (
                    <Button
                      size="sm"
                      variant={previewSyncEnabled ? 'accent' : 'default'}
                      onClick={() => setPreviewSyncEnabled((current) => !current)}
                    >
                      {t('editor.syncPreview')}
                    </Button>
                  )}
                </>
              )}
              <Button
                size="sm"
                disabled={
                  activeEditor.loading ||
                  activeEditor.saving ||
                  activeEditor.binary ||
                  activeEditor.truncated ||
                  !activeEditor.dirty
                }
                variant={
                  activeEditor.loading ||
                  activeEditor.saving ||
                  activeEditor.binary ||
                  activeEditor.truncated ||
                  !activeEditor.dirty
                    ? 'default'
                    : 'accent'
                }
                onClick={() => void onSaveEditor(activeEditor)}
              >
                {activeEditor.saving ? t('editor.saving') : activeEditor.dirty ? t('editor.save') : t('editor.saved')}
              </Button>
            </>
          )}
          <Button
            size="icon-sm"
            aria-label={t('editor.cmd.showShortcuts')}
            title={`${t('editor.cmd.showShortcuts')} (Ctrl+K Ctrl+S)`}
            data-testid="editor-more-actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setToolbarMenu({ x: rect.right - 232, y: rect.bottom + 4 })
            }}
          >
            <FiMoreHorizontal aria-hidden="true" size={14} />
          </Button>
        </div>
      </div>
      {activeEditor?.saveError && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-danger/10 px-3 py-1.5 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate">
            {t('editor.saveFailedKept')} · {activeEditor.saveError}
          </span>
          <button
            className="shrink-0 text-accent hover:underline disabled:opacity-40"
            disabled={activeEditor.saving}
            onClick={() => void onSaveEditor(activeEditor)}
          >
            {t('common.retry')}
          </button>
          <button
            aria-label={t('common.close')}
            className="shrink-0 text-text-3 hover:text-text-1"
            onClick={() => setEditorSaveError(activeEditor.id, undefined)}
          >
            ×
          </button>
        </div>
      )}
      <div
        className="relative min-h-0 flex-1 bg-bg-0"
        onDragOver={(event) => {
          if (!hasDraggedFile(event)) return
          const dragged = decodeDraggedFile(event)
          event.preventDefault()
          event.dataTransfer.dropEffect = getDragDropEffect(dragged, event.dataTransfer.effectAllowed)
          setPaneDropTarget(null)
          setDropTarget(
            getDropPlacement(
              (event.currentTarget as HTMLDivElement).getBoundingClientRect(),
              event.clientX,
              event.clientY,
            ),
          )
        }}
        onDragLeave={(event) => {
          if (!(event.currentTarget as HTMLDivElement).contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => {
          const dragged = decodeDraggedFile(event)
          if (!dragged) return
          event.preventDefault()
          const placement = getDropPlacement(
            (event.currentTarget as HTMLDivElement).getBoundingClientRect(),
            event.clientX,
            event.clientY,
          )
          setDropTarget(null)
          clearActiveDraggedFile()
          void handleGroupDrop(dragged, placement)
        }}
      >
        {dropTarget && renderDropOverlay(dropTarget)}
        <div className="flex h-full min-h-0 flex-col">{renderLayout(editorLayout)}</div>
      </div>
      {quickPickMode === 'goto-line' && (
        <EditorQuickPick
          title={t('editor.quickpick.gotoLineTitle')}
          placeholder={t('editor.quickpick.gotoLinePlaceholder')}
          items={[]}
          emptyLabel=""
          hint={t('editor.quickpick.hint')}
          onSubmitText={(text) => {
            if (!activeEditor) return false
            const lineCount =
              editorRefs.current[activeEditor.id]?.getModel?.()?.getLineCount?.() ||
              activeEditor.content.split('\n').length
            const parsed = parseGotoLine(text, lineCount)
            if (!parsed) return false
            revealPosition(activeEditor.id, parsed.line, parsed.column)
            setQuickPickMode(null)
            return true
          }}
          onSelect={() => setQuickPickMode(null)}
          onClose={() => setQuickPickMode(null)}
        />
      )}
      {quickPickMode === 'symbol' && (
        <EditorQuickPick
          title={t('editor.quickpick.symbolTitle')}
          placeholder={t('editor.quickpick.symbolPlaceholder')}
          items={outline.map((symbol) => ({
            id: `${symbol.line}:${symbol.column}:${symbol.name}`,
            label: symbol.name,
            detail: `L${symbol.line}`,
            description: symbol.kind,
          }))}
          emptyLabel={t('editor.quickpick.empty')}
          hint={t('editor.quickpick.hint')}
          onSelect={(item) => {
            const [line, column] = item.id.split(':')
            if (activeEditor) revealPosition(activeEditor.id, Number(line), Number(column))
            setQuickPickMode(null)
          }}
          onClose={() => setQuickPickMode(null)}
        />
      )}
      {tabMenu && (
        <EditorContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          title={t('editor.menu.title')}
          actions={buildTabMenuActions(tabMenu.editorId)}
          onClose={() => setTabMenu(null)}
        />
      )}
      {toolbarMenu && (
        <EditorContextMenu
          x={toolbarMenu.x}
          y={toolbarMenu.y}
          title={t('editor.menu.title')}
          actions={buildToolbarMenuActions()}
          onClose={() => setToolbarMenu(null)}
        />
      )}
      <EditorShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ConfirmDialog
        open={!!pendingCloseEditorId}
        title={t('editor.closeConfirm', { name: openEditors.find((e) => e.id === pendingCloseEditorId)?.name || '' })}
        message=""
        confirmLabel={t('editor.closeDiscard')}
        cancelLabel={t('common.cancel')}
        extraLabel={t('editor.saveAndClose')}
        tone="danger"
        onCancel={() => setPendingCloseEditorId(null)}
        onConfirm={() => {
          if (pendingCloseEditorId) {
            cancelPendingDefinition()
            closeEditor(pendingCloseEditorId)
            setPendingCloseEditorId(null)
          }
        }}
        onExtra={async () => {
          const id = pendingCloseEditorId
          const target = openEditors.find((e) => e.id === id)
          if (!id || !target) return setPendingCloseEditorId(null)
          await onSaveEditor(target)
          // onSaveEditor 吞错（写 saveError + toast）：只有确实落盘（不再 dirty）才允许关；
          // 保存失败则收起弹窗回编辑器，内联错误条留在原处可重试
          const latest = useConsoleStore.getState().openEditors.find((e) => e.id === id)
          if (latest && !latest.dirty) {
            cancelPendingDefinition()
            closeEditor(id)
          }
          setPendingCloseEditorId(null)
        }}
      />
    </section>
  )
}
