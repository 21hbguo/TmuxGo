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
import { InstallAppBanner } from './InstallAppBanner'
import { ShortcutBar } from './ShortcutBar'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts, useSessions, useSessionPanes, useWindows } from '@/hooks/useApi'
import { useWebSocket } from '@/hooks/useWebSocket'
import { usePreferences } from '@/hooks/usePreferences'

const MOBILE_QUERY = '(max-width: 1023px)'

export function ConsoleLayout({ initialIsMobile=false }:{ initialIsMobile?:boolean }) {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const showCommandPalette = useConsoleStore((s) => s.showCommandPalette)
  const setCommandPalette = useConsoleStore((s) => s.setCommandPalette)
  const toggleSidebar = useConsoleStore((s) => s.toggleSidebar)
  const { preferences } = usePreferences()

  const { data: hostsData = [] } = useHosts()
  const { data: sessionsData = [] } = useSessions(activeHostId || '')
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { data: panesData = [] } = useSessionPanes(activeHostId || '', activeSessionId || '')
  const { send } = useWebSocket()

  const [isMobile, setIsMobile] = useState(initialIsMobile)
  const [appHeight, setAppHeight] = useState<string>(initialIsMobile?'100svh':'100dvh')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerType, setDrawerType] = useState<'sessions' | 'panes'>('sessions')
  const [showSettings, setShowSettings] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [keyboardInset, setKeyboardInset] = useState(0)
  const overlayRef = useRef<string[]>([])
  const appHeightRef = useRef('')
  const viewportBaseHeightRef = useRef(0)
  const appHeightNumRef = useRef(0)
  const keyboardOpenRef = useRef(false)
  const appHeightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushOverlay = useCallback((id: string) => {
    if (overlayRef.current[overlayRef.current.length - 1] === id) return
    overlayRef.current.push(id)
    window.history.pushState({ overlay: id }, '')
  }, [])

  const closeOverlay = useCallback((id: string) => {
    if (overlayRef.current[overlayRef.current.length - 1] !== id) return
    window.history.back()
  }, [])
  const openDrawer = useCallback((type: 'sessions' | 'panes') => {
    if (drawerOpen && drawerType === type) return
    setDrawerType(type)
    if (!drawerOpen) {
      setDrawerOpen(true)
      pushOverlay('drawer')
      return
    }
    setDrawerOpen(true)
  }, [drawerOpen, drawerType, pushOverlay])
  const openSettings = useCallback(() => {
    if (showSettings) return
    setShowSettings(true)
    pushOverlay('settings')
  }, [showSettings, pushOverlay])
  const openPalette = useCallback(() => {
    if (showCommandPalette) return
    setCommandPalette(true)
    pushOverlay('palette')
  }, [showCommandPalette, setCommandPalette, pushOverlay])
  useEffect(() => {
    keyboardOpenRef.current = keyboardOpen
  }, [keyboardOpen])

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    setIsMobile(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    const clearSyncTimer = () => {
      if (!appHeightTimerRef.current) return
      clearTimeout(appHeightTimerRef.current)
      appHeightTimerRef.current = null
    }
    const applyAppHeight = (nextHeight: number) => {
      const nextValue = `${nextHeight}px`
      if (appHeightRef.current === nextValue) return
      appHeightRef.current = nextValue
      appHeightNumRef.current = nextHeight
      setAppHeight(nextValue)
    }
    const syncAppHeight = (deferred=false) => {
      const isMobileViewport = window.matchMedia(MOBILE_QUERY).matches
      const vv = window.visualViewport
      if (isMobileViewport && vv?.height && vv.height > viewportBaseHeightRef.current) viewportBaseHeightRef.current = vv.height
      const nextHeight = Math.round(
        !isMobileViewport
          ? window.innerHeight
          : keyboardOpenRef.current
            ? (vv?.height || window.innerHeight)
            : (viewportBaseHeightRef.current || window.innerHeight)
      )
      if (isMobileViewport && appHeightNumRef.current && !keyboardOpenRef.current && Math.abs(nextHeight - appHeightNumRef.current) < 36) return
      if (isMobileViewport && appHeightNumRef.current && keyboardOpenRef.current && Math.abs(nextHeight - appHeightNumRef.current) < 6) return
      if (isMobileViewport && !keyboardOpenRef.current && deferred) {
        clearSyncTimer()
        appHeightTimerRef.current = setTimeout(() => {
          appHeightTimerRef.current = null
          applyAppHeight(nextHeight)
        }, 120)
        return
      }
      clearSyncTimer()
      applyAppHeight(nextHeight)
    }
    const handleOrientation = () => window.setTimeout(() => syncAppHeight(), 80)
    const handleResize = () => syncAppHeight(true)
    syncAppHeight()
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleOrientation)
    return () => {
      clearSyncTimer()
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleOrientation)
    }
  }, [keyboardOpen])
  useEffect(() => {
    const getViewportInset = () => {
      const vv = window.visualViewport
      if (!vv) return 0
      if (vv.height > viewportBaseHeightRef.current) viewportBaseHeightRef.current = vv.height
      return Math.max(0, viewportBaseHeightRef.current - vv.height)
    }
    const handleKeyboardChange = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean; inset?: number }>).detail
      setKeyboardOpen(!!detail?.open)
      setKeyboardInset(detail?.open ? detail?.inset || 0 : 0)
    }
    const syncKeyboardOpen = () => {
      const inset = getViewportInset()
      const byViewport = inset >= 80
      const byClass = document.body.classList.contains('keyboard-open')
      setKeyboardOpen(byViewport || byClass)
      setKeyboardInset(byViewport || byClass ? inset : 0)
    }
    window.addEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
    window.visualViewport?.addEventListener('resize', syncKeyboardOpen)
    window.addEventListener('focus', syncKeyboardOpen)
    window.addEventListener('pageshow', syncKeyboardOpen)
    syncKeyboardOpen()
    return () => {
      window.removeEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
      window.visualViewport?.removeEventListener('resize', syncKeyboardOpen)
      window.removeEventListener('focus', syncKeyboardOpen)
      window.removeEventListener('pageshow', syncKeyboardOpen)
    }
  }, [])

  useEffect(() => {
    if (hostsData.length > 0 && !activeHostId) {
      const persistedHost = typeof window !== 'undefined' ? localStorage.getItem('tmuxgo-active-host') : null
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
    const persistedSession = typeof window !== 'undefined' ? localStorage.getItem('tmuxgo-active-session') : null
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
    localStorage.setItem('tmuxgo-active-session', activeSessionId)
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
        if (showCommandPalette) {
          closeOverlay('palette')
        } else {
          openPalette()
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showCommandPalette, openPalette, closeOverlay, toggleSidebar])

  useEffect(() => {
    const handlePopState = () => {
      const stack = overlayRef.current
      if (stack.length === 0) return
      const top = stack[stack.length - 1]
      if (top === 'settings') setShowSettings(false)
      else if (top === 'drawer') setDrawerOpen(false)
      else if (top === 'palette') setCommandPalette(false)
      stack.pop()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [setCommandPalette])

  const sidebarOrder = preferences.sidebarPosition === 'right' ? 1 : 0

  return (
    <div className="flex w-screen flex-col overflow-hidden" style={{ height: appHeight, ['--app-height' as any]: appHeight }}>
      <InstallAppBanner />
      {!isMobile && <TopBar />}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <div style={{ order: sidebarOrder }}>
            <Sidebar />
          </div>
        )}
        <main className="flex flex-1 min-h-0 flex-col bg-bg-1" style={isMobile ? { paddingBottom: keyboardOpen ? '0px' : 'calc(48px + env(safe-area-inset-bottom,0px))' } : undefined}>
          <PaneGrid />
        </main>
      </div>
      {!isMobile && preferences.showStatusBar && <StatusBar />}
      {isMobile && (
        keyboardOpen ? <ShortcutBar mode="dock" /> : <MobileNav onOpenDrawer={openDrawer} onOpenSettings={openSettings} onOpenSearch={openPalette} />
      )}
      {showCommandPalette && <CommandPalette onClose={() => closeOverlay('palette')} />}
      {showSettings && <Settings onClose={() => closeOverlay('settings')} />}
      <MobileDrawer
        isOpen={drawerOpen}
        onClose={() => closeOverlay('drawer')}
        type={drawerType}
      />
    </div>
  )
}
