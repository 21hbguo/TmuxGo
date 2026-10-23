import Fastify from 'fastify'
import { ZodError } from 'zod'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { existsSync } from 'fs'
import path from 'path'
import { applyTmuxGoEnv, cleanupMultiplexSockets } from './lib/tmux-executor.js'
import { hostRoutes } from './routes/hosts.js'
import { sessionRoutes } from './routes/sessions.js'
import { windowRoutes } from './routes/windows.js'
import { streamRoutes } from './routes/stream.js'
import { vncRoutes } from './routes/vnc.js'
import { browserRoutes } from './routes/browser.js'
import { systemRoutes } from './routes/system.js'
import { paneRoutes } from './routes/panes.js'
import { syncPaneRoutes } from './routes/sync-panes.js'
import { fileRoutes } from './routes/files.js'
import { preferencesRoutes } from './routes/preferences.js'
import { clientEventRoutes } from './routes/client-events.js'
import { gitRoutes } from './routes/git.js'
import { isRequestOriginAllowed } from './lib/request-origin.js'
import { auditRoutes } from './routes/audit.js'
import { recordAuditRequest } from './lib/audit-log.js'
import { isAuthExemptPath } from './lib/auth-exempt.js'
import { assertListenSafety } from './lib/startup-guards.js'
import { createShutdownSequence } from './lib/shutdown-sequence.js'
import { describeZodError } from './lib/request-validation.js'
import { templateRoutes } from './routes/templates.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { sessionArchiveRoutes } from './routes/session-archives.js'
import { pluginRoutes } from './routes/plugins.js'
import { pluginManager } from './lib/plugin-manager.js'
import { createFastifyLoggerConfig } from './lib/process-log.js'
import { authRoutes } from './routes/auth.js'
import { shareRoutes } from './routes/shares.js'
import { authenticateHttpRequest, initializeAuthStore, isAuthEnabled, isPasswordChangeRequired } from './lib/auth.js'
import { accessScopeGuard } from './lib/access-scope.js'
import { agentManager } from './agent-manager.js'
import { agentMonitor } from './lib/agent-monitor.js'
import { agentEventRoutes } from './routes/agent-events.js'
import { agentNotificationRoutes } from './routes/agent-notifications.js'
import { agentControlRoutes } from './routes/agent-control.js'
import { agentRecoveryRoutes } from './routes/agent-recovery.js'
import { agentPushRoutes } from './routes/agent-push.js'
import { inboxRoutes } from './routes/inbox.js'
import { endpointsRoutes } from './routes/endpoints.js'
import { inboxPublicRoutes } from './routes/inbox-public.js'
import { agentRoutes } from './routes/agents.js'
import {
  detectTmuxVersion,
  getSecurityWarnings,
  isEncryptedTransportConfigured,
  isInsecureModeAllowed,
} from './lib/security.js'

const fastify = Fastify({
  logger: createFastifyLoggerConfig(),
})
await initializeAuthStore()
fastify.addHook('onRequest', async (request, reply) => {
  const forwardedHost = request.headers['x-forwarded-host']
  if (
    isRequestOriginAllowed(
      request.headers.origin,
      request.headers.host,
      undefined,
      typeof forwardedHost === 'string' ? forwardedHost : undefined,
      request.ip,
    )
  )
    return
  return reply.code(403).send({ message: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' })
})
fastify.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') return
  if (!isAuthEnabled()) return
  const routePath = request.url.split('?')[0]
  if (isAuthExemptPath(routePath)) return
  const payload = authenticateHttpRequest(request)
  if (!payload) return reply.code(401).send({ message: 'Authentication required', code: 'AUTH_REQUIRED' })
  if (isPasswordChangeRequired() && routePath !== '/api/auth/change-password')
    return reply.code(403).send({ message: 'Password change is required', code: 'PASSWORD_CHANGE_REQUIRED' })
})
// host/session scope（Task16）：preHandler 阶段 body 已解析，可统一抽取 params/query/body
// 里的 host/session 目标做判定；受限身份越权一律 403 且不回显资源信息
fastify.addHook('preHandler', accessScopeGuard)
fastify.addHook('onSend', recordAuditRequest)
fastify.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError)
    return reply.code(400).send({
      message: describeZodError(error),
      code: 'INVALID_REQUEST',
    })
  return reply.send(error)
})

await fastify.register(cors, {
  origin: true,
  credentials: true,
})

await fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 20,
  },
})
await fastify.register(websocket)

await fastify.register(authRoutes, { prefix: '/api' })
await fastify.register(shareRoutes, { prefix: '/api' })
await fastify.register(hostRoutes, { prefix: '/api' })
await fastify.register(sessionRoutes, { prefix: '/api' })
await fastify.register(windowRoutes, { prefix: '/api' })
await fastify.register(streamRoutes, { prefix: '/api' })
await fastify.register(vncRoutes, { prefix: '/api' })
await fastify.register(browserRoutes, { prefix: '/api' })
await fastify.register(systemRoutes, { prefix: '/api' })
await fastify.register(paneRoutes, { prefix: '/api' })
await fastify.register(syncPaneRoutes, { prefix: '/api' })
await fastify.register(fileRoutes, { prefix: '/api' })
await fastify.register(preferencesRoutes, { prefix: '/api' })
await fastify.register(clientEventRoutes, { prefix: '/api' })
await fastify.register(gitRoutes, { prefix: '/api' })
await fastify.register(auditRoutes, { prefix: '/api' })
await fastify.register(templateRoutes, { prefix: '/api' })
await fastify.register(workspaceRoutes, { prefix: '/api' })
await fastify.register(sessionArchiveRoutes, { prefix: '/api' })
await fastify.register(pluginRoutes, { prefix: '/api' })
await fastify.register(agentEventRoutes, { prefix: '/api' })
await fastify.register(agentNotificationRoutes, { prefix: '/api' })
await fastify.register(agentControlRoutes, { prefix: '/api' })
await fastify.register(agentRecoveryRoutes, { prefix: '/api' })
await fastify.register(agentPushRoutes, { prefix: '/api' })
await fastify.register(inboxRoutes, { prefix: '/api' })
await fastify.register(endpointsRoutes, { prefix: '/api' })
// 收件箱附件公开分享下载（/s/i/:token）：刻意不带 /api 前缀以绕开登录 hook，
// 自身用不可猜 token + 有效期 + 撤销做访问控制
await fastify.register(inboxPublicRoutes)
await fastify.register(agentRoutes, { prefix: '/api' })

const frontendDist = process.env.TMUXGO_FRONTEND_DIST || path.resolve(process.cwd(), '../frontend/dist')
if (existsSync(frontendDist)) {
  await fastify.register(fastifyStatic, {
    root: frontendDist,
    prefix: '/',
    setHeaders(res, filePath) {
      const normalized = filePath.replace(/\\/g, '/')
      if (normalized.endsWith('/sw.js')) {
        res.header('Cache-Control', 'no-cache')
        return
      }
      if (normalized.includes('/fonts/') || /\.(?:woff2?|ttf|otf)$/i.test(normalized)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable')
        return
      }
      if (/\.(?:js|css|svg|png|jpg|jpeg|gif|webp|ico|map)$/i.test(normalized)) {
        res.header('Cache-Control', 'public, max-age=604800')
        return
      }
      if (normalized.endsWith('/index.html') || normalized.endsWith('index.html')) {
        res.header('Cache-Control', 'no-cache')
      }
    },
  })
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      reply.header('Cache-Control', 'no-cache')
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ message: 'Not found' })
  })
}

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3001')
    const host = process.env.TMUXGO_HOST?.trim() || '127.0.0.1'
    const warnings = getSecurityWarnings({
      host,
      authEnabled: isAuthEnabled(),
      encryptedTransport: isEncryptedTransportConfigured(),
      tmuxVersion: await detectTmuxVersion(),
      passwordChangeRequired: isPasswordChangeRequired(),
    })
    warnings.forEach((warning) => console.warn(`[security] ${warning}`))
    assertListenSafety({
      host,
      authEnabled: isAuthEnabled(),
      passwordChangeRequired: isPasswordChangeRequired(),
      insecureModeAllowed: isInsecureModeAllowed(),
    })
    await fastify.listen({ port, host })
    void agentMonitor.start()
    // token 轮换/重启后 tmux 全局环境仍是旧值：启动时重断言 setenv -g，
    // 之后新建的 pane 才能继承当前 token（既有 pane 保留各自快照）
    applyTmuxGoEnv('local', {}).catch(() => {})
    console.log(`Gateway listening on ${host}:${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()

const shutdown = createShutdownSequence({
  logWarn: (message) => fastify.log.warn(message),
  logError: (error) => fastify.log.error(error),
  stopMonitor: () => agentMonitor.stop(),
  unregisterAgents: (reason) => agentManager.unregisterAll(reason),
  terminateWebSockets: () =>
    fastify.websocketServer.clients.forEach((socket: { terminate: () => void }) => socket.terminate()),
  shutdownPlugins: () => pluginManager.shutdown(),
  cleanupSockets: () => cleanupMultiplexSockets(),
  closeServer: () => fastify.close(),
  exit: (code) => process.exit(code),
})
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
