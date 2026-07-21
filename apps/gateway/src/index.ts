import Fastify from 'fastify'
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

const fastify = Fastify({
  logger: process.env.NODE_ENV === 'production' ? { level: 'warn' } : true,
})
fastify.addHook('onRequest', async (request, reply) => {
  const forwardedHost = request.headers['x-forwarded-host']
  if (isRequestOriginAllowed(request.headers.origin, request.headers.host, undefined, typeof forwardedHost === 'string' ? forwardedHost : undefined, request.ip)) return
  return reply.code(403).send({ message: 'Origin is not allowed', code: 'ORIGIN_NOT_ALLOWED' })
})
fastify.addHook('onSend', recordAuditRequest)

await fastify.register(cors, {
  origin: true,
})

await fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 20,
  },
})
await fastify.register(websocket)

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
  await fastify.register(fastifyStatic, { root: frontendDist, prefix: '/' })
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) return reply.sendFile('index.html')
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
