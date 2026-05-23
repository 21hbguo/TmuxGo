'use client'

import { useEffect, useState } from 'react'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import { PaneGrid } from './PaneGrid'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { MobileNav } from './MobileNav'
import { MobileDrawer } from './MobileDrawer'
import { Settings } from './Settings'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts, useSessions } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { usePreferences } from '@/hooks/usePreferences'

export function ConsoleLayout() {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const showCommandPalette = useConsoleStore((s) => s.showCommandPalette)
  const toggleCommandPalette = useConsoleStore((s) => s.toggleCommandPalette)
  const toggleSidebar = useConsoleStore((s) => s.toggleSidebar)
  const { preferences } = usePreferences()

  const { data: hostsData = [] } = useHosts()
  const { data: sessionsData = [] } = useSessions(activeHostId || '')
  const { send } = useWebSocket()

  const [isMobile, setIsMobile] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerType, setDrawerType] = useState<'sessions' | 'panes'>('sessions')
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // 一次性初始化 hosts + activeHostId
  useEffect(() => {
    if (hostsData.length > 0 && !activeHostId) {
      const persistedHost = typeof window !== 'undefined' ? localStorage.getItem('tmuxu-active-host') : null
      const localHost = hostsData.find((h: any) => h.id === 'local')
      const restoredHost = persistedHost && hostsData.some((h: any) => h.id === persistedHost) ? persistedHost : null
      useConsoleStore.setState({
        hosts: hostsData,
        activeHostId: restoredHost || localHost?.id || hostsData[0].id,
      })
    }
  }, [hostsData, activeHostId])

  // 一次性初始化 sessions + activeSessionId
  useEffect(() => {
    if (sessionsData.length === 0) {
      return
    }
    const persistedSession = typeof window !== 'undefined' ? localStorage.getItem('tmuxu-active-session') : null
    const persistedSessionExists = !!persistedSession && sessionsData.some((s: any) => s.id === persistedSession)
    if (!activeSessionId) {
      useConsoleStore.setState({
        sessions: sessionsData,
        activeSessionId: persistedSessionExists ? persistedSession : sessionsData[0].id,
      })
      return
    }
    useConsoleStore.setState({ sessions: sessionsData })
  }, [sessionsData, activeSessionId])
  useEffect(() => {
    if (!activeSessionId) return
    localStorage.setItem('tmuxu-active-session', activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-terminal],.xterm,.xterm-screen')) {
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        toggleCommandPalette()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleCommandPalette, toggleSidebar])

  const openDrawer = (type: 'sessions' | 'panes') => {
    setDrawerType(type)
    setDrawerOpen(true)
  }

  const sidebarOrder = preferences.sidebarPosition === 'right' ? 1 : 0

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      {!isMobile && <TopBar />}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <div style={{ order: sidebarOrder }}>
            <Sidebar />
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-hidden">
          <PaneGrid />
        </main>
      </div>
      {!isMobile && preferences.showStatusBar && <StatusBar />}
      {isMobile && (
        <MobileNav
          onOpenDrawer={openDrawer}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
      {showCommandPalette && <CommandPalette />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      <MobileDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        type={drawerType}
      />
    </div>
  )
}
