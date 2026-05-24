'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from './usePreferences'

type WSState={ws:WebSocket|null,reconnectTimer:NodeJS.Timeout|null,reconnectCount:number,isConnecting:boolean,pingTimer:NodeJS.Timeout|null,subscribers:number,onMessage:((data:any)=>void)|null,onOpen:(()=>void)|null,onClose:(()=>void)|null,onError:(()=>void)|null}
const wsState:WSState={ws:null,reconnectTimer:null,reconnectCount:0,isConnecting:false,pingTimer:null,subscribers:0,onMessage:null,onOpen:null,onClose:null,onError:null}

export function useWebSocket() {
  const reconnectCountRef = useRef(0)
  const updateConnection = useConsoleStore((s) => s.updateConnection)
  const isConnected = useConsoleStore((s) => s.connection.status === 'connected')
  const { preferences } = usePreferences()

  const handleMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'pong':
        const latency = Date.now() - (data.timestamp || Date.now())
        updateConnection({ status: 'connected', latency, lastPing: new Date().toISOString() })
        break
      case 'output':
        const terminalElement = document.querySelector('[data-terminal]')
        if (terminalElement) {
          const event = new CustomEvent('terminal-output', { detail: data.data, bubbles: false })
          terminalElement.dispatchEvent(event)
        }
        break
      case 'connected':
        updateConnection({ status: 'connected' })
        break
      case 'attached':
        window.dispatchEvent(new CustomEvent('tmux-attached', { detail: data }))
        break
    }
  }, [updateConnection])

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return
    if (wsState.ws?.readyState === WebSocket.OPEN || wsState.isConnecting) return
    const envBase = process.env.NEXT_PUBLIC_API_URL
    let wsUrl = ''
    if (envBase) {
      const base = new URL(envBase)
      const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
      wsUrl = `${wsProtocol}//${base.host}/api/stream`
    } else {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsHost = window.location.hostname
      const wsPort = window.location.port === '3000' ? '3001' : window.location.port || '3001'
      wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/api/stream`
    }
    wsState.isConnecting = true
    try {
      const ws = new WebSocket(wsUrl)
      wsState.ws = ws
      ws.onopen = () => {
        wsState.isConnecting = false
        wsState.reconnectCount = 0
        reconnectCountRef.current = 0
        updateConnection({ status: 'connected', latency: 0 })
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
        window.dispatchEvent(new CustomEvent('ws-reconnected'))
        wsState.onOpen?.()
      }
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          wsState.onMessage?.(data)
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err)
        }
      }
      ws.onclose = () => {
        wsState.isConnecting = false
        updateConnection({ status: 'disconnected' })
        scheduleReconnect()
        wsState.onClose?.()
      }
      ws.onerror = () => {
        wsState.isConnecting = false
        scheduleReconnect()
        wsState.onError?.()
      }
    } catch (err) {
      wsState.isConnecting = false
      wsState.onError?.()
    }
  }, [updateConnection])

  const scheduleReconnect = useCallback(() => {
    if (!preferences.autoReconnect) return
    if (wsState.reconnectTimer) clearTimeout(wsState.reconnectTimer)
    wsState.reconnectCount += 1
    reconnectCountRef.current = wsState.reconnectCount
    updateConnection({ status: 'reconnecting' })
    const delay = Math.min(preferences.reconnectInterval * wsState.reconnectCount, 30000)
    wsState.reconnectTimer = setTimeout(() => {
      connect()
    }, delay)
  }, [connect, updateConnection, preferences.autoReconnect, preferences.reconnectInterval])

  const send = useCallback((data: any) => {
    if (wsState.ws?.readyState === WebSocket.OPEN) {
      wsState.ws.send(JSON.stringify(data))
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    wsState.subscribers += 1
    wsState.onMessage = handleMessage
    wsState.onOpen = () => {}
    wsState.onClose = () => {
      scheduleReconnect()
    }
    wsState.onError = () => {
      scheduleReconnect()
    }
    connect()
    if (!wsState.pingTimer) {
      wsState.pingTimer = setInterval(() => {
        if (wsState.ws?.readyState === WebSocket.OPEN) {
          wsState.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
        }
      }, 10000)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const ws = wsState.ws
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          wsState.reconnectCount = 0
          connect()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      wsState.subscribers -= 1
      if (wsState.subscribers <= 0) {
        if (wsState.reconnectTimer) {
          clearTimeout(wsState.reconnectTimer)
          wsState.reconnectTimer = null
        }
        if (wsState.pingTimer) {
          clearInterval(wsState.pingTimer)
          wsState.pingTimer = null
        }
        if (wsState.ws) {
          wsState.ws.close()
          wsState.ws = null
        }
        wsState.reconnectCount = 0
        wsState.isConnecting = false
        wsState.onMessage = null
        wsState.onOpen = null
        wsState.onClose = null
        wsState.onError = null
      }
    }
  }, [connect, handleMessage, scheduleReconnect])

  return { send, isConnected }
}
