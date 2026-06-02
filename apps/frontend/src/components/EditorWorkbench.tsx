'use client'
import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from '@/hooks/usePreferences'
import { useGitDetect } from '@/hooks/useApi'
import { useTranslation } from '@/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffViewer } from './DiffViewer'

const MonacoEditor=dynamic(() => import('@monaco-editor/react').then((mod) => mod.default), { ssr: false })
const MonacoDiffEditor=dynamic(() => import('@monaco-editor/react').then((mod) => mod.DiffEditor), { ssr: false })
const AUTO_SCROLL_DEADZONE = 10
const AUTO_SCROLL_MAX_STEP = 42
const FILE_DRAG_MIME = 'application/x-tmuxgo-file'
const EDGE_DROP_RATIO = 0.22
function getParentDir(path: string) {
  const normalized = path.replace(/\/+$/,'')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}
function getMonacoTheme(theme: string) {
  if (theme === 'light') return 'vs'
  if (theme === 'high-contrast') return 'hc-black'
  return 'vs-dark'
}
function getTabSize(language: string) {
  if (language === 'python' || language === 'yaml') return 4
  if (language === 'go') return 4
  return 2
}
function isImagePreviewable(editor: FileEditorDocument) {
  return !!editor.previewUrl
}
function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
function applyInlineMarkdown(value: string) {
  return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
}
function renderMarkdown(content: string) {
  const blocks = content.replace(/\r\n/g, '\n').split('\n')
  const html:string[] = []
  let paragraph:string[] = []
  let listItems:string[] = []
  let codeLines:string[] = []
  let codeLanguage = ''
  const flushParagraph = () => {
    if (!paragraph.length) return
    html.push(`<p>${applyInlineMarkdown(paragraph.join('<br />'))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!listItems.length) return
    html.push(`<ul>${listItems.map((item) => `<li>${applyInlineMarkdown(item)}</li>`).join('')}</ul>`)
    listItems = []
  }
  const flushCode = () => {
    if (!codeLines.length) return
    html.push(`<pre><code class="language-${escapeHtml(codeLanguage)}">${codeLines.join('\n')}</code></pre>`)
    codeLines = []
    codeLanguage = ''
  }
  for (const rawLine of blocks) {
    const line = escapeHtml(rawLine)
    if (rawLine.startsWith('```')) {
      flushParagraph()
      flushList()
      if (codeLines.length) flushCode()
      else codeLanguage = rawLine.slice(3).trim()
      continue
    }
    if (codeLanguage || codeLines.length) {
      codeLines.push(line)
      continue
    }
    if (!rawLine.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = rawLine.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html.push(`<h${level}>${applyInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`)
      continue
    }
    const quote = rawLine.match(/^>\s?(.*)$/)
    if (quote) {
      flushParagraph()
      flushList()
      html.push(`<blockquote>${applyInlineMarkdown(escapeHtml(quote[1]))}</blockquote>`)
      continue
    }
    const list = rawLine.match(/^[-*]\s+(.*)$/)
    if (list) {
      flushParagraph()
      listItems.push(escapeHtml(list[1]))
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  flushCode()
  return html.join('')
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
  const raw = event.dataTransfer?.getData(FILE_DRAG_MIME)
  if (!raw) return null
  try {
    return JSON.parse(raw) as FileDocumentHandle
  } catch {
    return null
  }
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
export function EditorWorkbench({ onSaveEditor, onOpenFile, onOpenFileAtPosition = async (file) => file.id, onCreateCompare }:{ onSaveEditor: (editor: FileEditorDocument) => Promise<void>; onOpenFile: (file: FileDocumentHandle) => Promise<string>; onOpenFileAtPosition?: (file: FileDocumentHandle, placement: 'center' | 'left' | 'right' | 'top' | 'bottom') => Promise<string>; onCreateCompare: (source: FileDocumentHandle, targetId: string) => Promise<void> }) {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const activeEditorId = useConsoleStore((state) => state.activeEditorId)
  const editorPrimaryGroupIds = useConsoleStore((state) => state.editorPrimaryGroupIds)
  const editorSecondaryGroupIds = useConsoleStore((state) => state.editorSecondaryGroupIds)
  const editorPrimaryId = useConsoleStore((state) => state.editorPrimaryId)
  const editorSecondaryId = useConsoleStore((state) => state.editorSecondaryId)
  const editorSplitDirection = useConsoleStore((state) => state.editorSplitDirection)
  const editorSplitRatio = useConsoleStore((state) => state.editorSplitRatio)
  const placeEditorInSplit = useConsoleStore((state) => state.placeEditorInSplit)
  const setEditorSplitRatio = useConsoleStore((state) => state.setEditorSplitRatio)
  const setActiveEditor = useConsoleStore((state) => state.setActiveEditor)
  const moveEditorToGroup = useConsoleStore((state) => state.moveEditorToGroup)
  const closeEditor = useConsoleStore((state) => state.closeEditor)
  const setEditorContent = useConsoleStore((state) => state.setEditorContent)
  const ensureGitHostState = useConsoleStore((state) => state.ensureGitHostState)
  const setGitFollowEditorRepo = useConsoleStore((state) => state.setGitFollowEditorRepo)
  const gitByHost = useConsoleStore((state) => state.gitByHost)
  const { preferences } = usePreferences()
  const { t } = useTranslation()
  const editorRefs = useRef<Record<string, any>>({})
  const editorViewportRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const autoScrollFrameRef = useRef<number | null>(null)
  const autoScrollStateRef = useRef<{ active: boolean; editorId: string | null; anchorY: number; pointerY: number }>({ active: false, editorId: null, anchorY: 0, pointerY: 0 })
  const [pendingCloseEditorId, setPendingCloseEditorId] = useState<string | null>(null)
  const [previewOpenById, setPreviewOpenById] = useState<Record<string, boolean>>({})
  const [cursorById, setCursorById] = useState<Record<string, { line: number; column: number }>>({})
  const [autoScrollIndicator, setAutoScrollIndicator] = useState<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 })
  const [dropTarget, setDropTarget] = useState<'center' | 'left' | 'right' | 'top' | 'bottom' | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<{ group: 'primary' | 'secondary'; placement: 'center' | 'left' | 'right' | 'top' | 'bottom' } | null>(null)
  const [imageScale, setImageScale] = useState(1)
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 })
  const imageViewportRef = useRef<HTMLDivElement | null>(null)
  const imageDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const splitResizeRef = useRef<{ active: boolean; direction: 'horizontal' | 'vertical'; startRatio: number } | null>(null)
  const activeEditor = openEditors.find((item) => item.id === activeEditorId) || openEditors[openEditors.length - 1] || null
  const primaryGroupEditors = editorPrimaryGroupIds.map((id) => openEditors.find((item) => item.id === id) || null).filter(Boolean) as FileEditorDocument[]
  const secondaryGroupEditors = editorSecondaryGroupIds.map((id) => openEditors.find((item) => item.id === id) || null).filter(Boolean) as FileEditorDocument[]
  const primaryEditor = editorPrimaryId ? openEditors.find((item) => item.id === editorPrimaryId) || null : activeEditor
  const secondaryEditor = editorSecondaryId ? openEditors.find((item) => item.id === editorSecondaryId) || null : null
  const gitDiff = activeEditor?.id.startsWith('git-diff?') ? parseGitDiffId(activeEditor.id) : null
  const followFilePath = !gitDiff && activeEditor?.absolutePath ? getParentDir(activeEditor.absolutePath) : ''
  const gitMode = activeHostId ? gitByHost[activeHostId]?.mode || 'follow-editor' : 'follow-editor'
  const { data: detectResult } = useGitDetect(activeHostId || '', followFilePath)
  const cursor = activeEditor ? cursorById[activeEditor.id] : null
  const stopAutoScroll = () => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current)
      autoScrollFrameRef.current = null
    }
    autoScrollStateRef.current.active = false
    autoScrollStateRef.current.editorId = null
    setAutoScrollIndicator((current) => current.active ? { ...current, active: false } : current)
  }
  const runAutoScroll = () => {
    if (!autoScrollStateRef.current.active) return
    const editor = autoScrollStateRef.current.editorId ? editorRefs.current[autoScrollStateRef.current.editorId] : null
    if (editor) {
      const step = getAutoScrollStep(autoScrollStateRef.current.pointerY - autoScrollStateRef.current.anchorY)
      if (step) {
        const scrollTop = Number(editor.getScrollTop?.() || 0)
        editor.setScrollTop?.(scrollTop + step)
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
    autoScrollStateRef.current.anchorY = clientY
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
      if (!(event.metaKey || event.ctrlKey) || !activeEditor) return
      const target = event.target
      if (target instanceof Element && target.closest('[data-terminal],.xterm,.xterm-screen')) return
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!gitDiff && !activeEditor.loading && !activeEditor.saving && !activeEditor.binary && !activeEditor.truncated) void onSaveEditor(activeEditor)
        return
      }
      if (event.key.toLowerCase() === 'f' && event.shiftKey) {
        event.preventDefault()
        if (!gitDiff) void editorRefs.current[activeEditor.id]?.getAction?.('editor.action.formatDocument')?.run?.()
        return
      }
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation?.()
        if (activeEditor.dirty) { setPendingCloseEditorId(activeEditor.id); return }
        closeEditor(activeEditor.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [activeEditor, closeEditor, gitDiff, onSaveEditor])
  useEffect(() => {
    if (!autoScrollIndicator.active) return
    const handlePointerMove = (event: PointerEvent) => {
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
      const container = splitContainerRef.current
      if (!resize || !resize.active || !container) return
      const rect = container.getBoundingClientRect()
      if (resize.direction === 'horizontal' && rect.width > 0) setEditorSplitRatio((event.clientX - rect.left) / rect.width)
      if (resize.direction === 'vertical' && rect.height > 0) setEditorSplitRatio((event.clientY - rect.top) / rect.height)
    }
    const handlePointerUp = () => {
      splitResizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
    }
  }, [setEditorSplitRatio])
  useEffect(() => {
    stopAutoScroll()
    setDropTarget(null)
    setTabDropTarget(null)
    setImageScale(1)
    setImageOffset({ x: 0, y: 0 })
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
  }, [activeEditor?.absolutePath, activeHostId, detectResult?.isGitRepo, detectResult?.rootPath, gitDiff, gitMode, setGitFollowEditorRepo])
  const renderTab = (editor: FileEditorDocument, group: 'primary' | 'secondary') => (
    <div key={editor.id} className={`group flex h-[42px] w-44 shrink-0 items-center border-r border-[rgba(255,255,255,0.04)] ${editor.id === activeEditor?.id ? 'bg-bg-0' : 'bg-bg-1/80'}`}>
      <button draggable={editor.kind !== 'compare'} onDragStart={(event) => {
        if (editor.kind === 'compare') return
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify({ id: editor.id, hostId: editor.hostId, rootId: editor.rootId, rootLabel: editor.rootLabel, rootPath: editor.rootPath, path: editor.path, name: editor.name, absolutePath: editor.absolutePath } satisfies FileDocumentHandle))
      }} onDragOver={(event) => {
        const dragged = decodeDraggedFile(event)
        if (!dragged || dragged.id === editor.id || editor.kind === 'compare') return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }} onDrop={(event) => {
        const dragged = decodeDraggedFile(event)
        if (!dragged || dragged.id === editor.id || editor.kind === 'compare') return
        event.preventDefault()
        event.stopPropagation()
        moveEditorToGroup(dragged.id, group, editor.id)
      }} onClick={() => setActiveEditor(editor.id)} className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm ${editor.id === activeEditor?.id ? 'text-text-1' : 'text-text-3 hover:text-text-1'}`}>
        <span className={`h-2 w-2 rounded-full ${editor.dirty ? 'bg-warn' : editor.saving ? 'bg-accent' : 'border border-[var(--line)] bg-transparent'}`} />
        <span className="min-w-0 flex-1 truncate">{editor.name}</span>
      </button>
      <button onClick={() => {
        if (editor.dirty) { setPendingCloseEditorId(editor.id); return }
        closeEditor(editor.id)
      }} className="mr-2 shrink-0 rounded px-1.5 py-1 text-xs text-text-3 opacity-0 hover:bg-bg-2 hover:text-text-1 group-hover:opacity-100">×</button>
    </div>
  )
  const renderTabStrip = (editors: FileEditorDocument[], group: 'primary' | 'secondary') => <div data-testid={`editor-group-${group}`} className={`tmuxgo-scrollbar-subtle relative flex min-h-[42px] items-stretch overflow-x-auto border-b border-[var(--line)] bg-bg-1 ${tabDropTarget?.group === group ? 'ring-1 ring-accent/40 ring-inset' : ''}`} onDragOver={(event) => {
    const dragged = decodeDraggedFile(event)
    if (!dragged) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setTabDropTarget({ group, placement: getDropPlacement((event.currentTarget as HTMLDivElement).getBoundingClientRect(), event.clientX, event.clientY) })
  }} onDragLeave={(event) => {
    if (!(event.currentTarget as HTMLDivElement).contains(event.relatedTarget as Node | null)) setTabDropTarget((current) => current?.group === group ? null : current)
  }} onDrop={(event) => {
    const dragged = decodeDraggedFile(event)
    if (!dragged) return
    event.preventDefault()
    const placement = getDropPlacement((event.currentTarget as HTMLDivElement).getBoundingClientRect(), event.clientX, event.clientY)
    setTabDropTarget(null)
    if (placement === 'center') moveEditorToGroup(dragged.id, group)
    else placeEditorInSplit(dragged.id, placement)
  }}>{tabDropTarget?.group === group && <div className="pointer-events-none absolute inset-0 z-10">
    <div className={`absolute inset-y-0 left-0 w-[18%] ${tabDropTarget.placement === 'left' ? 'bg-accent/15' : ''}`} />
    <div className={`absolute inset-y-0 right-0 w-[18%] ${tabDropTarget.placement === 'right' ? 'bg-accent/15' : ''}`} />
    <div className={`absolute inset-x-0 top-0 h-[38%] ${tabDropTarget.placement === 'top' ? 'bg-accent/15' : ''}`} />
    <div className={`absolute inset-x-0 bottom-0 h-[38%] ${tabDropTarget.placement === 'bottom' ? 'bg-accent/15' : ''}`} />
    <div className={`absolute inset-[24%] rounded-md ${tabDropTarget.placement === 'center' ? 'bg-accent/12 border border-accent/40' : ''}`} />
  </div>}{editors.map((editor) => renderTab(editor, group))}</div>
  const renderPane = (editor: FileEditorDocument, groupEditors: FileEditorDocument[], group: 'primary' | 'secondary') => <div className="flex min-h-0 flex-1 flex-col">{renderTabStrip(groupEditors, group)}<button onClick={() => setActiveEditor(editor.id)} className="relative min-h-0 min-w-0 flex-1 overflow-hidden text-left">{renderSurface(editor, activeEditor?.id === editor.id)}{activeEditor?.id === editor.id && <span className="pointer-events-none absolute inset-0 border border-accent/35" />}</button></div>
  const renderSurface = (editor: FileEditorDocument, focused: boolean) => {
    const markdownPreviewOpen = editor.language === 'markdown' && !!previewOpenById[editor.id]
    const compareLeft = editor.compareLeftId ? openEditors.find((item) => item.id === editor.compareLeftId) || null : null
    const compareRight = editor.compareRightId ? openEditors.find((item) => item.id === editor.compareRightId) || null : null
    const diff = editor.id.startsWith('git-diff?') ? parseGitDiffId(editor.id) : null
    if (diff) return <DiffViewer hostId={diff.hostId} repoPath={diff.repoPath} filePath={diff.filePath} staged={diff.staged} commit={diff.commit} />
    if (editor.kind === 'compare') {
      return compareLeft && compareRight ? <MonacoDiffEditor key={editor.id} original={compareLeft.content} modified={compareRight.content} language={editor.language} theme={getMonacoTheme(preferences.theme)} options={{ readOnly: true, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false }, fontFamily: preferences.fontFamily, fontSize: Math.max(12, preferences.fontSize), scrollBeyondLastLine: false, wordWrap: 'off', renderOverviewRuler: false, scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false } }} /> : <div className="flex h-full items-center justify-center text-sm text-text-3">{t('editor.compareMissing')}</div>
    }
    if (editor.loading) return <div className="flex h-full items-center justify-center text-sm text-text-3">{t('editor.loading', { name: editor.name })}</div>
    if (isImagePreviewable(editor)) {
      return <div ref={focused ? imageViewportRef : undefined} className="flex h-full items-center justify-center overflow-hidden bg-bg-0 p-4" onWheel={focused ? (event) => {
        if (!(event.ctrlKey || event.metaKey)) return
        event.preventDefault()
        const viewport = imageViewportRef.current
        if (!viewport) return
        const rect = viewport.getBoundingClientRect()
        const pointX = event.clientX - rect.left - rect.width / 2 - imageOffset.x
        const pointY = event.clientY - rect.top - rect.height / 2 - imageOffset.y
        const nextScale = Math.max(0.25, Math.min(8, imageScale * (event.deltaY < 0 ? 1.12 : 0.9)))
        const ratio = nextScale / imageScale
        setImageScale(nextScale)
        setImageOffset({ x: imageOffset.x - pointX * (ratio - 1), y: imageOffset.y - pointY * (ratio - 1) })
      } : undefined} onDoubleClick={focused ? () => {
        if (Math.abs(imageScale - 1) < 0.01) setImageScale(2)
        else {
          setImageScale(1)
          setImageOffset({ x: 0, y: 0 })
        }
      } : undefined} onPointerDown={focused ? (event) => {
        imageDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: imageOffset.x, originY: imageOffset.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      } : undefined} onPointerMove={focused ? (event) => {
        const drag = imageDragRef.current
        if (!drag || drag.pointerId !== event.pointerId || imageScale <= 1) return
        setImageOffset({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY })
      } : undefined} onPointerUp={focused ? (event) => {
        if (imageDragRef.current?.pointerId === event.pointerId) imageDragRef.current = null
      } : undefined} onPointerCancel={focused ? (event) => {
        if (imageDragRef.current?.pointerId === event.pointerId) imageDragRef.current = null
      } : undefined}><img src={editor.previewUrl} alt={editor.name} className="max-h-full max-w-full rounded border border-[var(--line)] bg-bg-1 object-contain select-none" style={focused ? { transform: `translate(${imageOffset.x}px,${imageOffset.y}px) scale(${imageScale})`, transformOrigin: 'center center' } : undefined} />{focused && <div className="absolute right-4 top-3 rounded-full border border-[var(--line)] bg-bg-1/90 px-3 py-1 text-[11px] text-text-2">{Math.round(imageScale * 100)}%</div>}</div>
    }
    if (editor.problem || editor.binary || editor.truncated) return <div className="flex h-full items-center justify-center p-6"><div className="max-w-xl rounded-lg border border-[var(--line)] bg-bg-1 p-5"><div className="text-sm text-text-1">{editor.name}</div><div className="mt-2 text-sm text-text-3">{editor.problem || (editor.binary ? t('editor.binaryNotEditable') : t('editor.largePreviewOnly'))}</div></div></div>
    return <div className={`flex h-full min-h-0 ${markdownPreviewOpen ? 'flex-row' : 'flex-col'}`}><div ref={(node) => { editorViewportRefs.current[editor.id] = node }} data-testid={focused ? 'editor-auto-scroll-zone' : undefined} onMouseDown={(event) => handleEditorMouseDown(editor.id, event)} className={`relative ${markdownPreviewOpen ? 'min-w-0 flex-1 border-r border-[var(--line)]' : 'h-full'}`}><MonacoEditor key={editor.id} path={editor.absolutePath} language={editor.language} theme={getMonacoTheme(preferences.theme)} value={editor.content} onMount={(instance) => {
      editorRefs.current[editor.id] = instance
      const position = instance.getPosition?.()
      if (position) setCursorById((current) => ({ ...current, [editor.id]: { line: position.lineNumber, column: position.column } }))
      instance.onDidChangeCursorPosition?.((event: any) => {
        setCursorById((current) => ({ ...current, [editor.id]: { line: event.position.lineNumber, column: event.position.column } }))
      })
    }} onChange={(value) => setEditorContent(editor.id, value || '')} options={{ automaticLayout: true, minimap: { enabled: false }, fontFamily: preferences.fontFamily, fontSize: Math.max(12, preferences.fontSize), lineNumbers: 'on', lineNumbersMinChars: 4, glyphMargin: false, folding: true, guides: { indentation: true, bracketPairs: true }, bracketPairColorization: { enabled: true }, matchBrackets: 'always', renderLineHighlight: 'line', renderValidationDecorations: 'on', occurrencesHighlight: 'singleFile', selectionHighlight: true, codeLens: false, contextmenu: true, links: true, mouseWheelZoom: true, cursorSmoothCaretAnimation: 'on', scrollBeyondLastLine: false, scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false }, overviewRulerBorder: false, wordWrap: 'off', wordWrapColumn: 120, wrappingIndent: 'same', tabSize: getTabSize(editor.language), insertSpaces: editor.language !== 'go', detectIndentation: true, formatOnPaste: true, formatOnType: true, trimAutoWhitespace: true, renderWhitespace: 'boundary', renderControlCharacters: false, smoothScrolling: true, cursorBlinking: preferences.cursorBlink ? 'blink' : 'solid', cursorStyle: 'line', readOnlyMessage: { value: t('editor.readOnly') }, padding: { top: 16, bottom: 16 } }} />{autoScrollIndicator.active && autoScrollStateRef.current.editorId === editor.id && <span data-testid="editor-auto-scroll-indicator" className="pointer-events-none absolute z-20 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/70 bg-bg-0/85 shadow-[0_0_0_1px_rgba(30,200,255,0.22)]" style={{ left: autoScrollIndicator.x, top: autoScrollIndicator.y }}><span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-accent/70" /><span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-accent/70" /></span>}</div>{markdownPreviewOpen && <div className="tmuxgo-scrollbar min-w-0 flex-1 overflow-auto bg-bg-1/60 px-6 py-5"><article className="prose prose-invert max-w-none text-sm text-text-2 [&_a]:text-accent [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--line)] [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-bg-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:text-text-1 [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-2xl [&_h2]:text-text-1 [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-xl [&_h3]:text-text-1 [&_li]:mb-1 [&_p]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-bg-0 [&_pre]:p-4 [&_strong]:text-text-1" dangerouslySetInnerHTML={{ __html: renderMarkdown(escapeHtml(editor.content)) || `<p>${t('editor.nothingToPreview')}</p>` }} /></div>}</div>
  }
  if (!activeEditor) return null
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-0">
      <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.04)] bg-bg-1/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm text-text-1">{activeEditor.absolutePath}</div>
          <div className="mt-0.5 text-[11px] text-text-3">{activeEditor.language.toUpperCase()} · {activeEditor.size || 0}B{cursor ? ` · Ln ${cursor.line}, Col ${cursor.column}` : ''}{activeEditor.modifiedAt ? ` · ${new Date(activeEditor.modifiedAt).toLocaleString()}` : ''}</div>
        </div>
        <div className="flex items-center gap-2">
          {!gitDiff && <>
            <button onClick={() => void editorRefs.current[activeEditor.id]?.getAction?.('actions.find')?.run?.()} className="rounded px-3 py-1.5 text-xs bg-bg-2 text-text-2 hover:text-text-1">{t('editor.find')}</button>
            <button onClick={() => void editorRefs.current[activeEditor.id]?.getAction?.('editor.action.formatDocument')?.run?.()} className="rounded px-3 py-1.5 text-xs bg-bg-2 text-text-2 hover:text-text-1">{t('editor.format')}</button>
            {activeEditor.language === 'markdown' && <button onClick={() => setPreviewOpenById((current) => ({ ...current, [activeEditor.id]: !current[activeEditor.id] }))} className={`rounded px-3 py-1.5 text-xs ${previewOpenById[activeEditor.id] ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-2 hover:text-text-1'}`}>{t('editor.preview')}</button>}
            <button disabled={activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated || !activeEditor.dirty} onClick={() => void onSaveEditor(activeEditor)} className={`rounded px-3 py-1.5 text-xs ${activeEditor.loading || activeEditor.saving || activeEditor.binary || activeEditor.truncated || !activeEditor.dirty ? 'bg-bg-2 text-text-3/50' : 'bg-accent/20 text-accent hover:text-text-1'}`}>{activeEditor.saving ? t('editor.saving') : activeEditor.dirty ? t('editor.save') : t('editor.saved')}</button>
          </>}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-bg-0" onDragOver={(event) => {
        const dragged = decodeDraggedFile(event)
        if (!dragged) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropTarget(getDropPlacement((event.currentTarget as HTMLDivElement).getBoundingClientRect(), event.clientX, event.clientY))
      }} onDragLeave={(event) => {
        if (!(event.currentTarget as HTMLDivElement).contains(event.relatedTarget as Node | null)) setDropTarget(null)
      }} onDrop={(event) => {
        const dragged = decodeDraggedFile(event)
        if (!dragged) return
        event.preventDefault()
        const placement = getDropPlacement((event.currentTarget as HTMLDivElement).getBoundingClientRect(), event.clientX, event.clientY)
        setDropTarget(null)
        void onOpenFileAtPosition(dragged, placement)
      }}>
        {dropTarget && <div className="pointer-events-none absolute inset-[16px] z-20">
          <div className={`absolute inset-[28%] rounded-2xl border border-dashed ${dropTarget === 'center' ? 'border-accent bg-accent/12' : 'border-[var(--line)] bg-bg-1/35'}`} />
          <div className={`absolute inset-y-0 left-0 w-[22%] rounded-l-2xl border border-dashed ${dropTarget === 'left' ? 'border-accent bg-accent/12' : 'border-[var(--line)] bg-bg-1/30'}`} />
          <div className={`absolute inset-y-0 right-0 w-[22%] rounded-r-2xl border border-dashed ${dropTarget === 'right' ? 'border-accent bg-accent/12' : 'border-[var(--line)] bg-bg-1/30'}`} />
          <div className={`absolute inset-x-0 top-0 h-[22%] rounded-t-2xl border border-dashed ${dropTarget === 'top' ? 'border-accent bg-accent/12' : 'border-[var(--line)] bg-bg-1/30'}`} />
          <div className={`absolute inset-x-0 bottom-0 h-[22%] rounded-b-2xl border border-dashed ${dropTarget === 'bottom' ? 'border-accent bg-accent/12' : 'border-[var(--line)] bg-bg-1/30'}`} />
          <div className="absolute inset-0 flex items-center justify-center"><div className="rounded-full border border-accent/40 bg-bg-0/92 px-4 py-2 text-xs tracking-[0.24em] text-accent">{t(`editor.drop.${dropTarget}` as never)}</div></div>
        </div>}
        {primaryEditor && secondaryEditor && editorSplitDirection ? <div ref={splitContainerRef} className={`flex h-full min-h-0 ${editorSplitDirection === 'horizontal' ? 'flex-row' : 'flex-col'}`}><div style={editorSplitDirection === 'horizontal' ? { flexBasis: `${editorSplitRatio * 100}%` } : { flexBasis: `${editorSplitRatio * 100}%` }} className="min-h-0 min-w-0 flex shrink-0 grow-0">{renderPane(primaryEditor, primaryGroupEditors, 'primary')}</div><div data-testid="editor-split-resizer" onPointerDown={(event) => {
          splitResizeRef.current = { active: true, direction: editorSplitDirection, startRatio: editorSplitRatio }
          document.body.style.cursor = editorSplitDirection === 'horizontal' ? 'col-resize' : 'row-resize'
          document.body.style.userSelect = 'none'
          event.preventDefault()
          event.stopPropagation()
        }} className={editorSplitDirection === 'horizontal' ? 'w-1 cursor-col-resize bg-[var(--line)] hover:bg-accent/40' : 'h-1 cursor-row-resize bg-[var(--line)] hover:bg-accent/40'} /><div className="min-h-0 min-w-0 flex flex-1">{renderPane(secondaryEditor, secondaryGroupEditors, 'secondary')}</div></div> : <div className="flex h-full min-h-0 flex-col">{renderTabStrip(primaryGroupEditors.length ? primaryGroupEditors : [activeEditor], 'primary')}{renderSurface(activeEditor, true)}</div>}
      </div>
      <ConfirmDialog open={!!pendingCloseEditorId} title={t('editor.closeConfirm', { name: openEditors.find((e) => e.id === pendingCloseEditorId)?.name || '' })} message="" confirmLabel={t('common.confirm')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingCloseEditorId(null)} onConfirm={() => { if (pendingCloseEditorId) { closeEditor(pendingCloseEditorId); setPendingCloseEditorId(null) } }} />
    </section>
  )
}
