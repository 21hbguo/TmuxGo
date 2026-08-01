import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto'
import os from 'os'
import path from 'path'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'

const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
const WS_TICKET_TTL_SECONDS = 60
const MAX_LOGIN_ATTEMPTS = 10
const LOGIN_WINDOW_MS = 60 * 1000
const AUTH_VERSION = 1
const COOKIE_NAME = 'tmuxgo_refresh_token'
const ACCESS_COOKIE_NAME = 'tmuxgo_access_token'
const ACCESS_SECRET_CONTEXT = 'access'
const WS_TICKET_CONTEXT = 'ws-ticket'

export type AuthUser = { username: string }
export type AccessTokenPayload = { username: string; sessionId: string; exp: number }
export type AuthSession = { id: string; createdAt: string; lastUsedAt: string; expiresAt: string; userAgent?: string; ip?: string }
type StoredSession = AuthSession & { refreshTokenHash: string }
type AuthStore = { version: number; username: string; passwordHash: string; signingKey: string; sessions: StoredSession[] }
type LoginAttempt = { count: number; resetAt: number }

export class AuthError extends Error {
  statusCode: number
  code: string
  constructor(message: string, statusCode = 401, code = 'AUTH_ERROR') {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

const configuredUsername = (process.env.TMUXGO_AUTH_USERNAME ?? 'admin').trim()
const configuredPassword = process.env.TMUXGO_AUTH_PASSWORD ?? 'admin123'
const configDir = process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo')
const authFile = path.join(configDir, 'auth.json')
let store: AuthStore | null = null
let initialized = false
let initPromise: Promise<void> | null = null
const accessTokens = new Map<string, AccessTokenPayload>()
const wsTickets = new Map<string, { username: string; sessionId: string; expiresAt: number }>()
const loginAttempts = new Map<string, LoginAttempt>()

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function hashPassword(password: string, salt: string) {
  return hash(`${salt}:${password}`)
}
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}
function createPasswordHash(password: string) {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 32)
  return `scrypt:${salt.toString('base64url')}:${derived.toString('base64url')}`
}
function verifyPassword(password: string, passwordHash: string) {
  const parts = passwordHash.split(':')
  if (parts[0] === 'scrypt') {
    const salt = parts[1]
    const expected = parts[2]
    if (!salt || !expected) return false
    return safeEqual(scryptSync(password, Buffer.from(salt, 'base64url'), 32).toString('base64url'), expected)
  }
  const [salt, expected] = parts
  return !!salt && !!expected && safeEqual(hashPassword(password, salt), expected)
}
function now() {
  return Date.now()
}
function toIso(timestamp: number) {
  return new Date(timestamp).toISOString()
}
async function writeStore() {
  if (!store) return
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await chmod(configDir, 0o700)
  const temporary = `${authFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, authFile)
  await chmod(authFile, 0o600)
}
async function initializeAuth() {
  if (initialized) return
  initialized = true
  if (!configuredUsername || !configuredPassword) return
  let loaded: AuthStore | null = null
  try {
    loaded = JSON.parse(await readFile(authFile, 'utf8')) as AuthStore
  } catch {}
  if (loaded?.version === AUTH_VERSION && typeof loaded.username === 'string' && typeof loaded.passwordHash === 'string' && typeof loaded.signingKey === 'string' && Array.isArray(loaded.sessions)) {
    store = loaded
    store.sessions = store.sessions.filter((session) => typeof session.refreshTokenHash === 'string' && Date.parse(session.expiresAt) > now())
    if (store.username !== configuredUsername) {
      store.username = configuredUsername
      await writeStore()
    }
    return
  }
  store = { version: AUTH_VERSION, username: configuredUsername, passwordHash: createPasswordHash(configuredPassword), signingKey: randomBytes(32).toString('base64url'), sessions: [] }
  await writeStore()
}
export async function initializeAuthStore() {
  if (!initPromise) initPromise = initializeAuth()
  await initPromise
}
export function isAuthEnabled() {
  return !!configuredUsername && !!configuredPassword
}
export function getAuthUsername() {
  return store?.username || configuredUsername
}
export function getRefreshCookieName() {
  return COOKIE_NAME
}
export function getAccessCookieName() {
  return ACCESS_COOKIE_NAME
}
export function getAccessTokenTtl() {
  return ACCESS_TTL_SECONDS
}
export function getAuthUser(username = getAuthUsername()) {
  return { username }
}
function requireStore() {
  if (!store) throw new AuthError('Authentication is disabled', 401, 'AUTH_DISABLED')
  return store
}
function issueAccessToken(username: string, sessionId: string) {
  const authStore = requireStore()
  const payload: AccessTokenPayload = { username, sessionId, exp: Math.floor(now() / 1000) + ACCESS_TTL_SECONDS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const token = `${encoded}.${sign(`${ACCESS_SECRET_CONTEXT}.${encoded}`, authStore.signingKey)}`
  accessTokens.set(token, payload)
  return token
}
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  if (!store || typeof token !== 'string') return null
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature || !safeEqual(sign(`${ACCESS_SECRET_CONTEXT}.${encoded}`, store.signingKey), signature)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccessTokenPayload
    if (!payload || payload.username !== store.username || typeof payload.sessionId !== 'string' || typeof payload.exp !== 'number' || payload.exp <= Math.floor(now() / 1000)) return null
    if (!store.sessions.some((session) => session.id === payload.sessionId && Date.parse(session.expiresAt) > now())) return null
    return payload
  } catch {
    return null
  }
}
function getValidAccessToken(token: string) {
  const payload = accessTokens.get(token)
  if (payload && payload.exp > Math.floor(now() / 1000)) return payload
  accessTokens.delete(token)
  return verifyAccessToken(token)
}
function checkLoginRateLimit(identifier: string) {
  const current = loginAttempts.get(identifier)
  const timestamp = now()
  if (!current || current.resetAt <= timestamp) {
    loginAttempts.set(identifier, { count: 1, resetAt: timestamp + LOGIN_WINDOW_MS })
    return
  }
  current.count++
  if (current.count > MAX_LOGIN_ATTEMPTS) throw new AuthError('Too many login attempts', 429, 'RATE_LIMITED')
}
export async function login(username: string, password: string, metadata: { userAgent?: string; ip?: string } = {}) {
  await initializeAuthStore()
  const authStore = requireStore()
  checkLoginRateLimit(metadata.ip || 'unknown')
  if (username !== authStore.username || !verifyPassword(password, authStore.passwordHash)) throw new AuthError('Invalid username or password', 401, 'INVALID_CREDENTIALS')
  const timestamp = now()
  const rawRefreshToken = randomBytes(48).toString('base64url')
  const session: StoredSession = { id: randomUUID(), createdAt: toIso(timestamp), lastUsedAt: toIso(timestamp), expiresAt: toIso(timestamp + REFRESH_TTL_SECONDS * 1000), refreshTokenHash: hash(rawRefreshToken), userAgent: metadata.userAgent, ip: metadata.ip }
  authStore.sessions.push(session)
  await writeStore()
  return { accessToken: issueAccessToken(authStore.username, session.id), refreshToken: rawRefreshToken, expiresIn: ACCESS_TTL_SECONDS, user: getAuthUser(authStore.username), sessionId: session.id }
}
function findSession(refreshToken: string) {
  if (!store) return null
  return store.sessions.find((session) => safeEqual(session.refreshTokenHash, hash(refreshToken)) && Date.parse(session.expiresAt) > now()) || null
}
export async function refresh(refreshToken: string, metadata: { userAgent?: string; ip?: string } = {}) {
  await initializeAuthStore()
  const authStore = requireStore()
  const session = findSession(refreshToken)
  if (!session) throw new AuthError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN')
  const timestamp = now()
  const nextRefreshToken = randomBytes(48).toString('base64url')
  session.refreshTokenHash = hash(nextRefreshToken)
  session.lastUsedAt = toIso(timestamp)
  if (metadata.userAgent) session.userAgent = metadata.userAgent
  if (metadata.ip) session.ip = metadata.ip
  await writeStore()
  return { accessToken: issueAccessToken(authStore.username, session.id), refreshToken: nextRefreshToken, expiresIn: ACCESS_TTL_SECONDS, user: getAuthUser(authStore.username), sessionId: session.id }
}
export async function logout(refreshToken?: string, sessionId?: string) {
  await initializeAuthStore()
  if (!store) return
  if (refreshToken) store.sessions = store.sessions.filter((session) => !safeEqual(session.refreshTokenHash, hash(refreshToken)))
  else if (sessionId) store.sessions = store.sessions.filter((session) => session.id !== sessionId)
  await writeStore()
}
export async function listSessions() {
  await initializeAuthStore()
  return store?.sessions.map(({ refreshTokenHash: _refreshTokenHash, ...session }) => session) || []
}
export async function deleteSession(sessionId: string) {
  await initializeAuthStore()
  if (!store) return false
  const count = store.sessions.length
  store.sessions = store.sessions.filter((session) => session.id !== sessionId)
  if (store.sessions.length !== count) await writeStore()
  return store.sessions.length !== count
}
export async function changePassword(currentPassword: string, newPassword: string) {
  await initializeAuthStore()
  const authStore = requireStore()
  if (!verifyPassword(currentPassword, authStore.passwordHash)) throw new AuthError('Invalid password', 401, 'INVALID_CREDENTIALS')
  if (newPassword.length < 8 || newPassword.length > 256) throw new AuthError('Password must be 8 to 256 characters', 400, 'INVALID_PASSWORD')
  authStore.passwordHash = createPasswordHash(newPassword)
  authStore.sessions = []
  accessTokens.clear()
  await writeStore()
}
export async function issueWebSocketTicket(accessToken: string) {
  await initializeAuthStore()
  const payload = getValidAccessToken(accessToken)
  if (!payload) throw new AuthError('Invalid access token')
  const ticket = randomBytes(32).toString('base64url')
  wsTickets.set(ticket, { username: payload.username, sessionId: payload.sessionId, expiresAt: now() + WS_TICKET_TTL_SECONDS * 1000 })
  return { ticket, expiresIn: WS_TICKET_TTL_SECONDS }
}
export function consumeWebSocketTicket(ticket: string): AuthUser | null {
  const entry = wsTickets.get(ticket)
  if (!entry || entry.expiresAt <= now()) {
    wsTickets.delete(ticket)
    return null
  }
  if (!store?.sessions.some((session) => session.id === entry.sessionId && Date.parse(session.expiresAt) > now())) {
    wsTickets.delete(ticket)
    return null
  }
  wsTickets.delete(ticket)
  return getAuthUser(entry.username)
}
