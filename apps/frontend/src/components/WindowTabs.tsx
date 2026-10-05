'use client'

import { useEffect, useState } from 'react'
import { FiCheck, FiEdit3, FiLayout, FiMoreHorizontal, FiPlus, FiTrash2, FiX, FiXCircle } from 'react-icons/fi'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useBatchKillWindows, useCreateWindow, useSessionSnapshot, useWindows } from '@/hooks/useApi'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useTranslation } from '@/i18n'
import { Chip } from './Chip'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { summarizeAgentByWindow } from '@/lib/agent-status'
import { setTerminalDockDragActive, TERMINAL_DOCK_DRAG_MIME } from '@/lib/terminal-dock-drag'
import type { TerminalDockPosition } from '@/stores/useConsoleStore'

const DOCK_POSITIONS: TerminalDockPosition[] = ['bottom', 'left', 'right']
// dataTransfer.types 会被规范化为小写，自定义 MIME 必须全小写
const WINDOW_TAB_DRAG_MIME = 'application/x-tmuxgo-window'

export function WindowTabs() {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const pushToast = useConsoleStore((s) => s.pushToast)
  const terminalDock = useConsoleStore((s) => s.terminalDock)
  const setTerminalDock = useConsoleStore((s) => s.setTerminalDock)
  const { data: windows = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const { syncAfterWindowChange } = useSessionSnapshotSync()
  const createWindow = useCreateWindow()
  const batchKillWindows = useBatchKillWindows()
  const { t } = useTranslation()

  const [batchMode, setBatchMode] = useState(false)
  const [selectedWindowIds, setSelectedWindowIds] = useState<string[]>([])
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false)
  const [newWindowPromptOpen, setNewWindowPromptOpen] = useState(false)
  const [newWindowName, setNewWindowName] = useState('')
  const [dockMenuPos, setDockMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [dragWindowId, setDragWindowId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null)

  useEffect(() => {
    if (!dockMenuPos && !tabMenu) return
    const close = () => {
      setDockMenuPos(null)
      setTabMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [dockMenuPos, tabMenu])

  if (!activeSessionId || windows.length === 0) {
    return null
  }

  const sessionWindows = windows.filter((w: any) => w.sessionId === activeSessionId)
  if (sessionWindows.length === 0) {
    return null
  }
  const windowRollups = new Map(
    summarizeAgentByWindow(snapshotData?.panes || []).map((rollup) => [rollup.windowId, rollup]),
  )
  // tmux kill 掉最后一个 window 会连带销毁整个 session，故禁止关最后一个
  const isLastWindow = sessionWindows.length <= 1

  const handleSelect = async (windowId: string) => {
    if (!activeHostId || !activeSessionId) return
    const previousWindows = getWindows()
    setWindows(
      previousWindows.map((window: any) =>
        window.sessionId === activeSessionId ? { ...window, active: window.id === windowId } : window,
      ),
    )
    try {
      const result = await api.windows.select(activeHostId, activeSessionId, windowId)
      if (result.windows) setWindows(result.windows)
      await syncAfterWindowChange()
    } catch (err) {
      setWindows(previousWindows)
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.switchFailed') })
    }
  }

  const handleCloseWindow = async (window: any) => {
    if (!activeHostId || !activeSessionId || isLastWindow) return
    try {
      const result = await api.windows.kill(activeHostId, activeSessionId, window.id)
      if (result?.windows) {
        setWindows(result.windows)
        await syncAfterWindowChange()
      } else {
        pushToast({ type: 'error', message: result?.error || t('window.closeFailed') })
      }
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.closeFailed') })
    }
  }

  const handleCloseOthers = async (window: any) => {
    if (!activeHostId || !activeSessionId) return
    const others = sessionWindows.filter((w: any) => w.id !== window.id).map((w: any) => w.id)
    if (!others.length) return
    try {
      const results = await batchKillWindows.mutateAsync({
        hostId: activeHostId,
        sessionId: activeSessionId,
        windowIds: others,
      })
      const failed = results.filter((r) => !r.ok).length
      if (failed) pushToast({ type: 'error', message: t('window.batchDeleteFailed', { count: failed }) })
      // 浏览器语义：close others 后保持右键的 tab 为活动窗口（kill 掉 active 时 tmux 选中的未必是它）
      if (!window.active) {
        const selected = await api.windows.select(activeHostId, activeSessionId, window.id)
        if (selected?.windows) setWindows(selected.windows)
      }
      await syncAfterWindowChange()
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('window.batchDeleteFailed', { count: others.length }),
      })
    }
  }

  const confirmRename = async (name: string) => {
    const target = renameTarget
    setRenameTarget(null)
    if (!target || !activeHostId || !activeSessionId) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === target.name) return
    try {
      const result = await api.windows.rename(activeHostId, activeSessionId, target.id, trimmed)
      if (result?.windows) setWindows(result.windows)
      else pushToast({ type: 'error', message: result?.error || t('window.renameFailed') })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.renameFailed') })
    }
  }

  const handleTabDrop = async (dragId: string, targetId: string, side: 'before' | 'after') => {
    if (!dragId || dragId === targetId || !activeHostId || !activeSessionId) return
    const ids = sessionWindows.map((w: any) => w.id).filter((id: string) => id !== dragId)
    let index = ids.indexOf(targetId)
    if (index < 0) return
    if (side === 'after') index += 1
    ids.splice(index, 0, dragId)
    try {
      const result = await api.windows.move(activeHostId, activeSessionId, ids)
      if (result?.windows) setWindows(result.windows)
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.reorderFailed') })
    }
  }

  const handleOpenNewWindowPrompt = () => {
    if (!activeHostId || !activeSessionId) {
      pushToast({ type: 'error', message: t('window.createMissingSession') })
      return
    }
    if (batchMode) {
      setBatchMode(false)
      setSelectedWindowIds([])
    }
    setNewWindowName(`win-${sessionWindows.length + 1}`)
    setNewWindowPromptOpen(true)
  }

  const confirmCreateWindow = async (inputName?: string) => {
    if (!activeHostId || !activeSessionId) {
      setNewWindowPromptOpen(false)
      return
    }
    const name = (typeof inputName === 'string' ? inputName : newWindowName || '').trim() || 'new-window'
    try {
      const created = await createWindow.mutateAsync({ hostId: activeHostId, sessionId: activeSessionId, name })
      if (created?.id) {
        const selected = await api.windows.select(activeHostId, activeSessionId, created.id)
        if (selected?.windows) setWindows(selected.windows)
        else {
          const latest = await api.windows.list(activeHostId, activeSessionId)
          if (Array.isArray(latest)) setWindows(latest)
        }
      }
      await syncAfterWindowChange()
      pushToast({ type: 'success', message: t('window.created', { name }) })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('window.createFailed') })
    }
    setNewWindowPromptOpen(false)
  }

  const toggleBatchMode = () => {
    const next = !batchMode
    setBatchMode(next)
    if (!next) setSelectedWindowIds([])
  }

  const toggleBatchSelection = (windowId: string) => {
    setSelectedWindowIds((prev) =>
      prev.includes(windowId) ? prev.filter((id) => id !== windowId) : [...prev, windowId],
    )
  }

  const nonActiveIds = sessionWindows.filter((w: any) => !w.active).map((w: any) => w.id)

  const handleBatchDelete = async () => {
    if (!activeHostId || !activeSessionId || selectedWindowIds.length === 0) return
    try {
      const results = await batchKillWindows.mutateAsync({
        hostId: activeHostId,
        sessionId: activeSessionId,
        windowIds: selectedWindowIds,
      })
      const success = results.filter((r) => r.ok).length
      const failed = results.length - success
      if (failed === 0) {
        pushToast({ type: 'success', message: t('window.batchDeleteSuccess', { count: success }) })
      } else if (success > 0) {
        pushToast({ type: 'error', message: t('window.batchDeletePartial', { success, failed }) })
      } else {
        pushToast({ type: 'error', message: t('window.batchDeleteFailed', { count: failed }) })
      }
    } catch (err) {
      pushToast({
        type: 'error',
        message:
          err instanceof Error ? err.message : t('window.batchDeleteFailed', { count: selectedWindowIds.length }),
      })
    } finally {
      setPendingBatchDelete(false)
      setBatchMode(false)
      setSelectedWindowIds([])
    }
  }

  const tabMenuWindow = tabMenu ? sessionWindows.find((w: any) => w.id === tabMenu.id) : null

  return (
    <div
      className="flex items-end gap-1 border-b border-[var(--line)] bg-bg-1 pl-1.5 pr-2 pt-1"
      title={t('terminal.dockHint', { position: t(`terminal.dock.${terminalDock}`) })}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TERMINAL_DOCK_DRAG_MIME, '1')
        event.dataTransfer.effectAllowed = 'move'
        setTerminalDockDragActive(true)
      }}
      onDragEnd={() => setTerminalDockDragActive(false)}
    >
      {batchMode && (
        <div className="flex shrink-0 items-center gap-1 self-center border-r border-[var(--line)] pr-2">
          <Chip
            onClick={() => setSelectedWindowIds(nonActiveIds)}
            className="whitespace-nowrap px-2 py-1 text-xs"
            disabled={nonActiveIds.length === 0}
          >
            {t('window.batchSelectAll')}
          </Chip>
          <Chip
            onClick={() => setSelectedWindowIds([])}
            className="whitespace-nowrap px-2 py-1 text-xs"
            disabled={selectedWindowIds.length === 0}
          >
            {t('window.batchClearAll')}
          </Chip>
          <Chip
            tone="danger"
            onClick={() => setPendingBatchDelete(true)}
            className="flex items-center gap-1 whitespace-nowrap px-2 py-1 text-xs"
            disabled={selectedWindowIds.length === 0}
          >
            <FiTrash2 aria-hidden="true" size={11} />
            {t('window.batchDeleteSelected', { count: selectedWindowIds.length })}
          </Chip>
          <Chip onClick={toggleBatchMode} className="whitespace-nowrap px-2 py-1 text-xs">
            {t('window.batchCancel')}
          </Chip>
        </div>
      )}
      <div role="tablist" className="tmuxgo-scrollbar-subtle flex min-w-0 flex-1 items-end overflow-x-auto">
        {sessionWindows.map((window: any) => {
          if (batchMode) {
            const selected = selectedWindowIds.includes(window.id)
            return (
              <div
                key={window.id}
                role="tab"
                aria-selected={window.active}
                title={window.active ? t('window.cannotDeleteActive') : window.name}
                onClick={() => {
                  if (!window.active) toggleBatchSelection(window.id)
                }}
                className={cn(
                  'tmuxgo-window-tab text-meta',
                  window.active && 'tmuxgo-window-tab--active tmuxgo-window-tab--disabled',
                  selected && 'tmuxgo-window-tab--selected',
                )}
              >
                {!window.active && <span className="shrink-0 text-[10px]">{selected ? '☑' : '☐'}</span>}
                <span className="min-w-0 flex-1 truncate">{window.name}</span>
                <WindowAgentRollupBadge windowId={window.id} rollups={windowRollups} />
              </div>
            )
          }
          return (
            <div
              key={window.id}
              role="tab"
              aria-selected={window.active}
              tabIndex={0}
              title={window.name}
              draggable
              onClick={() => handleSelect(window.id)}
              onMouseDown={(event) => {
                // 中键直接关（浏览器惯例）；preventDefault 顺带挡掉 Linux 下 middle-click autoscroll/粘贴
                if (event.button === 1) {
                  event.preventDefault()
                  void handleCloseWindow(window)
                }
              }}
              onDoubleClick={() => setRenameTarget({ id: window.id, name: window.name })}
              onContextMenu={(event) => {
                event.preventDefault()
                setTabMenu({ x: event.clientX, y: event.clientY, id: window.id })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSelect(window.id)
              }}
              onDragStart={(event) => {
                // 排序拖拽独立于外层 strip 的 dock 拖动，必须截断冒泡
                event.stopPropagation()
                setDragWindowId(window.id)
                event.dataTransfer.setData(WINDOW_TAB_DRAG_MIME, window.id)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(WINDOW_TAB_DRAG_MIME)) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                if (window.id === dragWindowId) {
                  setDropTarget(null)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                setDropTarget({
                  id: window.id,
                  side: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
                })
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDropTarget((current) => (current?.id === window.id ? null : current))
              }}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const dragId = event.dataTransfer.getData(WINDOW_TAB_DRAG_MIME) || dragWindowId
                setDragWindowId(null)
                setDropTarget(null)
                if (dragId)
                  void handleTabDrop(
                    dragId,
                    window.id,
                    event.clientX <
                      event.currentTarget.getBoundingClientRect().left +
                        event.currentTarget.getBoundingClientRect().width / 2
                      ? 'before'
                      : 'after',
                  )
              }}
              onDragEnd={(event) => {
                event.stopPropagation()
                setDragWindowId(null)
                setDropTarget(null)
              }}
              className={cn(
                'tmuxgo-window-tab group text-meta',
                window.active && 'tmuxgo-window-tab--active',
                dragWindowId === window.id && 'tmuxgo-window-tab--dragging',
                dropTarget?.id === window.id && 'tmuxgo-window-tab--droptarget',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{window.name}</span>
              <WindowAgentRollupBadge windowId={window.id} rollups={windowRollups} />
              <button
                type="button"
                aria-label={t('window.close')}
                title={isLastWindow ? t('window.lastWindow') : t('window.close')}
                disabled={isLastWindow}
                className="tmuxgo-window-tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCloseWindow(window)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                ×
              </button>
              {dropTarget?.id === window.id && (
                <span
                  className={`pointer-events-none absolute inset-y-1 z-20 w-[2px] rounded-full bg-accent shadow-[0_0_0_1px_rgba(30,200,255,0.2)] ${dropTarget.side === 'before' ? 'left-0' : 'right-0'}`}
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-1 self-center">
        <Chip
          onClick={handleOpenNewWindowPrompt}
          className="px-2 py-1"
          title={t('window.createTitle')}
          aria-label={t('window.createTitle')}
          disabled={createWindow.isPending}
        >
          <FiPlus aria-hidden="true" size={13} />
        </Chip>
        <Chip
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setDockMenuPos({ x: rect.right, y: rect.bottom + 4 })
          }}
          className="cursor-grab px-2 py-1.5"
          title={t('terminal.dockHint', { position: t(`terminal.dock.${terminalDock}`) })}
          aria-label={t('terminal.dockHint', { position: t(`terminal.dock.${terminalDock}`) })}
        >
          <FiLayout aria-hidden="true" size={13} />
        </Chip>
        <Chip
          onClick={toggleBatchMode}
          className={`px-2 py-1.5 ${batchMode ? 'tmuxgo-chip--accent' : ''}`}
          title={t(batchMode ? 'window.batchCancel' : 'window.batchMode')}
          aria-label={t(batchMode ? 'window.batchCancel' : 'window.batchMode')}
        >
          <FiMoreHorizontal aria-hidden="true" size={13} />
        </Chip>
      </div>
      {dockMenuPos && (
        <div
          className="tmuxgo-menu fixed z-[90] w-36 py-1 text-xs"
          style={{ left: dockMenuPos.x - 144, top: dockMenuPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {DOCK_POSITIONS.map((position) => (
            <button
              key={position}
              className={`tmuxgo-menu-item text-xs ${position === terminalDock ? 'text-accent' : ''}`}
              onClick={() => {
                setTerminalDock(position)
                setDockMenuPos(null)
              }}
            >
              <FiCheck aria-hidden="true" size={13} className={position === terminalDock ? '' : 'opacity-0'} />
              {t(`terminal.dock.${position}`)}
            </button>
          ))}
        </div>
      )}
      {tabMenu && tabMenuWindow && (
        <div
          className="tmuxgo-menu fixed z-[90] w-36 py-1 text-xs"
          style={{ left: Math.max(8, Math.min(tabMenu.x, window.innerWidth - 152)), top: tabMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="tmuxgo-menu-item text-xs"
            onClick={() => {
              setRenameTarget({ id: tabMenu.id, name: tabMenuWindow.name })
              setTabMenu(null)
            }}
          >
            <FiEdit3 aria-hidden="true" size={13} />
            {t('window.rename')}
          </button>
          <button
            className="tmuxgo-menu-item tmuxgo-menu-item--danger text-xs"
            disabled={isLastWindow}
            onClick={() => {
              setTabMenu(null)
              void handleCloseWindow(tabMenuWindow)
            }}
          >
            <FiX aria-hidden="true" size={13} />
            {t('window.close')}
          </button>
          <button
            className="tmuxgo-menu-item tmuxgo-menu-item--danger text-xs"
            disabled={isLastWindow}
            onClick={() => {
              setTabMenu(null)
              void handleCloseOthers(tabMenuWindow)
            }}
          >
            <FiXCircle aria-hidden="true" size={13} />
            {t('window.closeOthers')}
          </button>
        </div>
      )}
      <PromptDialog
        open={newWindowPromptOpen}
        title={t('window.createTitle')}
        defaultValue={newWindowName}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setNewWindowPromptOpen(false)}
        onConfirm={(value) => {
          setNewWindowName(value)
          return confirmCreateWindow(value)
        }}
      />
      <PromptDialog
        open={!!renameTarget}
        title={t('window.renameTitle')}
        defaultValue={renameTarget?.name ?? ''}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setRenameTarget(null)}
        onConfirm={confirmRename}
      />
      <ConfirmDialog
        open={pendingBatchDelete}
        title={t('window.batchDeleteTitle')}
        message={t('window.batchDeleteConfirm', { count: selectedWindowIds.length })}
        items={sessionWindows
          .filter((window: any) => selectedWindowIds.includes(window.id))
          .map((window: any) => window.name || `#${window.index}`)}
        confirmLabel={t('window.batchDeleteSelected', { count: selectedWindowIds.length })}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingBatchDelete(false)}
        onConfirm={handleBatchDelete}
      />
    </div>
  )
}

function WindowAgentRollupBadge({
  windowId,
  rollups,
}: {
  windowId: string
  rollups: Map<string, ReturnType<typeof summarizeAgentByWindow>[number]>
}) {
  const { t } = useTranslation()
  const rollup = rollups.get(windowId)
  if (!rollup || !rollup.summary.total) return null
  const parts = rollup.statuses.map((status) => (
    <span
      key={status}
      className={`inline-flex items-center gap-0.5 ${status === 'blocked' ? 'text-danger' : status === 'done' ? 'text-accent-2' : status === 'working' ? 'text-accent' : 'text-text-3'}`}
      title={t(`agent.status.${status}`)}
    >
      {rollup.summary[status]}
      <span className="text-[0.65em] opacity-70">{t(`agent.status.${status}`).slice(0, 1).toLowerCase()}</span>
    </span>
  ))
  return (
    <span className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-text-1/10 bg-bg-2/50 px-1.5 py-0.5 font-mono text-caption tabular-nums">
      {parts}
    </span>
  )
}
