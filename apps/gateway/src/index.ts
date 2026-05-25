import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { hostRoutes } from './routes/hosts.js'
import { sessionRoutes } from './routes/sessions.js'
import { windowRoutes } from './routes/windows.js'
import { streamRoutes } from './routes/stream.js'
import { systemRoutes } from './routes/system.js'
import { paneRoutes } from './routes/panes.js'

const fastify = Fastify({
  logger: true,
})

await fastify.register(cors, {
  origin: true,
})

await fastify.register(websocket)

await fastify.register(hostRoutes, { prefix: '/api' })
await fastify.register(sessionRoutes, { prefix: '/api' })
await fastify.register(windowRoutes, { prefix: '/api' })
await fastify.register(streamRoutes, { prefix: '/api' })
await fastify.register(systemRoutes, { prefix: '/api' })
await fastify.register(paneRoutes, { prefix: '/api' })

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
