'use client'

import { useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { FiGitBranch, FiInbox, FiMonitor, FiMoreHorizontal } from 'react-icons/fi'

const NAV_COMPACT_KEY = 'tmuxgo-mobile-nav-compact'
function readNavCompact() {
  try {
    return localStorage.getItem(NAV_COMPACT_KEY) === 'true'
  } catch {
    return false
  }
}

interface MobileNavProps {
  onOpenDrawer: (type: 'sessions' | 'panes' | 'windows') => void
  onOpenSettings: () => void
  onOpenFiles: () => void
  onOpenGit: () => void
  onOpenDesktop: () => void
  onOpenInbox: () => void
  gitOpen?: boolean
  sessionsOpen?: boolean
  windowsOpen?: boolean
  panesOpen?: boolean
  filesOpen?: boolean
  desktopOpen?: boolean
  settingsOpen?: boolean
  inboxOpen?: boolean
  inboxUnread?: number
  docked?: boolean
}

function NavIcon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const icons = {
  sessions: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  panes: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  windows: 'M4 4h16v16H4zM4 9h16M9 4v16',
  files: 'M3 5h7l2 2h9v12H3z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
}

export function MobileNav({
  onOpenDrawer,
  onOpenSettings,
  onOpenFiles,
  onOpenGit,
  onOpenDesktop,
  onOpenInbox,
  gitOpen = false,
  sessionsOpen = false,
  windowsOpen = false,
  panesOpen = false,
  filesOpen = false,
  desktopOpen = false,
  settingsOpen = false,
  inboxOpen = false,
  inboxUnread = 0,
  docked = false,
}: MobileNavProps) {
  const connection = useConsoleStore((state) => state.connection)
  const attachLatency = useConsoleStore((state) => state.terminalPerf.attachLatency)
  const { t } = useTranslation()

  const isConnected = connection.status === 'connected'
  const isRecovering = connection.status === 'reconnecting' || connection.status === 'attaching'
  const statusColor = isConnected ? 'bg-accent-2' : isRecovering ? 'bg-warn' : 'bg-danger'
  const statusText = isConnected ? `${connection.latency ?? 0}/${attachLatency}ms` : isRecovering ? '...' : t('nav.off')
  // 精简布局可选：默认保留原七项；切换持久化，随时可回退
  const [compact, setCompact] = useState(readNavCompact)
  const [moreOpen, setMoreOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreOpen) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [moreOpen])
  const toggleCompact = () => {
    const next = !compact
    setCompact(next)
    setMoreOpen(false)
    try {
      localStorage.setItem(NAV_COMPACT_KEY, String(next))
    } catch {
      // 隐私模式等场景 localStorage 不可用：仅本次会话生效
    }
  }
  const containerClass = docked
    ? 'tmuxgo-mobile-nav mobile-nav-landscape-hide relative h-full pb-[env(safe-area-inset-bottom)] transition-transform duration-200'
    : 'tmuxgo-glass tmuxgo-mobile-nav mobile-nav-landscape-hide fixed left-2 right-2 z-40 rounded-apple border pb-[env(safe-area-inset-bottom)] transition-transform duration-200'
  // 所有入口统一选中反馈（对齐 Git 的 aria-current + 选中样式）
  const navButtonClass = (active: boolean) =>
    `tmuxgo-mobile-nav-button flex flex-col items-center justify-center gap-px transition-all active:scale-95 active:bg-bg-2/50 ${active ? 'tmuxgo-mobile-nav-button--active' : 'text-text-3 active:text-accent'}`
  // 收件箱未读角标：封顶 99+，避免长数字撑破触摸区
  const inboxBadge = inboxUnread > 0 ? (inboxUnread > 99 ? '99+' : String(inboxUnread)) : null
  const inboxIcon = (
    <div className="relative">
      <FiInbox aria-hidden="true" size={18} />
      {inboxBadge && (
        <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-danger px-0.5 text-center text-[9px] font-medium leading-4 text-white">
          {inboxBadge}
        </span>
      )}
    </div>
  )
  // 精简栏位互换：面板更高频直接上栏，收件箱收进更多（角标随 icon 保留）
  const moreEntries = [
    {
      key: 'inbox',
      label: t('nav.inbox'),
      open: inboxOpen,
      icon: inboxIcon,
      onClick: onOpenInbox,
    },
    {
      key: 'files',
      label: t('nav.files'),
      open: filesOpen,
      icon: <NavIcon d={icons.files} />,
      onClick: onOpenFiles,
    },
    {
      key: 'git',
      label: t('nav.git'),
      open: gitOpen,
      icon: <FiGitBranch aria-hidden="true" size={18} />,
      onClick: onOpenGit,
    },
    {
      key: 'desktop',
      label: t('vnc.title'),
      open: desktopOpen,
      icon: <FiMonitor aria-hidden="true" size={18} />,
      onClick: onOpenDesktop,
    },
    {
      key: 'settings',
      label: t('nav.settings'),
      open: settingsOpen,
      icon: <NavIcon d={icons.settings} />,
      onClick: onOpenSettings,
    },
  ]

  return (
    <div
      ref={rootRef}
      data-mobile-nav
      className={containerClass}
      style={docked ? undefined : { bottom: 'var(--mobile-keyboard-inset, 0px)' }}
    >
      {/* 连接状态独立成一行：不再占用「设置」按钮的文字位 */}
      <div className="relative flex h-3 items-center justify-center text-caption leading-none text-text-3">
        {statusText}
        <button
          aria-label={compact ? t('nav.fullBar') : t('nav.compactBar')}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-text-3 active:text-accent"
          onClick={toggleCompact}
        >
          {compact ? '⊞' : '⊟'}
        </button>
      </div>
      {compact && moreOpen && (
        <div
          data-mobile-nav-more
          className="tmuxgo-float-surface absolute bottom-full left-2 right-2 z-50 mb-1 grid grid-cols-4 gap-1 rounded-apple border p-2"
        >
          {moreEntries.map((entry) => (
            <button
              key={entry.key}
              aria-label={entry.label}
              aria-current={entry.open ? 'page' : undefined}
              onClick={() => {
                setMoreOpen(false)
                entry.onClick()
              }}
              className={navButtonClass(entry.open)}
            >
              {entry.icon}
              <span className="text-caption leading-none">{entry.label}</span>
            </button>
          ))}
        </div>
      )}
      {compact ? (
        <div className="grid h-12 grid-cols-4 items-center">
          <button
            aria-label={t('nav.sessions')}
            aria-current={sessionsOpen ? 'page' : undefined}
            onClick={() => onOpenDrawer('sessions')}
            className={navButtonClass(sessionsOpen)}
          >
            <NavIcon d={icons.sessions} />
            <span className="text-caption leading-none">{t('nav.sessions')}</span>
          </button>
          <button
            aria-label={t('nav.windows')}
            aria-current={windowsOpen ? 'page' : undefined}
            onClick={() => onOpenDrawer('windows')}
            className={navButtonClass(windowsOpen)}
          >
            <NavIcon d={icons.windows} />
            <span className="text-caption leading-none">{t('nav.windows')}</span>
          </button>
          <button
            aria-label={t('nav.panes')}
            aria-current={panesOpen ? 'page' : undefined}
            onClick={() => onOpenDrawer('panes')}
            className={navButtonClass(panesOpen)}
          >
            <NavIcon d={icons.panes} />
            <span className="text-caption leading-none">{t('nav.panes')}</span>
          </button>
          <button
            aria-label={t('nav.more')}
            aria-expanded={moreOpen}
            aria-current={moreEntries.some((entry) => entry.open) ? 'page' : undefined}
            onClick={() => setMoreOpen((value) => !value)}
            className={navButtonClass(moreEntries.some((entry) => entry.open))}
          >
            <div className="relative">
              <FiMoreHorizontal aria-hidden="true" size={18} />
              {/* 收件箱在更多内：未读用角点数透出，不显示具体数字以免挤爆栏位 */}
              {inboxBadge && <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-danger" />}
            </div>
            <span className="text-caption leading-none">{t('nav.more')}</span>
          </button>
        </div>
      ) : (
        <div className="grid h-12 grid-cols-8 items-center">
          <button
            aria-label={t('nav.sessions')}
            aria-current={sessionsOpen ? 'page' : undefined}
            onClick={() => onOpenDrawer('sessions')}
            className={navButtonClass(sessionsOpen)}
          >
            <NavIcon d={icons.sessions} />
            <span className="text-caption leading-none">{t('nav.sessions')}</span>
          </button>

          <button
            aria-label={t('nav.windows')}
            aria-current={windowsOpen ? 'page' : undefined}
            onClick={() => onOpenDrawer('windows')}
            className={navButtonClass(windowsOpen)}
          >
            <NavIcon d={icons.windows} />
            <span className="text-caption leading-none">{t('nav.windows')}</span>
          </button>

          <button
            aria-label={t('nav.inbox')}
            aria-current={inboxOpen ? 'page' : undefined}
            onClick={onOpenInbox}
            className={navButtonClass(inboxOpen)}
          >
            {inboxIcon}
            <span className="text-caption leading-none">{t('nav.inbox')}</span>
          </button>

          <button
            aria-label={t('nav.panes')}
            aria-current={panesOpen ? 'page' : undefined}
            onClick={() => onOpenDrawer('panes')}
            className={navButtonClass(panesOpen)}
          >
            <NavIcon d={icons.panes} />
            <span className="text-caption leading-none">{t('nav.panes')}</span>
          </button>

          <button
            aria-label={t('nav.files')}
            aria-current={filesOpen ? 'page' : undefined}
            onClick={onOpenFiles}
            className={navButtonClass(filesOpen)}
          >
            <NavIcon d={icons.files} />
            <span className="text-caption leading-none">{t('nav.files')}</span>
          </button>

          <button
            aria-label={t('nav.git')}
            aria-current={gitOpen ? 'page' : undefined}
            onClick={onOpenGit}
            className={navButtonClass(gitOpen)}
          >
            <FiGitBranch aria-hidden="true" size={18} />
            <span className="text-caption leading-none">{t('nav.git')}</span>
          </button>

          <button
            aria-label={t('vnc.title')}
            aria-current={desktopOpen ? 'page' : undefined}
            onClick={onOpenDesktop}
            className={navButtonClass(desktopOpen)}
          >
            <FiMonitor aria-hidden="true" size={18} />
            <span className="text-caption leading-none">{t('vnc.title')}</span>
          </button>

          <button
            aria-label={t('nav.settings')}
            aria-current={settingsOpen ? 'page' : undefined}
            onClick={onOpenSettings}
            className={navButtonClass(settingsOpen)}
          >
            <div className="relative">
              <NavIcon d={icons.settings} />
              <div
                className={`absolute -top-1 -right-1.5 w-2.5 h-2.5 rounded-full ${statusColor} ${isRecovering ? 'animate-pulse' : ''} border border-bg-1`}
              />
            </div>
            <span className="text-caption leading-none">{t('nav.settings')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
