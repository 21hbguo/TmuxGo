'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { ActivityBar } from './ActivityBar'
import { FilePanel } from './FilePanel'
import { GitPanel } from './GitPanel'
import { SessionPanel } from './SessionPanel'
import { SessionRail } from './SessionRail'
import { EditorWorkbench } from './EditorWorkbench'
import { TerminalDock } from './TerminalDock'
import { useTranslation } from '@/i18n'

const ACTIVITY_BAR_WIDTH = 56
const SESSION_RAIL_WIDTH = 136
const IMAGE_EXTENSIONS = new Set(['.avif','.bmp','.gif','.ico','.jpeg','.jpg','.png','.tif','.tiff','.webp'])
function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
function isImagePath(path: string) {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(lower.slice(dot))
}
function getEditorLanguage(path: string) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'plaintext'
  if (name.endsWith('.c')) return 'c'
  if (name.endsWith('.cc') || name.endsWith('.cpp') || name.endsWith('.cxx') || name.endsWith('.hpp') || name.endsWith('.h')) return 'cpp'
  if (name.endsWith('.ts')) return 'typescript'
  if (name.endsWith('.tsx')) return 'typescript'
  if (name.endsWith('.js')) return 'javascript'
  if (name.endsWith('.jsx')) return 'javascript'
  if (name.endsWith('.mjs') || name.endsWith('.cjs')) return 'javascript'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.jsonc')) return 'json'
  if (name.endsWith('.md')) return 'markdown'
  if (name.endsWith('.css')) return 'css'
  if (name.endsWith('.scss')) return 'scss'
  if (name.endsWith('.less')) return 'less'
  if (name.endsWith('.html')) return 'html'
  if (name.endsWith('.xml') || name.endsWith('.svg')) return 'xml'
  if (name.endsWith('.sh')) return 'shell'
  if (name.endsWith('.bash') || name.endsWith('.zsh')) return 'shell'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.go')) return 'go'
  if (name.endsWith('.java')) return 'java'
  if (name.endsWith('.kt')) return 'kotlin'
  if (name.endsWith('.rs')) return 'rust'
  if (name.endsWith('.php')) return 'php'
  if (name.endsWith('.rb')) return 'ruby'
  if (name.endsWith('.sql')) return 'sql'
  if (name.endsWith('.toml')) return 'ini'
  if (name.endsWith('.ini') || name.endsWith('.cfg') || name.endsWith('.conf')) return 'ini'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml'
  return 'plaintext'
}

export function DesktopWorkbench() {
  const { t } = useTranslation()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const sessionPanelWidth = useConsoleStore((state) => state.sessionPanelWidth)
  const filePanelWidth = useConsoleStore((state) => state.filePanelWidth)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const gitPanelWidth = useConsoleStore((state) => state.gitPanelWidth)
  const setGitPanelWidth = useConsoleStore((state) => state.setGitPanelWidth)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const setSessionPanelWidth = useConsoleStore((state) => state.setSessionPanelWidth)
  const setFilePanelWidth = useConsoleStore((state) => state.setFilePanelWidth)
  const setFilePanelOpen = useConsoleStore((state) => state.setFilePanelOpen)
  const openEditor = useConsoleStore((state) => state.openEditor)
  const setEditorLoaded = useConsoleStore((state) => state.setEditorLoaded)
  const setEditorSaving = useConsoleStore((state) => state.setEditorSaving)
  const markEditorSaved = useConsoleStore((state) => state.markEditorSaved)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const containerRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef<'session' | 'file' | 'git' | null>(null)
  const restoredRef = useRef(false)
  const pendingSessionWidthRef = useRef(sessionPanelWidth)
  const pendingFileWidthRef = useRef(filePanelWidth)
  const pendingGitWidthRef = useRef(gitPanelWidth)
  const frameRef = useRef<number | null>(null)
  const [previewSessionWidth, setPreviewSessionWidth] = useState<number | null>(null)
  const [previewFileWidth, setPreviewFileWidth] = useState<number | null>(null)
  const [previewGitWidth, setPreviewGitWidth] = useState<number | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const viewportWidth = containerSize.width || 1440
  const viewportHeight = containerSize.height || 820
  const minWorkspaceWidth = viewportWidth < 1180 ? 420 : 560
  const sessionPanelMin = clampValue(Math.floor(viewportWidth * 0.16), 208, 232)
  const sessionPanelMax = clampValue(Math.floor(viewportWidth * 0.22), sessionPanelMin, 320)
  const renderedSessionPanelWidth = clampValue(previewSessionWidth ?? sessionPanelWidth, sessionPanelMin, sessionPanelMax)
  const compactSessionWidth = clampValue(Math.floor(viewportWidth * 0.13), 88, SESSION_RAIL_WIDTH)
  const leftWidth = ACTIVITY_BAR_WIDTH + (sessionPanelExpanded ? renderedSessionPanelWidth : compactSessionWidth)
  const gitPanelMin = 260
  const gitPanelMax = 400
  const renderedGitPanelWidth = clampValue(previewGitWidth ?? gitPanelWidth, gitPanelMin, gitPanelMax)
  const filePanelAvailable = viewportWidth - leftWidth - (gitPanelOpen ? renderedGitPanelWidth : 0) - minWorkspaceWidth
  const filePanelMaxBase = clampValue(Math.floor(viewportWidth * 0.36), 320, 520)
  const filePanelMax = clampValue(Math.min(filePanelMaxBase, filePanelAvailable), 240, filePanelMaxBase)
  const filePanelMin = clampValue(Math.floor(viewportWidth * 0.16), 200, Math.min(320, filePanelMax))
  const renderedFilePanelWidth = clampValue(previewFileWidth ?? filePanelWidth, filePanelMin, filePanelMax)
  const terminalMinHeight = clampValue(Math.floor(viewportHeight * 0.22), 150, 220)
  const terminalInlineMaxHeight = clampValue(Math.floor(viewportHeight * 0.58), terminalMinHeight, 760)
  const terminalMaxHeight = clampValue(viewportHeight - 12, terminalInlineMaxHeight, 2000)
  const terminalPanelHeight = useConsoleStore((state) => state.terminalPanelHeight)
  const editorsHydrated = useConsoleStore((state) => state.editorsHydrated)
  const hydrateEditorsFromStorage = useConsoleStore((state) => state.hydrateEditorsFromStorage)
  const terminalOverlay = openEditors.length > 0 && terminalPanelHeight > terminalInlineMaxHeight
  const terminalOverlayTopOffset = clampValue(viewportHeight - terminalPanelHeight, 0, viewportHeight)
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () => setContainerSize({ width: Math.round(element.clientWidth), height: Math.round(element.clientHeight) })
    update()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(element)
    }
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])
  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (resizingRef.current === 'session') {
        pendingSessionWidthRef.current = clampValue(event.clientX - ACTIVITY_BAR_WIDTH, sessionPanelMin, sessionPanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewSessionWidth(pendingSessionWidthRef.current)
        })
        return
      }
      if (resizingRef.current === 'file') {
        const sessionOffset = ACTIVITY_BAR_WIDTH + (sessionPanelExpanded ? (previewSessionWidth ?? pendingSessionWidthRef.current ?? renderedSessionPanelWidth) : compactSessionWidth)
        pendingFileWidthRef.current = clampValue(event.clientX - sessionOffset, filePanelMin, filePanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewFileWidth(pendingFileWidthRef.current)
        })
        return
      }
      if (resizingRef.current === 'git') {
        const sessionOffset = ACTIVITY_BAR_WIDTH + (sessionPanelExpanded ? (previewSessionWidth ?? pendingSessionWidthRef.current ?? renderedSessionPanelWidth) : compactSessionWidth)
        const fileOffset = sessionOffset + (filePanelOpen ? (previewFileWidth ?? pendingFileWidthRef.current ?? renderedFilePanelWidth) : 0)
        pendingGitWidthRef.current = clampValue(event.clientX - fileOffset, gitPanelMin, gitPanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewGitWidth(pendingGitWidthRef.current)
        })
      }
    }
    const handleUp = () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resizingRef.current === 'session') {
        setSessionPanelWidth(pendingSessionWidthRef.current)
        setPreviewSessionWidth(null)
      }
      if (resizingRef.current === 'file') {
        setFilePanelWidth(pendingFileWidthRef.current)
        setPreviewFileWidth(null)
      }
      if (resizingRef.current === 'git') {
        setGitPanelWidth(pendingGitWidthRef.current)
        setPreviewGitWidth(null)
      }
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [compactSessionWidth, filePanelMax, filePanelMin, previewSessionWidth, renderedSessionPanelWidth, sessionPanelExpanded, sessionPanelMax, sessionPanelMin, setFilePanelWidth, setSessionPanelWidth])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'desktop-workbench', sessionPanelExpanded, sessionPanelWidth, filePanelOpen, filePanelWidth, gitPanelOpen, gitPanelWidth, editorsOpen: openEditors.length > 0, terminalPanelHeight, terminalOverlay } }))
  }, [filePanelOpen, filePanelWidth, gitPanelOpen, gitPanelWidth, openEditors.length, sessionPanelExpanded, sessionPanelWidth, terminalOverlay, terminalPanelHeight])
  const handleOpenFile = useCallback(async (file: FileDocumentHandle) => {
    setFilePanelOpen(true)
    const existing = useConsoleStore.getState().openEditors.find((item) => item.id === file.id)
    openEditor({ ...file, language: existing?.language || getEditorLanguage(file.path) })
    if (isImagePath(file.path)) {
      setEditorLoaded(file.id, {
        loading: false,
        content: '',
        savedContent: '',
        modifiedAt: existing?.modifiedAt || '',
        size: existing?.size || 0,
        binary: true,
        truncated: false,
        problem: undefined,
        previewUrl: api.files.imageUrl(file.hostId, file.rootId, file.path),
      })
      return
    }
    if (existing && !existing.loading && (!!existing.modifiedAt || !!existing.problem || existing.binary || existing.truncated)) return
    try {
      const result = await api.files.content(file.hostId, file.rootId, file.path)
      setEditorLoaded(file.id, {
        loading: false,
        content: result.content,
        savedContent: result.content,
        modifiedAt: result.modifiedAt,
        size: result.size,
        binary: result.binary,
        truncated: result.truncated,
        problem: result.reason === 'large-file' ? t('desktop.largePreviewMode') : result.reason === 'binary-file' ? t('desktop.binaryNotEditable') : result.reason === 'directory' ? t('desktop.directoryNotEditable') : undefined,
        previewUrl: undefined,
      })
    } catch (err) {
      setEditorLoaded(file.id, { loading: false, problem: err instanceof Error ? err.message : t('desktop.openFailed') })
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('desktop.openFailed') })
    }
  }, [openEditor, pushToast, setEditorLoaded, setFilePanelOpen])
  useEffect(() => {
    hydrateEditorsFromStorage()
  }, [hydrateEditorsFromStorage])
  useEffect(() => {
    if (!editorsHydrated) return
    if (restoredRef.current) return
    restoredRef.current = true
    const editors = useConsoleStore.getState().openEditors
    if (!editors.length) return
    setFilePanelOpen(true)
    for (const editor of editors) void handleOpenFile(editor)
  }, [editorsHydrated, handleOpenFile, setFilePanelOpen])
  const handleSaveEditor = useCallback(async (editor: FileEditorDocument) => {
    if (editor.loading || editor.binary || editor.truncated) return
    setEditorSaving(editor.id, true)
    try {
      const result = await api.files.saveContent(editor.hostId, editor.rootId, editor.path, editor.content, editor.modifiedAt || undefined)
      markEditorSaved(editor.id, result.content, result.modifiedAt, result.size)
      pushToast({ type: 'success', message: t('editor.saved') })
    } catch (err) {
      setEditorSaving(editor.id, false)
      const message = err instanceof Error ? err.message : t('desktop.saveFailed')
      pushToast({ type: 'error', message })
    }
  }, [markEditorSaved, pushToast, setEditorSaving])
  if (!mounted) {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <ActivityBar />
        <SessionRail />
        <div className="min-h-0 flex-1 bg-bg-1" />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <ActivityBar />
      {sessionPanelExpanded ? (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: renderedSessionPanelWidth }}>
          <div className="h-full min-h-0">
            <SessionPanel />
          </div>
          <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={() => {
            resizingRef.current = 'session'
            pendingSessionWidthRef.current = sessionPanelWidth
            setPreviewSessionWidth(sessionPanelWidth)
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }} />
        </div>
      ) : <SessionRail />}
      {filePanelOpen && (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: renderedFilePanelWidth }}>
          <div className="h-full min-h-0">
            <FilePanel mode="explorer" onOpenFile={handleOpenFile} />
          </div>
          <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={() => {
            resizingRef.current = 'file'
            pendingFileWidthRef.current = filePanelWidth
            setPreviewFileWidth(filePanelWidth)
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }} />
        </div>
      )}
      {gitPanelOpen && (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: renderedGitPanelWidth }}>
          <div className="h-full min-h-0">
            <GitPanel />
          </div>
          <div className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40" onMouseDown={() => {
            resizingRef.current = 'git'
            pendingGitWidthRef.current = gitPanelWidth
            setPreviewGitWidth(gitPanelWidth)
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }} />
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg-1">
        {openEditors.length > 0 ? (
          <>
            <div className={`min-h-0 flex-1 ${terminalOverlay ? 'pointer-events-none select-none opacity-50' : ''}`}>
              <EditorWorkbench onSaveEditor={handleSaveEditor} />
            </div>
            <TerminalDock minHeight={terminalMinHeight} maxHeight={terminalMaxHeight} overlay={terminalOverlay} dragViewportHeight={viewportHeight} overlayTopOffset={terminalOverlayTopOffset} />
          </>
        ) : (
          <div className="min-h-0 flex-1">
            <TerminalDock fill />
          </div>
        )}
      </div>
    </div>
  )
}
