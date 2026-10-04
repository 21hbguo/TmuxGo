import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { appendAuditEvent } from './audit-log.js'
import { describeScope, getRequestPrincipal, type RequestPrincipal } from './principal.js'

// host/session 最小权限模型（Task16）：
//   principal.scope 缺失 = 全权（本机 admin/未开鉴权部署，行为与旧版完全一致）；
//   scope 存在即受限身份，按 hosts/sessions/readOnly 逐请求判定。
// 权限来源集中在 TMUXGO_CONFIG_DIR/access-scopes.json：
//   subjects["user:<name>"]  覆盖登录用户的默认全权 scope
//   subjects["agent"]        覆盖 agent event token 的默认全权 scope
//   tokens[]                 长期 API token（哈希落盘），签发即绑定 scope——
//                            多用户部署时 admin 给成员发受限 token，不复用第二套身份
// 文件缺失/为空 = 没有任何受限身份，单用户行为不变。
export interface AccessScope {
  hosts: '*' | string[]
  sessions?: '*' | string[]
  readOnly?: boolean
}
export interface ScopedApiToken {
  id: string
  name: string
  tokenHash: string
  scope: AccessScope
  createdAt: string
  expiresAt?: string
  revokedAt?: string | null
}
interface AccessScopeConfig {
  version: 1
  subjects: Record<string, AccessScope>
  tokens: ScopedApiToken[]
}
const SUBJECT_NAME = /^[A-Za-z0-9._:-]{1,80}$/
const HOST_ID = /^[A-Za-z0-9._-]{1,64}$/
const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/
const SCOPED_TOKEN_PREFIX = 'tgk_'

function accessScopePath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo'), 'access-scopes.json')
}
function text(value: unknown, max = 128) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : ''
}
function normalizeScope(raw: unknown): AccessScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const list = (value: unknown, pattern: RegExp, limit = 64): string[] | null => {
    if (value === undefined) return null
    if (!Array.isArray(value)) return null
    const items = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item && pattern.test(item))
    return items.slice(0, limit)
  }
  const hosts = input.hosts === '*' ? '*' : list(input.hosts, HOST_ID)
  if (!hosts || (Array.isArray(hosts) && !hosts.length)) return null
  const sessions = input.sessions === '*' ? '*' : list(input.sessions, SESSION_NAME)
  if (sessions && Array.isArray(sessions) && !sessions.length) return null
  const scope: AccessScope = { hosts }
  if (sessions) scope.sessions = sessions
  if (input.readOnly === true) scope.readOnly = true
  return scope
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
export function loadAccessScopeConfig(): AccessScopeConfig {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(accessScopePath(), 'utf8')) as Record<string, unknown>
  } catch {
    return { version: 1, subjects: {}, tokens: [] }
  }
  const subjects: Record<string, AccessScope> = {}
  for (const [key, value] of Object.entries((parsed.subjects as Record<string, unknown>) || {})) {
    const scope = normalizeScope(value)
    if (SUBJECT_NAME.test(key) && scope) subjects[key] = scope
  }
  const tokens: ScopedApiToken[] = []
  for (const item of (parsed.tokens as unknown[]) || []) {
    const raw = item as Partial<ScopedApiToken>
    const scope = normalizeScope(raw?.scope)
    if (
      typeof raw?.id === 'string' &&
      typeof raw.name === 'string' &&
      typeof raw.tokenHash === 'string' &&
      typeof raw.createdAt === 'string' &&
      scope
    )
      tokens.push({
        id: raw.id,
        name: raw.name,
        tokenHash: raw.tokenHash,
        scope,
        createdAt: raw.createdAt,
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
        revokedAt: typeof raw.revokedAt === 'string' ? raw.revokedAt : null,
      })
  }
  return { version: 1, subjects, tokens }
}
function persistAccessScopeConfig(config: AccessScopeConfig) {
  const filePath = accessScopePath()
  const directory = path.dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, filePath)
  chmodSync(filePath, 0o600)
}
// 既有凭证的 scope 覆盖；未配置返回 undefined = 保持既有全权行为
export function subjectScope(subject: string): AccessScope | undefined {
  return loadAccessScopeConfig().subjects[subject]
}
export function createScopedApiToken(input: { name: string; scope: unknown; expiresAt?: string }): {
  token: string
  record: Omit<ScopedApiToken, 'tokenHash'>
} {
  const name = input.name.trim()
  if (!SUBJECT_NAME.test(name) || name.includes(':')) throw new Error('Invalid token name')
  const scope = normalizeScope(input.scope)
  if (!scope) throw new Error('Invalid token scope')
  const config = loadAccessScopeConfig()
  const token = `${SCOPED_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const record: ScopedApiToken = {
    id: randomUUID(),
    name,
    tokenHash: hash(token),
    scope,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    revokedAt: null,
  }
  config.tokens.push(record)
  persistAccessScopeConfig(config)
  const { tokenHash: _tokenHash, ...publicRecord } = record
  return { token, record: publicRecord }
}
export function listScopedApiTokens(): Omit<ScopedApiToken, 'tokenHash'>[] {
  return loadAccessScopeConfig().tokens.map(({ tokenHash: _tokenHash, ...rest }) => rest)
}
export function revokeScopedApiToken(id: string) {
  const config = loadAccessScopeConfig()
  const entry = config.tokens.find((item) => item.id === id)
  if (!entry) return false
  if (!entry.revokedAt) {
    entry.revokedAt = new Date().toISOString()
    persistAccessScopeConfig(config)
  }
  return true
}
export function verifyScopedApiToken(token: string): { name: string; scope: AccessScope } | null {
  if (typeof token !== 'string' || !token.startsWith(SCOPED_TOKEN_PREFIX)) return null
  const tokenHash = hash(token)
  for (const entry of loadAccessScopeConfig().tokens) {
    const matched =
      entry.tokenHash.length === tokenHash.length &&
      timingSafeEqual(Buffer.from(entry.tokenHash), Buffer.from(tokenHash))
    if (!matched) continue
    if (entry.revokedAt) return null
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) return null
    return { name: entry.name, scope: entry.scope }
  }
  return null
}

// scope 判定：scope 存在且任一维度受限才算受限身份（{hosts:'*'} 等价全权）
export function scopeIsRestricted(scope: AccessScope | undefined): boolean {
  return (
    !!scope &&
    (scope.hosts !== '*' || scope.readOnly === true || (scope.sessions !== undefined && scope.sessions !== '*'))
  )
}
export function scopeAllowsHost(scope: AccessScope, hostId: string) {
  return scope.hosts === '*' || scope.hosts.includes(hostId)
}
export function scopeAllowsSession(scope: AccessScope, hostId: string, sessionName: string) {
  return (
    scopeAllowsHost(scope, hostId) &&
    (scope.sessions === undefined || scope.sessions === '*' || scope.sessions.includes(sessionName))
  )
}

// 受限身份禁入的实例管理面（不区分资源存在与否，一律 403）。
// 注意 /api/hosts/:hostId/<资源> 是 host 作用域路由，不在此列
const ADMIN_ONLY_PREFIXES = [
  '/api/auth/sessions',
  '/api/auth/change-password',
  '/api/auth/tokens',
  '/api/audit-log',
  '/api/system',
  '/api/plugins',
  '/api/inbox',
  '/api/shares',
  '/api/agents',
  '/api/browser',
  '/api/client-events',
  '/api/agent-notifications',
  '/api/hosts/config',
  '/api/hosts/ssh-config',
  // 实例级状态：workspaces/preferences/templates 内嵌 hostId 或跨 host 语义，
  // 放开会泄露 host 清单（等价于绕过 GET /hosts 过滤）
  '/api/workspaces',
  '/api/preferences',
  '/api/session-templates',
]
// /api/hosts 本身（增删 host）与 :id 直属的管理/凭据子路径
const HOST_ADMIN_EXACT = /^\/api\/hosts(?:\/[A-Za-z0-9._-]{1,64})?$/
const HOST_ADMIN_SUBPATH = /^\/api\/hosts\/[A-Za-z0-9._-]{1,64}\/(?:vnc|test|test-tasks|resolve|github)(?:\/|$)/

function hostFromPrefixedId(value: unknown, marker: RegExp) {
  const raw = text(value, 256)
  const separator = raw.indexOf(':')
  if (separator <= 0) return ''
  const hostId = raw.slice(0, separator)
  return HOST_ID.test(hostId) && marker.test(raw.slice(separator + 1)) ? hostId : ''
}
// session 引用解析与 parseSessionRef 同语义：session-<host>-<name> 优先按路由 hostId
// 前缀拆，失配按 local 兼容名拆；无法解析的交给路由自身校验（不算绕过）
function sessionRefTargets(ref: string, routeHostId: string, hosts: Set<string>, sessions: Map<string, Set<string>>) {
  const add = (hostId: string, sessionName: string) => {
    if (!HOST_ID.test(hostId) || !SESSION_NAME.test(sessionName)) return
    hosts.add(hostId)
    const set = sessions.get(hostId) || new Set<string>()
    set.add(sessionName)
    sessions.set(hostId, set)
  }
  const value = ref.trim()
  if (!value) return
  if (value.startsWith('session-')) {
    const expected = `session-${routeHostId}-`
    if (routeHostId && value.startsWith(expected)) return add(routeHostId, value.slice(expected.length))
    if (routeHostId === 'local' || !routeHostId) return add('local', value.slice('session-'.length))
    // 路由 host 与 sessionId 前缀不一致：scope 按 sessionId 声明的 host 判定
    const rest = value.slice('session-'.length)
    const separator = rest.indexOf('-')
    if (separator > 0) return add(rest.slice(0, separator), rest.slice(separator + 1))
    return
  }
  add(routeHostId || 'local', value)
}
// 从 params/query/body 收集请求声明的 host 与 (host, session) 目标；
// 只做保守抽取—— malformed 值跳过，留给路由自身校验报错
export function collectScopeTargets(request: FastifyRequest) {
  const routePath = (request.routeOptions.url || request.url.split('?')[0]).replace(/^\/api/, '')
  const params = (request.params || {}) as Record<string, unknown>
  const query = (request.query || {}) as Record<string, unknown>
  const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const hosts = new Set<string>()
  const sessions = new Map<string, Set<string>>()
  const addHost = (value: unknown) => {
    const hostId = text(value, 64)
    if (HOST_ID.test(hostId)) hosts.add(hostId)
  }
  const addSession = (hostId: string, value: unknown) => sessionRefTargets(text(value, 256), hostId, hosts, sessions)
  const addSessionList = (hostId: string, value: unknown) => {
    if (Array.isArray(value)) for (const item of value) addSession(hostId, item)
    else if (value !== undefined) addSession(hostId, value)
  }
  const paramHost = text(params.hostId, 64)
  if (paramHost) addHost(paramHost)
  // /hosts/:id 与 /agents/:id 的 :id 即 hostId；其余路由的 :id 不是 host 维度
  if (/^\/hosts\/[^/]+/.test(routePath) || /^\/agents\//.test(routePath)) addHost(params.id)
  for (const source of [params, query, body]) {
    const hostId = text(source.hostId, 64)
    if (hostId) addHost(hostId)
    const paneId = hostFromPrefixedId(source.paneId, /^%/)
    if (paneId) addHost(paneId)
    const windowId = hostFromPrefixedId(source.windowId, /^@/)
    if (windowId) addHost(windowId)
  }
  if (Array.isArray(body.orderedWindowIds))
    for (const item of body.orderedWindowIds) {
      const hostId = hostFromPrefixedId(item, /^@/)
      if (hostId) addHost(hostId)
    }
  const fallbackHost = paramHost || text(body.hostId, 64) || text(query.hostId, 64) || 'local'
  for (const source of [params, query, body]) {
    addSessionList(fallbackHost, source.sessionId)
    addSessionList(fallbackHost, source.sessionIds)
    if (source.sessionName !== undefined) addSession(fallbackHost, source.sessionName)
  }
  // session 创建：新 session 名即 scope 对象
  if (/^\/hosts\/[^/]+\/sessions$/.test(routePath) && request.method === 'POST') addSession(fallbackHost, body.name)
  // agent wait target / inbox 路由体内嵌套 host+session
  const target = body.target as Record<string, unknown> | undefined
  if (target && typeof target === 'object') {
    const paneHost = hostFromPrefixedId(target.paneId, /^%/)
    if (paneHost) addHost(paneHost)
    if (target.sessionName !== undefined) addSession(text(body.hostId, 64) || 'local', target.sessionName)
  }
  const route = body.route as Record<string, unknown> | undefined
  if (route && typeof route === 'object' && route.hostId !== undefined) addHost(route.hostId)
  return { hosts, sessions }
}
// 受限身份的 scope 判定：返回拒绝原因（仅进审计，不外发）；null = 放行
export function scopeDenyReason(
  scope: AccessScope | undefined,
  request: FastifyRequest,
): { reason: string; hostId?: string } | null {
  if (!scopeIsRestricted(scope)) return null
  const routePath = request.url.split('?')[0]
  if (!routePath.startsWith('/api/') || request.method === 'OPTIONS') return null
  if (
    ADMIN_ONLY_PREFIXES.some((prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`)) ||
    (HOST_ADMIN_EXACT.test(routePath) && request.method !== 'GET' && request.method !== 'HEAD') ||
    HOST_ADMIN_SUBPATH.test(routePath)
  )
    return { reason: 'admin-only' }
  if (scope!.readOnly && !['GET', 'HEAD'].includes(request.method)) return { reason: 'read-only' }
  const { hosts, sessions } = collectScopeTargets(request)
  for (const hostId of hosts) if (!scopeAllowsHost(scope!, hostId)) return { reason: 'host', hostId }
  for (const [hostId, names] of sessions)
    for (const name of names) if (!scopeAllowsSession(scope!, hostId, name)) return { reason: 'session', hostId }
  return null
}
// 请求 principal → scope：scoped token 自带 scope；http 用户/agent token 走 subjects 覆盖
export function resolvePrincipalScope(principal: RequestPrincipal): AccessScope | undefined {
  if (principal.scope) return principal.scope
  if (principal.source === 'http' && principal.actor) return subjectScope(`user:${principal.actor}`)
  if (principal.source === 'agent-token') return subjectScope('agent')
  return undefined
}
// 全局 preHandler：统一 403 文案不回显 target，不泄露资源存在性；deny 决策落审计
export async function accessScopeGuard(request: FastifyRequest, reply: FastifyReply) {
  const principal = getRequestPrincipal(request)
  const scope = resolvePrincipalScope(principal)
  // 解析结果写回 principal：惰性派生的身份（agent-token）也要固化 scope，
  // 路由内过滤（如 GET /hosts）与审计读到的必须是同一份判定依据
  if (scope) request.principal = { ...principal, scope }
  const deny = scopeDenyReason(scope, request)
  if (!deny) return
  void appendAuditEvent({
    id: `${Date.now().toString(36)}-scope-${request.id}`,
    timestamp: new Date().toISOString(),
    user: principal.actor,
    actor: principal.actor,
    source: principal.source,
    action: 'scope.deny',
    target: request.url.split('?')[0],
    result: 'failure',
    method: request.method,
    statusCode: 403,
    hostId: deny.hostId,
    message: `${deny.reason}${scope ? ` ${describeScope(scope)}` : ''}`,
  }).catch(() => {})
  return reply.code(403).send({ message: 'Forbidden', code: 'SCOPE_DENIED' })
}
