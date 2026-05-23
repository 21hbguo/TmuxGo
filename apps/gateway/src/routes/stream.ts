import type { FastifyInstance } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import { agentManager } from '../agent-manager.js'

export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/stream', { websocket: true }, (connection: SocketStream) => {
    console.log('Client connected to stream')

    const paneOutputs: Map<string, string[]> = new Map()
    let agentId: string | null = null
    const socket = connection.socket

    function send(data: any) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data))
      }
    }

    function addToBuffer(paneId: string, data: string) {
      if (!paneOutputs.has(paneId)) {
        paneOutputs.set(paneId, [])
      }
      const buffer = paneOutputs.get(paneId)!
      buffer.push(data)
      if (buffer.length > 1000) {
        buffer.shift()
      }
    }

    socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString())
        console.log('Received:', data.type)

        switch (data.type) {
          case 'register':
            agentId = data.host.id
            agentManager.register(data.host.id, data.host.name, data.host.address, socket)
            send({
              type: 'registered',
              agentId: data.host.id,
            })
            break

          case 'input':
            addToBuffer(data.paneId, data.data)
            send({
              type: 'output',
              paneId: data.paneId,
              data: data.data,
            })
            break

          case 'sessions':
            send({
              type: 'sessions-list',
              sessions: data.sessions,
            })
            break

          case 'session-created':
            send({
              type: 'session-created',
              session: data.session,
            })
            break

          case 'split':
            send({
              type: 'pane-created',
              parentPaneId: data.paneId,
              direction: data.direction,
              newPaneId: `pane-${Date.now()}`,
            })
            break

          case 'close-pane':
            send({
              type: 'pane-closed',
              paneId: data.paneId,
            })
            break

          case 'resize':
            send({
              type: 'resized',
              paneId: data.paneId,
              cols: data.cols,
              rows: data.rows,
            })
            break

          case 'get-output':
            const output = paneOutputs.get(data.paneId) || []
            send({
              type: 'output-history',
              paneId: data.paneId,
              data: output.join(''),
            })
            break

          case 'ping':
            send({
              type: 'pong',
              timestamp: data.timestamp || Date.now(),
            })
            break

          default:
            send({
              type: 'error',
              message: `Unknown message type: ${data.type}`,
            })
        }
      } catch (err) {
        send({
          type: 'error',
          message: 'Invalid message format',
        })
      }
    })

    socket.on('close', () => {
      console.log('Client disconnected from stream')
      if (agentId) {
        agentManager.unregister(agentId)
      }
    })

    send({
      type: 'connected',
      timestamp: Date.now(),
    })
  })
}
