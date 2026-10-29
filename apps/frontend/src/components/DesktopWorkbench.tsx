'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isPersistableEditorMeta, TERMINAL_DOCK_POSITIONS, useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import type { FileDocumentHandle, FileEditorDocument } from '@/types'
import { openFileInEditor } from '@/lib/editor-open'
import { clearActiveDraggedFile, FILE_DRAG_MIME, getActiveDraggedFile, readDraggedFile } from '@/lib/editor-drag'
import { ActivityBar } from './ActivityBar'
import dynamic from '@/lib/dynamic'
import { SessionPanel } from './SessionPanel'
import { SessionRail } from './SessionRail'
import { EditorWorkbench } from './EditorWorkbench'
import { TerminalDock } from './TerminalDock'
import { SessionSplitView } from './SessionSplitView'
import { useSplitGroups } from '@/hooks/useSplitGroups'
import { useTranslation } from '@/i18n'
import {
  isOutsideWindowStrip,
  isTerminalDockDrag,
  setTerminalDockDragActive,
  WINDOW_TAB_DRAG_MIME,
} from '@/lib/terminal-dock-drag'
import type { TerminalDockPosition } from '@/stores/useConsoleStore'

// 默认关闭的侧栏/插件面板动态加载：开 panel 时才拉取对应 chunk，缩小主入口
const FilePanel = dynamic(() => import('./FilePanel').then((m) => ({ default: m.FilePanel })))
const GitPanel = dynamic(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })))
const SshPanel = dynamic(() => import('./SshPanel').then((m) => ({ default: m.SshPanel })))
const PluginView = dynamic(() => import('./PluginView').then((m) => ({ default: m.PluginView })))
const EndpointsPanel = dynamic(() => import('./EndpointsPanel').then((m) => ({ default: m.EndpointsPanel })))
const FleetPanel = dynamic(() => import('./FleetPanel').then((m) => ({ default: m.FleetPanel })))

const ACTIVITY_BAR_WIDTH = 56
const SESSION_RAIL_WIDTH = 109
// 拖拽吸附阈值：展开态拖过 min-48 松手收起为窄栏；窄栏拖出 +60 即时展开并接管为宽度拖拽
const SESSION_COLLAPSE_DELTA = 48
const SESSION_EXPAND_DELTA = 60
function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

type SidePanelKind = 'file' | 'git' | 'ssh' | 'fleet'
// files/git/ssh 面板共用外壳：定宽 surface + 右缘拖拽手柄；clip=内容需裁剪（如 FilePanel 溢出内容）
function SidePanelShell({
  clip,
  width,
  resizing,
  onStartResize,
  children,
}: {
  clip?: boolean
  width: number
  resizing?: boolean
  onStartResize: () => void
  children: ReactNode
}) {
  const clipCls = clip ? ' overflow-hidden' : ''
  return (
    <div
      className={`tmuxgo-content-surface relative shrink-0${clipCls} border-r border-[var(--line)]`}
      style={{ width }}
    >
      <div className={`h-full min-h-0${clipCls}`}>{children}</div>
      {/* 命中区 4px 铺在面板右缘，默认只靠面板自身的 border-r 当分隔线，hover/拖拽才给 accent 反馈 */}
      <div
        data-resize-handle="side-panel"
        aria-hidden="true"
        className={`absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors ${resizing ? 'bg-accent/70' : 'hover:bg-accent/40'}`}
        onMouseDown={onStartResize}
      />
    </div>
  )
}

export function DesktopWorkbench() {
  const { t } = useTranslation()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const sessionPanelWidth = useConsoleStore((state) => state.sessionPanelWidth)
  const sidePanelWidth = useConsoleStore((state) => state.sidePanelWidth)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const fleetPanelOpen = useConsoleStore((state) => state.fleetPanelOpen)
  const sshPanelOpen = useConsoleStore((state) => state.sshPanelOpen)
  const endpointsPanelOpen = useConsoleStore((state) => state.endpointsPanelOpen)
  const activeSplitGroupId = useConsoleStore((state) => state.activeSplitGroupId)
  const activePluginView = useConsoleStore((state) => state.activePluginView)
  const setActivePluginView = useConsoleStore((state) => state.setActivePluginView)
  const { groups: splitGroups } = useSplitGroups()
  const activeSplitGroup = splitGroups.find((item) => item.id === activeSplitGroupId) || null
  const setSidePanelWidth = useConsoleStore((state) => state.setSidePanelWidth)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const setSessionPanelWidth = useConsoleStore((state) => state.setSessionPanelWidth)
  const setSessionPanelExpanded = useConsoleStore((state) => state.setSessionPanelExpanded)
  const setFilePanelOpen = useConsoleStore((state) => state.setFilePanelOpen)
  const setEditorSaving = useConsoleStore((state) => state.setEditorSaving)
  const setEditorSaveError = useConsoleStore((state) => state.setEditorSaveError)
  const markEditorSaved = useConsoleStore((state) => state.markEditorSaved)
  const openCompareEditor = useConsoleStore((state) => state.openCompareEditor)
  const placeEditorInSplit = useConsoleStore((state) => state.placeEditorInSplit)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const containerRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef<'session' | 'file' | 'git' | 'ssh' | 'fleet' | 'rail' | null>(null)
  const sessionCollapseArmedRef = useRef(false)
  const restoredRef = useRef(false)
  const pendingSessionWidthRef = useRef(sessionPanelWidth)
  const pendingSideWidthRef = useRef(sidePanelWidth)
  const frameRef = useRef<number | null>(null)
  const [previewSessionWidth, setPreviewSessionWidth] = useState<number | null>(null)
  const [previewSideWidth, setPreviewSideWidth] = useState<number | null>(null)
  const [sessionCollapseArmed, setSessionCollapseArmed] = useState(false)
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
  // 侧面板 DOM 顺序即宽度堆叠顺序：拖拽手柄按各面板在此数组里的下标换算已占宽度。
  // fleet/endpoints/plugin 都必须计入，漏一个就会让 workspaceWidth 偏大、拖拽越界压垮主工作区
  const openSidePanels = useMemo(
    () =>
      [
        filePanelOpen && 'file',
        fleetPanelOpen && 'fleet',
        gitPanelOpen && 'git',
        sshPanelOpen && 'ssh',
        endpointsPanelOpen && 'endpoints',
        activePluginView && 'plugin',
      ].filter((kind): kind is SidePanelKind | 'endpoints' | 'plugin' => Boolean(kind)),
    [activePluginView, endpointsPanelOpen, filePanelOpen, fleetPanelOpen, gitPanelOpen, sshPanelOpen],
  )
  // files/git/ssh/endpoints 共用同一渲染宽度，切 tab 不跳；拖拽任一手柄改的都是这个值
  const sidePanelMin = clampValue(Math.floor(viewportWidth * 0.16), 200, 320)
  // 每块侧面板同宽：留出主工作区最小宽度后按已开面板数均分上限，避免多开时把主体挤没
  const sidePanelCount = Math.max(1, openSidePanels.length)
  const sidePanelMax = Math.max(
    sidePanelMin,
    Math.min(920, Math.floor((viewportWidth - leftWidth - minWorkspaceWidth) / sidePanelCount)),
  )
  const renderedSidePanelWidth = clampValue(previewSideWidth ?? sidePanelWidth, sidePanelMin, sidePanelMax)
  const terminalMinHeight = clampValue(Math.floor(viewportHeight * 0.22), 150, 220)
  const terminalInlineMaxHeight = clampValue(Math.floor(viewportHeight * 0.58), terminalMinHeight, 760)
  const terminalMaxHeight = clampValue(viewportHeight - 12, terminalInlineMaxHeight, 2000)
  const workspaceWidth = Math.max(320, viewportWidth - leftWidth - openSidePanels.length * renderedSidePanelWidth)
  const terminalMinWidth = clampValue(Math.floor(viewportWidth * 0.18), 260, 440)
  // 侧向停靠时给编辑区保留 ≥160px 即可，终端可以拉到接近全宽
  const terminalMaxWidth = clampValue(workspaceWidth - 160, terminalMinWidth, 2000)
  const terminalDock = useConsoleStore((state) => state.terminalDock)
  const setTerminalDock = useConsoleStore((state) => state.setTerminalDock)
  const editorsHydrated = useConsoleStore((state) => state.editorsHydrated)
  const [dockDragActive, setDockDragActive] = useState(false)
  const [dockDropSide, setDockDropSide] = useState<TerminalDockPosition | null>(null)
  const [emptyAreaDropActive, setEmptyAreaDropActive] = useState(false)
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
    // mounted 前渲染的是无 containerRef 的占位树，[] 依赖会让 observer 永远不挂——
    // containerSize 停在 {0,0}，viewportWidth/Height 恒为 1440/820 fallback，
    // 终端/侧栏拖拽上限全被钉死在错误值上
  }, [mounted])
  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (resizingRef.current === 'session') {
        const raw = event.clientX - ACTIVITY_BAR_WIDTH
        const armed = raw < sessionPanelMin - SESSION_COLLAPSE_DELTA
        if (armed !== sessionCollapseArmedRef.current) {
          sessionCollapseArmedRef.current = armed
          setSessionCollapseArmed(armed)
        }
        pendingSessionWidthRef.current = clampValue(raw, sessionPanelMin, sessionPanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewSessionWidth(pendingSessionWidthRef.current)
        })
        return
      }
      if (resizingRef.current === 'rail') {
        if (event.clientX - ACTIVITY_BAR_WIDTH > compactSessionWidth + SESSION_EXPAND_DELTA) {
          resizingRef.current = 'session'
          setSessionPanelExpanded(true)
          pendingSessionWidthRef.current = clampValue(
            event.clientX - ACTIVITY_BAR_WIDTH,
            sessionPanelMin,
            sessionPanelMax,
          )
          if (!frameRef.current) {
            frameRef.current = requestAnimationFrame(() => {
              frameRef.current = null
              setPreviewSessionWidth(pendingSessionWidthRef.current)
            })
          }
        }
        return
      }
      if (
        resizingRef.current === 'file' ||
        resizingRef.current === 'git' ||
        resizingRef.current === 'ssh' ||
        resizingRef.current === 'fleet'
      ) {
        // 四个面板同宽，手柄按各自面板左缘（排在其前的同宽面板数，见 openSidePanels）换算回栏宽
        const sessionOffset =
          ACTIVITY_BAR_WIDTH +
          (sessionPanelExpanded
            ? (previewSessionWidth ?? pendingSessionWidthRef.current ?? renderedSessionPanelWidth)
            : compactSessionWidth)
        const panelsBefore = Math.max(0, openSidePanels.indexOf(resizingRef.current))
        const panelOffset = sessionOffset + panelsBefore * renderedSidePanelWidth
        pendingSideWidthRef.current = clampValue(event.clientX - panelOffset, sidePanelMin, sidePanelMax)
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setPreviewSideWidth(pendingSideWidthRef.current)
        })
      }
    }
    const handleUp = () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resizingRef.current === 'session') {
        if (sessionCollapseArmedRef.current) setSessionPanelExpanded(false)
        else setSessionPanelWidth(pendingSessionWidthRef.current)
        setPreviewSessionWidth(null)
      }
      if (
        resizingRef.current === 'file' ||
        resizingRef.current === 'git' ||
        resizingRef.current === 'ssh' ||
        resizingRef.current === 'fleet'
      ) {
        setSidePanelWidth(pendingSideWidthRef.current)
        setPreviewSideWidth(null)
      }
      if (resizingRef.current) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
      resizingRef.current = null
      sessionCollapseArmedRef.current = false
      setSessionCollapseArmed(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    // 窗口失焦 mouseup 不会送达：blur 统一结算，否则 gesture end 丢失
    window.addEventListener('blur', handleUp)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('blur', handleUp)
    }
  }, [
    compactSessionWidth,
    openSidePanels,
    previewSessionWidth,
    renderedSessionPanelWidth,
    renderedSidePanelWidth,
    sessionPanelExpanded,
    sessionPanelMax,
    sessionPanelMin,
    setSessionPanelExpanded,
    setSessionPanelWidth,
    setSidePanelWidth,
    sidePanelMax,
    sidePanelMin,
  ])
  // 卸载兜底补 end（独立 mount-only：上面的 effect 依赖 preview 宽度、拖拽中
  // 每次移动都重跑 cleanup，不能在里面发 end）
  useEffect(
    () => () => {
      if (resizingRef.current) emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'end' })
    },
    [],
  )
  const handleOpenFile = useCallback(
    async (file: FileDocumentHandle) => {
      await openFileInEditor(file, { t, pushToast, openPanel: true })
    },
    [pushToast, t],
  )
  const handleOpenFileForDrop = useCallback(
    async (file: FileDocumentHandle, options?: { preserveActive?: boolean }) => {
      if (file.type === 'directory') return ''
      const existing = useConsoleStore.getState().openEditors.find((item) => item.id === file.id)
      if (existing && !existing.loading) {
        // preserveActive（分栏中转）：不抢活动——落地动作会激活目标组
        if (!options?.preserveActive) useConsoleStore.getState().setActiveEditor(existing.id)
        return existing.id
      }
      // 拖拽打开视为显式打开：钉住新 tab，保留目标组已有预览 tab
      await openFileInEditor(file, {
        t,
        pushToast,
        openPanel: true,
        pinned: true,
        preserveActive: options?.preserveActive,
      })
      return useConsoleStore.getState().openEditors.find((item) => item.id === file.id)?.id || file.id
    },
    [pushToast, t],
  )
  const handleOpenFileAtPosition = useCallback(
    async (file: FileDocumentHandle, placement: 'center' | 'left' | 'right' | 'top' | 'bottom') => {
      const id = await handleOpenFileForDrop(file, { preserveActive: placement !== 'center' })
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
    // 窗口 tab 排序拖（dragstart 被 stopPropagation，走不到上面）：指针拖出 tab 条矩形后
    // 转为停靠拖拽显示 zones，回到条内还原——条内 reorder 与出条停靠两种手势合一
    const handleDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes(WINDOW_TAB_DRAG_MIME)) return
      const rect = document.querySelector('[data-tmuxgo-window-strip]')?.getBoundingClientRect()
      const docking = isOutsideWindowStrip(rect, event.clientX, event.clientY)
      setTerminalDockDragActive(docking)
      setDockDragActive((prev) => (prev === docking ? prev : docking))
    }
    const handleDragEnd = () => {
      setTerminalDockDragActive(false)
      setDockDragActive(false)
      setDockDropSide(null)
    }
    window.addEventListener('dragstart', handleDragStart)
    // 必须 capture：tab 的 onDragOver 有 stopPropagation，bubble 阶段在条内收不到事件
    window.addEventListener('dragover', handleDragOver, true)
    window.addEventListener('dragend', handleDragEnd)
    window.addEventListener('drop', handleDragEnd)
    return () => {
      window.removeEventListener('dragstart', handleDragStart)
      window.removeEventListener('dragover', handleDragOver, true)
      window.removeEventListener('dragend', handleDragEnd)
      window.removeEventListener('drop', handleDragEnd)
    }
  }, [])
  useEffect(() => {
    if (!editorsHydrated) return
    if (restoredRef.current) return
    restoredRef.current = true
    const editors = useConsoleStore.getState().openEditors.filter(isPersistableEditorMeta)
    if (!editors.length) return
    setFilePanelOpen(true)
    for (const editor of editors) void handleOpenFile(editor)
  }, [editorsHydrated, handleOpenFile, setFilePanelOpen])
  const handleSaveEditor = useCallback(
    async (editor: FileEditorDocument) => {
      if (editor.loading || editor.binary || editor.truncated) return
      setEditorSaving(editor.id, true)
      setEditorSaveError(editor.id, undefined)
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
        setEditorSaveError(editor.id, message)
        pushToast({ type: 'error', message })
      }
    },
    [markEditorSaved, pushToast, setEditorSaving, setEditorSaveError, t],
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

  const beginSideResize = (kind: SidePanelKind) => {
    resizingRef.current = kind
    emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
    pendingSideWidthRef.current = renderedSidePanelWidth
    setPreviewSideWidth(renderedSidePanelWidth)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div ref={containerRef} className="tmuxgo-workspace flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <ActivityBar />
      <>
        {sessionPanelExpanded ? (
          <div
            className={`tmuxgo-content-surface relative shrink-0 border-r border-[var(--line)] transition-opacity ${sessionCollapseArmed ? 'opacity-50' : ''}`}
            style={{ width: renderedSessionPanelWidth }}
          >
            <div className="h-full min-h-0">
              <SessionPanel />
            </div>
            <div
              className={`absolute right-0 top-0 h-full w-1 cursor-col-resize ${sessionCollapseArmed ? 'bg-accent' : 'hover:bg-accent/40'}`}
              onMouseDown={() => {
                resizingRef.current = 'session'
                emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
                pendingSessionWidthRef.current = sessionPanelWidth
                setPreviewSessionWidth(sessionPanelWidth)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
            />
          </div>
        ) : (
          <div className="relative shrink-0">
            <SessionRail />
            <div
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
              onMouseDown={() => {
                resizingRef.current = 'rail'
                emitStreamEvent(STREAM_EVENT.resizeGesture, { phase: 'start' })
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
            />
          </div>
        )}
        {filePanelOpen && (
          <SidePanelShell
            clip
            width={renderedSidePanelWidth}
            resizing={previewSideWidth !== null}
            onStartResize={() => beginSideResize('file')}
          >
            <FilePanel mode="explorer" onOpenFile={handleOpenFile} />
          </SidePanelShell>
        )}
        {fleetPanelOpen && (
          <SidePanelShell
            clip
            width={renderedSidePanelWidth}
            resizing={previewSideWidth !== null}
            onStartResize={() => beginSideResize('fleet')}
          >
            <FleetPanel onClose={() => useConsoleStore.getState().setFleetPanelOpen(false)} />
          </SidePanelShell>
        )}
        {gitPanelOpen && (
          <SidePanelShell
            width={renderedSidePanelWidth}
            resizing={previewSideWidth !== null}
            onStartResize={() => beginSideResize('git')}
          >
            <GitPanel />
          </SidePanelShell>
        )}
        {sshPanelOpen && (
          <SidePanelShell
            width={renderedSidePanelWidth}
            resizing={previewSideWidth !== null}
            onStartResize={() => beginSideResize('ssh')}
          >
            <SshPanel />
          </SidePanelShell>
        )}
        {endpointsPanelOpen && (
          <div
            className="tmuxgo-content-surface relative shrink-0 border-r border-[var(--line)]"
            style={{ width: renderedSidePanelWidth }}
          >
            <EndpointsPanel mode="panel" onClose={() => useConsoleStore.getState().toggleEndpointsPanel()} />
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
          className={`tmuxgo-content-surface relative flex min-h-0 min-w-0 flex-1 ${terminalDock === 'left' || terminalDock === 'right' ? 'flex-row' : 'flex-col'}`}
        >
          {activeSplitGroup ? (
            <SessionSplitView group={activeSplitGroup} />
          ) : (
            <>
              {/* TerminalDock 必须固定在同一个 JSX 位置：开关编辑器只改 props，避免 xterm 卸载重建导致的二次 attach/resize */}
              <TerminalDock
                fill={terminalDock === 'full'}
                dock={terminalDock}
                minHeight={terminalMinHeight}
                maxHeight={terminalMaxHeight}
                dragViewportHeight={viewportHeight}
                minWidth={terminalMinWidth}
                maxWidth={terminalMaxWidth}
                dragViewportWidth={workspaceWidth}
              />
              {terminalDock !== 'full' ? (
                <div className="min-h-0 min-w-0 flex-1">
                  {openEditors.length > 0 ? (
                    <EditorWorkbench
                      onSaveEditor={handleSaveEditor}
                      onOpenFile={handleOpenFileForDrop}
                      onOpenFileAtPosition={handleOpenFileAtPosition}
                      onCreateCompare={handleCreateCompare}
                    />
                  ) : (
                    // 空编辑区（无编辑器）：自带 data-editor-drop 才能过 DropGuard，
                    // 落点即打开文件（pinned），与 EditorWorkbench 外圈 drop 语义一致
                    <div
                      data-editor-drop
                      className={`flex h-full items-center justify-center text-sm ${emptyAreaDropActive ? 'text-accent' : 'text-text-3'}`}
                      onDragOver={(event) => {
                        const types = event.dataTransfer?.types ? Array.from(event.dataTransfer.types) : []
                        if (!types.includes(FILE_DRAG_MIME) && !getActiveDraggedFile()) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'copy'
                        setEmptyAreaDropActive(true)
                      }}
                      onDragLeave={(event) => {
                        if (!(event.currentTarget as HTMLDivElement).contains(event.relatedTarget as Node | null))
                          setEmptyAreaDropActive(false)
                      }}
                      onDrop={(event) => {
                        const dragged = readDraggedFile(event.dataTransfer)
                        if (!dragged) return
                        event.preventDefault()
                        clearActiveDraggedFile()
                        setEmptyAreaDropActive(false)
                        void handleOpenFileForDrop(dragged)
                      }}
                    >
                      {t('editor.emptyArea')}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
          {dockDragActive &&
            !activeSplitGroup &&
            TERMINAL_DOCK_POSITIONS.map((zone) => (
              <div
                key={zone}
                data-dock-drop
                // zones 仅停靠拖拽期间存在，要让用户看清落点：色块+边框+位置名
                className={`absolute z-30 flex items-center justify-center transition-colors ${zone === 'left' ? 'left-0 top-0 bottom-0 w-24' : zone === 'right' ? 'right-0 top-0 bottom-0 w-24' : zone === 'full' ? 'left-24 right-24 top-0 bottom-24' : 'left-0 right-0 bottom-0 h-24'} ${dockDropSide === zone ? 'bg-accent/25 text-accent' : 'bg-accent/10 text-text-3'}`}
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
              >
                <span
                  className={`rounded-full border px-3 py-1 text-xs ${dockDropSide === zone ? 'border-accent/60 bg-bg-0/90' : 'border-[var(--line)] bg-bg-0/80'}`}
                >
                  {t(`terminal.dock.${zone}`)}
                </span>
              </div>
            ))}
        </div>
      </>
    </div>
  )
}
