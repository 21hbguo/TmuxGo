'use client'
import { useCallback, useEffect, useRef } from 'react'
import { getWebSocketBase } from '@/lib/runtime-endpoints'
import { getWebSocketUrl, isAuthEnabled } from '@/lib/auth'
import { decodeStreamOutputBinary } from '@/lib/stream-binary'
import { decodeCellDiff, decodeCellDiffV2, decodeCellSnapshot, decodeCellSnapshotV2 } from '@/lib/terminal-grid/decode-cell'
import { diffToAnsi, snapshotToAnsi } from '@/lib/terminal-grid/apply-cell'
type OutputMessage = { data: string; sessionName?: string | null; hostId?: string | null; resync?: boolean }
type OutputListener = (message: OutputMessage) => void
type SocketOutputMessage = OutputMessage & { type?: string }
interface ConnectionState {
  key: string
  ws: WebSocket | null
  isConnecting: boolean
  socketReady: boolean
  attached: boolean
  listeners: Set<OutputListener>
  subscribers: number
  reconnectCount: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  pongTimer: ReturnType<typeof setTimeout> | null
  lastPongAt: number
  connectAttempt: number
  closeExpected: boolean
}
const connections = new Map<string, ConnectionState>()
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000
const PING_INTERVAL_MS = 10000
const PONG_TIMEOUT_MS = 8000
const STALE_PONG_MS = 25000
function getKey(hostId: string, sessionId: string) {
  return `${hostId || 'local'}\u0000${sessionId}`
}
function createConnection(key: string): ConnectionState {
  return { key, ws: null, isConnecting: false, socketReady: false, attached: false, listeners: new Set(), subscribers: 0, reconnectCount: 0, reconnectTimer: null, pingTimer: null, pongTimer: null, lastPongAt: 0, connectAttempt: 0, closeExpected: false }
}
function getConnection(key: string) {
  let connection = connections.get(key)
  if (!connection) {
    connection = createConnection(key)
    connections.set(key, connection)
  }
  return connection
}
function clearPongTimer(connection: ConnectionState) {
  if (connection.pongTimer) {
    clearTimeout(connection.pongTimer)
    connection.pongTimer = null
  }
}
function detachSocketHandlers(connection: ConnectionState) {
  const ws = connection.ws
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try { ws.close() } catch {}
  }
  connection.ws = null
  connection.isConnecting = false
  connection.socketReady = false
  connection.attached = false
  clearPongTimer(connection)
}
function scheduleReconnect(connection: ConnectionState) {
  if (connection.reconnectTimer || connection.isConnecting) return
  connection.reconnectCount += 1
  const delay = Math.min(RECONNECT_BASE_MS * Math.max(connection.reconnectCount, 1), RECONNECT_MAX_MS)
  connection.reconnectTimer = setTimeout(() => {
    connection.reconnectTimer = null
    connect(connection)
  }, delay)
}
function connect(connection: ConnectionState) {
  if (typeof window === 'undefined' || connection.subscribers <= 0) return
  if (connection.ws?.readyState === WebSocket.OPEN || connection.isConnecting) return
  if (connection.reconnectTimer) {
    clearTimeout(connection.reconnectTimer)
    connection.reconnectTimer = null
  }
  connection.isConnecting = true
  connection.attached = false
  const attempt = ++connection.connectAttempt
  const openSocket = (wsUrl: string) => {
    if (attempt !== connection.connectAttempt || !connection.isConnecting) return
    try {
      const ws = new WebSocket(wsUrl)
      connection.ws = ws
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        if (connection.ws !== ws) return
        connection.isConnecting = false
        connection.closeExpected = false
        connection.socketReady = true
        connection.reconnectCount = 0
        connection.lastPongAt = Date.now()
        try { ws.send(JSON.stringify({ type: 'stream_caps', binaryOutput: true, compressOutput: 'gzip', cellOutput: false })) } catch {}
        sendPing(connection)
      }
      ws.onmessage = (event) => {
        try {
          if (typeof ArrayBuffer !== 'undefined' && event.data instanceof ArrayBuffer) {
            const decoded = decodeStreamOutputBinary(event.data)
            if (!decoded) return
            if ((decoded.type === 'cell_snapshot' || decoded.type === 'cell_snapshot_v2') && decoded.cellPayload) {
              const snap = (decoded.type === 'cell_snapshot_v2' ? decodeCellSnapshotV2 : decodeCellSnapshot)(decoded.cellPayload)
              if (!snap) {
                try { ws.send(JSON.stringify({ type: 'cell_resync_request', sessionName: decoded.sessionName, hostId: decoded.hostId })) } catch {}
                return
              }
              const ansi = snapshotToAnsi(snap)
              dispatchOutput(connection, { type: 'output_resync', data: ansi, sessionName: decoded.sessionName, hostId: decoded.hostId })
              return
            }
            if ((decoded.type === 'cell_diff' || decoded.type === 'cell_diff_v2') && decoded.cellPayload) {
              const diff = (decoded.type === 'cell_diff_v2' ? decodeCellDiffV2 : decodeCellDiff)(decoded.cellPayload)
              if (!diff) return
              const ansi = diffToAnsi(diff)
              dispatchOutput(connection, { type: 'output', data: ansi, sessionName: decoded.sessionName, hostId: decoded.hostId })
              return
            }
            dispatchOutput(connection, { type: decoded.type, data: decoded.data, sessionName: decoded.sessionName, hostId: decoded.hostId })
            return
          }
          const raw = typeof event.data === 'string' ? event.data : String(event.data)
          const data = JSON.parse(raw)
          handleMessage(connection, data)
        } catch (err) {
          console.error('Failed to parse session socket message:', err)
        }
      }
      ws.onclose = () => {
        if (connection.ws !== ws) return
        connection.ws = null
        connection.isConnecting = false
        connection.socketReady = false
        connection.attached = false
        clearPongTimer(connection)
        const expected = connection.closeExpected
        connection.closeExpected = false
        if (!expected) scheduleReconnect(connection)
      }
      ws.onerror = () => {
        if (connection.ws !== ws) return
        detachSocketHandlers(connection)
        scheduleReconnect(connection)
      }
    } catch {
      connection.isConnecting = false
      connection.ws = null
      scheduleReconnect(connection)
    }
  }
  if (isAuthEnabled()) {
    void getWebSocketUrl().then((wsUrl) => {
      if (attempt !== connection.connectAttempt || connection.subscribers <= 0 || connection.ws || !connection.isConnecting) return
      openSocket(wsUrl)
    }).catch(() => {
      if (attempt !== connection.connectAttempt) return
      connection.isConnecting = false
      scheduleReconnect(connection)
    })
    return
  }
  openSocket(getWebSocketBase())
}
function sendPing(connection: ConnectionState, timeout = PONG_TIMEOUT_MS) {
  const ws = connection.ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
  clearPongTimer(connection)
  connection.pongTimer = setTimeout(() => {
    if (connection.ws !== ws || ws.readyState !== WebSocket.OPEN) return
    connection.closeExpected = false
    ws.close()
  }, timeout)
}
function dispatchOutput(connection: ConnectionState, message: SocketOutputMessage) {
  const sessionName = message.sessionName
  if (sessionName && getKey(message.hostId || 'local', sessionName) !== connection.key) return
  connection.listeners.forEach((listener) => listener({ data: message.data, sessionName: message.sessionName, hostId: message.hostId, resync: message.resync }))
}
function handleMessage(connection: ConnectionState, data: any) {
  switch (data.type) {
    case 'pong':
      connection.lastPongAt = Date.now()
      clearPongTimer(connection)
      break
    case 'output':
    case 'output_resync':
      dispatchOutput(connection, { data: data.data, sessionName: data.sessionName ?? null, hostId: data.hostId ?? null, resync: data.type === 'output_resync' })
      break
    case 'connected':
      connection.socketReady = true
      connection.attached = false
      break
    case 'attached':
      connection.attached = true
      window.dispatchEvent(new CustomEvent('tmux-attached', { detail: data }))
      break
    case 'resized':
      window.dispatchEvent(new CustomEvent('tmux-resized', { detail: data }))
      break
    case 'error':
      connection.attached = false
      window.dispatchEvent(new CustomEvent('tmux-error', { detail: data }))
      break
    case 'detached':
      window.dispatchEvent(new CustomEvent('tmux-detached', { detail: data }))
      break
    case 'session-exit':
      window.dispatchEvent(new CustomEvent('tmux-session-exit', { detail: data }))
      break
    case 'stream_caps':
      break
    default:
      break
  }
}
let foregroundListenerReady=false
function ensureForegroundListener() {
  if (foregroundListenerReady||typeof window==='undefined') return
  foregroundListenerReady=true
  const handleForeground=()=>{
    if (document.visibilityState!=='visible') return
    connections.forEach((connection)=>{
      if (connection.subscribers<=0) return
      const ws=connection.ws
      if (ws?.readyState===WebSocket.OPEN) {
        sendPing(connection,1500)
        return
      }
      if (connection.isConnecting) return
      if (connection.reconnectTimer) {
        clearTimeout(connection.reconnectTimer)
        connection.reconnectTimer=null
      }
      connection.reconnectCount=0
      connect(connection)
    })
  }
  document.addEventListener('visibilitychange',handleForeground)
  window.addEventListener('focus',handleForeground)
  window.addEventListener('online',handleForeground)
}
export function useSessionSocket(hostId: string, sessionId: string) {
  const connectionRef = useRef<ConnectionState | null>(null)
  if (!connectionRef.current) connectionRef.current = getConnection(getKey(hostId, sessionId))
  const connection = connectionRef.current
  const send = useCallback((data: any) => {
    if (connection.ws?.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(data))
      return true
    }
    return false
  }, [connection])
  const subscribeOutput = useCallback((host: string, session: string, listener: OutputListener) => {
    if (getKey(host, session) !== connection.key) return () => {}
    connection.listeners.add(listener)
    return () => {
      connection.listeners.delete(listener)
    }
  }, [connection])
  useEffect(() => {
    connection.subscribers += 1
    ensureForegroundListener()
    connect(connection)
    if (!connection.pingTimer) {
      connection.pingTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        const ws = connection.ws
        if (!ws) {
          if (!connection.isConnecting) {
            connection.reconnectCount = 0
            connect(connection)
          }
          return
        }
        if (ws.readyState === WebSocket.OPEN) {
          if (Date.now() - connection.lastPongAt >= STALE_PONG_MS) sendPing(connection)
          return
        }
        if ((ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) && !connection.isConnecting) {
          connection.reconnectCount = 0
          connect(connection)
        }
      }, 1500)
    }
    return () => {
      connection.subscribers -= 1
      if (connection.subscribers <= 0) {
        if (connection.pingTimer) {
          clearInterval(connection.pingTimer)
          connection.pingTimer = null
        }
        connection.closeExpected = true
        detachSocketHandlers(connection)
        if (connection.reconnectTimer) {
          clearTimeout(connection.reconnectTimer)
          connection.reconnectTimer = null
        }
        connections.delete(connection.key)
      }
    }
  }, [connection])
  return { send, isConnected: connection.socketReady && connection.attached, isSocketReady: connection.socketReady, subscribeOutput }
}
