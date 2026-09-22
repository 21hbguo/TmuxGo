'use client'
import { useEffect, useRef, useCallback } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { usePreferences } from './usePreferences'
import { isMobileDevice } from './useMobileKeyboard'
import { getWebSocketBase } from '@/lib/runtime-endpoints'
import { getWebSocketUrl, isAuthEnabled } from '@/lib/auth'
import { recordMobileDiagnostic } from '@/lib/mobile-diagnostics'
import { decodeStreamOutputBinary, type StreamRouteMap } from '@/lib/stream-binary'
import {
  decodeCellDiff,
  decodeCellDiffV2,
  decodeCellSnapshot,
  decodeCellSnapshotV2,
} from '@/lib/terminal-grid/decode-cell'
import { applyCellToXterm, diffToAnsi, snapshotToAnsi } from '@/lib/terminal-grid/apply-cell'
import { emitStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import {
  netStatsFlushPending,
  netStatsPingSent,
  netStatsPong,
  netStatsReset,
  netStatsRx,
  netStatsTx,
} from '@/lib/net-stats'
import { encodePasteBinary, shouldUsePasteBinary } from '@/lib/paste-safety'
type WSState = {
  ws: WebSocket | null
  routes: Map<number, { hostId: string; sessionName: string }>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectCount: number
  isConnecting: boolean
  socketReady: boolean
  attached: boolean
  pingTimer: ReturnType<typeof setInterval> | null
  pongTimer: ReturnType<typeof setTimeout> | null
  connectTimer: ReturnType<typeof setTimeout> | null
  connectAttempt: number
  connectStartedAt: number
  closeTimer: ReturnType<typeof setTimeout> | null
  subscribers: number
  lastPongAt: number
  onMessage: ((data: any) => void) | null
  onOpen: (() => void) | null
  onClose: (() => void) | null
  onError: (() => void) | null
  closeExpected: boolean
  lastInteractionRecoverAt: number
  listenersReady: boolean
  cleanupListeners: (() => void) | null
}
const wsState: WSState = {
  ws: null,
  routes: new Map(),
  reconnectTimer: null,
  reconnectCount: 0,
  isConnecting: false,
  socketReady: false,
  attached: false,
  pingTimer: null,
  pongTimer: null,
  connectTimer: null,
  connectAttempt: 0,
  connectStartedAt: 0,
  closeTimer: null,
  subscribers: 0,
  lastPongAt: 0,
  onMessage: null,
  onOpen: null,
  onClose: null,
  onError: null,
  closeExpected: false,
  lastInteractionRecoverAt: 0,
  listenersReady: false,
  cleanupListeners: null,
}
type OutputMessage = {
  data: string
  sessionName?: string | null
  hostId?: string | null
  resync?: boolean
  cell?:
    | { kind: 'snapshot'; snapshot: import('@/lib/terminal-grid/decode-cell').CellSnapshot }
    | { kind: 'diff'; diff: import('@/lib/terminal-grid/decode-cell').CellDiff }
}
const outputListeners = new Map<string, Set<(message: OutputMessage) => void>>()
let cellLastSeq = 0
let mobileInteractiveProfileTimer: ReturnType<typeof setTimeout> | null = null
let mobileInteractiveProfileActive = false
const CONNECT_TIMEOUT_MS = 10000
const STALE_CONNECT_RESET_MS = 8000
const MOBILE_INTERACTIVE_PROFILE_MS = 160
function resetMobileInteractiveProfile() {
  if (mobileInteractiveProfileTimer) clearTimeout(mobileInteractiveProfileTimer)
  mobileInteractiveProfileTimer = null
  mobileInteractiveProfileActive = false
}
function getOutputListenerKey(hostId: string, sessionName: string) {
  return `${hostId}\u0000${sessionName}`
}
function trackedSend(ws: WebSocket, payload: string) {
  netStatsTx()
  ws.send(payload)
}
function recordMobileDebug(event: string, data?: Record<string, unknown>) {
  recordMobileDiagnostic(
    event,
    data,
    event.includes('close') || event.includes('error') || event.includes('background'),
  )
  if (typeof window === 'undefined' || !window.localStorage.getItem('tmuxgo-debug-mobile')) return
  const target = window as typeof window & { __tmuxgoMobileDebug?: { events: Array<Record<string, unknown>> } }
  const state = target.__tmuxgoMobileDebug || { events: [] }
  state.events.push({ event, at: Math.round(performance.now()), ...data })
  state.events = state.events.slice(-300)
  target.__tmuxgoMobileDebug = state
}
export function useWebSocket() {
  const reconnectCountRef = useRef(0)
  const updateConnection = useConsoleStore((s) => s.updateConnection)
  const connectionStatus = useConsoleStore((s) => s.connection.status)
  const isConnected = connectionStatus === 'connected'
  const isSocketReady = wsState.socketReady || connectionStatus === 'connected' || connectionStatus === 'attaching'
  const { preferences } = usePreferences()
  const clearPongTimer = useCallback(() => {
    if (!wsState.pongTimer) return
    clearTimeout(wsState.pongTimer)
    wsState.pongTimer = null
  }, [])
  const clearConnectTimer = useCallback(() => {
    if (!wsState.connectTimer) return
    clearTimeout(wsState.connectTimer)
    wsState.connectTimer = null
  }, [])
  const emitOutput = useCallback((message: OutputMessage) => {
    outputListeners
      .get(getOutputListenerKey(message.hostId || 'local', message.sessionName || ''))
      ?.forEach((listener) => listener(message))
  }, [])
  const handleMessage = useCallback(
    (data: any) => {
      switch (data.type) {
        case 'pong':
          wsState.lastPongAt = Date.now()
          netStatsPong()
          clearPongTimer()
          updateConnection({ latency: Date.now() - (data.timestamp || Date.now()), lastPing: new Date().toISOString() })
          break
        case 'output':
        case 'output_resync': {
          emitOutput({
            data: data.data,
            sessionName: data.sessionName ?? null,
            hostId: data.hostId ?? null,
            resync: data.type === 'output_resync',
          })
          break
        }
        case 'stream_caps':
          if (data.compactHeader !== true) wsState.routes.clear()
          break
        case 'stream_route': {
          const routeIdx = Number(data.routeIdx)
          const hostId = typeof data.hostId === 'string' ? data.hostId : ''
          const sessionName = typeof data.sessionName === 'string' ? data.sessionName : ''
          if (Number.isInteger(routeIdx) && routeIdx > 0 && hostId && sessionName)
            wsState.routes.set(routeIdx, { hostId, sessionName })
          break
        }
        case 'connected':
          wsState.socketReady = true
          wsState.attached = false
          updateConnection({ status: 'attaching' })
          break
        case 'attached':
          wsState.attached = true
          emitStreamEvent(STREAM_EVENT.attached, data)
          updateConnection({ status: 'connected' })
          break
        case 'resized':
          emitStreamEvent(STREAM_EVENT.resized, data)
          break
        case 'window-size':
          emitStreamEvent(STREAM_EVENT.windowSize, data)
          break
        case 'exclusive-revoked':
          emitStreamEvent(STREAM_EVENT.exclusiveRevoked, data)
          break
        case 'error':
          wsState.attached = false
          emitStreamEvent(STREAM_EVENT.error, data)
          updateConnection({ status: 'disconnected' })
          break
        case 'detached':
          emitStreamEvent(STREAM_EVENT.detached, data)
          break
        case 'session-exit':
          emitStreamEvent(STREAM_EVENT.sessionExit, data)
          break
        case 'agent_status_changed':
          emitStreamEvent(STREAM_EVENT.agentStatus, data)
          break
        case 'agent_status_snapshot':
          emitStreamEvent(STREAM_EVENT.agentStatusSnapshot, data)
          break
        case 'agent_status_removed':
          emitStreamEvent(STREAM_EVENT.agentStatusRemoved, data)
          break
        case 'agent_notification':
          emitStreamEvent(STREAM_EVENT.agentNotification, data)
          break
        case 'agent_monitor_error':
          emitStreamEvent(STREAM_EVENT.agentMonitorError, data)
          break
      }
    },
    [clearPongTimer, emitOutput, updateConnection],
  )
  const sendPing = useCallback(
    (timeout = 8000) => {
      const ws = wsState.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      netStatsPingSent()
      trackedSend(ws, JSON.stringify({ type: 'ping', timestamp: Date.now() }))
      clearPongTimer()
      wsState.pongTimer = setTimeout(() => {
        if (wsState.ws !== ws || ws.readyState !== WebSocket.OPEN) return
        netStatsFlushPending()
        wsState.closeExpected = false
        ws.close()
      }, timeout)
    },
    [clearPongTimer],
  )
  const connect = useCallback(() => {
    if (typeof window === 'undefined' || wsState.subscribers <= 0) return
    if (document.visibilityState === 'hidden') return
    const current = wsState.ws
    if (current?.readyState === WebSocket.OPEN) return
    if (wsState.isConnecting) return
    if (current) {
      current.onopen = null
      current.onmessage = null
      current.onerror = null
      current.onclose = null
      try {
        current.close()
      } catch {}
      wsState.ws = null
      wsState.socketReady = false
      clearPongTimer()
    }
    if (wsState.reconnectTimer) {
      clearTimeout(wsState.reconnectTimer)
      wsState.reconnectTimer = null
    }
    wsState.isConnecting = true
    wsState.attached = false
    wsState.connectStartedAt = Date.now()
    const attempt = ++wsState.connectAttempt
    clearConnectTimer()
    wsState.connectTimer = setTimeout(() => {
      if (attempt !== wsState.connectAttempt || !wsState.isConnecting) return
      const ws = wsState.ws
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        try {
          ws.close()
        } catch {}
      }
      wsState.ws = null
      wsState.isConnecting = false
      wsState.socketReady = false
      wsState.attached = false
      wsState.connectTimer = null
      recordMobileDebug('ws-connect-timeout')
      updateConnection({ status: 'disconnected' })
      wsState.onClose?.()
    }, CONNECT_TIMEOUT_MS)
    recordMobileDebug('ws-connect')
    const openSocket = (wsUrl: string) => {
      if (attempt !== wsState.connectAttempt || !wsState.isConnecting) return
      try {
        const ws = new WebSocket(wsUrl)
        wsState.ws = ws
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
          if (wsState.ws !== ws) return
          resetMobileInteractiveProfile()
          clearConnectTimer()
          wsState.isConnecting = false
          wsState.closeExpected = false
          wsState.socketReady = true
          wsState.attached = false
          // 重连后服务端字典从 1 重建，旧 route 映射必须作废
          wsState.routes.clear()
          wsState.reconnectCount = 0
          reconnectCountRef.current = 0
          wsState.lastPongAt = Date.now()
          updateConnection({ status: 'attaching', latency: 0 })
          recordMobileDebug('ws-open')
          netStatsReset()
          try {
            trackedSend(
              ws,
              JSON.stringify({
                type: 'stream_caps',
                binaryOutput: true,
                compressOutput: 'gzip',
                cellOutput: true,
                compactHeader: true,
              }),
            )
          } catch {}
          sendPing()
          emitStreamEvent(STREAM_EVENT.reconnected)
          wsState.onOpen?.()
        }
        ws.onmessage = (event) => {
          netStatsRx()
          try {
            if (typeof ArrayBuffer !== 'undefined' && event.data instanceof ArrayBuffer) {
              const decoded = decodeStreamOutputBinary(event.data, wsState.routes as StreamRouteMap)
              if (!decoded) return
              if ((decoded.type === 'cell_snapshot' || decoded.type === 'cell_snapshot_v2') && decoded.cellPayload) {
                const snap = (decoded.type === 'cell_snapshot_v2' ? decodeCellSnapshotV2 : decodeCellSnapshot)(
                  decoded.cellPayload,
                )
                if (!snap) {
                  try {
                    trackedSend(
                      ws,
                      JSON.stringify({
                        type: 'cell_resync_request',
                        sessionName: decoded.sessionName,
                        hostId: decoded.hostId,
                      }),
                    )
                  } catch {}
                  return
                }
                cellLastSeq = snap.seq
                const ansi = snapshotToAnsi(snap)
                wsState.onMessage?.({
                  type: 'output_resync',
                  data: ansi,
                  sessionName: decoded.sessionName,
                  hostId: decoded.hostId,
                  cell: { kind: 'snapshot', snapshot: snap },
                })
                return
              }
              if ((decoded.type === 'cell_diff' || decoded.type === 'cell_diff_v2') && decoded.cellPayload) {
                const diff = (decoded.type === 'cell_diff_v2' ? decodeCellDiffV2 : decodeCellDiff)(decoded.cellPayload)
                if (!diff) return
                if (cellLastSeq !== 0 && diff.baseSeq !== cellLastSeq) {
                  try {
                    trackedSend(
                      ws,
                      JSON.stringify({
                        type: 'cell_resync_request',
                        sessionName: decoded.sessionName,
                        hostId: decoded.hostId,
                      }),
                    )
                  } catch {}
                  return
                }
                cellLastSeq = diff.seq
                const ansi = diffToAnsi(diff)
                wsState.onMessage?.({
                  type: 'output',
                  data: ansi,
                  sessionName: decoded.sessionName,
                  hostId: decoded.hostId,
                  cell: { kind: 'diff', diff },
                })
                return
              }
              wsState.onMessage?.({
                type: decoded.type,
                data: decoded.data,
                sessionName: decoded.sessionName,
                hostId: decoded.hostId,
              })
              return
            }
            const raw = typeof event.data === 'string' ? event.data : String(event.data)
            const data = JSON.parse(raw)
            wsState.onMessage?.(data)
          } catch (err) {
            console.error('Failed to parse WebSocket message:', err)
          }
        }
        ws.onclose = () => {
          if (wsState.ws !== ws) return
          resetMobileInteractiveProfile()
          wsState.ws = null
          wsState.isConnecting = false
          wsState.socketReady = false
          wsState.attached = false
          clearConnectTimer()
          clearPongTimer()
          netStatsFlushPending()
          const expected = wsState.closeExpected
          wsState.closeExpected = false
          recordMobileDebug('ws-close', { expected, visibility: document.visibilityState })
          if (!expected && document.visibilityState === 'hidden') return
          updateConnection({ status: 'disconnected' })
          if (!expected) {
            wsState.onClose?.()
          }
        }
        ws.onerror = () => {
          if (wsState.ws !== ws) return
          resetMobileInteractiveProfile()
          wsState.isConnecting = false
          wsState.socketReady = false
          wsState.attached = false
          clearConnectTimer()
          clearPongTimer()
          netStatsFlushPending()
          ws.onopen = null
          ws.onmessage = null
          ws.onerror = null
          ws.onclose = null
          try {
            ws.close()
          } catch {}
          wsState.ws = null
          recordMobileDebug('ws-error', { visibility: document.visibilityState })
          wsState.onError?.()
        }
      } catch (err) {
        resetMobileInteractiveProfile()
        clearConnectTimer()
        clearPongTimer()
        wsState.isConnecting = false
        wsState.socketReady = false
        wsState.attached = false
        wsState.ws = null
        recordMobileDebug('ws-connect-error')
        wsState.onError?.()
      }
    }
    if (isAuthEnabled()) {
      void getWebSocketUrl()
        .then((wsUrl) => {
          if (attempt !== wsState.connectAttempt || wsState.subscribers <= 0 || wsState.ws || !wsState.isConnecting)
            return
          openSocket(wsUrl)
        })
        .catch(() => {
          if (attempt !== wsState.connectAttempt) return
          resetMobileInteractiveProfile()
          clearConnectTimer()
          clearPongTimer()
          wsState.isConnecting = false
          wsState.socketReady = false
          wsState.attached = false
          recordMobileDebug('ws-ticket-error')
          wsState.onError?.()
        })
      return
    }
    openSocket(getWebSocketBase())
  }, [clearConnectTimer, clearPongTimer, sendPing, updateConnection])
  const scheduleReconnect = useCallback(() => {
    if (!preferences.autoReconnect || wsState.subscribers <= 0) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (wsState.reconnectTimer || wsState.isConnecting) return
    wsState.reconnectCount += 1
    reconnectCountRef.current = wsState.reconnectCount
    updateConnection({ status: 'reconnecting' })
    const baseDelay = wsState.reconnectCount === 1 ? 400 : preferences.reconnectInterval
    const delay = Math.min(baseDelay * Math.max(wsState.reconnectCount, 1), 30000)
    wsState.reconnectTimer = setTimeout(() => {
      wsState.reconnectTimer = null
      connect()
    }, delay)
  }, [connect, updateConnection, preferences.autoReconnect, preferences.reconnectInterval])
  const resetAndReconnect = useCallback(() => {
    const ws = wsState.ws
    resetMobileInteractiveProfile()
    updateConnection({ status: 'reconnecting' })
    wsState.connectAttempt += 1
    clearConnectTimer()
    clearPongTimer()
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {}
    }
    wsState.ws = null
    wsState.isConnecting = false
    wsState.socketReady = false
    wsState.attached = false
    wsState.closeExpected = false
    wsState.reconnectCount = 0
    reconnectCountRef.current = 0
    connect()
  }, [clearConnectTimer, clearPongTimer, connect, updateConnection])
  const ensureConnection = useCallback(
    (recover = false) => {
      const ws = wsState.ws
      recordMobileDebug('ws-ensure', { recover, readyState: ws?.readyState ?? -1 })
      if (!ws) {
        wsState.reconnectCount = 0
        if (wsState.isConnecting) {
          if (recover && Date.now() - wsState.connectStartedAt > STALE_CONNECT_RESET_MS) resetAndReconnect()
          return
        }
        connect()
        return
      }
      if (ws.readyState === WebSocket.OPEN) {
        sendPing(1500)
        return
      }
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING) {
        if (recover && Date.now() - wsState.connectStartedAt > STALE_CONNECT_RESET_MS) resetAndReconnect()
        return
      }
      if (recover || ws.readyState === WebSocket.CLOSED) {
        wsState.reconnectCount = 0
        connect()
      }
    },
    [connect, resetAndReconnect, sendPing],
  )
  const send = useCallback((data: any) => {
    const ws = wsState.ws
    if (ws?.readyState === WebSocket.OPEN) {
      // Oversized paste: binary paste-data frame to avoid JSON escape bloat.
      // Small input stays on the JSON type:input path unchanged.
      if (
        data?.type === 'input' &&
        typeof data.data === 'string' &&
        data.hostId &&
        data.sessionName &&
        shouldUsePasteBinary(data.data)
      ) {
        const frame = encodePasteBinary(String(data.hostId), String(data.sessionName), data.data)
        if (typeof document !== 'undefined' && document.visibilityState === 'visible' && isMobileDevice()) {
          if (!mobileInteractiveProfileActive) {
            trackedSend(ws, JSON.stringify({ type: 'stream_profile', profile: 'foreground' }))
            mobileInteractiveProfileActive = true
            recordMobileDebug('stream-profile-interactive-start')
          }
          if (mobileInteractiveProfileTimer) clearTimeout(mobileInteractiveProfileTimer)
          netStatsTx()
          ws.send(frame)
          mobileInteractiveProfileTimer = setTimeout(() => {
            mobileInteractiveProfileTimer = null
            mobileInteractiveProfileActive = false
            if (wsState.ws !== ws || ws.readyState !== WebSocket.OPEN) return
            trackedSend(ws, JSON.stringify({ type: 'stream_profile', profile: 'mobile' }))
            recordMobileDebug('stream-profile-interactive-end')
          }, MOBILE_INTERACTIVE_PROFILE_MS)
          return true
        }
        netStatsTx()
        ws.send(frame)
        return true
      }
      if (
        data?.type === 'input' &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        isMobileDevice()
      ) {
        if (!mobileInteractiveProfileActive) {
          trackedSend(ws, JSON.stringify({ type: 'stream_profile', profile: 'foreground' }))
          mobileInteractiveProfileActive = true
          recordMobileDebug('stream-profile-interactive-start')
        }
        if (mobileInteractiveProfileTimer) clearTimeout(mobileInteractiveProfileTimer)
        trackedSend(ws, JSON.stringify(data))
        mobileInteractiveProfileTimer = setTimeout(() => {
          mobileInteractiveProfileTimer = null
          mobileInteractiveProfileActive = false
          if (wsState.ws !== ws || ws.readyState !== WebSocket.OPEN) return
          trackedSend(ws, JSON.stringify({ type: 'stream_profile', profile: 'mobile' }))
          recordMobileDebug('stream-profile-interactive-end')
        }, MOBILE_INTERACTIVE_PROFILE_MS)
        return true
      }
      trackedSend(ws, JSON.stringify(data))
      return true
    }
    return false
  }, [])
  const subscribeOutput = useCallback(
    (hostId: string, sessionName: string, listener: (message: OutputMessage) => void) => {
      const key = getOutputListenerKey(hostId || 'local', sessionName)
      const listeners = outputListeners.get(key) || new Set<(message: OutputMessage) => void>()
      listeners.add(listener)
      outputListeners.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) outputListeners.delete(key)
      }
    },
    [],
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (wsState.closeTimer) {
      clearTimeout(wsState.closeTimer)
      wsState.closeTimer = null
    }
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
        if (document.visibilityState !== 'visible') return
        const ws = wsState.ws
        if (!ws) {
          if (!wsState.isConnecting) {
            wsState.reconnectCount = 0
            connect()
          }
          return
        }
        if (ws.readyState === WebSocket.OPEN) {
          if (Date.now() - wsState.lastPongAt >= 10000) {
            sendPing()
          }
          return
        }
        if ((ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) && !wsState.isConnecting) {
          wsState.reconnectCount = 0
          connect()
        }
      }, 1500)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        ensureConnection(true)
      } else {
        resetMobileInteractiveProfile()
      }
    }
    const handlePageShow = () => {
      ensureConnection(false)
    }
    const handleFocus = () => {
      ensureConnection(true)
    }
    const handleOnline = () => {
      ensureConnection(true)
    }
    const handleInteractionRecover = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - wsState.lastInteractionRecoverAt < 1200) return
      wsState.lastInteractionRecoverAt = now
      ensureConnection(true)
    }
    if (!wsState.listenersReady) {
      wsState.listenersReady = true
      document.addEventListener('visibilitychange', handleVisibilityChange)
      window.addEventListener('pageshow', handlePageShow)
      window.addEventListener('focus', handleFocus)
      window.addEventListener('online', handleOnline)
      document.addEventListener('pointerdown', handleInteractionRecover, true)
      document.addEventListener('touchstart', handleInteractionRecover, true)
      wsState.cleanupListeners = () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        window.removeEventListener('pageshow', handlePageShow)
        window.removeEventListener('focus', handleFocus)
        window.removeEventListener('online', handleOnline)
        document.removeEventListener('pointerdown', handleInteractionRecover, true)
        document.removeEventListener('touchstart', handleInteractionRecover, true)
      }
    }
    return () => {
      wsState.subscribers -= 1
      if (wsState.subscribers <= 0) {
        if (wsState.closeTimer) clearTimeout(wsState.closeTimer)
        wsState.closeTimer = setTimeout(() => {
          if (wsState.subscribers > 0) return
          wsState.closeTimer = null
          wsState.cleanupListeners?.()
          wsState.cleanupListeners = null
          wsState.listenersReady = false
          if (wsState.reconnectTimer) {
            clearTimeout(wsState.reconnectTimer)
            wsState.reconnectTimer = null
          }
          if (wsState.pingTimer) {
            clearInterval(wsState.pingTimer)
            wsState.pingTimer = null
          }
          resetMobileInteractiveProfile()
          clearConnectTimer()
          clearPongTimer()
          wsState.connectAttempt += 1
          wsState.connectStartedAt = 0
          wsState.closeExpected = false
          if (wsState.ws) {
            wsState.closeExpected = true
            wsState.ws.close()
            wsState.ws = null
          }
          wsState.reconnectCount = 0
          wsState.isConnecting = false
          wsState.socketReady = false
          wsState.attached = false
          wsState.lastPongAt = 0
          wsState.lastInteractionRecoverAt = 0
          wsState.onMessage = null
          wsState.onOpen = null
          wsState.onClose = null
          wsState.onError = null
        }, 250)
      }
    }
  }, [clearConnectTimer, connect, ensureConnection, handleMessage, scheduleReconnect, sendPing, clearPongTimer])
  return { send, isConnected, isSocketReady, subscribeOutput }
}
