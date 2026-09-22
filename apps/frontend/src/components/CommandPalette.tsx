'use client'

import { useState, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { api } from '@/lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { writeClipboardText } from '@/lib/clipboard-text'
import { requestTerminalSelection } from '@/lib/terminal-selection'
import { isApplePlatform, isImeKeyEvent } from '@/lib/terminal-platform'
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
  const {
    refreshSnapshot,
    resolveActivePaneId,
    resolveFreshActivePaneId,
    syncAfterWindowChange,
    optimisticallyToggleWindowZoom,
    discardOptimisticWindowZoom,
  } = useSessionSnapshotSync()
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
  // 快捷键提示跟随平台：mac 用 Cmd，其余用 Ctrl（实际绑定均为 metaKey||ctrlKey）
  const mod = isApplePlatform() ? 'Cmd' : 'Ctrl'
  const activeWindow = windows.find((window: any) => window.active) || windows[0] || null
  const activeSession = sessions.find((session: any) => session.id === activeSessionId)
  const hostName = (hostId: string) => hosts.find((host: any) => host.id === hostId)?.name || hostId
  const copySelection = async () => {
    const text = await requestTerminalSelection()
    if (!text) throw new Error('No selection')
    const result = await writeClipboardText(text)
    if (!result.copied) throw new Error(t('clipboard.copyFailed'))
    if (result.unavailable) pushToast({ type: 'info', message: t('clipboard.unavailable') })
  }
  const pasteClipboard = async () => window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste'))
  const pluginItems = (pluginsData?.plugins || [])
    .filter((plugin) => plugin.enabled && plugin.state === 'active')
    .flatMap((plugin) =>
      (plugin.manifest.contributes?.actions || [])
        .filter(
          (action) =>
            action.title.toLowerCase().includes(q) ||
            action.id.toLowerCase().includes(q) ||
            plugin.manifest.name.toLowerCase().includes(q),
        )
        .map((action) => ({
          key: `plugin-${plugin.pluginId}-${action.id}`,
          type: 'plugin',
          title: action.title,
          meta: plugin.manifest.name,
          action: async () => {
            const log = await invokePluginAction.mutateAsync({
              pluginId: plugin.pluginId,
              actionId: action.id,
              context: {
                hostId: activeHostId || 'local',
                sessionId: activeSessionId || '',
                paneId: useConsoleStore.getState().activePaneId || '',
                source: 'command-palette',
              },
            })
            if (log.status !== 'success') throw new Error(log.error || log.stderr || t('plugins.actionFailed'))
            if (log.stdout.trim()) pushToast({ type: 'success', message: log.stdout.trim() })
          },
        })),
    )
  interface PaletteItem {
    key: string
    type: 'plugin' | 'host' | 'session' | 'window' | 'action'
    title: string
    meta: string
    // 中文标题经 includes 已可命中；keywords 补英文原名与少量同义词，不引搜索库
    keywords?: string[]
    danger?: boolean
    action: () => Promise<unknown>
  }
  const matchQuery = (item: Pick<PaletteItem, 'title' | 'keywords'>) =>
    !q ||
    item.title.toLowerCase().includes(q) ||
    (item.keywords || []).some((keyword) => keyword.toLowerCase().includes(q))
  const actionItems: PaletteItem[] = [
    {
      key: 'split-horizontal',
      type: 'action',
      title: t('palette.splitHorizontal'),
      meta: 'Ctrl+Shift+-',
      keywords: ['分屏', '水平分屏', '横屏', 'split', 'horizontal', 'split horizontal'],
      action: async () => {
        const paneId = await resolveFreshActivePaneId()
        if (!paneId) throw new Error(t('pane.noActive'))
        await api.panes.split(paneId, 'horizontal')
        await refreshSnapshotSafely()
        window.dispatchEvent(
          new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'split-pane', direction: 'horizontal' } }),
        )
      },
    },
    {
      key: 'split-vertical',
      type: 'action',
      title: t('palette.splitVertical'),
      meta: 'Ctrl+Shift+|',
      keywords: ['分屏', '垂直分屏', '竖屏', 'split', 'vertical', 'split vertical'],
      action: async () => {
        const paneId = await resolveFreshActivePaneId()
        if (!paneId) throw new Error(t('pane.noActive'))
        await api.panes.split(paneId, 'vertical')
        await refreshSnapshotSafely()
        window.dispatchEvent(
          new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'split-pane', direction: 'vertical' } }),
        )
      },
    },
    {
      key: 'new-session',
      type: 'action',
      title: t('palette.newSession'),
      meta: '+',
      keywords: ['新建会话', 'new session', 'create session'],
      action: async () => window.dispatchEvent(new CustomEvent('tmuxgo-new-session')),
    },
    {
      key: 'zoom-pane',
      type: 'action',
      title: t('palette.zoomPane'),
      meta: 'Z',
      keywords: ['缩放', '全屏', 'zoom', 'zoom pane'],
      action: async () => {
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
      },
    },
    {
      key: 'copy-selection',
      type: 'action',
      title: t('palette.copySelection'),
      meta: `${mod}+C`,
      keywords: ['复制', 'copy', 'copy selection'],
      action: copySelection,
    },
    {
      key: 'paste-clipboard',
      type: 'action',
      title: t('palette.pasteClipboard'),
      meta: `${mod}+V`,
      keywords: ['粘贴', 'paste'],
      action: pasteClipboard,
    },
    {
      key: 'open-files',
      type: 'action',
      title: t('palette.openFiles'),
      meta: `${mod}+E`,
      keywords: ['文件', 'files', 'open files'],
      action: async () => {
        if (window.matchMedia('(max-width: 1023px)').matches) useConsoleStore.setState({ mobileFileSheetOpen: true })
        else toggleFilePanel()
      },
    },
    {
      key: 'toggle-sessions',
      type: 'action',
      title: t('palette.toggleSessions'),
      meta: `${mod}+B`,
      keywords: ['会话列表', '侧栏', 'sessions', 'toggle sessions', 'sidebar'],
      action: async () => toggleSessionPanel(),
    },
    {
      key: 'rename-window',
      type: 'action',
      title: t('palette.renameWindow'),
      meta: activeWindow?.name || '',
      keywords: ['重命名', 'rename', 'rename window'],
      action: async () => {
        if (!activeHostId || !activeSessionId || !activeWindow) return
        setPendingRenameWindow({ id: activeWindow.id, name: activeWindow.name })
        return false
      },
    },
    {
      key: 'kill-window',
      type: 'action',
      title: t('palette.killWindow'),
      meta: activeWindow?.name || '',
      keywords: ['关闭窗口', '结束窗口', 'kill', 'kill window', 'close window'],
      danger: true,
      action: async () => {
        if (!activeWindow) return
        setPendingKillWindow({ id: activeWindow.id, name: activeWindow.name })
        return false
      },
    },
    {
      key: 'open-settings',
      type: 'action',
      title: t('palette.openSettings'),
      meta: t('palette.escToClose'),
      keywords: ['设置', 'settings', 'open settings', 'preferences'],
      action: async () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')),
    },
  ]
  const allItems: PaletteItem[] = [
    ...pluginItems.map((item) => ({ ...item, type: 'plugin' as const })),
    ...hosts
      .filter((host: any) => matchQuery({ title: host.name, keywords: [host.address || ''] }))
      .map((host: any): PaletteItem => ({
        key: `host-${host.id}`,
        type: 'host',
        title: host.name,
        meta: host.address,
        action: async () => setActiveHost(host.id),
      })),
    ...sessions
      .filter((session: any) => matchQuery({ title: session.name, keywords: ['会话', 'session'] }))
      .map((session: any): PaletteItem => ({
        key: `session-${session.id}`,
        type: 'session',
        title: session.name,
        meta: `${hostName(session.hostId || activeHostId || 'local')} · ${t('palette.windows', { count: session.windowCount })}`,
        action: async () => setActiveSession(session.id),
      })),
    ...windows
      .filter((window: any) => matchQuery({ title: window.name, keywords: ['窗口', 'window'] }))
      .map((window: any): PaletteItem => ({
        key: `window-${window.id}`,
        type: 'window',
        title: t('palette.switchWindow', { name: window.name }),
        meta: activeSession?.name || '',
        action: async () => {
          if (!activeHostId || !activeSessionId) return
          const previousWindows = getWindows()
          setWindows(
            previousWindows.map((item: any) =>
              item.sessionId === activeSessionId ? { ...item, active: item.id === window.id } : item,
            ),
          )
          try {
            const result = await api.windows.select(activeHostId, activeSessionId, window.id)
            if (result.windows) setWindows(result.windows)
            await syncAfterWindowChange()
          } catch (err) {
            setWindows(previousWindows)
            throw err
          }
        },
      })),
    ...actionItems,
  ]
  // 空查询时按 会话→窗口→动作→主机→插件 排序（最近入口优先）；危险动作
  // 永远沉底，不会成为默认首选项
  const emptyRank: Record<PaletteItem['type'], number> = { session: 0, window: 1, action: 2, host: 3, plugin: 4 }
  const items = [
    ...allItems
      .filter((item) => !item.danger && matchQuery(item))
      .sort((a, b) => (q ? 0 : emptyRank[a.type] - emptyRank[b.type])),
    ...allItems.filter((item) => item.danger && matchQuery(item)),
  ]

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])
  const listRef = useRef<HTMLDivElement>(null)
  // 方向键选中项必须始终可见
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, items.length])

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
    if (!activeHostId || !activeSessionId || !pendingRenameWindow || !name) {
      setPendingRenameWindow(null)
      return
    }
    try {
      const result = await api.windows.rename(activeHostId, activeSessionId, pendingRenameWindow.id, name)
      if (result.windows) setWindows(result.windows)
      setPendingRenameWindow(null)
      close()
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('palette.actionFailed') })
    }
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center tmuxgo-scrim p-4" onClick={close}>
        <div
          className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-[500px] overflow-hidden rounded-apple border"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 p-3 border-b border-[var(--line)]">
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-text-3 flex-shrink-0"
            >
              <circle cx={11} cy={11} r={8} />
              <path d="m21 21-4.35-4.35" />
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
                // IME 组字期 Enter/方向键/Escape 归输入法选词，不消费为应用动作；
                // 判定需 isComposing 与 keyCode 229 双保险，见 isImeKeyEvent 注释
                if (isImeKeyEvent(e.nativeEvent)) return
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
            <Button variant="ghost" size="icon-sm" className="flex-shrink-0" onClick={close} aria-label="close">
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </Button>
          </div>

          <div ref={listRef} className="tmuxgo-scrollbar max-h-[50vh] overflow-x-hidden overflow-y-auto">
            {items.map((item, index) => (
              <button
                key={item.key}
                data-selected={selectedIndex === index || undefined}
                onClick={() => void handleSelect(index)}
                className={`w-full px-3 py-2.5 text-left flex items-center justify-between gap-3 rounded-apple transition-colors ${selectedIndex === index ? 'bg-bg-2/60 text-text-1' : 'hover:bg-bg-2/40 text-text-2'}`}
              >
                <div>
                  <div className="text-text-1 text-sm">{item.title}</div>
                  <div className="text-text-3 text-xs">{item.meta}</div>
                </div>
                <div className="text-caption uppercase tracking-[0.18em] text-text-3">{item.type}</div>
              </button>
            ))}
            {items.length === 0 && (
              <div className="px-3 py-6 text-text-3 text-sm text-center">{t('palette.noResults')}</div>
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
  )
}
