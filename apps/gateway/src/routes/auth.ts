import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  AuthError,
  changePassword,
  deleteOtherSessions,
  deleteSession,
  getAccessCookieName,
  getAccessTokenTtl,
  getAuthUsername,
  getRefreshCookieName,
  initializeAuthStore,
  isAuthEnabled,
  isPasswordChangeRequired,
  issueScopedWebSocketTicket,
  issueWebSocketTicket,
  listSessions,
  login,
  logout,
  refresh,
  verifyAccessToken,
} from '../lib/auth.js'
import {
  createScopedApiToken,
  listScopedApiTokens,
  revokeScopedApiToken,
  verifyScopedApiToken,
} from '../lib/access-scope.js'

type AuthBody = Record<string, unknown>
function body(request: FastifyRequest) {
  return (request.body && typeof request.body === 'object' ? request.body : {}) as AuthBody
}
function requiredString(value: unknown, field: string, min = 1, max = 4096) {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    throw new AuthError(`${field} is invalid`, 400, 'INVALID_REQUEST')
  return value
}
function bearer(request: FastifyRequest) {
  const value = request.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}
function cookieValue(request: FastifyRequest, name: string) {
  const header = request.headers.cookie || ''
  const prefix = `${name}=`
  return (
    header
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length) || ''
  )
}
function cookie(request: FastifyRequest) {
  return cookieValue(request, getRefreshCookieName())
}
function currentSessionId(request: FastifyRequest) {
  const payload = verifyAccessToken(bearer(request) || cookieValue(request, getAccessCookieName()))
  if (!payload) throw new AuthError('Authentication required', 401, 'AUTH_REQUIRED')
  return payload.sessionId
}
function setAuthCookies(request: FastifyRequest, reply: FastifyReply, accessToken: string, refreshToken: string) {
  const forwardedProto = request.headers['x-forwarded-proto']
  const secure =
    request.protocol === 'https' ||
    (typeof forwardedProto === 'string' && forwardedProto.split(',')[0]?.trim() === 'https')
  reply.header('set-cookie', [
    `${getAccessCookieName()}=${accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${getAccessTokenTtl()}${secure ? '; Secure' : ''}`,
    `${getRefreshCookieName()}=${refreshToken}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
  ])
}
function clearAuthCookies(request: FastifyRequest, reply: FastifyReply) {
  const forwardedProto = request.headers['x-forwarded-proto']
  const secure =
    request.protocol === 'https' ||
    (typeof forwardedProto === 'string' && forwardedProto.split(',')[0]?.trim() === 'https')
  reply.header('set-cookie', [
    `${getAccessCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
    `${getRefreshCookieName()}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
  ])
}
function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return reply.code(error.statusCode).send({ message: error.message, code: error.code })
  return reply
    .code(400)
    .send({ message: error instanceof Error ? error.message : String(error), code: 'INVALID_REQUEST' })
}
export async function authRoutes(fastify: FastifyInstance) {
  await initializeAuthStore()
  fastify.get('/auth/status', async (request) => {
    if (!isAuthEnabled()) return { enabled: false, authenticated: true }
    const token = bearer(request) || cookieValue(request, getAccessCookieName())
    const payload = token ? verifyAccessToken(token) : null
    return {
      enabled: true,
      authenticated: !!payload,
      username: getAuthUsername(),
      sessionId: payload?.sessionId,
      passwordChangeRequired: !!payload && isPasswordChangeRequired(),
    }
  })
  fastify.post('/auth/login', async (request, reply) => {
    try {
      const input = body(request)
      const result = await login(
        requiredString(input.username, 'username', 1, 128),
        requiredString(input.password, 'password', 1, 256),
        { userAgent: request.headers['user-agent'], ip: request.ip },
      )
      setAuthCookies(request, reply, result.accessToken, result.refreshToken)
      return result
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/auth/refresh', async (request, reply) => {
    try {
      const input = body(request)
      const result = await refresh(typeof input.refreshToken === 'string' ? input.refreshToken : cookie(request), {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })
      setAuthCookies(request, reply, result.accessToken, result.refreshToken)
      return result
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/auth/logout', async (request, reply) => {
    try {
      const input = body(request)
      const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken : cookie(request)
      if (refreshToken) await logout(refreshToken)
      else await logout(undefined, currentSessionId(request))
      clearAuthCookies(request, reply)
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.get('/auth/sessions', async (request, reply) => {
    try {
      return { sessions: await listSessions(), currentSessionId: currentSessionId(request) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.delete('/auth/sessions/:id', async (request, reply) => {
    try {
      const params = request.params as { id?: string }
      if (!params.id) throw new AuthError('id is invalid', 400, 'INVALID_REQUEST')
      const currentId = currentSessionId(request)
      const deleted = await deleteSession(params.id)
      if (params.id === currentId) clearAuthCookies(request, reply)
      return { deleted, current: params.id === currentId }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/auth/sessions/revoke-others', async (request, reply) => {
    try {
      return { deleted: await deleteOtherSessions(currentSessionId(request)) }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/auth/change-password', async (request, reply) => {
    try {
      const input = body(request)
      await changePassword(
        requiredString(input.currentPassword, 'currentPassword', 1, 256),
        requiredString(input.newPassword, 'newPassword', 8, 256),
      )
      clearAuthCookies(request, reply)
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.post('/auth/ws-ticket', async (request, reply) => {
    try {
      const accessToken = body(request).accessToken
      const candidates = [
        bearer(request),
        cookieValue(request, getAccessCookieName()),
        typeof accessToken === 'string' ? accessToken : '',
      ]
      const token = candidates.find((candidate) => verifyAccessToken(candidate))
      if (token) return await issueWebSocketTicket(token)
      // scoped API token 也走同一票据入口：ticket 携带其 scope，WS/HTTP 身份一致
      const scoped = candidates.map((candidate) => (candidate ? verifyScopedApiToken(candidate) : null)).find(Boolean)
      if (scoped) return await issueScopedWebSocketTicket(scoped.name, scoped.scope)
      throw new AuthError('Authentication required', 401, 'AUTH_REQUIRED')
    } catch (error) {
      return sendError(reply, error)
    }
  })
  // scoped API token 管理：仅全权身份可达（受限身份被 accessScopeGuard 挡在
  // /api/auth/tokens 前）。token 原文只在创建响应里出现一次，落盘仅存哈希
  fastify.get('/auth/tokens', async () => ({ tokens: listScopedApiTokens() }))
  fastify.post('/auth/tokens', async (request, reply) => {
    try {
      const input = body(request)
      const name = requiredString(input.name, 'name', 1, 80)
      const scope = input.scope as Record<string, unknown> | undefined
      const expiresInMinutes = Number(input.expiresInMinutes)
      const expiresAt =
        Number.isFinite(expiresInMinutes) && expiresInMinutes > 0
          ? new Date(Date.now() + expiresInMinutes * 60000).toISOString()
          : undefined
      const { token, record } = createScopedApiToken({ name, scope, expiresAt })
      return { ...record, token }
    } catch (error) {
      return sendError(reply, error)
    }
  })
  fastify.delete('/auth/tokens/:id', async (request, reply) => {
    const { id } = request.params as { id?: string }
    if (!id || !revokeScopedApiToken(id))
      return reply.code(404).send({ message: 'Token not found', code: 'TOKEN_NOT_FOUND' })
    return { ok: true }
  })
}
