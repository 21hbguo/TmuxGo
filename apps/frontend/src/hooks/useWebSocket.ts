'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'

const WS_URL = 'ws://localhost:3001/api/stream'

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectCountRef = useRef(0)
  const isConnectingRef = useRef(false)

  const updateConnection = useConsoleStore((s) => s.updateConnection)

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return
    if (wsRef.current?.readyState === WebSocket.OPEN || isConnectingRef.current) {
      return
    }

    isConnectingRef.current = true
    console.log('Connecting to WebSocket:', WS_URL)

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('WebSocket connected')
        isConnectingRef.current = false
        reconnectCountRef.current = 0
        updateConnection({ status: 'connected', latency: 0 })

        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleMessage(data)
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err)
        }
      }

      ws.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason)
        isConnectingRef.current = false
        updateConnection({ status: 'disconnected' })
        scheduleReconnect()
      }

      ws.onerror = (err) => {
        console.error('WebSocket error:', err)
        isConnectingRef.current = false
      }
    } catch (err) {
      console.error('Failed to create WebSocket:', err)
      isConnectingRef.current = false
      scheduleReconnect()
    }
  }, [updateConnection])

  const handleMessage = (data: any) => {
    switch (data.type) {
      case 'pong':
        const latency = Date.now() - (data.timestamp || Date.now())
        updateConnection({ latency, lastPing: new Date().toISOString() })
        break

      case 'output':
        const terminalElement = document.querySelector(`[data-pane-id="${data.paneId}"]`)
        if (terminalElement) {
          const event = new CustomEvent('terminal-output', { detail: data.data, bubbles: false })
          terminalElement.dispatchEvent(event)
        }
        break

      case 'output-history':
        const historyElement = document.querySelector(`[data-pane-id="${data.paneId}"]`)
        if (historyElement && data.data) {
          const event = new CustomEvent('terminal-output', { detail: data.data, bubbles: false })
          historyElement.dispatchEvent(event)
        }
        break

      case 'connected':
        console.log('Stream connected:', data)
        break
    }
  }

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
    }

    reconnectCountRef.current++
    updateConnection({ status: 'reconnecting' })

    const delay = Math.min(3000 * reconnectCountRef.current, 30000)
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectCountRef.current})`)

    reconnectTimerRef.current = setTimeout(() => {
      connect()
    }, delay)
  }, [connect, updateConnection])

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    } else {
      console.warn('WebSocket not connected, cannot send:', data)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    connect()

    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        send({ type: 'ping', timestamp: Date.now() })
      }
    }, 10000)

    return () => {
      clearInterval(pingInterval)
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, []) // Only run once on mount

  return { send }
}
