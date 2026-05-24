'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import { PaneGrid } from './PaneGrid'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { MobileNav } from './MobileNav'
import { MobileDrawer } from './MobileDrawer'
import { Settings } from './Settings'
import { ShortcutBar } from './ShortcutBar'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts, useSessions, useSessionPanes, useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { usePreferences } from '@/hooks/usePreferences'

const MOBILE_QUERY = '(max-width: 1023px)'
const KEYBOARD_EVENT = 'mobile-keyboard-change'

export function ConsoleLayout() {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const showCommandPalette = useConsoleStore((s) => s.showCommandPalette)
  const toggleCommandPalette = useConsoleStore((s) => s.toggleCommandPalette)
  const toggleSidebar = useConsoleStore((s) => s.toggleSidebar)
  const { preferences } = usePreferences()

  const { data: hostsData = [] } = useHosts()
  const { data: sessionsData = [] } = useSessions(activeHostId || '')
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { data: panesData = [] } = useSessionPanes(activeHostId || '', activeSessionId || '')
  const { send } = useWebSocket()

  const [isMobile, setIsMobile] = useState(false)
  const [appHeight, setAppHeight] = useState<string>('100dvh')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerType, setDrawerType] = useState<'sessions' | 'panes'>('sessions')
  const [showSettings, setShowSettings] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const overlayRef = useRef<string[]>([])
  const appHeightRef = useRef('')

  const pushOverlay = useCallback((id: string) => {
    overlayRef.current.push(id)
    window.history.pushState({ overlay: id }, '')
  }, [])

  const popOverlay = useCallback(() => {
    overlayRef.current.pop()
  }, [])

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    setIsMobile(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    const syncAppHeight = () => {
      const isMobileViewport = window.matchMedia(MOBILE_QUERY).matches
      const nextHeight = Math.round(isMobileViewport ? (window.visualViewport?.height || window.innerHeight) : (window.visualViewport?.height || window.innerHeight))
      const nextValue = `${nextHeight}px`
      if (appHeightRef.current === nextValue) return
      appHeightRef.current = nextValue
      setAppHeight(nextValue)
    }
    const handleOrientation = () => window.setTimeout(syncAppHeight, 100)
    syncAppHeight()
    window.addEventListener('resize', syncAppHeight)
    window.visualViewport?.addEventListener('resize', syncAppHeight)
    window.addEventListener('orientationchange', handleOrientation)
    return () => {
      window.removeEventListener('resize', syncAppHeight)
      window.visualViewport?.removeEventListener('resize', syncAppHeight)
      window.removeEventListener('orientationchange', handleOrientation)
    }
  }, [])

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

  useEffect(() => {
    if (sessionsData.length === 0) return
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
    if (!activeHostId || !activeSessionId) {
      useConsoleStore.setState({ windows: [] })
      return
    }
    useConsoleStore.setState({ windows: windowsData })
  }, [windowsData, activeHostId, activeSessionId])

  useEffect(() => {
    if (!activeHostId || !activeSessionId) {
      useConsoleStore.setState({ panes: [], activePaneId: null })
      return
    }
    useConsoleStore.setState((state) => ({
      panes: panesData,
      activePaneId: panesData.find((pane: any) => pane.active)?.id || (panesData.some((pane: any) => pane.id === state.activePaneId) ? state.activePaneId : panesData[0]?.id || null),
    }))
  }, [panesData, activeHostId, activeSessionId])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-terminal],.xterm,.xterm-screen')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        openPalette()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleCommandPalette, toggleSidebar])

  useEffect(() => {
    const handlePopState = () => {
      const stack = overlayRef.current
      if (stack.length === 0) return
      const top = stack[stack.length - 1]
      if (top === 'settings') setShowSettings(false)
      else if (top === 'drawer') setDrawerOpen(false)
      else if (top === 'palette') toggleCommandPalette()
      stack.pop()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [toggleCommandPalette])

  useEffect(() => {
    if (!isMobile) return
    const handleKeyboardChange = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail
      setKeyboardOpen(!!detail?.open)
    }
    setKeyboardOpen(document.body.classList.contains('keyboard-open'))
    window.addEventListener(KEYBOARD_EVENT, handleKeyboardChange as EventListener)
    return () => {
      window.removeEventListener(KEYBOARD_EVENT, handleKeyboardChange as EventListener)
    }
  }, [isMobile])

  const openDrawer = useCallback((type: 'sessions' | 'panes') => {
    setDrawerType(type)
    setDrawerOpen(true)
    pushOverlay('drawer')
  }, [pushOverlay])

  const openSettings = useCallback(() => {
    setShowSettings(true)
    pushOverlay('settings')
  }, [pushOverlay])

  const openPalette = useCallback(() => {
    if (!showCommandPalette) pushOverlay('palette')
    toggleCommandPalette()
  }, [showCommandPalette, pushOverlay, toggleCommandPalette])

  const sidebarOrder = preferences.sidebarPosition === 'right' ? 1 : 0

  return (
    <div className="flex w-screen flex-col overflow-hidden" style={{ height: appHeight, ['--app-height' as any]: appHeight }}>
      {!isMobile && <TopBar />}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <div style={{ order: sidebarOrder }}>
            <Sidebar />
          </div>
        )}
        <main data-console-main className="flex flex-1 min-h-0 flex-col bg-bg-1" style={isMobile ? { paddingBottom: keyboardOpen ? 'calc(52px + env(safe-area-inset-bottom,0px))' : 'calc(56px + env(safe-area-inset-bottom,0px))' } : undefined}>
          <PaneGrid />
          {!isMobile && <ShortcutBar />}
        </main>
      </div>
      {!isMobile && preferences.showStatusBar && <StatusBar />}
      {isMobile && keyboardOpen && <ShortcutBar />}
      {isMobile && (
        <MobileNav
          onOpenDrawer={openDrawer}
          onOpenSettings={openSettings}
          onOpenSearch={openPalette}
        />
      )}
      {showCommandPalette && <CommandPalette onClose={popOverlay} />}
      {showSettings && <Settings onClose={() => { setShowSettings(false); popOverlay() }} />}
      <MobileDrawer
        isOpen={drawerOpen}
        onClose={() => { setDrawerOpen(false); popOverlay() }}
        type={drawerType}
      />
    </div>
  )
}
