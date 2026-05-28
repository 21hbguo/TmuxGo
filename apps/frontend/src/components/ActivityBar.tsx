'use client'
import { useConsoleStore } from '@/stores/useConsoleStore'

export function ActivityBar() {
  const desktopPanel = useConsoleStore((state) => state.desktopPanel)
  const sidebarCollapsed = useConsoleStore((state) => state.sidebarCollapsed)
  const setDesktopPanel = useConsoleStore((state) => state.setDesktopPanel)
  const toggleSidebar = useConsoleStore((state) => state.toggleSidebar)
  const setCommandPalette = useConsoleStore((state) => state.setCommandPalette)
  const items = [
    { id: 'sessions', label: 'Sessions', icon: '▣', onClick: () => { if (desktopPanel === 'sessions' && !sidebarCollapsed) toggleSidebar(); else setDesktopPanel('sessions') } },
    { id: 'files', label: 'Explorer', icon: '≡', onClick: () => { if (desktopPanel === 'files' && !sidebarCollapsed) toggleSidebar(); else setDesktopPanel('files') } },
    { id: 'search', label: 'Search', icon: '⌕', onClick: () => setCommandPalette(true) },
    { id: 'settings', label: 'Settings', icon: '⚙', onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-open-settings')) },
  ] as const
  return (
    <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--line)] bg-bg-1 px-2 py-3">
      <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--line)] bg-bg-2 text-sm font-semibold text-accent">TG</div>
      {items.map((item) => {
        const active = item.id === desktopPanel && !sidebarCollapsed && (item.id === 'sessions' || item.id === 'files')
        return (
          <button key={item.id} title={item.label} onClick={item.onClick} className={`flex h-10 w-10 items-center justify-center rounded-lg border text-sm transition-colors ${active ? 'border-[var(--line)] bg-bg-2 text-accent' : 'border-transparent bg-transparent text-text-3 hover:bg-bg-2 hover:text-text-1'}`}>
            {item.icon}
          </button>
        )
      })}
    </aside>
  )
}
