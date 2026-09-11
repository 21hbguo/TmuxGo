import { getApiBase, getWebSocketBase } from './runtime-endpoints'

export interface AuthStatus {
  enabled: boolean
  authenticated: boolean
  username?: string
  sessionId?: string
  passwordChangeRequired?: boolean
}
export interface AuthResponse {
  accessToken: string
  refreshToken?: string
  expiresIn: number
  user: { username: string }
  sessionId: string
  passwordChangeRequired?: boolean
}
export interface AuthSession {
  id: string
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  userAgent?: string
  ip?: string
}
type AuthListener = (status: AuthStatus) => void
let accessToken: string | null = null
let authStatus: AuthStatus = { enabled: false, authenticated: false }
let refreshPromise: Promise<boolean> | null = null
const listeners = new Set<AuthListener>()
function setAuthStatus(next: AuthStatus) {
  authStatus = next
  listeners.forEach((listener) => listener(authStatus))
}
async function readPayload(response: Response) {
  const raw = await response.text()
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { message: raw }
  }
}
function createAuthError(status: number, payload: unknown) {
  const body = payload && typeof payload === 'object' ? payload as { message?: string; code?: string } : {}
  const error = new Error(body.message || `HTTP ${status}`) as Error & { status?: number; code?: string }
  error.status = status
  error.code = body.code || 'AUTH_REQUEST_FAILED'
  return error
}
function updateToken(response: AuthResponse) {
  accessToken = response.accessToken
  setAuthStatus({ enabled: true, authenticated: true, username: response.user?.username, sessionId: response.sessionId, passwordChangeRequired: response.passwordChangeRequired === true })
}
export function getAccessToken() {
  return accessToken
}
export function isAuthEnabled() {
  return authStatus.enabled
}
export function onAuthChange(listener: AuthListener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const NETWORK_RETRY_DELAYS = [0, 400, 1200, 2500]
export async function authenticatedFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${getApiBase()}${path}`
  const method = (init.method || 'GET').toUpperCase()
  const retryDelays = retry && ['GET', 'HEAD', 'PUT'].includes(method) ? NETWORK_RETRY_DELAYS : []
  let response: Response | null = null
  for (let attempt = 0; !response; attempt += 1) {
    try {
      response = await fetch(url, { ...init, headers, credentials: 'include' })
    } catch (error) {
      if (attempt >= retryDelays.length || !(error instanceof TypeError)) throw error
      const delay = retryDelays[attempt]
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
  if (response.status !== 401 || !retry || !authStatus.enabled || path.startsWith('/api/auth/')) return response
  if (!await refreshAuth()) return response
  return authenticatedFetch(path, init, false)
}
export async function getAuthStatus() {
  const response = await authenticatedFetch('/api/auth/status', {}, false)
  const payload = await readPayload(response)
  if (!response.ok) throw createAuthError(response.status, payload)
  const status = payload as unknown as AuthStatus
  setAuthStatus({ enabled: status.enabled === true, authenticated: status.authenticated === true, username: typeof status.username === 'string' ? status.username : undefined, sessionId: typeof status.sessionId === 'string' ? status.sessionId : undefined, passwordChangeRequired: status.passwordChangeRequired === true })
  return authStatus
}
export async function login(username: string, password: string) {
  const response = await authenticatedFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }), headers: { 'Content-Type': 'application/json' } }, false)
  const payload = await readPayload(response)
  if (!response.ok) throw createAuthError(response.status, payload)
  updateToken(payload as unknown as AuthResponse)
  return payload as unknown as AuthResponse
}
export async function refreshAuth() {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    try {
      const response = await authenticatedFetch('/api/auth/refresh', { method: 'POST', signal: controller.signal }, false)
      const payload = await readPayload(response)
      if (!response.ok) {
        accessToken = null
        if (authStatus.enabled) setAuthStatus({ ...authStatus, authenticated: false })
        return false
      }
      updateToken(payload as unknown as AuthResponse)
      return true
    } finally {
      clearTimeout(timeout)
    }
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}
export async function logout() {
  try {
    await authenticatedFetch('/api/auth/logout', { method: 'POST' }, false)
  } finally {
    accessToken = null
    setAuthStatus({ enabled: authStatus.enabled, authenticated: false, username: authStatus.username })
  }
}
export async function listAuthSessions() {
  const response = await authenticatedFetch('/api/auth/sessions')
  const payload = await readPayload(response)
  if (!response.ok) throw createAuthError(response.status, payload)
  const data = payload && typeof payload === 'object' ? payload as { sessions?: unknown; currentSessionId?: unknown } : {}
  return { sessions: Array.isArray(data.sessions) ? data.sessions as AuthSession[] : [], currentSessionId: typeof data.currentSessionId === 'string' ? data.currentSessionId : '' }
}
export async function revokeAuthSession(sessionId: string) {
  const response = await authenticatedFetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  const payload = await readPayload(response)
  if (!response.ok) throw createAuthError(response.status, payload)
  return payload as { deleted: boolean; current: boolean }
}
export async function revokeOtherAuthSessions() {
  const response = await authenticatedFetch('/api/auth/sessions/revoke-others', { method: 'POST' })
  const payload = await readPayload(response)
  if (!response.ok) throw createAuthError(response.status, payload)
  return payload as { deleted: number }
}
export async function changePassword(currentPassword: string, newPassword: string) {
  const response = await authenticatedFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }), headers: { 'Content-Type': 'application/json' } })
  const payload = await readPayload(response)
  if (!response.ok) throw createAuthError(response.status, payload)
  accessToken = null
  setAuthStatus({ enabled: authStatus.enabled, authenticated: false, username: authStatus.username })
}
export async function getWebSocketUrl() {
  if (!authStatus.enabled) return getWebSocketBase()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4000)
  try {
    let response = await authenticatedFetch('/api/auth/ws-ticket', { method: 'POST', signal: controller.signal }, false)
    if (response.status === 401 && await refreshAuth()) response = await authenticatedFetch('/api/auth/ws-ticket', { method: 'POST', signal: controller.signal }, false)
    const payload = await readPayload(response)
    if (!response.ok) throw createAuthError(response.status, payload)
    const ticket = payload && typeof payload.ticket === 'string' ? payload.ticket : ''
    if (!ticket) throw new Error('Missing WebSocket ticket')
    const separator = getWebSocketBase().includes('?') ? '&' : '?'
    return `${getWebSocketBase()}${separator}ticket=${encodeURIComponent(ticket)}`
  } finally {
    clearTimeout(timeout)
  }
}
