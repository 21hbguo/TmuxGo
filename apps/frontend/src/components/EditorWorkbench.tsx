'use client'
import { useEffect, useRef, useState } from 'react'
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
import { ensureTmuxgoTheme, tmuxgoThemeName } from '@/lib/monaco-theme'
import type { Monaco } from '@monaco-editor/react'
import { resolveEditorDefinition } from '@/lib/code-navigation'
import { useTranslation } from '@/i18n'
import { MARKDOWN_PROSE_CLASS, renderMarkdown } from '@/lib/markdown'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { Button } from './Button'
import { ZoomSurface } from './ZoomSurface'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffViewer } from './DiffViewer'
import dynamic from '@/lib/dynamic'
import { FiArrowLeft, FiArrowRight, FiCode } from 'react-icons/fi'

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((mod) => ({ default: mod.default })))
const MonacoDiffEditor = dynamic(() => import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor })))
const AUTO_SCROLL_DEADZONE = 10
const AUTO_SCROLL_MAX_STEP = 42
const EDGE_DROP_RATIO = 0.22
type DropPlacement = 'center' | 'left' | 'right' | 'top' | 'bottom'
type TabInsertSide = 'before' | 'after'
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
  onOpenFile: (file: FileDocumentHandle) => Promise<string>
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
  const setEditorContent = useConsoleStore((state) => state.setEditorContent)
  const ensureGitHostState = useConsoleStore((state) => state.ensureGitHostState)
  const setGitFollowEditorRepo = useConsoleStore((state) => state.setGitFollowEditorRepo)
  const gitByHost = useConsoleStore((state) => state.gitByHost)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const editorRefs = useRef<Record<string, any>>({})
  const monacoRef = useRef<Monaco | null>(null)
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
  const definitionPendingRef = useRef(false)
  const pendingLocationRef = useRef<Record<string, { line: number; column: number }>>({})
  const [pendingCloseEditorId, setPendingCloseEditorId] = useState<string | null>(null)
  const [previewOpenById, setPreviewOpenById] = useState<Record<string, boolean>>({})
  const [cursorById, setCursorById] = useState<Record<string, { line: number; column: number }>>({})
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
  const [navigationVersion, setNavigationVersion] = useState(0)
  const [previewSyncEnabled, setPreviewSyncEnabled] = useState(true)
  const previewSyncEnabledRef = useRef(true)
  previewSyncEnabledRef.current = previewSyncEnabled
  const previewElRefs = useRef<Record<string, HTMLElement | null>>({})
  const previewHighlightRef = useRef<Record<string, HTMLElement | null>>({})
  const splitResizeRef = useRef<{
    active: boolean
    direction: 'horizontal' | 'vertical'
    splitId: string
    container: HTMLDivElement | null
  } | null>(null)
  const editorById = new Map(openEditors.map((item) => [item.id, item]))
  const groupById = new Map(editorGroups.map((group) => [group.id, group]))
  const orderedGroupIds = collectEditorLayoutGroupIds(editorLayout)
  const activeEditor = activeEditorId
    ? editorById.get(activeEditorId) || null
    : openEditors[openEditors.length - 1] || null
  const gitDiff = activeEditor?.id.startsWith('git-diff?') ? parseGitDiffId(activeEditor.id) : null
  const followFilePath = !gitDiff && activeEditor?.absolutePath ? getParentDir(activeEditor.absolutePath) : ''
  const gitMode = activeHostId ? gitByHost[activeHostId]?.mode || 'follow-editor' : 'follow-editor'
  const { data: detectResult } = useGitDetect(activeHostId || '', followFilePath)
  const cursor = activeEditor ? cursorById[activeEditor.id] : null
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
  const getDragDropEffect = (dragged: FileDocumentHandle | null) =>
    dragged && isOpenEditorId(dragged.id) ? 'move' : 'copy'
  const getTabInsertSide = (rect: DOMRect, clientX: number) =>
    clientX <= rect.left + rect.width / 2 ? ('before' as const) : ('after' as const)
  const getNavigationPosition = (editorId: string) => {
    const cursorState = cursorById[editorId]
    if (cursorState) return cursorState
    const position = editorRefs.current[editorId]?.getPosition?.()
    if (!position) return null
    return { line: position.lineNumber, column: position.column }
  }
  const syncPreviewToLine = (editorId: string, line: number) => {
    const previewEl = previewElRefs.current[editorId]
    if (!previewEl || !line) return
    const blocks = Array.from(previewEl.querySelectorAll<HTMLElement>('[data-line]'))
    let target: HTMLElement | null = null
    for (const block of blocks) {
      const start = Number(block.getAttribute('data-line'))
      if (start <= line) target = block
      else break
    }
    const previous = previewHighlightRef.current[editorId]
    if (previous && previous !== target) previous.style.boxShadow = ''
    previewHighlightRef.current[editorId] = target
    if (!target) return
    target.style.boxShadow = 'inset 0 0 0 1px var(--accent)'
    target.scrollIntoView?.({ block: 'center' })
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
  const createNavigationEntry = (editor: FileEditorDocument, position?: { line: number; column: number } | null) => {
    const resolvedPosition = position || getNavigationPosition(editor.id)
    if (!resolvedPosition) return null
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
    } satisfies NavigationEntry
  }
  const sameNavigationEntry = (left: NavigationEntry | null | undefined, right: NavigationEntry | null | undefined) =>
    !!left && !!right && left.id === right.id && left.line === right.line && left.column === right.column
  const syncNavigationState = () => setNavigationVersion((current) => current + 1)
  const openNavigationEntry = async (entry: NavigationEntry) => {
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
      { t, pushToast, position: { line: entry.line, column: entry.column }, openPanel: true, skipReload: true },
    )
  }
  const navigateToEntry = async (entry: NavigationEntry, sourceEntry?: NavigationEntry | null) => {
    if (navigationPendingRef.current || sameNavigationEntry(sourceEntry, entry)) return
    navigationPendingRef.current = true
    try {
      if (
        sourceEntry &&
        !sameNavigationEntry(navigationBackRef.current[navigationBackRef.current.length - 1], sourceEntry)
      )
        navigationBackRef.current.push(sourceEntry)
      navigationForwardRef.current = []
      await openNavigationEntry(entry)
      syncNavigationState()
    } finally {
      navigationPendingRef.current = false
    }
  }
  const goBackInNavigation = async () => {
    if (navigationPendingRef.current) return
    const entry = navigationBackRef.current.pop()
    if (!entry) return
    const currentEntry = activeEditor && !gitDiff ? createNavigationEntry(activeEditor) : null
    navigationPendingRef.current = true
    try {
      if (
        currentEntry &&
        !sameNavigationEntry(navigationForwardRef.current[navigationForwardRef.current.length - 1], currentEntry)
      )
        navigationForwardRef.current.push(currentEntry)
      await openNavigationEntry(entry)
      syncNavigationState()
    } finally {
      navigationPendingRef.current = false
    }
  }
  const goForwardInNavigation = async () => {
    if (navigationPendingRef.current) return
    const entry = navigationForwardRef.current.pop()
    if (!entry) return
    const currentEntry = activeEditor && !gitDiff ? createNavigationEntry(activeEditor) : null
    navigationPendingRef.current = true
    try {
      if (
        currentEntry &&
        !sameNavigationEntry(navigationBackRef.current[navigationBackRef.current.length - 1], currentEntry)
      )
        navigationBackRef.current.push(currentEntry)
      await openNavigationEntry(entry)
      syncNavigationState()
    } finally {
      navigationPendingRef.current = false
    }
  }
  const goToDefinition = async (editor: FileEditorDocument, position: { line: number; column: number }) => {
    if (
      navigationPendingRef.current ||
      definitionPendingRef.current ||
      editor.loading ||
      editor.binary ||
      editor.truncated ||
      editor.kind === 'compare'
    )
      return
    const sourceEntry = createNavigationEntry(editor, position)
    if (!sourceEntry) return
    definitionPendingRef.current = true
    try {
      const result = await resolveEditorDefinition(editor, position, openEditorsRef.current)
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
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('editor.definitionNotFound') })
    } finally {
      definitionPendingRef.current = false
    }
  }
  const resolveTabInsertTargetId = (
    groupEditors: FileEditorDocument[],
    draggedId: string,
    targetId: string,
    side: TabInsertSide,
  ) => {
    if (side === 'before') return targetId
    const baseIds = groupEditors.map((item) => item.id).filter((item) => item !== draggedId)
    const targetIndex = baseIds.indexOf(targetId)
    return targetIndex >= 0 ? baseIds[targetIndex + 1] || null : null
  }
  const openDraggedFileInGroup = async (dragged: FileDocumentHandle, groupId: string, targetId?: string | null) => {
    const id = await onOpenFile(dragged)
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
    const id = await onOpenFile(dragged)
    placeEditorInSplit(id, placement, resolvedGroupId)
  }
  const handleGroupDrop = async (dragged: FileDocumentHandle, placement: DropPlacement, groupId?: string | null) => {
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
    const insertTargetId = resolveTabInsertTargetId(groupEditors, dragged.id, targetEditor.id, side)
    if (isOpenEditorId(dragged.id)) {
      moveEditorToGroup(dragged.id, groupId, insertTargetId)
      return
    }
    await openDraggedFileInGroup(dragged, groupId, insertTargetId)
  }
  const handleTabStripDrop = async (dragged: FileDocumentHandle, groupId: string, placement: DropPlacement) => {
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
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-terminal],.xterm,.xterm-screen')) return
      if (event.key === 'F12' && activeEditor && !gitDiff) {
        event.preventDefault()
        const position = getNavigationPosition(activeEditor.id)
        if (position) void goToDefinition(activeEditor, position)
        return
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        void goBackInNavigation()
        return
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault()
        void goForwardInNavigation()
        return
      }
      if (!(event.metaKey || event.ctrlKey) || !activeEditor) return
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (
          !gitDiff &&
          !activeEditor.loading &&
          !activeEditor.saving &&
          !activeEditor.binary &&
          !activeEditor.truncated
        )
          void onSaveEditor(activeEditor)
        return
      }
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation?.()
        if (activeEditor.dirty) {
          setPendingCloseEditorId(activeEditor.id)
          return
        }
        closeEditor(activeEditor.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [activeEditor, closeEditor, cursorById, gitDiff, navigationVersion, onSaveEditor, openEditors])
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
      if (splitResizeRef.current?.active) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
      splitResizeRef.current = null
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
      if (splitResizeRef.current?.active) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
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
  useEffect(() => {
    const handleOpenEditorLocation = (event: Event) => {
      const detail = (event as CustomEvent<{ editorId?: string; line?: number; column?: number }>).detail
      const editorId = detail?.editorId
      const line = Number(detail?.line)
      const column = Number(detail?.column) || 1
      if (!editorId || !Number.isFinite(line) || line < 1) return
      pendingLocationRef.current[editorId] = { line, column: Math.max(1, column) }
      setActiveEditor(editorId)
      requestAnimationFrame(() => {
        const editor = editorRefs.current[editorId]
        const position = pendingLocationRef.current[editorId]
        if (!editor || !position) return
        editor.setPosition?.({ lineNumber: position.line, column: position.column })
        editor.revealPositionInCenter?.({ lineNumber: position.line, column: position.column })
        editor.focus?.()
        delete pendingLocationRef.current[editorId]
      })
    }
    window.addEventListener(OPEN_EDITOR_LOCATION_EVENT, handleOpenEditorLocation as EventListener)
    return () => window.removeEventListener(OPEN_EDITOR_LOCATION_EVENT, handleOpenEditorLocation as EventListener)
  }, [setActiveEditor])
  const renderTab = (editor: FileEditorDocument, groupEditors: FileEditorDocument[], groupId: string) => (
    <div
      key={editor.id}
      className={`group relative flex h-6 w-40 shrink-0 items-center border-r border-[rgba(255,255,255,0.04)] ${editor.id === activeEditor?.id ? 'bg-bg-0' : 'bg-bg-1/80'}`}
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
          event.dataTransfer.dropEffect = getDragDropEffect(dragged)
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
        onClick={() => setActiveEditor(editor.id)}
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
          if (editor.dirty) {
            setPendingCloseEditorId(editor.id)
            return
          }
          closeEditor(editor.id)
        }}
      >
        ×
      </Chip>
      {tabInsertionTarget?.groupId === groupId && tabInsertionTarget.editorId === editor.id && (
        <span
          className={`pointer-events-none absolute inset-y-1 z-20 w-[2px] rounded-full bg-accent shadow-[0_0_0_1px_rgba(30,200,255,0.2)] ${tabInsertionTarget.side === 'before' ? 'left-0' : 'right-0'}`}
        />
      )}
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
      data-testid={`editor-group-${getLegacyGroupName(groupId)}`}
      data-editor-group-id={groupId}
      className={`tmuxgo-scrollbar-subtle relative flex min-h-6 items-stretch overflow-x-auto border-b border-[var(--line)] bg-bg-1 ${tabDropTarget?.groupId === groupId ? 'ring-1 ring-accent/40 ring-inset' : ''}`}
      onDragOver={(event) => {
        if (!hasDraggedFile(event)) return
        const dragged = decodeDraggedFile(event)
        event.preventDefault()
        event.dataTransfer.dropEffect = getDragDropEffect(dragged)
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
  const renderPane = (groupId: string) => {
    const groupEditors = getGroupEditors(groupId)
    const editor = getGroupActiveEditor(groupId)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {renderTabStrip(groupEditors, groupId)}
        <button
          onClick={() => editor && setActiveEditor(editor.id)}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden text-left"
          onDragOverCapture={(event) => {
            if (!hasDraggedFile(event)) return
            const dragged = decodeDraggedFile(event)
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = getDragDropEffect(dragged)
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
            renderSurface(editor, activeEditor?.id === editor.id)
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-3">
              {t('editor.drop.center' as never)}
            </div>
          )}
          {editor && activeEditor?.id === editor.id && (
            <span className="pointer-events-none absolute inset-0 border border-accent/35" />
          )}
          {paneDropTarget?.groupId === groupId && renderDropOverlay(paneDropTarget.placement)}
        </button>
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
  const renderSurface = (editor: FileEditorDocument, focused: boolean) => {
    const previewOpen =
      (editor.language === 'markdown' || editor.language === 'html') && previewOpenById[editor.id] !== false
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
      <div className={`flex h-full min-h-0 ${previewOpen ? 'flex-row' : 'flex-col'}`}>
        <div
          ref={(node) => {
            editorViewportRefs.current[editor.id] = node
          }}
          data-testid={focused ? 'editor-auto-scroll-zone' : undefined}
          onMouseDown={(event) => handleEditorMouseDown(editor.id, event)}
          className={`relative ${previewOpen ? 'min-w-0 flex-1 border-r border-[var(--line)]' : 'h-full'}`}
        >
          <MonacoEditor
            key={editor.id}
            path={editor.absolutePath}
            language={editor.language}
            theme={getMonacoTheme(preferences.theme)}
            beforeMount={(monaco) => {
              monacoRef.current = monaco
              ensureTmuxgoTheme(monaco, preferences.theme)
            }}
            value={editor.content}
            onMount={(instance) => {
              editorRefs.current[editor.id] = instance
              // 卸载时清掉死引用：rAF 落位遇到死实例会落空,清掉后走 pendingLocation → remount 时 onMount 兜底
              instance.onDidDispose?.(() => {
                if (editorRefs.current[editor.id] === instance) delete editorRefs.current[editor.id]
              })
              const position = instance.getPosition?.()
              if (position)
                setCursorById((current) => ({
                  ...current,
                  [editor.id]: { line: position.lineNumber, column: position.column },
                }))
              instance.onDidChangeCursorPosition?.((event: any) => {
                setCursorById((current) => ({
                  ...current,
                  [editor.id]: { line: event.position.lineNumber, column: event.position.column },
                }))
                if (previewSyncEnabledRef.current && editor.language === 'markdown' && previewOpen)
                  syncPreviewToLine(editor.id, event.position.lineNumber)
              })
              const pendingPosition = pendingLocationRef.current[editor.id]
              if (pendingPosition) {
                instance.setPosition?.({ lineNumber: pendingPosition.line, column: pendingPosition.column })
                instance.revealPositionInCenter?.({ lineNumber: pendingPosition.line, column: pendingPosition.column })
                instance.focus?.()
                delete pendingLocationRef.current[editor.id]
              }
              instance.onMouseDown?.((event: any) => {
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
            }}
            onChange={(value) => setEditorContent(editor.id, value || '')}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              fontFamily: preferences.fontFamily,
              fontSize: Math.max(12, preferences.fontSize),
              lineNumbers: 'on',
              lineNumbersMinChars: 2,
              lineDecorationsWidth: 0,
              glyphMargin: false,
              folding: true,
              guides: { indentation: true, bracketPairs: true },
              bracketPairColorization: { enabled: true },
              matchBrackets: 'always',
              renderLineHighlight: 'line',
              renderValidationDecorations: 'on',
              occurrencesHighlight: 'singleFile',
              selectionHighlight: true,
              codeLens: false,
              contextmenu: true,
              links: true,
              mouseWheelZoom: true,
              cursorSmoothCaretAnimation: 'on',
              scrollBeyondLastLine: false,
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
                alwaysConsumeMouseWheel: false,
                useShadows: false,
                verticalHasArrows: false,
                horizontalHasArrows: false,
              },
              overviewRulerBorder: false,
              wordWrap: 'off',
              wordWrapColumn: 120,
              wrappingIndent: 'same',
              tabSize: getTabSize(editor.language),
              insertSpaces: editor.language !== 'go',
              detectIndentation: true,
              formatOnPaste: true,
              formatOnType: true,
              trimAutoWhitespace: true,
              renderWhitespace: 'boundary',
              renderControlCharacters: false,
              smoothScrolling: true,
              cursorBlinking: preferences.cursorBlink ? 'blink' : 'solid',
              cursorStyle: 'line',
              dragAndDrop: false,
              dropIntoEditor: { enabled: false },
              readOnlyMessage: { value: t('editor.readOnly') },
              padding: { top: 16, bottom: 16 },
            }}
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
        {previewOpen &&
          (editor.language === 'markdown' ? (
            <ZoomSurface
              active={focused}
              resetKey={editor.id}
              doubleClickZoom={false}
              className="tmuxgo-scrollbar min-w-0 flex-1 overflow-auto bg-bg-1/60 px-6 py-5"
            >
              <article
                ref={(node) => {
                  previewElRefs.current[editor.id] = node
                }}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(editor.content) || `<p>${t('editor.nothingToPreview')}</p>`,
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
              className="h-full min-w-0 flex-1 border-0 bg-white"
            />
          ))}
      </div>
    )
  }
  const closeAllEditors = () => {
    for (const editor of [...openEditors]) closeEditor(editor.id)
  }
  if (!activeEditor) return null
  return (
    <section data-editor-drop className="flex h-full min-h-0 flex-col bg-bg-0">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.04)] bg-bg-1/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-text-1">{activeEditor.absolutePath}</div>
          <div className="mt-0.5 text-meta text-text-3">
            {activeEditor.language.toUpperCase()} · {activeEditor.size || 0}B
            {cursor ? ` · Ln ${cursor.line}, Col ${cursor.column}` : ''}
            {activeEditor.modifiedAt ? ` · ${new Date(activeEditor.modifiedAt).toLocaleString()}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
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
              {(activeEditor.language === 'markdown' || activeEditor.language === 'html') && (
                <Button
                  size="sm"
                  variant={previewOpenById[activeEditor.id] !== false ? 'accent' : 'default'}
                  onClick={() =>
                    setPreviewOpenById((current) => ({
                      ...current,
                      [activeEditor.id]: current[activeEditor.id] === false,
                    }))
                  }
                >
                  {t('editor.preview')}
                </Button>
              )}
              {activeEditor.language === 'markdown' && previewOpenById[activeEditor.id] !== false && (
                <Button
                  size="sm"
                  variant={previewSyncEnabled ? 'accent' : 'default'}
                  onClick={() => setPreviewSyncEnabled((current) => !current)}
                >
                  {t('editor.syncPreview')}
                </Button>
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
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1 bg-bg-0"
        onDragOver={(event) => {
          if (!hasDraggedFile(event)) return
          const dragged = decodeDraggedFile(event)
          event.preventDefault()
          event.dataTransfer.dropEffect = getDragDropEffect(dragged)
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
      <ConfirmDialog
        open={!!pendingCloseEditorId}
        title={t('editor.closeConfirm', { name: openEditors.find((e) => e.id === pendingCloseEditorId)?.name || '' })}
        message=""
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingCloseEditorId(null)}
        onConfirm={() => {
          if (pendingCloseEditorId) {
            closeEditor(pendingCloseEditorId)
            setPendingCloseEditorId(null)
          }
        }}
      />
    </section>
  )
}
