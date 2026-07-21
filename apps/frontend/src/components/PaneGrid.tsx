'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'

const ATTACH_TIMEOUT = 5000
const ATTACH_RETRY_DELAY = 900
const INPUT_QUEUE_LIMIT = 128
const INPUT_FLUSH_INTERVAL = 10
const INPUT_BATCH_CHARS = 768

export function PaneGrid({ sessionId: controlledSessionId }: { sessionId?: string }) {
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
  const queryClient = useOptionalQueryClient()
  const { syncAfterWindowChange } = useSessionSnapshotSync()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const setActiveSession = useConsoleStore((s) => s.setActiveSession)
  const sessionId = controlledSessionId === undefined ? activeSessionId : controlledSessionId
  const isControlled = controlledSessionId !== undefined
  const { data: windowsData = [] } = useWindows(activeHostId || '', sessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', sessionId || '')
  const exclusive = !isMobile || preferences.attachExclusive
  const attachedRef = useRef<string | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const terminalReadyRef = useRef(false)
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachInFlightRef = useRef<string | null>(null)
  const pendingSwitchRef = useRef(false)
  const lastSessionRef = useRef<string | null>(sessionId || null)
  const inputQueueRef = useRef<string[]>([])
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastExclusiveRef = useRef(exclusive)
  const lastExternalInputRef = useRef<{ data: string; at: number } | null>(null)
  const attachStartedAtRef = useRef(0)
  const lastOutputAtRef = useRef('')
  const lastArchiveCaptureRef = useRef<{ key: string; at: number } | null>(null)
  const continuityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSessionAttachedRef = useRef(false)
  const pendingSessionIdRef = useRef<string | null>(null)
  const pendingSessionNameRef = useRef<string | null>(null)
  const [visibleSessionId, setVisibleSessionId] = useState(sessionId || '')
  const [visibleSessionName, setVisibleSessionName] = useState(() => parseSessionName(activeHostId || 'local', sessionId || ''))

  const sessionName = parseSessionName(activeHostId || 'local', sessionId || '')
  const targetSessionName = pendingSessionNameRef.current || sessionName
  const renderedSessionName = visibleSessionName || targetSessionName

  const sessionWindows = useMemo(() =>
    windowsData.filter((w: any) => w.sessionId === sessionId),
    [windowsData, sessionId]
  )
  const activeWindowIndex = useMemo(() =>
    sessionWindows.findIndex((w: any) => w.active),
    [sessionWindows]
  )
  const switchWindow = useCallback(async (direction: -1 | 1) => {
    if (!activeHostId || !sessionId || sessionWindows.length <= 1) return
    const nextIndex = (activeWindowIndex + direction + sessionWindows.length) % sessionWindows.length
    const targetWindow = sessionWindows[nextIndex]
    if (!targetWindow) return
    const previousWindows = getWindows()
    setWindows(previousWindows.map((w: any) =>
      w.sessionId === sessionId ? { ...w, active: w.id === targetWindow.id } : w
    ))
    try {
      const result = await api.windows.select(activeHostId, sessionId, targetWindow.id)
      if (result.windows) setWindows(result.windows)
      await syncAfterWindowChange()
    } catch {
      setWindows(previousWindows)
      pushToast({ type: 'error', message: t('window.switchFailed') })
    }
  }, [activeHostId, sessionId, sessionWindows, activeWindowIndex, getWindows, setWindows, pushToast, syncAfterWindowChange, t])
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
    if (isControlled || !sessionContinuity.enabled) return
    if (!activeHostId || !sessionId || !sessionName) return
    const activeWindow = sessionWindows.find((item: any) => item.active) || sessionWindows[0] || null
    const now = new Date().toISOString()
    const size = sizeRef.current
    upsertResumePoint({
      hostId: activeHostId,
      sessionId,
      sessionName,
      windowId: activeWindow?.id || null,
      paneId: useConsoleStore.getState().activePaneId || null,
      cols: size?.cols || 120,
      rows: size?.rows || 36,
      exclusive,
      lastSeenAt: now,
      lastOutputAt: lastOutputAtRef.current || now,
    })
    const archive = sessionContinuity.archive
    const key = `${activeHostId}:${sessionId}`
    const previous = lastArchiveCaptureRef.current
    if (archive.enabled && archive.captureMode !== 'none' && (!previous || previous.key !== key || Date.now() - previous.at >= 60000)) {
      lastArchiveCaptureRef.current = { key, at: Date.now() }
      void api.sessionArchives.capture(activeHostId, sessionId, archive).catch(() => {})
    }
  }, [activeHostId, sessionId, isControlled, sessionContinuity.enabled, sessionContinuity.archive, sessionName, sessionWindows, upsertResumePoint, exclusive])
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
    if (!isConnected || !isSessionAttachedRef.current || attachedRef.current !== targetSessionName) return
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
  }, [clearInputFlushTimer, isConnected, send, targetSessionName])
  const scheduleInputFlush = useCallback(() => {
    if (inputFlushTimerRef.current) return
    inputFlushTimerRef.current = setTimeout(() => {
      inputFlushTimerRef.current = null
      flushInputQueue()
    }, INPUT_FLUSH_INTERVAL)
  }, [flushInputQueue])
  const attachNow = useCallback(() => {
    if (!targetSessionName || !isSocketReady || !terminalReadyRef.current) return
    const attachKey = `${activeHostId || 'local'}:${targetSessionName}:${exclusive ? 'exclusive' : 'shared'}`
    if (attachInFlightRef.current === attachKey) return
    const size = sizeRef.current
    clearAttachTimers()
    attachInFlightRef.current = attachKey
    attachStartedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now()
    isSessionAttachedRef.current = false
    updateConnection({ status: 'attaching' })
    const sent = send({ type: 'attach', hostId: activeHostId || 'local', sessionName: targetSessionName, cols: size?.cols || 120, rows: size?.rows || 36, exclusive })
    if (!sent) {
      attachInFlightRef.current = null
      return
    }
    attachTimerRef.current = setTimeout(() => {
      attachInFlightRef.current = null
      attachedRef.current = null
      sentResizeRef.current = null
      updateConnection({ status: 'attaching' })
      attachRetryTimerRef.current = setTimeout(() => {
        attachTimerRef.current = null
        attachRetryTimerRef.current = null
        attachNow()
      }, ATTACH_RETRY_DELAY)
    }, ATTACH_TIMEOUT)
  }, [activeHostId, clearAttachTimers, exclusive, isSocketReady, send, targetSessionName, updateConnection])

  useEffect(() => {
    if (!sessionId) {
      pendingSwitchRef.current = false
      lastSessionRef.current = null
       pendingSessionIdRef.current = null
       pendingSessionNameRef.current = null
       setVisibleSessionId('')
       setVisibleSessionName('')
      return
    }
    if (!lastSessionRef.current) {
      lastSessionRef.current = sessionId
      pendingSessionIdRef.current = null
      pendingSessionNameRef.current = null
      if (!visibleSessionId) {
        setVisibleSessionId(sessionId)
        setVisibleSessionName(sessionName)
      }
      return
    }
    if (lastSessionRef.current !== sessionId) {
      pendingSwitchRef.current = true
      lastSessionRef.current = sessionId
      pendingSessionIdRef.current = sessionId
      pendingSessionNameRef.current = sessionName
    }
  }, [sessionId, sessionName, visibleSessionId])
  useEffect(() => {
    clearAttachTimers()
    clearInputFlushTimer()
    clearContinuityTimer()
    attachedRef.current = null
    attachInFlightRef.current = null
    isSessionAttachedRef.current = false
    sentResizeRef.current = null
    inputQueueRef.current = []
  }, [targetSessionName, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer])
  useEffect(() => {
    if (connectionStatus === 'disconnected') {
      clearAttachTimers()
      clearInputFlushTimer()
      clearContinuityTimer()
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
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
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      if (terminalReadyRef.current) attachNow()
    }
    window.addEventListener('ws-reconnected', handleReconnect)
    return () => window.removeEventListener('ws-reconnected', handleReconnect)
  }, [attachNow, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer])
  useEffect(() => {
    if (lastExclusiveRef.current === exclusive) return
    lastExclusiveRef.current = exclusive
    if (!targetSessionName || !terminalReadyRef.current) return
      clearAttachTimers()
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      attachNow()
  }, [exclusive, targetSessionName, attachNow, clearAttachTimers])
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
      if (detail.sessionName !== targetSessionName) return
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      clearAttachTimers()
      attachInFlightRef.current = null
      attachedRef.current = targetSessionName
      isSessionAttachedRef.current = true
      if (pendingSessionIdRef.current && pendingSessionNameRef.current === detail.sessionName) {
        setVisibleSessionId(pendingSessionIdRef.current)
        setVisibleSessionName(pendingSessionNameRef.current!)
        pendingSessionIdRef.current = null
        pendingSessionNameRef.current = null
      }
      pendingSwitchRef.current = false
      const attachedCols = Number(detail.cols)
      const attachedRows = Number(detail.rows)
      const attachLatency = Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - attachStartedAtRef.current))
      updateConnection({ status: 'connected' })
      updateTerminalPerf({ attachLatency })
      flushInputQueue()
      if (exclusive && sizeRef.current) sendResizeNow(sizeRef.current)
      scheduleContinuityFlush(0)
    }
    window.addEventListener('tmux-attached', handleAttached as EventListener)
    return () => window.removeEventListener('tmux-attached', handleAttached as EventListener)
  }, [activeHostId, exclusive, targetSessionName, clearAttachTimers, updateConnection, updateTerminalPerf, flushInputQueue, sendResizeNow, scheduleContinuityFlush])
  useEffect(() => {
    const handleDetached = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      clearAttachTimers()
      updateConnection({ status: 'attaching' })
      if (terminalReadyRef.current && isSocketReady) attachNow()
    }
    window.addEventListener('tmux-detached', handleDetached as EventListener)
    return () => window.removeEventListener('tmux-detached', handleDetached as EventListener)
  }, [activeHostId, attachNow, clearAttachTimers, isSocketReady, targetSessionName, updateConnection])
  useEffect(() => {
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId?: string; sessionName?: string; message?: string }>).detail || {}
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      clearAttachTimers()
      attachInFlightRef.current = null
      attachedRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      pendingSwitchRef.current = false
      if (pendingSessionNameRef.current === detail.sessionName) {
        pendingSessionIdRef.current = null
        pendingSessionNameRef.current = null
      }
      if (!isControlled && visibleSessionId && visibleSessionId !== activeSessionId) setActiveSession(visibleSessionId)
      updateConnection({ status: 'disconnected' })
      pushToast({ type: 'error', message: detail.message || t('session.requestFailed') })
      void queryClient?.invalidateQueries({ queryKey: ['sessions', activeHostId || 'local'] })
    }
    window.addEventListener('tmux-error', handleError as EventListener)
    return () => window.removeEventListener('tmux-error', handleError as EventListener)
  }, [activeHostId, activeSessionId, isControlled, clearAttachTimers, pushToast, queryClient, setActiveSession, t, targetSessionName, updateConnection, visibleSessionId])
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
    const canWriteDirectly = isConnected && isSessionAttachedRef.current && attachedRef.current === targetSessionName
    if (canWriteDirectly) {
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
    if (isSocketReady && terminalReadyRef.current) attachNow()
  }, [attachNow, isConnected, isSocketReady, send, targetSessionName, scheduleInputFlush, scheduleContinuityFlush])
  useEffect(() => {
    if (attachedRef.current === targetSessionName) return
    attachNow()
  }, [targetSessionName, attachNow, isSocketReady])
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
    if (attachedRef.current !== targetSessionName) return
    sendResizeNow(nextSize)
    scheduleContinuityFlush(100)
  }, [isConnected, targetSessionName, sendResizeNow, scheduleContinuityFlush])
  const handleReady = useCallback(() => {
    terminalReadyRef.current = true
    if (attachedRef.current === targetSessionName) return
    attachNow()
    scheduleContinuityFlush(50)
  }, [targetSessionName, attachNow, scheduleContinuityFlush])
  useEffect(() => {
    if (isControlled || !sessionContinuity.enabled) return
    const timer = setInterval(() => {
      if (attachedRef.current !== targetSessionName) return
      flushResumePoint()
    }, 8000)
    return () => clearInterval(timer)
  }, [flushResumePoint, isControlled, sessionContinuity.enabled, targetSessionName])
  useEffect(() => {
    const handleOutput = (message: { data: string; sessionName?: string | null; hostId?: string | null; resync?: boolean }) => {
      if ((message.hostId || activeHostId || 'local') !== (activeHostId || 'local')) return
      if (message.sessionName && message.sessionName !== targetSessionName) return
      if (!message.data) return
      lastOutputAtRef.current = new Date().toISOString()
      scheduleContinuityFlush(150)
    }
    const unsubscribe = subscribeOutput(handleOutput)
    return () => {
      unsubscribe()
    }
  }, [activeHostId, scheduleContinuityFlush, targetSessionName, subscribeOutput])

  if (!sessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-3 gap-4">
        <div className="text-6xl">⊞</div>
        <div className="text-lg">{t('grid.noWindows')}</div>
        <div className="text-sm">{t('grid.selectSession')}</div>
      </div>
    )
  }

  return (
    <div className="tmuxgo-content-surface relative h-full w-full min-h-0 min-w-0 overflow-hidden">
      {pendingSwitchRef.current && (
        <div className="absolute inset-0 z-10 pointer-events-none bg-gradient-to-b from-bg-1/5 via-bg-1/15 to-bg-1/30" />
      )}
      {isMobile && connectionStatus !== 'connected' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-bg-2/95 border border-[var(--line)] text-xs text-text-1">
          {t(`status.${connectionStatus}`)}
        </div>
      )}
      <TerminalPane sessionName={renderedSessionName} onInput={handleInput} onResize={handleResize} attachExclusive={exclusive} onReady={handleReady} subscribeOutput={subscribeOutput} onSwipeLeft={!isControlled && sessionWindows.length > 1 ? handleSwipeLeft : undefined} onSwipeRight={!isControlled && sessionWindows.length > 1 ? handleSwipeRight : undefined} />
    </div>
  )
}
