'use client'

import { useState, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { api } from '@/lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useHosts, useInvokePluginAction, usePlugins, useWindows } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { ModalPortal } from './ModalPortal'

interface CommandPaletteProps {
  onClose: () => void
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [pendingKillWindow, setPendingKillWindow] = useState<{ id: string; name: string } | null>(null)
  const [pendingRenameWindow, setPendingRenameWindow] = useState<{ id: string; name: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const setCommandPalette = useConsoleStore((state) => state.setCommandPalette)
  const setActiveHost = useConsoleStore((state) => state.setActiveHost)
  const setActiveSession = useConsoleStore((state) => state.setActiveSession)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const toggleSessionPanel = useConsoleStore((state) => state.toggleSessionPanel)
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  const { data: hosts = [] } = useHosts()
  const { data: sessions = [] } = useOrderedSessions(activeHostId || '')
  const { data: windows = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { data: pluginsData } = usePlugins()
  const invokePluginAction = useInvokePluginAction()
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const { t } = useTranslation()
  const { refreshSnapshot, resolveActivePaneId, resolveFreshActivePaneId, syncAfterWindowChange, optimisticallyToggleWindowZoom, discardOptimisticWindowZoom } = useSessionSnapshotSync()
  const refreshSnapshotSafely = async () => {
    try {
      await refreshSnapshot()
    } catch {}
  }

  const close = () => {
    setCommandPalette(false)
    onClose()
  }

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const q = query.toLowerCase()
  const activeWindow = windows.find((window: any) => window.active) || windows[0] || null
  const copySelection = async () => {
    const text = await requestTerminalSelection()
    if (!text) throw new Error('No selection')
    const result = await writeClipboardText(text)
    if (!result.copied) throw new Error(t('clipboard.copyFailed'))
    if (result.unavailable) pushToast({ type: 'info', message: t('clipboard.unavailable') })
  }
  const pasteClipboard = async () => window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))
  const pluginItems = (pluginsData?.plugins || []).filter((plugin) => plugin.enabled && plugin.state === 'active').flatMap((plugin) => (plugin.manifest.contributes?.actions || []).filter((action) => action.title.toLowerCase().includes(q) || action.id.toLowerCase().includes(q) || plugin.manifest.name.toLowerCase().includes(q)).map((action) => ({ key: `plugin-${plugin.pluginId}-${action.id}`, type: 'plugin', title: action.title, meta: plugin.manifest.name, action: async () => {
    const log = await invokePluginAction.mutateAsync({ pluginId: plugin.pluginId, actionId: action.id, context: { hostId: activeHostId || 'local', sessionId: activeSessionId || '', paneId: useConsoleStore.getState().activePaneId || '', source: 'command-palette' } })
    if (log.status !== 'success') throw new Error(log.error || log.stderr || t('plugins.actionFailed'))
    if (log.stdout.trim()) pushToast({ type: 'success', message: log.stdout.trim() })
  } })))
  const items = [
    ...pluginItems,
    ...hosts.filter((h: any) => h.name.toLowerCase().includes(q)).map((host: any) => ({ key: `host-${host.id}`, type: 'host', title: host.name, meta: host.address, action: async () => setActiveHost(host.id) })),
    ...sessions.filter((s: any) => s.name.toLowerCase().includes(q)).map((session: any) => ({ key: `session-${session.id}`, type: 'session', title: session.name, meta: t('palette.windows', { count: session.windowCount }), action: async () => setActiveSession(session.id) })),
    ...windows.filter((w: any) => w.name.toLowerCase().includes(q)).map((window: any) => ({ key: `window-${window.id}`, type: 'action', title: t('palette.switchWindow', { name: window.name }), meta: 'Enter', action: async () => {
      if (!activeHostId || !activeSessionId) return
      const previousWindows = getWindows()
      setWindows(previousWindows.map((item: any) => item.sessionId === activeSessionId ? { ...item, active: item.id === window.id } : item))
      try {
        const result = await api.windows.select(activeHostId, activeSessionId, window.id)
        if (result.windows) setWindows(result.windows)
        await syncAfterWindowChange()
      } catch (err) {
        setWindows(previousWindows)
        throw err
      }
    } })),
    ...['horizontal', 'vertical'].filter((direction) => (`split ${direction}`).includes(q) || q.length === 0).map((direction) => ({ key: `split-${direction}`, type: 'action', title: direction === 'horizontal' ? t('palette.splitHorizontal') : t('palette.splitVertical'), meta: direction === 'horizontal' ? 'Ctrl+Shift+-' : 'Ctrl+Shift+|', action: async () => {
      const paneId = await resolveFreshActivePaneId()
      if (!paneId) throw new Error(t('pane.noActive'))
      await api.panes.split(paneId, direction as 'horizontal' | 'vertical')
      await refreshSnapshotSafely()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'split-pane', direction } }))
    } })),
    ...[t('palette.newSession')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'new-session', type: 'action', title: t('palette.newSession'), meta: '+', action: async () => window.dispatchEvent(new CustomEvent('tmuxgo-new-session')) })),
    ...[t('palette.zoomPane')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'zoom-pane', type: 'action', title: t('palette.zoomPane'), meta: 'Z', action: async () => {
      const paneId = await resolveFreshActivePaneId()
      if (!paneId) throw new Error(t('pane.noActive'))
      try {
        optimisticallyToggleWindowZoom(paneId)
        await api.panes.zoomByPane(paneId)
        await refreshSnapshotSafely()
        window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'zoom-pane' } }))
      } catch (err) {
        discardOptimisticWindowZoom(paneId)
        await refreshSnapshotSafely()
        throw err
      }
    } })),
    ...[t('palette.copySelection')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'copy-selection', type: 'action', title: t('palette.copySelection'), meta: 'Cmd+C', action: copySelection })),
    ...[t('palette.pasteClipboard')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'paste-clipboard', type: 'action', title: t('palette.pasteClipboard'), meta: 'Cmd+V', action: pasteClipboard })),
    ...[t('palette.openFiles')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'open-files', type: 'action', title: t('palette.openFiles'), meta: 'Cmd+E', action: async () => {
      if (window.matchMedia('(max-width: 1023px)').matches) useConsoleStore.setState({ mobileFileSheetOpen: true })
      else toggleFilePanel()
    } })),
    ...[t('palette.toggleSessions')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'toggle-sessions', type: 'action', title: t('palette.toggleSessions'), meta: 'Cmd+B', action: async () => toggleSessionPanel() })),
    ...[t('palette.renameWindow')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'rename-window', type: 'action', title: t('palette.renameWindow'), meta: activeWindow?.name || '', action: async () => {
      if (!activeHostId || !activeSessionId || !activeWindow) return
      setPendingRenameWindow({ id: activeWindow.id, name: activeWindow.name })
      return false
    } })),
    ...[t('palette.killWindow')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'kill-window', type: 'action', title: t('palette.killWindow'), meta: activeWindow?.name || '', action: async () => {
      if (!activeWindow) return
      setPendingKillWindow({ id: activeWindow.id, name: activeWindow.name })
      return false
    } })),
    ...[t('palette.openSettings')].filter((name) => name.toLowerCase().includes(q) || q.length === 0).map(() => ({ key: 'open-settings', type: 'action', title: t('palette.openSettings'), meta: t('palette.escToClose'), action: async () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')) })),
  ]

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleSelect = async (index: number) => {
    const item = items[index]
    if (!item) return
    try {
      const result = await item.action()
      if (result !== false) close()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('palette.actionFailed') })
    }
  }
  const confirmKillWindow = async () => {
    if (!activeHostId || !activeSessionId || !pendingKillWindow) return
    try {
      const result = await api.windows.kill(activeHostId, activeSessionId, pendingKillWindow.id)
      if (result.windows) setWindows(result.windows)
      setPendingKillWindow(null)
      close()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('palette.actionFailed') })
    }
  }
  const confirmRenameWindow = async (name: string) => {
    if (!activeHostId || !activeSessionId || !pendingRenameWindow || !name) { setPendingRenameWindow(null); return }
    try {
      const result = await api.windows.rename(activeHostId, activeSessionId, pendingRenameWindow.id, name)
      if (result.windows) setWindows(result.windows)
      setPendingRenameWindow(null)
      close()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('palette.actionFailed') })
    }
  }

  return <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 p-4 pt-[10vh]" onClick={close}>
      <div className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-[500px] overflow-hidden rounded-lg border" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 p-3 border-b border-[var(--line)]">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-text-3 flex-shrink-0">
            <circle cx={11} cy={11} r={8} /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            className="flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3 text-sm"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIndex((prev) => Math.min(prev + 1, Math.max(items.length - 1, 0)))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIndex((prev) => Math.max(prev - 1, 0))
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSelect(selectedIndex)
              }
            }}
          />
          <button onClick={close} className="tmuxgo-button tmuxgo-button--ghost tmuxgo-button--icon-sm tmuxgo-icon-button flex-shrink-0" aria-label="close">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {items.map((item, index) => (
            <button
              key={item.key}
              onClick={() => void handleSelect(index)}
              className={`w-full px-3 py-2.5 text-left flex items-center justify-between gap-3 rounded-lg transition-colors ${selectedIndex === index ? 'bg-bg-2/60 text-text-1' : 'hover:bg-bg-2/40 text-text-2'}`}
            >
              <div>
                <div className="text-text-1 text-sm">{item.title}</div>
                <div className="text-text-3 text-xs">{item.meta}</div>
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-3">{item.type}</div>
            </button>
          ))}
          {items.length === 0 && (
            <div className="px-3 py-6 text-text-3 text-sm text-center">
              {t('palette.noResults')}
            </div>
          )}
        </div>

        <div className="hidden lg:flex p-2 border-t border-[var(--line)] items-center justify-between text-text-3 text-xs">
          <span>{t('palette.navigate')}</span>
          <span>{t('palette.select')}</span>
          <span>{t('palette.close')}</span>
        </div>
      </div>
      <ConfirmDialog
        open={!!pendingKillWindow}
        title={t('palette.killWindow')}
        message={pendingKillWindow?.name || ''}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onCancel={() => setPendingKillWindow(null)}
        onConfirm={() => void confirmKillWindow()}
      />
      <PromptDialog
        open={!!pendingRenameWindow}
        title={t('palette.renameWindow')}
        defaultValue={pendingRenameWindow?.name || ''}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setPendingRenameWindow(null)}
        onConfirm={(value) => void confirmRenameWindow(value)}
      />
    </div>
  </ModalPortal>
}
