import Fastify from 'fastify'
import { ZodError } from 'zod'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { existsSync } from 'fs'
import path from 'path'
import { cleanupMultiplexSockets } from './lib/tmux-executor.js'
import { hostRoutes } from './routes/hosts.js'
import { sessionRoutes } from './routes/sessions.js'
import { windowRoutes } from './routes/windows.js'
import { streamRoutes } from './routes/stream.js'
import { systemRoutes } from './routes/system.js'
import { paneRoutes } from './routes/panes.js'
import { fileRoutes } from './routes/files.js'
import { preferencesRoutes } from './routes/preferences.js'
import { clientEventRoutes } from './routes/client-events.js'
import { gitRoutes } from './routes/git.js'
import { isRequestOriginAllowed } from './lib/request-origin.js'
import { auditRoutes } from './routes/audit.js'
import { recordAuditRequest } from './lib/audit-log.js'
import { templateRoutes } from './routes/templates.js'
import { sessionArchiveRoutes } from './routes/session-archives.js'
import { pluginRoutes } from './routes/plugins.js'
import { pluginManager } from './lib/plugin-manager.js'
import { createFastifyLoggerConfig } from './lib/process-log.js'
import { authRoutes } from './routes/auth.js'
import { shareRoutes } from './routes/shares.js'
import { getAccessCookieName, initializeAuthStore, isAuthEnabled, isPasswordChangeRequired, verifyAccessToken } from './lib/auth.js'

const fastify = Fastify({
  logger: createFastifyLoggerConfig(),
})
await initializeAuthStore()
fastify.addHook('onRequest', async (request, reply) => {
  const forwardedHost = request.headers['x-forwarded-host']
  if (isRequestOriginAllowed(request.headers.origin, request.headers.host, undefined, typeof forwardedHost === 'string' ? forwardedHost : undefined, request.ip)) return
  return reply.code(403).send({ message: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' })
})
fastify.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') return
  if (!isAuthEnabled()) return
  const routePath = request.url.split('?')[0]
  if (!routePath.startsWith('/api/') || routePath === '/api/stream' || routePath === '/api/auth/status' || routePath === '/api/auth/login' || routePath === '/api/auth/refresh' || routePath === '/api/auth/logout' || routePath === '/api/shares/exchange') return
  const authorization = request.headers.authorization
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  const cookiePrefix = `${getAccessCookieName()}=`
  const cookieToken = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(cookiePrefix))?.slice(cookiePrefix.length) || ''
  const payload = verifyAccessToken(token) || verifyAccessToken(cookieToken)
  if (!payload) return reply.code(401).send({ message: 'Authentication required', code: 'AUTH_REQUIRED' })
  if (isPasswordChangeRequired() && routePath !== '/api/auth/change-password') return reply.code(403).send({ message: 'Password change is required', code: 'PASSWORD_CHANGE_REQUIRED' })
})
fastify.addHook('onSend', recordAuditRequest)
fastify.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ message: error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), code: 'INVALID_REQUEST' })
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
await fastify.register(systemRoutes, { prefix: '/api' })
await fastify.register(paneRoutes, { prefix: '/api' })
await fastify.register(fileRoutes, { prefix: '/api' })
await fastify.register(preferencesRoutes, { prefix: '/api' })
await fastify.register(clientEventRoutes, { prefix: '/api' })
await fastify.register(gitRoutes, { prefix: '/api' })
await fastify.register(auditRoutes, { prefix: '/api' })
await fastify.register(templateRoutes, { prefix: '/api' })
await fastify.register(sessionArchiveRoutes, { prefix: '/api' })
await fastify.register(pluginRoutes, { prefix: '/api' })

const frontendDist = process.env.TMUXGO_FRONTEND_DIST || path.resolve(process.cwd(), '../frontend/dist')
if (existsSync(frontendDist)) {
  await fastify.register(fastifyStatic, {
    root: frontendDist,
    prefix: '/',
    setHeaders(res, filePath) {
      const normalized = filePath.replace(/\\/g, '/')
      if (normalized.includes('/fonts/') || /\.(?:woff2?|ttf|otf)$/i.test(normalized)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        return
      }
      if (/\.(?:js|css|svg|png|jpg|jpeg|gif|webp|ico|map)$/i.test(normalized)) {
        res.setHeader('Cache-Control', 'public, max-age=604800')
        return
      }
      if (normalized.endsWith('/index.html') || normalized.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache')
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
    await fastify.listen({ port, host: '0.0.0.0' })
    console.log(`Gateway listening on port ${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()

const shutdown = async () => {
  await pluginManager.shutdown()
  await cleanupMultiplexSockets()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
