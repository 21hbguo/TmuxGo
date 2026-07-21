'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { FiBell, FiFolder, FiGitBranch, FiGrid, FiSearch, FiServer, FiSettings } from 'react-icons/fi'
import { FiActivity, FiBox, FiCode, FiCpu, FiDatabase, FiGlobe, FiTerminal, FiTool, FiZap } from 'react-icons/fi'
import { usePlugins } from '@/hooks/useApi'

const pluginIcons = { activity: FiActivity, box: FiBox, code: FiCode, cpu: FiCpu, database: FiDatabase, globe: FiGlobe, terminal: FiTerminal, tool: FiTool, zap: FiZap }

export function ActivityBar() {
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const toggleSessionPanel = useConsoleStore((state) => state.toggleSessionPanel)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  const thumbnailPanelOpen = useConsoleStore((state) => state.thumbnailPanelOpen)
  const toggleThumbnailPanel = useConsoleStore((state) => state.toggleThumbnailPanel)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const activePluginView = useConsoleStore((state) => state.activePluginView)
  const setActivePluginView = useConsoleStore((state) => state.setActivePluginView)
  const toggleGitPanel = useConsoleStore((state) => state.toggleGitPanel)
  const setCommandPalette = useConsoleStore((state) => state.setCommandPalette)
  const { t } = useTranslation()
  const { data } = usePlugins()
  const pluginViews = (data?.plugins || []).filter((plugin) => plugin.enabled && plugin.state === 'active').flatMap((plugin) => (plugin.manifest.contributes?.views || []).map((view) => ({ plugin, view })))
  const items = [
    { id: 'sessions', label: t('activity.sessions'), icon: FiServer, onClick: toggleSessionPanel },
    { id: 'files', label: t('activity.explorer'), icon: FiFolder, onClick: toggleFilePanel },
    { id: 'thumbnails', label: t('activity.thumbnails'), icon: FiGrid, onClick: toggleThumbnailPanel },
    { id: 'git', label: t('git.title'), icon: FiGitBranch, onClick: toggleGitPanel },
    { id: 'search', label: t('activity.search'), icon: FiSearch, onClick: () => setCommandPalette(true) },
    { id: 'notifications', label: t('notification.title'), icon: FiBell, onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-toggle-notifications')) },
    { id: 'settings', label: t('activity.settings'), icon: FiSettings, onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')) },
  ] as const
  return (
    <aside className="tmuxgo-glass tmuxgo-glass-sidebar flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r px-2 py-3">
      <img src="/app-icon.svg" alt="" className="mb-1 h-9 w-9 rounded-[10px] shadow-sm" />
      {items.map((item) => {
        const active = item.id === 'sessions' ? sessionPanelExpanded : item.id === 'files' ? filePanelOpen : item.id === 'thumbnails' ? thumbnailPanelOpen : item.id === 'git' ? gitPanelOpen : false
        const Icon = item.icon
        return (
          <button key={item.id} aria-label={item.label} title={item.label} onClick={item.onClick} className={`tmuxgo-icon-button flex h-10 w-10 items-center justify-center rounded-xl border text-sm ${active ? 'border-accent/30 bg-accent/15 text-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]' : 'border-transparent bg-transparent text-text-3 hover:bg-bg-2/65 hover:text-text-1'}`}>
            <Icon aria-hidden="true" size={18} />
          </button>
        )
      })}
      {!!pluginViews.length && <div className="my-1 h-px w-7 shrink-0 bg-[var(--line)]" />}
      {pluginViews.map(({ plugin, view }) => {
        const Icon = pluginIcons[(view.icon || plugin.manifest.icon || 'box') as keyof typeof pluginIcons] || FiBox
        const active = activePluginView?.pluginId === plugin.pluginId && activePluginView.viewId === view.id
        return <button key={`${plugin.pluginId}:${view.id}`} aria-label={view.title} title={`${view.title} · ${plugin.manifest.name}`} onClick={() => setActivePluginView({ pluginId: plugin.pluginId, viewId: view.id })} className={`tmuxgo-icon-button flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${active ? 'border-accent/30 bg-accent/15 text-accent' : 'border-transparent text-text-3 hover:bg-bg-2/65 hover:text-text-1'}`}><Icon aria-hidden="true" size={18} /></button>
      })}
    </aside>
  )
}
