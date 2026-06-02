'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'

export function ActivityBar() {
  const sessionPanelExpanded = useConsoleStore((state) => state.sessionPanelExpanded)
  const toggleSessionPanel = useConsoleStore((state) => state.toggleSessionPanel)
  const filePanelOpen = useConsoleStore((state) => state.filePanelOpen)
  const toggleFilePanel = useConsoleStore((state) => state.toggleFilePanel)
  const gitPanelOpen = useConsoleStore((state) => state.gitPanelOpen)
  const toggleGitPanel = useConsoleStore((state) => state.toggleGitPanel)
  const setCommandPalette = useConsoleStore((state) => state.setCommandPalette)
  const { t } = useTranslation()
  const items = [
    { id: 'sessions', label: t('activity.sessions'), icon: '▣', onClick: toggleSessionPanel },
    { id: 'files', label: t('activity.explorer'), icon: '≡', onClick: toggleFilePanel },
    { id: 'git', label: t('git.title'), icon: '⑂', onClick: toggleGitPanel },
    { id: 'search', label: t('activity.search'), icon: '⌕', onClick: () => setCommandPalette(true) },
    { id: 'settings', label: t('activity.settings'), icon: '⚙', onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')) },
  ] as const
  return (
    <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--line)] bg-bg-1 px-2 py-3">
      <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--line)] bg-bg-2 text-sm font-semibold text-accent">TG</div>
      {items.map((item) => {
        const active = item.id === 'sessions' ? sessionPanelExpanded : item.id === 'files' ? filePanelOpen : item.id === 'git' ? gitPanelOpen : false
        return (
          <button key={item.id} title={item.label} onClick={item.onClick} className={`flex h-10 w-10 items-center justify-center rounded-lg border text-sm transition-colors ${active ? 'border-[var(--line)] bg-bg-2 text-accent' : 'border-transparent bg-transparent text-text-3 hover:bg-bg-2 hover:text-text-1'}`}>
            {item.icon}
          </button>
        )
      })}
    </aside>
  )
}
