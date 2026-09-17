'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { getEditorLanguage, openFileInEditor } from '@/lib/editor-open'
import { ActivityBar } from './ActivityBar'
import { FilePanel } from './FilePanel'
import { GitPanel } from './GitPanel'
import { SshPanel } from './SshPanel'
import { SessionPanel } from './SessionPanel'
import { SessionRail } from './SessionRail'
import { EditorWorkbench } from './EditorWorkbench'
import { TerminalDock } from './TerminalDock'
import { SessionSplitView } from './SessionSplitView'
import { useSplitGroups } from '@/hooks/useSplitGroups'
import { useTranslation } from '@/i18n'
import { PluginView } from './PluginView'
import { isTerminalDockDrag } from '@/lib/terminal-dock-drag'
import type { TerminalDockPosition } from '@/stores/useConsoleStore'

const ACTIVITY_BAR_WIDTH = 56
const SESSION_RAIL_WIDTH = 109
function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function DesktopWorkbench() {
  const { t } = useTranslation()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const sessionPanelWidth = useConsoleStore((state) => state.sessionPanelWidth)
  const filePanelWidth = useConsoleStore((state) => state.filePanelWidth)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const sshPanelOpen = useConsoleStore((state) => state.sshPanelOpen)
  const activeSplitGroupId = useConsoleStore((state) => state.activeSplitGroupId)
  const activePluginView = useConsoleStore((state) => state.activePluginView)
  const setActivePluginView = useConsoleStore((state) => state.setActivePluginView)
  const { groups: splitGroups } = useSplitGroups()
  const activeSplitGroup = splitGroups.find((item) => item.id === activeSplitGroupId) || null
  const gitPanelWidth = useConsoleStore((state) => state.gitPanelWidth)
  const setGitPanelWidth = useConsoleStore((state) => state.setGitPanelWidth)
  const sshPanelWidth = useConsoleStore((state) => state.sshPanelWidth)
  const setSshPanelWidth = useConsoleStore((state) => state.setSshPanelWidth)
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
  const resizingRef = useRef<'session' | 'file' | 'git' | 'ssh' | null>(null)
  const restoredRef = useRef(false)
  const pendingSessionWidthRef = useRef(sessionPanelWidth)
  const pendingFileWidthRef = useRef(filePanelWidth)
  const pendingGitWidthRef = useRef(gitPanelWidth)
  const pendingSshWidthRef = useRef(sshPanelWidth)
  const frameRef = useRef<number | null>(null)
  const [previewSessionWidth, setPreviewSessionWidth] = useState<number | null>(null)
  const [previewFileWidth, setPreviewFileWidth] = useState<number | null>(null)
  const [previewGitWidth, setPreviewGitWidth] = useState<number | null>(null)
  const [previewSshWidth, setPreviewSshWidth] = useState<number | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const viewportWidth = containerSize.width || 1440
  const viewportHeight = containerSize.height || 820
  const minWorkspaceWidth = viewportWidth < 1180 ? 420 : 560
  const sessionPanelMin = clampValue(Math.floor(viewportWidth * 0.16), 208, 232)
  const sessionPanelMax = clampValue(Math.floor(viewportWidth * 0.22), sessionPanelMin, 320)
  const renderedSessionPanelWidth = clampValue(
    previewSessionWidth ?? sessionPanelWidth,
    sessionPanelMin,
    sessionPanelMax,
  )
  const compactSessionWidth = clampValue(Math.floor(viewportWidth * 0.1), 70, SESSION_RAIL_WIDTH)
  const leftWidth = ACTIVITY_BAR_WIDTH + (sessionPanelExpanded ? renderedSessionPanelWidth : compactSessionWidth)
  const gitPanelMin = clampValue(Math.floor(viewportWidth * 0.3), 380, 460)
  const gitPanelMax = Math.max(gitPanelMin, Math.min(920, viewportWidth - leftWidth - minWorkspaceWidth))
  const renderedGitPanelWidth = clampValue(previewGitWidth ?? gitPanelWidth, gitPanelMin, gitPanelMax)
  const sshPanelMin = 260
  const sshPanelMax = Math.max(sshPanelMin, Math.min(480, viewportWidth - leftWidth - minWorkspaceWidth))
  const renderedSshPanelWidth = clampValue(previewSshWidth ?? sshPanelWidth, sshPanelMin, sshPanelMax)
  const filePanelAvailable =
    viewportWidth -
    leftWidth -
    (gitPanelOpen ? renderedGitPanelWidth : 0) -
    (sshPanelOpen ? renderedSshPanelWidth : 0) -
    minWorkspaceWidth
  const filePanelMaxBase = clampValue(Math.floor(viewportWidth * 0.36), 320, 520)
  const filePanelMax = clampValue(Math.min(filePanelMaxBase, filePanelAvailable), 240, filePanelMaxBase)
  const filePanelMin = clampValue(Math.floor(viewportWidth * 0.16), 200, Math.min(320, filePanelMax))
  const renderedFilePanelWidth = clampValue(previewFileWidth ?? filePanelWidth, filePanelMin, filePanelMax)
  const terminalMinHeight = clampValue(Math.floor(viewportHeight * 0.22), 150, 220)
  const terminalInlineMaxHeight = clampValue(Math.floor(viewportHeight * 0.58), terminalMinHeight, 760)
  const terminalMaxHeight = clampValue(viewportHeight - 12, terminalInlineMaxHeight, 2000)
  const workspaceWidth = Math.max(
    320,
    viewportWidth -
      leftWidth -
      (filePanelOpen ? renderedFilePanelWidth : 0) -
      (gitPanelOpen ? renderedGitPanelWidth : 0) -
      (sshPanelOpen ? renderedSshPanelWidth : 0),
  )
  const terminalMinWidth = clampValue(Math.floor(viewportWidth * 0.18), 260, 440)
  // 侧向停靠时给编辑区保留 ≥160px 即可，终端可以拉到接近全宽
  const terminalMaxWidth = clampValue(workspaceWidth - 160, terminalMinWidth, 2000)
  const terminalPanelHeight = useConsoleStore((state) => state.terminalPanelHeight)
  const terminalDock = useConsoleStore((state) => state.terminalDock)
  const setTerminalDock = useConsoleStore((state) => state.setTerminalDock)
  const editorsHydrated = useConsoleStore((state) => state.editorsHydrated)
  const [dockDragActive, setDockDragActive] = useState(false)
  const [dockDropSide, setDockDropSide] = useState<TerminalDockPosition | null>(null)
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () =>
      setContainerSize({ width: Math.round(element.clientWidth), height: Math.round(element.clientHeight) })
    update()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(element)
    }
    return () => {
      observer?.disconnect()
    }
  }, [])
  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (resizingRef.current === 'session') {
        pendingSessionWidthRef.current = clampValue(
          event.clientX - ACTIVITY_BAR_WIDTH,
          sessionPanelMin,
          sessionPanelMax,
        )
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewSessionWidth(pendingSessionWidthRef.current)
        })
        return
      }
      if (resizingRef.current === 'file') {
        const sessionOffset =
          ACTIVITY_BAR_WIDTH +
          (sessionPanelExpanded
            ? (previewSessionWidth ?? pendingSessionWidthRef.current ?? renderedSessionPanelWidth)
            : compactSessionWidth)
        pendingFileWidthRef.current = clampValue(event.clientX - sessionOffset, filePanelMin, filePanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewFileWidth(pendingFileWidthRef.current)
        })
        return
      }
      if (resizingRef.current === 'git') {
        const sessionOffset =
          ACTIVITY_BAR_WIDTH +
          (sessionPanelExpanded
            ? (previewSessionWidth ?? pendingSessionWidthRef.current ?? renderedSessionPanelWidth)
            : compactSessionWidth)
        const fileOffset =
          sessionOffset +
          (filePanelOpen ? (previewFileWidth ?? pendingFileWidthRef.current ?? renderedFilePanelWidth) : 0)
        pendingGitWidthRef.current = clampValue(event.clientX - fileOffset, gitPanelMin, gitPanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewGitWidth(pendingGitWidthRef.current)
        })
        return
      }
      if (resizingRef.current === 'ssh') {
        const sessionOffset =
          ACTIVITY_BAR_WIDTH +
          (sessionPanelExpanded
            ? (previewSessionWidth ?? pendingSessionWidthRef.current ?? renderedSessionPanelWidth)
            : compactSessionWidth)
        const fileOffset =
          sessionOffset +
          (filePanelOpen ? (previewFileWidth ?? pendingFileWidthRef.current ?? renderedFilePanelWidth) : 0)
        const gitOffset =
          fileOffset + (gitPanelOpen ? (previewGitWidth ?? pendingGitWidthRef.current ?? renderedGitPanelWidth) : 0)
        pendingSshWidthRef.current = clampValue(event.clientX - gitOffset, sshPanelMin, sshPanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewSshWidth(pendingSshWidthRef.current)
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
      if (resizingRef.current === 'ssh') {
        setSshPanelWidth(pendingSshWidthRef.current)
        setPreviewSshWidth(null)
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
  }, [
    compactSessionWidth,
    filePanelMax,
    filePanelMin,
    gitPanelMax,
    gitPanelMin,
    previewSessionWidth,
    previewSshWidth,
    renderedSessionPanelWidth,
    renderedSshPanelWidth,
    sessionPanelExpanded,
    sessionPanelMax,
    sessionPanelMin,
    setFilePanelWidth,
    setGitPanelWidth,
    setSessionPanelWidth,
    setSshPanelWidth,
    sshPanelMax,
    sshPanelMin,
  ])
  const handleOpenFile = useCallback(
    async (file: FileDocumentHandle) => {
      await openFileInEditor(file, { t, pushToast, openPanel: true })
    },
    [pushToast, t],
  )
  const handleOpenFileForDrop = useCallback(
    async (file: FileDocumentHandle) => {
      if (file.type === 'directory') return ''
      const existing = useConsoleStore.getState().openEditors.find((item) => item.id === file.id)
      if (existing && !existing.loading) {
        useConsoleStore.getState().setActiveEditor(existing.id)
        return existing.id
      }
      // 拖拽打开视为显式打开：钉住新 tab，保留目标组已有预览 tab
      await openFileInEditor(file, { t, pushToast, openPanel: true, pinned: true })
      return useConsoleStore.getState().openEditors.find((item) => item.id === file.id)?.id || file.id
    },
    [pushToast, t],
  )
  const handleOpenFileAtPosition = useCallback(
    async (file: FileDocumentHandle, placement: 'center' | 'left' | 'right' | 'top' | 'bottom') => {
      const id = await handleOpenFileForDrop(file)
      placeEditorInSplit(id, placement)
      return id
    },
    [handleOpenFileForDrop, placeEditorInSplit],
  )
  const handleCreateCompare = useCallback(
    async (source: FileDocumentHandle, targetId: string) => {
      const target = useConsoleStore.getState().openEditors.find((item) => item.id === targetId)
      if (!target || target.kind === 'compare') return
      const sourceId = await handleOpenFileForDrop(source)
      const openedSource = useConsoleStore.getState().openEditors.find((item) => item.id === sourceId)
      const openedTarget = useConsoleStore.getState().openEditors.find((item) => item.id === targetId)
      if (
        !openedSource ||
        !openedTarget ||
        openedSource.binary ||
        openedTarget.binary ||
        openedSource.truncated ||
        openedTarget.truncated ||
        openedSource.loading ||
        openedTarget.loading
      ) {
        pushToast({ type: 'error', message: t('editor.compareUnavailable') })
        return
      }
      openCompareEditor(openedSource.id, openedTarget.id)
    },
    [handleOpenFileForDrop, openCompareEditor, pushToast, t],
  )
  useEffect(() => {
    const handleDragStart = (event: DragEvent) => setDockDragActive(isTerminalDockDrag(event.dataTransfer))
    const handleDragEnd = () => {
      setDockDragActive(false)
      setDockDropSide(null)
    }
    window.addEventListener('dragstart', handleDragStart)
    window.addEventListener('dragend', handleDragEnd)
    window.addEventListener('drop', handleDragEnd)
    return () => {
      window.removeEventListener('dragstart', handleDragStart)
      window.removeEventListener('dragend', handleDragEnd)
      window.removeEventListener('drop', handleDragEnd)
    }
  }, [])
  useEffect(() => {
    if (!editorsHydrated) return
    if (restoredRef.current) return
    restoredRef.current = true
    const editors = useConsoleStore.getState().openEditors
    if (!editors.length) return
    setFilePanelOpen(true)
    for (const editor of editors) void handleOpenFile(editor)
  }, [editorsHydrated, handleOpenFile, setFilePanelOpen])
  const handleSaveEditor = useCallback(
    async (editor: FileEditorDocument) => {
      if (editor.loading || editor.binary || editor.truncated) return
      setEditorSaving(editor.id, true)
      try {
        const result = await api.files.saveContent(
          editor.hostId,
          editor.rootId,
          editor.path,
          editor.content,
          editor.modifiedAt || undefined,
        )
        markEditorSaved(editor.id, result.content, result.modifiedAt, result.size)
        pushToast({ type: 'success', message: t('editor.saved') })
      } catch (err) {
        setEditorSaving(editor.id, false)
        const message = err instanceof Error ? err.message : t('desktop.saveFailed')
        pushToast({ type: 'error', message })
      }
    },
    [markEditorSaved, pushToast, setEditorSaving],
  )
  if (!mounted) {
    return (
      <div className="tmuxgo-workspace flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ActivityBar />
        <SessionRail />
        <div className="tmuxgo-content-surface min-h-0 flex-1" />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="tmuxgo-workspace flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <ActivityBar />
      <>
        {sessionPanelExpanded ? (
          <div
            className="tmuxgo-content-surface relative shrink-0 border-r border-[var(--line)]"
            style={{ width: renderedSessionPanelWidth }}
          >
            <div className="h-full min-h-0">
              <SessionPanel />
            </div>
            <div
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
              onMouseDown={() => {
                resizingRef.current = 'session'
                pendingSessionWidthRef.current = sessionPanelWidth
                setPreviewSessionWidth(sessionPanelWidth)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
            />
          </div>
        ) : (
          <SessionRail />
        )}
        {filePanelOpen && (
          <div
            className="tmuxgo-content-surface relative shrink-0 overflow-hidden border-r border-[var(--line)]"
            style={{ width: renderedFilePanelWidth }}
          >
            <div className="h-full min-h-0 overflow-hidden">
              <FilePanel mode="explorer" onOpenFile={handleOpenFile} />
            </div>
            <div
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
              onMouseDown={() => {
                resizingRef.current = 'file'
                pendingFileWidthRef.current = filePanelWidth
                setPreviewFileWidth(filePanelWidth)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
            />
          </div>
        )}
        {gitPanelOpen && (
          <div
            className="tmuxgo-content-surface relative shrink-0 border-r border-[var(--line)]"
            style={{ width: renderedGitPanelWidth }}
          >
            <div className="h-full min-h-0">
              <GitPanel />
            </div>
            <div
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
              onMouseDown={() => {
                resizingRef.current = 'git'
                pendingGitWidthRef.current = gitPanelWidth
                setPreviewGitWidth(gitPanelWidth)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
            />
          </div>
        )}
        {sshPanelOpen && (
          <div
            className="tmuxgo-content-surface relative shrink-0 border-r border-[var(--line)]"
            style={{ width: renderedSshPanelWidth }}
          >
            <div className="h-full min-h-0">
              <SshPanel />
            </div>
            <div
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
              onMouseDown={() => {
                resizingRef.current = 'ssh'
                pendingSshWidthRef.current = sshPanelWidth
                setPreviewSshWidth(sshPanelWidth)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
            />
          </div>
        )}
        {activePluginView && (
          <PluginView
            pluginId={activePluginView.pluginId}
            viewId={activePluginView.viewId}
            onClose={() => setActivePluginView(null)}
          />
        )}
        <div
          className={`tmuxgo-content-surface relative flex min-h-0 min-w-0 flex-1 ${terminalDock === 'bottom' ? 'flex-col' : 'flex-row'}`}
        >
          {activeSplitGroup ? (
            <SessionSplitView group={activeSplitGroup} />
          ) : (
            <>
              {/* TerminalDock 必须固定在同一个 JSX 位置：开关编辑器只改 props，避免 xterm 卸载重建导致的二次 attach/resize */}
              <TerminalDock
                fill={openEditors.length === 0 && terminalDock === 'bottom'}
                dock={terminalDock}
                minHeight={terminalMinHeight}
                maxHeight={terminalMaxHeight}
                dragViewportHeight={viewportHeight}
                minWidth={terminalMinWidth}
                maxWidth={terminalMaxWidth}
                dragViewportWidth={workspaceWidth}
              />
              {openEditors.length > 0 || terminalDock !== 'bottom' ? (
                <div className="min-h-0 min-w-0 flex-1">
                  {openEditors.length > 0 ? (
                    <EditorWorkbench
                      onSaveEditor={handleSaveEditor}
                      onOpenFile={handleOpenFileForDrop}
                      onOpenFileAtPosition={handleOpenFileAtPosition}
                      onCreateCompare={handleCreateCompare}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-text-3">
                      {t('editor.emptyArea')}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
          {dockDragActive &&
            !activeSplitGroup &&
            (['left', 'right', 'bottom'] as TerminalDockPosition[]).map((zone) => (
              <div
                key={zone}
                className={`absolute z-30 transition-colors ${zone === 'left' ? 'left-0 top-0 bottom-0 w-24' : zone === 'right' ? 'right-0 top-0 bottom-0 w-24' : 'left-0 right-0 bottom-0 h-24'} ${dockDropSide === zone ? 'bg-accent/25' : 'bg-accent/5'}`}
                onDragOver={(event) => {
                  if (!isTerminalDockDrag(event.dataTransfer)) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dockDropSide !== zone) setDockDropSide(zone)
                }}
                onDragLeave={() => {
                  if (dockDropSide === zone) setDockDropSide(null)
                }}
                onDrop={(event) => {
                  if (!isTerminalDockDrag(event.dataTransfer)) return
                  event.preventDefault()
                  setTerminalDock(zone)
                  setDockDragActive(false)
                  setDockDropSide(null)
                }}
              />
            ))}
        </div>
      </>
    </div>
  )
}
