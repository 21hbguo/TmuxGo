'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { getEditorLanguage, openFileInEditor } from '@/lib/editor-open'
import { ActivityBar } from './ActivityBar'
import { FilePanel } from './FilePanel'
import { SessionThumbnailPanel } from './SessionThumbnailPanel'
import { GitPanel } from './GitPanel'
import { SessionPanel } from './SessionPanel'
import { SessionRail } from './SessionRail'
import { EditorWorkbench } from './EditorWorkbench'
import { TerminalDock } from './TerminalDock'
import { useTranslation } from '@/i18n'

const ACTIVITY_BAR_WIDTH = 56
const SESSION_RAIL_WIDTH = 109
function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
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
  const thumbnailPanelOpen = useConsoleStore((state) => state.thumbnailPanelOpen)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const gitPanelWidth = useConsoleStore((state) => state.gitPanelWidth)
  const setGitPanelWidth = useConsoleStore((state) => state.setGitPanelWidth)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const setSessionPanelWidth = useConsoleStore((state) => state.setSessionPanelWidth)
  const setFilePanelWidth = useConsoleStore((state) => state.setFilePanelWidth)
  const setFilePanelOpen = useConsoleStore((state) => state.setFilePanelOpen)
  const setEditorSaving = useConsoleStore((state) => state.setEditorSaving)
  const markEditorSaved = useConsoleStore((state) => state.markEditorSaved)
  const openCompareEditor = useConsoleStore((state) => state.openCompareEditor)
  const placeEditorInSplit = useConsoleStore((state) => state.placeEditorInSplit)
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
  const compactSessionWidth = clampValue(Math.floor(viewportWidth * 0.10), 70, SESSION_RAIL_WIDTH)
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
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'desktop-workbench', sessionPanelExpanded, sessionPanelWidth, filePanelOpen, thumbnailPanelOpen, filePanelWidth, gitPanelOpen, gitPanelWidth, editorsOpen: openEditors.length > 0, terminalPanelHeight } }))
  }, [filePanelOpen, filePanelWidth, gitPanelOpen, gitPanelWidth, openEditors.length, sessionPanelExpanded, sessionPanelWidth, terminalPanelHeight, thumbnailPanelOpen])
  const handleOpenFile = useCallback(async (file: FileDocumentHandle) => {
    await openFileInEditor(file, { t, pushToast, openPanel: true })
  }, [pushToast, t])
  const handleOpenFileForDrop = useCallback(async (file: FileDocumentHandle) => {
    const existing = useConsoleStore.getState().openEditors.find((item) => item.id === file.id)
    if (existing && !existing.loading) {
      useConsoleStore.getState().setActiveEditor(existing.id)
      return existing.id
    }
    await handleOpenFile(file)
    return useConsoleStore.getState().openEditors.find((item) => item.id === file.id)?.id || file.id
  }, [handleOpenFile])
  const handleOpenFileAtPosition = useCallback(async (file: FileDocumentHandle, placement: 'center' | 'left' | 'right' | 'top' | 'bottom') => {
    const id = await handleOpenFileForDrop(file)
    placeEditorInSplit(id, placement)
    return id
  }, [handleOpenFileForDrop, placeEditorInSplit])
  const handleCreateCompare = useCallback(async (source: FileDocumentHandle, targetId: string) => {
    const target = useConsoleStore.getState().openEditors.find((item) => item.id === targetId)
    if (!target || target.kind === 'compare') return
    const sourceId = await handleOpenFileForDrop(source)
    const openedSource = useConsoleStore.getState().openEditors.find((item) => item.id === sourceId)
    const openedTarget = useConsoleStore.getState().openEditors.find((item) => item.id === targetId)
    if (!openedSource || !openedTarget || openedSource.binary || openedTarget.binary || openedSource.truncated || openedTarget.truncated || openedSource.loading || openedTarget.loading) {
      pushToast({ type: 'error', message: t('editor.compareUnavailable') })
      return
    }
    openCompareEditor(openedSource.id, openedTarget.id)
  }, [handleOpenFileForDrop, openCompareEditor, pushToast, t])
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
      {(filePanelOpen || thumbnailPanelOpen) && (
        <div className="relative shrink-0 border-r border-[var(--line)] bg-bg-1" style={{ width: renderedFilePanelWidth }}>
          <div className="h-full min-h-0">
            {filePanelOpen ? <FilePanel mode="explorer" onOpenFile={handleOpenFile} /> : <SessionThumbnailPanel />}
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
            <div className="min-h-0 flex-1">
              <EditorWorkbench onSaveEditor={handleSaveEditor} onOpenFile={handleOpenFileForDrop} onOpenFileAtPosition={handleOpenFileAtPosition} onCreateCompare={handleCreateCompare} />
            </div>
            <TerminalDock minHeight={terminalMinHeight} maxHeight={terminalMaxHeight} dragViewportHeight={viewportHeight} />
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
