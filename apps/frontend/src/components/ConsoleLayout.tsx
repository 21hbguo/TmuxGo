'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { TopBar } from './TopBar'
import { PaneGrid } from './PaneGrid'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { ClipboardController } from './ClipboardController'
import { MobileNav } from './MobileNav'
import { MobileDrawer } from './MobileDrawer'
import { Settings } from './Settings'
import { InstallAppBanner } from './InstallAppBanner'
import { ShortcutBar } from './ShortcutBar'
import { ToastViewport } from './ToastViewport'
import { FilePanel } from './FilePanel'
import { UploadConfirmDialog } from './UploadConfirmDialog'
import { UploadQueue } from './UploadQueue'
import { AppVersionGuard } from './AppVersionGuard'
import { createViewportStableState, getNextViewportStableState, getViewportLayoutState, normalizeKeyboardViewportState } from './consoleLayoutViewport'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts, useSessionSnapshot } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { usePreferences } from '@/hooks/usePreferences'
import { useSessionContinuity } from '@/hooks/useSessionContinuity'
import { DesktopWorkbench } from './DesktopWorkbench'
import { recordMobileDiagnostic, startMobileFlickerDiagnostics } from '@/lib/mobile-diagnostics'

const MOBILE_QUERY = '(max-width: 1023px)'
function recordMobileDebug(event: string, data?: Record<string, unknown>) {
  recordMobileDiagnostic(event, data)
  if (typeof window === 'undefined' || !window.localStorage.getItem('tmuxgo-debug-mobile')) return
  const target = window as typeof window & { __tmuxgoMobileDebug?: { events: Array<Record<string, unknown>> } }
  const state = target.__tmuxgoMobileDebug || { events: [] }
  state.events.push({ event, at: Math.round(performance.now()), ...data })
  state.events = state.events.slice(-240)
  target.__tmuxgoMobileDebug = state
}

export function ConsoleLayout({ initialIsMobile=false }:{ initialIsMobile?:boolean }) {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const showCommandPalette = useConsoleStore((s) => s.showCommandPalette)
  const setCommandPalette = useConsoleStore((s) => s.setCommandPalette)
  const setActiveHost = useConsoleStore((s) => s.setActiveHost)
  const setActiveSession = useConsoleStore((s) => s.setActiveSession)
  const sessionPanelExpanded = useConsoleStore((s) => s.sessionPanelExpanded)
  const toggleSessionPanel = useConsoleStore((s) => s.toggleSessionPanel)
  const filePanelOpen = useConsoleStore((s) => s.filePanelOpen)
  const toggleFilePanel = useConsoleStore((s) => s.toggleFilePanel)
  const mobileFileSheetOpen = useConsoleStore((s) => s.mobileFileSheetOpen)
  const setMobileFileSheetOpen = useConsoleStore((s) => s.setMobileFileSheetOpen)
  const { preferences } = usePreferences()
  const { sessionContinuity } = useSessionContinuity()

  const { data: hostsData = [] } = useHosts()
  const { data: sessionsData = [], isFetched: sessionsFetched } = useOrderedSessions(activeHostId || '')
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', activeSessionId || '')

  const [isMobile, setIsMobile] = useState(initialIsMobile)
  const [appHeight, setAppHeight] = useState(initialIsMobile ? '100svh' : '100dvh')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerType, setDrawerType] = useState<'sessions' | 'panes' | 'windows'>('sessions')
  const [showSettings, setShowSettings] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const overlayRef = useRef<string[]>([])
  const ignoreNextPopRef = useRef(false)
  const appHeightRef = useRef(appHeight)
  const viewportBaseHeightRef = useRef(0)
  const appHeightNumRef = useRef(0)
  const keyboardStateRef = useRef({ open: false, inset: 0 })
  const viewportFrameRef = useRef<number | null>(null)
  const viewportWidthRef = useRef(0)
  const viewportStableRef = useRef(createViewportStableState())

  const pushOverlay = useCallback((id: string) => {
    if (id !== 'mobile-files-level' && overlayRef.current[overlayRef.current.length - 1] === id) return
    overlayRef.current.push(id)
    window.history.pushState({ overlay: id }, '')
  }, [])

  const closeOverlay = useCallback((id: string) => {
    if (overlayRef.current[overlayRef.current.length - 1] !== id) return
    window.history.back()
  }, [])
  const openDrawer = useCallback((type: 'sessions' | 'panes' | 'windows') => {
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
  const dismissSettings = useCallback(() => {
    setShowSettings(false)
    const stack = overlayRef.current
    const index = stack.lastIndexOf('settings')
    if (index === -1) return
    if (index === stack.length - 1) {
      stack.pop()
      ignoreNextPopRef.current = true
      window.history.back()
      return
    }
    stack.splice(index, 1)
  }, [])
  const openPalette = useCallback(() => {
    if (showCommandPalette) return
    setCommandPalette(true)
    pushOverlay('palette')
  }, [showCommandPalette, setCommandPalette, pushOverlay])
  const openMobileFiles = useCallback(() => {
    if (mobileFileSheetOpen) return
    setMobileFileSheetOpen(true)
    pushOverlay('mobile-files')
  }, [mobileFileSheetOpen, setMobileFileSheetOpen, pushOverlay])
  const clearViewportSchedule = useCallback(() => {
    if (viewportFrameRef.current) {
      cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = null
    }
  }, [])
  const scheduleViewportSync = useCallback(() => {
    if (viewportFrameRef.current) return
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null
      const isMobileViewport = window.matchMedia(MOBILE_QUERY).matches
      const vv = window.visualViewport
      const viewportHeight = vv?.height || window.innerHeight
      const viewportWidth = vv?.width || window.innerWidth
      const byClass = document.body.classList.contains('keyboard-open')
      const activeElement = document.activeElement
      const keyboardOwnerActive = activeElement instanceof HTMLElement && activeElement.classList.contains('mobile-kb-input')
      const normalizedKeyboard = normalizeKeyboardViewportState({
        keyboardOpen: keyboardStateRef.current.open,
        keyboardInset: keyboardStateRef.current.inset,
        bodyKeyboardOpen: byClass,
        keyboardOwnerActive,
      })
      if (normalizedKeyboard.keyboardOpen !== keyboardStateRef.current.open || normalizedKeyboard.keyboardInset !== keyboardStateRef.current.inset) keyboardStateRef.current = { open: normalizedKeyboard.keyboardOpen, inset: normalizedKeyboard.keyboardInset }
      recordMobileDebug('viewport-sync', { innerHeight: window.innerHeight, vvHeight: vv?.height || 0, vvWidth: vv?.width || 0, keyboardOpen: keyboardStateRef.current.open, keyboardInset: keyboardStateRef.current.inset, bodyKeyboardOpen: byClass })
      viewportStableRef.current = getNextViewportStableState({
        state: viewportStableRef.current,
        isMobileViewport,
        innerHeight: window.innerHeight,
        viewportHeight,
        viewportWidth,
        previousViewportWidth: viewportWidthRef.current,
        baseHeight: viewportBaseHeightRef.current,
        keyboardOpen: keyboardStateRef.current.open,
        bodyKeyboardOpen: byClass,
        currentAppHeight: appHeightNumRef.current,
        now: performance.now(),
      })
      const state = getViewportLayoutState({
        isMobileViewport,
        innerHeight: window.innerHeight,
        viewportHeight,
        viewportWidth,
        previousViewportWidth: viewportWidthRef.current,
        baseHeight: viewportStableRef.current.stableClosedHeight || viewportBaseHeightRef.current,
        keyboardOpen: keyboardStateRef.current.open,
        keyboardInset: keyboardStateRef.current.inset,
        bodyKeyboardOpen: byClass,
      })
      if (viewportWidthRef.current !== state.viewportWidth) appHeightNumRef.current = 0
      viewportWidthRef.current = state.viewportWidth
      viewportBaseHeightRef.current = state.baseHeight
      const open = state.open
      if (keyboardStateRef.current.open !== open || keyboardStateRef.current.inset !== state.inset) {
        keyboardStateRef.current = { open, inset: state.inset }
        setKeyboardOpen(open)
      }
      const nextHeight = state.nextHeight
      if (isMobileViewport && appHeightNumRef.current && !open && Math.abs(nextHeight - appHeightNumRef.current) < 36) return
      if (isMobileViewport && appHeightNumRef.current && open && Math.abs(nextHeight - appHeightNumRef.current) < 6) return
      const nextValue = `${nextHeight}px`
      if (appHeightRef.current === nextValue) return
      appHeightRef.current = nextValue
      appHeightNumRef.current = nextHeight
      recordMobileDebug('app-height', { height: nextHeight, open })
      setAppHeight(nextValue)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'viewport-sync', height: nextHeight, keyboardOpen: open, mobile: isMobileViewport } }))
    })
  }, [])

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const syncViewportMode = () => {
      const nextMobile = mql.matches
      setIsMobile(nextMobile)
      const nextHeight = Math.round(window.visualViewport?.height || window.innerHeight || 0)
      if (!nextHeight) return
      const nextValue = `${nextHeight}px`
      appHeightRef.current = nextValue
      appHeightNumRef.current = nextHeight
      viewportBaseHeightRef.current = nextMobile ? nextHeight : 0
      viewportStableRef.current = createViewportStableState(nextMobile ? nextHeight : 0)
      setAppHeight(nextValue)
    }
    syncViewportMode()
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches)
      syncViewportMode()
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    const handleOrientation = () => window.setTimeout(() => scheduleViewportSync(), 80)
    const handleResize = () => scheduleViewportSync()
    scheduleViewportSync()
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleOrientation)
    return () => {
      clearViewportSchedule()
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleOrientation)
    }
  }, [clearViewportSchedule, scheduleViewportSync])
  useEffect(() => startMobileFlickerDiagnostics(), [])
  useEffect(() => {
    const handleKeyboardChange = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean; inset?: number }>).detail
      keyboardStateRef.current = { open: !!detail?.open, inset: detail?.open ? detail?.inset || 0 : 0 }
      setKeyboardOpen(!!detail?.open)
      scheduleViewportSync()
    }
    const syncKeyboardOpen = () => scheduleViewportSync()
    window.addEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
    window.visualViewport?.addEventListener('resize', syncKeyboardOpen)
    window.addEventListener('focus', syncKeyboardOpen)
    window.addEventListener('pageshow', syncKeyboardOpen)
    scheduleViewportSync()
    return () => {
      window.removeEventListener('mobile-keyboard-change', handleKeyboardChange as EventListener)
      window.visualViewport?.removeEventListener('resize', syncKeyboardOpen)
      window.removeEventListener('focus', syncKeyboardOpen)
      window.removeEventListener('pageshow', syncKeyboardOpen)
    }
  }, [scheduleViewportSync])

  useEffect(() => {
    if (hostsData.length > 0 && !activeHostId) {
      const persistedHost = typeof window !== 'undefined' ? localStorage.getItem('tmuxgo-active-host') : null
      const localHost = hostsData.find((h: any) => h.id === 'local')
      const restoredHost = persistedHost && hostsData.some((h: any) => h.id === persistedHost) ? persistedHost : null
      setActiveHost(restoredHost || localHost?.id || hostsData[0].id)
    }
  }, [hostsData, activeHostId, setActiveHost])
  useEffect(() => {
    if (!activeHostId || !hostsData.length) return
    if (hostsData.some((host: any) => host.id === activeHostId)) return
    const localHost = hostsData.find((host: any) => host.id === 'local')
    setActiveHost(localHost?.id || hostsData[0].id)
  }, [activeHostId, hostsData, setActiveHost])

  useEffect(() => {
    if (!sessionsFetched) return
    if (sessionsData.length === 0) {
      if (activeSessionId) setActiveSession('')
      return
    }
    const persistedSession = typeof window !== 'undefined' && activeHostId ? localStorage.getItem(`tmuxgo-active-session:${activeHostId}`) || localStorage.getItem('tmuxgo-active-session') : null
    const persistedSessionExists = !!persistedSession && sessionsData.some((s: any) => s.id === persistedSession)
    const continuityPoint = activeHostId && sessionContinuity.enabled && (sessionContinuity.resumeOnReconnect || sessionContinuity.resumeOnNewDevice) ? sessionContinuity.resumePoints.find((item) => item.hostId === activeHostId) : null
    const continuitySessionExists = !!continuityPoint?.sessionId && sessionsData.some((s: any) => s.id === continuityPoint.sessionId)
    const activeSessionExists = !!activeSessionId && sessionsData.some((s: any) => s.id === activeSessionId)
    if (!activeSessionId || !activeSessionExists) {
      setActiveSession(continuitySessionExists ? continuityPoint!.sessionId : persistedSessionExists ? persistedSession! : sessionsData[0].id)
    }
  }, [sessionsData, sessionsFetched, activeSessionId, activeHostId, setActiveSession, sessionContinuity])

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
        toggleSessionPanel()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (isMobile) openMobileFiles()
        else toggleFilePanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showCommandPalette, openPalette, closeOverlay, toggleSessionPanel, toggleFilePanel, isMobile, openMobileFiles])

  useEffect(() => {
    const handleMobileFilesPushLevel = () => pushOverlay('mobile-files-level')
    window.addEventListener('tmuxgo-mobile-files-push-level', handleMobileFilesPushLevel as EventListener)
    return () => window.removeEventListener('tmuxgo-mobile-files-push-level', handleMobileFilesPushLevel as EventListener)
  }, [pushOverlay])
  useEffect(() => {
    const handlePopState = () => {
      if (ignoreNextPopRef.current) {
        ignoreNextPopRef.current = false
        return
      }
      const stack = overlayRef.current
      if (stack.length === 0) return
      const top = stack[stack.length - 1]
      if (top === 'settings') setShowSettings(false)
      else if (top === 'drawer') setDrawerOpen(false)
      else if (top === 'palette') setCommandPalette(false)
      else if (top === 'mobile-files-level') {
        window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: { handled: false } }))
      }
      else if (top === 'mobile-files') {
        const detail = { handled: false }
        window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail }))
        if (detail.handled) return
        setMobileFileSheetOpen(false)
      }
      stack.pop()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [setCommandPalette, setMobileFileSheetOpen])
  useEffect(() => {
    const handleOpenSettings = () => openSettings()
    window.addEventListener('tmuxgo-open-settings', handleOpenSettings as EventListener)
    return () => window.removeEventListener('tmuxgo-open-settings', handleOpenSettings as EventListener)
  }, [openSettings])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'session-panel', open: sessionPanelExpanded, mobile: false } }))
  }, [sessionPanelExpanded])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'file-panel', open: filePanelOpen, mobile: false } }))
  }, [filePanelOpen])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'mobile-file-panel', open: mobileFileSheetOpen, mobile: true } }))
  }, [mobileFileSheetOpen])
  useEffect(() => {
    if (!isMobile) return
    window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'mobile-keyboard-dock', open: keyboardOpen, mobile: true } }))
  }, [isMobile, keyboardOpen])
  useEffect(() => {
    const handleNewSession = () => {
      if (isMobile) {
        setDrawerType('sessions')
        setDrawerOpen(true)
        return
      }
      window.dispatchEvent(new CustomEvent('tmuxgo-open-session-templates'))
    }
    window.addEventListener('tmuxgo-new-session', handleNewSession as EventListener)
    return () => window.removeEventListener('tmuxgo-new-session', handleNewSession as EventListener)
  }, [isMobile])

  return (
    <div className="flex w-screen flex-col overflow-hidden" style={{ height: appHeight, ['--app-height' as any]: appHeight }}>
      <InstallAppBanner />
      {!isMobile && <TopBar />}
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <main data-workspace-main className="flex flex-1 min-h-0 min-w-0 flex-col bg-bg-1">
          {isMobile ? <PaneGrid /> : <DesktopWorkbench />}
        </main>
      </div>
      {!isMobile && preferences.showStatusBar && <StatusBar />}
      {isMobile && (
        <div data-mobile-dock className="mobile-nav-landscape-hide relative z-40 w-full shrink-0">
          <div className={keyboardOpen ? 'hidden' : 'h-[calc(48px+env(safe-area-inset-bottom))]'}>
            <MobileNav docked onOpenDrawer={openDrawer} onOpenSettings={openSettings} onOpenSearch={openPalette} onOpenFiles={openMobileFiles} />
          </div>
          <div className={keyboardOpen ? 'block' : 'hidden'}>
            <ShortcutBar mode="dock" />
          </div>
        </div>
      )}
      {showCommandPalette && <CommandPalette onClose={() => closeOverlay('palette')} />}
      {showSettings && <Settings onClose={dismissSettings} />}
      <UploadConfirmDialog />
      <UploadQueue />
      <AppVersionGuard />
      <ClipboardController />
      <MobileDrawer
        isOpen={drawerOpen}
        onClose={() => closeOverlay('drawer')}
        type={drawerType}
      />
      {mobileFileSheetOpen && <div className="fixed left-0 right-0 top-0 z-50 bg-black/50" style={{ height: 'var(--app-height,100dvh)' }}><div className="absolute bottom-0 left-0 right-0 flex h-[65%] flex-col overflow-hidden rounded-t-xl border-t border-[var(--line)] bg-bg-1"><div className="flex shrink-0 justify-center py-2"><div className="h-1 w-10 rounded-full bg-text-3/30" /></div><div className="min-h-0 flex-1"><FilePanel mode="mobile" onClose={() => closeOverlay('mobile-files')} /></div></div></div>}
      <ToastViewport />
    </div>
  )
}
