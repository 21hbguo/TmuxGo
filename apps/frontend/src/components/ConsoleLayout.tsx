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
  const store = useConsoleStore()
  const { activeHostId, activeSessionId, setActiveHost, setActiveSession, showCommandPalette, toggleCommandPalette, toggleSidebar } = store
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

  useEffect(() => {
    if (hostsData.length > 0) {
      useConsoleStore.setState({ hosts: hostsData })
      const localHost = hostsData.find((host: any) => host.id === 'local')
      if (!activeHostId) {
        setActiveHost(localHost?.id || hostsData[0].id)
      }
    }
  }, [hostsData, activeHostId, setActiveHost])

  useEffect(() => {
    if (sessionsData.length > 0) {
      useConsoleStore.setState({ sessions: sessionsData })
      const currentSession = sessionsData.find((s: any) => s.id === activeSessionId)
      if (!activeSessionId || !currentSession) {
        setActiveSession(sessionsData[0].id)
      }
    }
  }, [sessionsData, activeSessionId, setActiveSession])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
    <div className="flex flex-col h-screen w-screen">
      {!isMobile && <TopBar />}
      <div className="flex flex-1 overflow-hidden">
        {!isMobile && (
          <div style={{ order: sidebarOrder }}>
            <Sidebar />
          </div>
        )}
        <main className="flex-1 overflow-hidden">
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
