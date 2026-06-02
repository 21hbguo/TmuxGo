'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'
import { useWindows } from '@/hooks/useApi'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { api } from '@/lib/api'
import { parseSessionName } from '@/lib/session-id'
import { useSessionContinuity } from '@/hooks/useSessionContinuity'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'

const ATTACH_TIMEOUT = 5000
const ATTACH_RETRY_DELAY = 900
const INPUT_QUEUE_LIMIT = 128
const INPUT_FLUSH_INTERVAL = 10
const INPUT_BATCH_CHARS = 768

export function PaneGrid() {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const connectionStatus = useConsoleStore((s) => s.connection.status)
  const updateConnection = useConsoleStore((s) => s.updateConnection)
  const updateTerminalPerf = useConsoleStore((s) => s.updateTerminalPerf)
  const { send, isConnected, isSocketReady, subscribeOutput } = useWebSocket()
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const { sessionContinuity, upsertResumePoint } = useSessionContinuity()
  const isMobile = isMobileDevice()
  const { data: windowsData = [] } = useWindows(activeHostId || '', activeSessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', activeSessionId || '')
  const { syncAfterWindowChange } = useSessionSnapshotSync()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const exclusive = !isMobile || preferences.attachExclusive
  const attachedRef = useRef<string | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const terminalReadyRef = useRef(false)
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSwitchRef = useRef(false)
  const lastSessionRef = useRef<string | null>(activeSessionId || null)
  const inputQueueRef = useRef<string[]>([])
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastExclusiveRef = useRef(exclusive)
  const lastExternalInputRef = useRef<{ data: string; at: number } | null>(null)
  const attachStartedAtRef = useRef(0)
  const lastOutputAtRef = useRef('')
  const continuityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sessionName = parseSessionName(activeHostId || 'local', activeSessionId || '')

  const sessionWindows = useMemo(() =>
    windowsData.filter((w: any) => w.sessionId === activeSessionId),
    [windowsData, activeSessionId]
  )
  const activeWindowIndex = useMemo(() =>
    sessionWindows.findIndex((w: any) => w.active),
    [sessionWindows]
  )
  const switchWindow = useCallback(async (direction: -1 | 1) => {
    if (!activeHostId || !activeSessionId || sessionWindows.length <= 1) return
    const nextIndex = (activeWindowIndex + direction + sessionWindows.length) % sessionWindows.length
    const targetWindow = sessionWindows[nextIndex]
    if (!targetWindow) return
    const previousWindows = getWindows()
    setWindows(previousWindows.map((w: any) =>
      w.sessionId === activeSessionId ? { ...w, active: w.id === targetWindow.id } : w
    ))
    try {
      const result = await api.windows.select(activeHostId, activeSessionId, targetWindow.id)
      if (result.windows) setWindows(result.windows)
      await syncAfterWindowChange()
    } catch {
      setWindows(previousWindows)
      pushToast({ type: 'error', message: t('window.switchFailed') })
    }
  }, [activeHostId, activeSessionId, sessionWindows, activeWindowIndex, getWindows, setWindows, pushToast, syncAfterWindowChange, t])
  const handleSwipeLeft = useCallback(() => { void switchWindow(1) }, [switchWindow])
  const handleSwipeRight = useCallback(() => { void switchWindow(-1) }, [switchWindow])

  const sendResizeNow = useCallback((size: { cols: number; rows: number }) => {
    if (!size.cols || !size.rows) return
    const prev = sentResizeRef.current
    if (prev && prev.cols === size.cols && prev.rows === size.rows) return
    sentResizeRef.current = size
    send({ type: 'resize', hostId: activeHostId || 'local', cols: size.cols, rows: size.rows })
  }, [activeHostId, send])
  const clearAttachTimers = useCallback(() => {
    if (attachTimerRef.current) {
      clearTimeout(attachTimerRef.current)
      attachTimerRef.current = null
    }
    if (attachRetryTimerRef.current) {
      clearTimeout(attachRetryTimerRef.current)
      attachRetryTimerRef.current = null
    }
  }, [])
  const clearInputFlushTimer = useCallback(() => {
    if (!inputFlushTimerRef.current) return
    clearTimeout(inputFlushTimerRef.current)
    inputFlushTimerRef.current = null
  }, [])
  const clearContinuityTimer = useCallback(() => {
    if (!continuityTimerRef.current) return
    clearTimeout(continuityTimerRef.current)
    continuityTimerRef.current = null
  }, [])
  const flushResumePoint = useCallback(() => {
    if (!sessionContinuity.enabled) return
    if (!activeHostId || !activeSessionId || !sessionName) return
    const activeWindow = sessionWindows.find((item: any) => item.active) || sessionWindows[0] || null
    const now = new Date().toISOString()
    const size = sizeRef.current
    upsertResumePoint({
      hostId: activeHostId,
      sessionId: activeSessionId,
      sessionName,
      windowId: activeWindow?.id || null,
      paneId: useConsoleStore.getState().activePaneId || null,
      cols: size?.cols || 120,
      rows: size?.rows || 36,
      exclusive,
      lastSeenAt: now,
      lastOutputAt: lastOutputAtRef.current || now,
    })
  }, [activeHostId, activeSessionId, sessionContinuity.enabled, sessionName, sessionWindows, upsertResumePoint, exclusive])
  const scheduleContinuityFlush = useCallback((delay = 0) => {
    if (!sessionContinuity.enabled) return
    if (continuityTimerRef.current) return
    continuityTimerRef.current = setTimeout(() => {
      continuityTimerRef.current = null
      flushResumePoint()
    }, Math.max(0, delay))
  }, [flushResumePoint, sessionContinuity.enabled])
  const flushInputQueue = useCallback(() => {
    clearInputFlushTimer()
    if (inputQueueRef.current.length === 0) return
    const queued = inputQueueRef.current.splice(0)
    let batch = ''
    for (const chunk of queued) {
      if (!chunk) continue
      if (batch.length + chunk.length > INPUT_BATCH_CHARS && batch) {
        send({ type: 'input', data: batch })
        batch = ''
      }
      batch += chunk
      if (batch.length >= INPUT_BATCH_CHARS) {
        send({ type: 'input', data: batch })
        batch = ''
      }
    }
    if (batch) send({ type: 'input', data: batch })
  }, [clearInputFlushTimer, send])
  const scheduleInputFlush = useCallback(() => {
    if (inputFlushTimerRef.current) return
    inputFlushTimerRef.current = setTimeout(() => {
      inputFlushTimerRef.current = null
      if (!isConnected) return
      flushInputQueue()
    }, INPUT_FLUSH_INTERVAL)
  }, [flushInputQueue, isConnected])
  const attachNow = useCallback(() => {
    if (!sessionName || !isSocketReady || !terminalReadyRef.current) return
    const size = sizeRef.current
    clearAttachTimers()
    attachStartedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now()
    updateConnection({ status: 'attaching' })
    const sent = send({ type: 'attach', hostId: activeHostId || 'local', sessionName, cols: size?.cols || 120, rows: size?.rows || 36, exclusive })
    if (!sent) return
    sentResizeRef.current = size || null
    attachTimerRef.current = setTimeout(() => {
      attachedRef.current = null
      sentResizeRef.current = null
      updateConnection({ status: 'attaching' })
      attachRetryTimerRef.current = setTimeout(() => {
        attachTimerRef.current = null
        attachRetryTimerRef.current = null
        attachNow()
      }, ATTACH_RETRY_DELAY)
    }, ATTACH_TIMEOUT)
  }, [activeHostId, clearAttachTimers, exclusive, isSocketReady, send, sessionName, updateConnection])

  useEffect(() => {
    if (!activeSessionId) {
      pendingSwitchRef.current = false
      lastSessionRef.current = null
      return
    }
    if (!lastSessionRef.current) {
      lastSessionRef.current = activeSessionId
      return
    }
    if (lastSessionRef.current !== activeSessionId) {
      pendingSwitchRef.current = true
      lastSessionRef.current = activeSessionId
    }
  }, [activeSessionId])
  useEffect(() => {
    clearAttachTimers()
    clearInputFlushTimer()
    clearContinuityTimer()
    attachedRef.current = null
    sentResizeRef.current = null
    terminalReadyRef.current = false
    inputQueueRef.current = []
  }, [sessionName, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer])
  useEffect(() => {
    if (connectionStatus === 'disconnected') {
      clearAttachTimers()
      clearInputFlushTimer()
      clearContinuityTimer()
      attachedRef.current = null
      sentResizeRef.current = null
      flushResumePoint()
    }
  }, [connectionStatus, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer, flushResumePoint])

  useEffect(() => {
    const handleReconnect = () => {
      clearAttachTimers()
      clearInputFlushTimer()
      clearContinuityTimer()
      attachedRef.current = null
      sentResizeRef.current = null
      if (terminalReadyRef.current) attachNow()
    }
    window.addEventListener('ws-reconnected', handleReconnect)
    return () => window.removeEventListener('ws-reconnected', handleReconnect)
  }, [attachNow, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer])
  useEffect(() => {
    if (lastExclusiveRef.current === exclusive) return
    lastExclusiveRef.current = exclusive
    if (!sessionName || !terminalReadyRef.current) return
    clearAttachTimers()
    attachedRef.current = null
    sentResizeRef.current = null
    attachNow()
  }, [exclusive, sessionName, attachNow, clearAttachTimers])
  useEffect(() => {
    if (!isSocketReady) return
    const profile = isMobile ? 'mobile' : document.visibilityState === 'visible' ? 'foreground' : 'background'
    send({ type: 'stream_profile', hostId: activeHostId || 'local', profile })
    const handleVisibilityChange = () => {
      const nextProfile = isMobile ? 'mobile' : document.visibilityState === 'visible' ? 'foreground' : 'background'
      send({ type: 'stream_profile', hostId: activeHostId || 'local', profile: nextProfile })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [activeHostId, isMobile, isSocketReady, send])
  useEffect(() => {
    const handleAttached = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.sessionName !== sessionName) return
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      clearAttachTimers()
      attachedRef.current = sessionName
      pendingSwitchRef.current = false
      const attachedCols = Number(detail.cols)
      const attachedRows = Number(detail.rows)
      if (attachedCols > 0 && attachedRows > 0) sentResizeRef.current = { cols: attachedCols, rows: attachedRows }
      const attachLatency = Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - attachStartedAtRef.current))
      updateConnection({ status: 'connected' })
      updateTerminalPerf({ attachLatency })
      flushInputQueue()
      if (exclusive && sizeRef.current) sendResizeNow(sizeRef.current)
      scheduleContinuityFlush(0)
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'attached', sessionName } }))
    }
    window.addEventListener('tmux-attached', handleAttached as EventListener)
    return () => window.removeEventListener('tmux-attached', handleAttached as EventListener)
  }, [activeHostId, exclusive, sessionName, clearAttachTimers, updateConnection, updateTerminalPerf, flushInputQueue, sendResizeNow, scheduleContinuityFlush])
  useEffect(() => {
    if (isConnected) flushInputQueue()
  }, [isConnected, flushInputQueue])

  useEffect(() => () => {
    clearAttachTimers()
    clearInputFlushTimer()
    clearContinuityTimer()
    flushResumePoint()
  }, [clearAttachTimers, clearInputFlushTimer, clearContinuityTimer, flushResumePoint])

  const handleInput = useCallback((data: string) => {
    scheduleContinuityFlush(100)
    if (isConnected) {
      if (data.length <= 12 && inputQueueRef.current.length === 0) {
        send({ type: 'input', data })
        return
      }
      inputQueueRef.current.push(data)
      scheduleInputFlush()
      return
    }
    inputQueueRef.current.push(data)
    if (isSocketReady) {
      scheduleInputFlush()
    }
    if (inputQueueRef.current.length > INPUT_QUEUE_LIMIT) {
      inputQueueRef.current.splice(0, inputQueueRef.current.length - INPUT_QUEUE_LIMIT)
    }
    if (isSocketReady) attachNow()
  }, [attachNow, isConnected, isSocketReady, send, scheduleInputFlush, scheduleContinuityFlush])
  useEffect(() => {
    if (attachedRef.current === sessionName) return
    attachNow()
  }, [sessionName, attachNow, isSocketReady])
  useEffect(() => {
    const handleTerminalInput = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: string }>).detail
      if (!detail?.data) return
      const now = Date.now()
      const last = lastExternalInputRef.current
      if (last && last.data === detail.data && now - last.at < 120) return
      lastExternalInputRef.current = { data: detail.data, at: now }
      handleInput(detail.data)
    }
    window.addEventListener('tmuxgo-terminal-input', handleTerminalInput as EventListener)
    return () => window.removeEventListener('tmuxgo-terminal-input', handleTerminalInput as EventListener)
  }, [handleInput])
  const handleResize = useCallback((cols: number, rows: number) => {
    const nextSize = { cols, rows }
    sizeRef.current = nextSize
    if (!isConnected) return
    if (attachedRef.current !== sessionName) return
    sendResizeNow(nextSize)
    scheduleContinuityFlush(100)
  }, [isConnected, sessionName, sendResizeNow, scheduleContinuityFlush])
  const handleReady = useCallback(() => {
    terminalReadyRef.current = true
    if (attachedRef.current === sessionName) return
    attachNow()
    scheduleContinuityFlush(50)
  }, [sessionName, attachNow, scheduleContinuityFlush])
  useEffect(() => {
    if (!sessionContinuity.enabled) return
    const timer = setInterval(() => {
      if (attachedRef.current !== sessionName) return
      flushResumePoint()
    }, 8000)
    return () => clearInterval(timer)
  }, [flushResumePoint, sessionContinuity.enabled, sessionName])
  useEffect(() => {
    const handleOutput = (message: { data: string; sessionName?: string | null; hostId?: string | null }) => {
      if ((message.hostId || activeHostId || 'local') !== (activeHostId || 'local')) return
      if (message.sessionName && message.sessionName !== sessionName) return
      if (!message.data) return
      lastOutputAtRef.current = new Date().toISOString()
      scheduleContinuityFlush(150)
    }
    const unsubscribe = subscribeOutput(handleOutput)
    return () => {
      unsubscribe()
    }
  }, [activeHostId, scheduleContinuityFlush, sessionName, subscribeOutput])

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-3 gap-4">
        <div className="text-6xl">⊞</div>
        <div className="text-lg">{t('grid.noWindows')}</div>
        <div className="text-sm">{t('grid.selectSession')}</div>
      </div>
    )
  }

  return (
    <div className="h-full w-full min-h-0 min-w-0 bg-bg-1 relative overflow-hidden">
      {pendingSwitchRef.current && (
        <div className="absolute inset-0 z-10 pointer-events-none bg-gradient-to-b from-bg-1/5 via-bg-1/15 to-bg-1/30" />
      )}
      {isMobile && connectionStatus !== 'connected' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-bg-2/95 border border-[var(--line)] text-xs text-text-1">
          {t(`status.${connectionStatus}`)}
        </div>
      )}
      <TerminalPane key={sessionName || 'empty-session'} sessionName={sessionName} onInput={handleInput} onResize={handleResize} attachExclusive={exclusive} onReady={handleReady} subscribeOutput={subscribeOutput} onSwipeLeft={sessionWindows.length > 1 ? handleSwipeLeft : undefined} onSwipeRight={sessionWindows.length > 1 ? handleSwipeRight : undefined} />
    </div>
  )
}
