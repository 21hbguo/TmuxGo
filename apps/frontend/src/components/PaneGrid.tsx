'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'

const MOBILE_RESIZE_DEBOUNCE = 48
const DESKTOP_RESIZE_DEBOUNCE = 80
const ATTACH_TIMEOUT = 5000
const ATTACH_RETRY_DELAY = 900
const INPUT_QUEUE_LIMIT = 128
const INPUT_FLUSH_INTERVAL = 10
const INPUT_BATCH_CHARS = 768

export function PaneGrid() {
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const connectionStatus = useConsoleStore((s) => s.connection.status)
  const updateConnection = useConsoleStore((s) => s.updateConnection)
  const { send, isConnected, isSocketReady } = useWebSocket()
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const isMobile = isMobileDevice()
  const exclusive = isMobile || preferences.attachExclusive
  const attachedRef = useRef<string | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const terminalReadyRef = useRef(false)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSwitchRef = useRef(false)
  const lastSessionRef = useRef<string | null>(activeSessionId || null)
  const inputQueueRef = useRef<string[]>([])
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sentResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastExclusiveRef = useRef(exclusive)

  const sessionName = activeSessionId?.replace('session-', '') || ''

  const clearPendingResize = useCallback(() => {
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }
    pendingResizeRef.current = null
  }, [])
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
    updateConnection({ status: 'attaching' })
    const sent = send({ type: 'attach', sessionName, cols: size?.cols || 120, rows: size?.rows || 36, exclusive })
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
  }, [clearAttachTimers, exclusive, isSocketReady, send, sessionName, updateConnection])

  const flushResize = useCallback(() => {
    resizeTimerRef.current = null
    const size = pendingResizeRef.current
    if (!size || !isConnected) return
    if (attachedRef.current !== sessionName) return
    const prev = sentResizeRef.current
    if (prev && prev.cols === size.cols && prev.rows === size.rows) return
    pendingResizeRef.current = null
    sentResizeRef.current = size
    send({ type: 'resize', cols: size.cols, rows: size.rows })
  }, [isConnected, send, sessionName])

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
    clearPendingResize()
    clearAttachTimers()
    clearInputFlushTimer()
    attachedRef.current = null
    sentResizeRef.current = null
    if (!sessionName) terminalReadyRef.current = false
    inputQueueRef.current = []
  }, [sessionName, clearPendingResize, clearAttachTimers, clearInputFlushTimer])
  useEffect(() => {
    if (connectionStatus === 'disconnected') {
      clearPendingResize()
      clearAttachTimers()
      clearInputFlushTimer()
      attachedRef.current = null
      sentResizeRef.current = null
    }
  }, [connectionStatus, clearPendingResize, clearAttachTimers, clearInputFlushTimer])

  useEffect(() => {
    const handleReconnect = () => {
      clearPendingResize()
      clearAttachTimers()
      clearInputFlushTimer()
      attachedRef.current = null
      sentResizeRef.current = null
      terminalReadyRef.current = true
      attachNow()
    }
    window.addEventListener('ws-reconnected', handleReconnect)
    return () => window.removeEventListener('ws-reconnected', handleReconnect)
  }, [attachNow, clearPendingResize, clearAttachTimers, clearInputFlushTimer])
  useEffect(() => {
    if (lastExclusiveRef.current === exclusive) return
    lastExclusiveRef.current = exclusive
    if (!sessionName || !terminalReadyRef.current) return
    clearPendingResize()
    clearAttachTimers()
    attachedRef.current = null
    sentResizeRef.current = null
    attachNow()
  }, [exclusive, sessionName, attachNow, clearPendingResize, clearAttachTimers])
  useEffect(() => {
    const handleAttached = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.sessionName !== sessionName) return
      clearAttachTimers()
      attachedRef.current = sessionName
      pendingSwitchRef.current = false
      updateConnection({ status: 'connected' })
      flushInputQueue()
      window.dispatchEvent(new CustomEvent('tmuxgo-layout-change', { detail: { reason: 'attached', sessionName } }))
    }
    window.addEventListener('tmux-attached', handleAttached as EventListener)
    return () => window.removeEventListener('tmux-attached', handleAttached as EventListener)
  }, [sessionName, clearAttachTimers, updateConnection, flushInputQueue])
  useEffect(() => {
    if (isConnected) flushInputQueue()
  }, [isConnected, flushInputQueue])

  useEffect(() => () => {
    clearPendingResize()
    clearAttachTimers()
    clearInputFlushTimer()
  }, [clearPendingResize, clearAttachTimers, clearInputFlushTimer])

  const handleInput = useCallback((data: string) => {
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
  }, [attachNow, isConnected, isSocketReady, send, scheduleInputFlush])
  useEffect(() => {
    if (attachedRef.current === sessionName) return
    attachNow()
  }, [sessionName, attachNow, isSocketReady])
  useEffect(() => {
    const handleTerminalInput = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: string }>).detail
      if (!detail?.data) return
      handleInput(detail.data)
    }
    window.addEventListener('tmuxgo-terminal-input', handleTerminalInput as EventListener)
    return () => window.removeEventListener('tmuxgo-terminal-input', handleTerminalInput as EventListener)
  }, [handleInput])
  const handleResize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows }
    if (!isConnected) return
    if (!exclusive) return
    if (attachedRef.current !== sessionName) return
    const nextSize = { cols, rows }
    pendingResizeRef.current = nextSize
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = setTimeout(flushResize, isMobile ? MOBILE_RESIZE_DEBOUNCE : DESKTOP_RESIZE_DEBOUNCE)
  }, [isConnected, isMobile, send, exclusive, sessionName, flushResize])
  const handleReady = useCallback(() => {
    terminalReadyRef.current = true
    if (attachedRef.current === sessionName) return
    attachNow()
  }, [sessionName, attachNow])

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
    <div className="flex-1 w-full min-h-0 bg-bg-1 relative">
      {pendingSwitchRef.current && (
        <div className="absolute inset-0 z-10 pointer-events-none bg-gradient-to-b from-bg-1/5 via-bg-1/15 to-bg-1/30" />
      )}
      {isMobile && connectionStatus !== 'connected' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-bg-2/95 border border-[var(--line)] text-xs text-text-1">
          {t(`status.${connectionStatus}`)}
        </div>
      )}
      <TerminalPane sessionName={sessionName} onInput={handleInput} onResize={handleResize} attachExclusive={exclusive} onReady={handleReady} />
    </div>
  )
}
