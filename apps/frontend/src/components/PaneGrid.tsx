'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'

const MOBILE_RESIZE_DEBOUNCE = 48

export function PaneGrid() {
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const connectionStatus = useConsoleStore((s) => s.connection.status)
  const { send, isConnected } = useWebSocket()
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const isMobile = isMobileDevice()
  const exclusive = isMobile || preferences.attachExclusive
  const attachedRef = useRef<string | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const terminalReadyRef = useRef(false)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sentResizeRef = useRef<{ cols: number; rows: number } | null>(null)

  const sessionName = activeSessionId?.replace('session-', '') || ''

  const clearPendingResize = useCallback(() => {
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }
    pendingResizeRef.current = null
  }, [])
  const attachNow = useCallback(() => {
    if (!sessionName || !isConnected || !terminalReadyRef.current) return
    const size = sizeRef.current
    send({ type: 'attach', sessionName, cols: size?.cols || 120, rows: size?.rows || 36, exclusive })
    attachedRef.current = sessionName
    sentResizeRef.current = size || null
  }, [exclusive, isConnected, send, sessionName])

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
    if (attachedRef.current && attachedRef.current !== sessionName && isConnected) {
      send({ type: 'detach' })
    }
    clearPendingResize()
    attachedRef.current = null
    sentResizeRef.current = null
    terminalReadyRef.current = false
  }, [sessionName, isConnected, send, clearPendingResize])
  useEffect(() => {
    if (!isConnected) {
      clearPendingResize()
      attachedRef.current = null
      sentResizeRef.current = null
    }
  }, [isConnected, clearPendingResize])

  useEffect(() => {
    const handleReconnect = () => {
      clearPendingResize()
      attachedRef.current = null
      sentResizeRef.current = null
      terminalReadyRef.current = true
      attachNow()
    }
    window.addEventListener('ws-reconnected', handleReconnect)
    return () => window.removeEventListener('ws-reconnected', handleReconnect)
  }, [attachNow, clearPendingResize])

  useEffect(() => () => clearPendingResize(), [clearPendingResize])

  useEffect(() => {
    if (attachedRef.current === sessionName) return
    attachNow()
  }, [sessionName, attachNow])

  const handleInput = useCallback((data: string) => {
    send({ type: 'input', data })
  }, [send])
  const handleResize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows }
    if (!isConnected) return
    if (!exclusive) return
    if (attachedRef.current !== sessionName) return
    const nextSize = { cols, rows }
    if (!isMobile) {
      const prev = sentResizeRef.current
      if (prev && prev.cols === cols && prev.rows === rows) return
      sentResizeRef.current = nextSize
      send({ type: 'resize', cols, rows })
      return
    }
    pendingResizeRef.current = nextSize
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = setTimeout(flushResize, MOBILE_RESIZE_DEBOUNCE)
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
      {isMobile && connectionStatus !== 'connected' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-bg-2/95 border border-[var(--line)] text-xs text-text-1">
          {t(`status.${connectionStatus}`)}
        </div>
      )}
      <TerminalPane key={activeSessionId} sessionName={sessionName} onInput={handleInput} onResize={handleResize} attachExclusive={exclusive} onReady={handleReady} />
    </div>
  )
}
