'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useInboxStore } from '@/stores/useInboxStore'
import { useTranslation } from '@/i18n'
import { FiBell, FiFolder, FiGitBranch, FiInbox, FiServer, FiSettings } from 'react-icons/fi'
import {
  FiActivity,
  FiBox,
  FiCode,
  FiCpu,
  FiDatabase,
  FiGlobe,
  FiMonitor,
  FiTerminal,
  FiTool,
  FiZap,
} from 'react-icons/fi'
import { usePlugins } from '@/hooks/useApi'

const pluginIcons = {
  activity: FiActivity,
  box: FiBox,
  code: FiCode,
  cpu: FiCpu,
  database: FiDatabase,
  globe: FiGlobe,
  terminal: FiTerminal,
  tool: FiTool,
  zap: FiZap,
}

export function ActivityBar() {
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const toggleSessionPanel = useConsoleStore((state) => state.toggleSessionPanel)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const toggleSshPanel = useConsoleStore((state) => state.toggleSshPanel)
  const sshPanelOpen = useConsoleStore((state) => state.sshPanelOpen)
  const activePluginView = useConsoleStore((state) => state.activePluginView)
  const setActivePluginView = useConsoleStore((state) => state.setActivePluginView)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeDesktop = useConsoleStore((state) => state.activeDesktop)
  const toggleDesktop = useConsoleStore((state) => state.toggleDesktop)
  const toggleGitPanel = useConsoleStore((state) => state.toggleGitPanel)
  const inboxPanelOpen = useInboxStore((state) => state.panelOpen)
  const inboxUnread = useInboxStore((state) => state.unreadCount)
  const { t } = useTranslation()
  const { data } = usePlugins()
  const pluginViews = (data?.plugins || [])
    .filter((plugin) => plugin.enabled && plugin.state === 'active')
    .flatMap((plugin) => (plugin.manifest.contributes?.views || []).map((view) => ({ plugin, view })))
  const items = [
    { id: 'sessions', label: t('activity.sessions'), icon: FiServer, onClick: toggleSessionPanel },
    { id: 'ssh', label: t('activity.ssh'), icon: FiGlobe, onClick: toggleSshPanel },
    { id: 'files', label: t('activity.explorer'), icon: FiFolder, onClick: toggleFilePanel },
    { id: 'git', label: t('git.title'), icon: FiGitBranch, onClick: toggleGitPanel },
    { id: 'desktop', label: t('vnc.title'), icon: FiMonitor, onClick: () => toggleDesktop(activeHostId || 'local') },
    {
      id: 'inbox',
      label: t('inbox.title'),
      icon: FiInbox,
      onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-inbox')),
    },
    {
      id: 'notifications',
      label: t('notification.title'),
      icon: FiBell,
      onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')),
    },
    {
      id: 'settings',
      label: t('activity.settings'),
      icon: FiSettings,
      onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')),
    },
  ] as const
  return (
    <aside className="tmuxgo-glass tmuxgo-glass-sidebar flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--line)] py-3 overflow-hidden scrollbar-none">
      <img src="/app-icon.svg" alt="" className="mb-1 h-9 w-9" />
      {items.map((item) => {
        const active =
          item.id === 'sessions'
            ? sessionPanelExpanded
            : item.id === 'ssh'
              ? sshPanelOpen
              : item.id === 'files'
                ? filePanelOpen
                : item.id === 'git'
                  ? gitPanelOpen
                  : item.id === 'desktop'
                    ? !!activeDesktop
                    : item.id === 'inbox'
                      ? inboxPanelOpen
                      : false
        const Icon = item.icon
        const unread = item.id === 'inbox' ? inboxUnread : 0
        return (
          <button
            key={item.id}
            aria-label={item.label}
            title={item.label}
            onClick={item.onClick}
            className={`tmuxgo-toolbar-icon ${active ? 'tmuxgo-toolbar-icon--active' : ''}`}
          >
            <span className="relative">
              <Icon aria-hidden="true" size={18} />
              {unread > 0 && (
                <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-danger px-0.5 text-center text-[9px] font-medium leading-4 text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
          </button>
        )
      })}
      {!!pluginViews.length && <div className="my-1 h-px w-7 shrink-0 bg-[var(--line)]" />}
      {pluginViews.map(({ plugin, view }) => {
        const Icon = pluginIcons[(view.icon || plugin.manifest.icon || 'box') as keyof typeof pluginIcons] || FiBox
        const active = activePluginView?.pluginId === plugin.pluginId && activePluginView.viewId === view.id
        return (
          <button
            key={`${plugin.pluginId}:${view.id}`}
            aria-label={view.title}
            title={`${view.title} · ${plugin.manifest.name}`}
            onClick={() => setActivePluginView({ pluginId: plugin.pluginId, viewId: view.id })}
            className={`tmuxgo-toolbar-icon ${active ? 'tmuxgo-toolbar-icon--active' : ''}`}
          >
            <Icon aria-hidden="true" size={18} />
          </button>
        )
      })}
    </aside>
  )
}
