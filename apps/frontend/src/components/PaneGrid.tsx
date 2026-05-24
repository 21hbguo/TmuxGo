'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'

export function PaneGrid() {
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const { send, isConnected } = useWebSocket()
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const attachedRef = useRef<string | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const terminalReadyRef = useRef(false)

  const sessionName = activeSessionId?.replace('session-', '') || ''

  // 当 session 变化时重置 attached 状态
  useEffect(() => {
    if (attachedRef.current && attachedRef.current !== sessionName && isConnected) {
      send({ type: 'detach' })
    }
    attachedRef.current = null
    terminalReadyRef.current = false
  }, [sessionName, isConnected, send])
  useEffect(() => {
    if (!isConnected) {
      attachedRef.current = null
    }
  }, [isConnected])

  useEffect(() => {
    const handleReconnect = () => {
      attachedRef.current = null
      terminalReadyRef.current = true
    }
    window.addEventListener('ws-reconnected', handleReconnect)
    return () => window.removeEventListener('ws-reconnected', handleReconnect)
  }, [])

  // attach: 就绪后立即连接
  useEffect(() => {
    if (!sessionName || !isConnected || !terminalReadyRef.current) return
    if (attachedRef.current === sessionName) return
    const size = sizeRef.current
    send({ type: 'attach', sessionName, cols: size?.cols || 120, rows: size?.rows || 36, exclusive: preferences.attachExclusive })
    attachedRef.current = sessionName
  }, [sessionName, isConnected, send, preferences.attachExclusive])

  const handleInput = useCallback((data: string) => {
    send({ type: 'input', data })
  }, [send])
  const handleResize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows }
    if (!isConnected) return
    if (!preferences.attachExclusive) return
    send({ type: 'resize', cols, rows })
  }, [isConnected, send, preferences.attachExclusive])
  const handleReady = useCallback(() => {
    terminalReadyRef.current = true
    if (!sessionName || !isConnected) return
    if (attachedRef.current === sessionName) return
    const size = sizeRef.current
    send({ type: 'attach', sessionName, cols: size?.cols || 120, rows: size?.rows || 36, exclusive: preferences.attachExclusive })
    attachedRef.current = sessionName
  }, [isConnected, preferences.attachExclusive, send, sessionName])

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
    <div className="flex-1 w-full min-h-0">
      <TerminalPane key={activeSessionId} onInput={handleInput} onResize={handleResize} attachExclusive={preferences.attachExclusive} onReady={handleReady} />
    </div>
  )
}
