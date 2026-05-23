export interface Host {
  id: string
  name: string
  address: string
  status: 'online' | 'offline' | 'unreachable'
  tags: string[]
}

export interface Session {
  id: string
  hostId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
}

export interface Window {
  id: string
  sessionId: string
  index: number
  name: string
  active: boolean
}

export interface Pane {
  id: string
  windowId: string
  index: number
  title: string
  active: boolean
  size: {
    cols: number
    rows: number
  }
}

export interface User {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'operator' | 'viewer'
  lastLoginAt: string
}

export interface ConnectionState {
  status: 'connected' | 'reconnecting' | 'disconnected'
  latency: number
  lastPing: string
}
