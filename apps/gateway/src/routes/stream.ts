import type { FastifyInstance } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { agentManager } from '../agent-manager.js'

const execFileAsync = promisify(execFile)

export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/stream', { websocket: true }, (connection: SocketStream) => {
    console.log('Client connected to stream')

    let ptyProcess: pty.IPty | null = null
    let agentId: string | null = null
    const socket = connection.socket

    function send(data: any) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data))
      }
    }

    function cleanup() {
      if (ptyProcess) {
        ptyProcess.kill()
        ptyProcess = null
      }
    }

    socket.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString())

        switch (data.type) {
          case 'register':
            agentId = data.host.id
            agentManager.register(data.host.id, data.host.name, data.host.address, socket)
            send({ type: 'registered', agentId: data.host.id })
            break

          case 'attach': {
            cleanup()
            const sessionName = data.sessionName
            const cols = data.cols || 80
            const rows = data.rows || 24

            ptyProcess = pty.spawn('tmux', ['attach', '-t', sessionName], {
              name: 'xterm-256color',
              cols,
              rows,
              env: { ...process.env, TERM: 'xterm-256color' },
            })

            ptyProcess.onData((output: string) => {
              send({ type: 'output', data: output })
            })

            ptyProcess.onExit(({ exitCode }) => {
              send({ type: 'session-exit', exitCode })
              ptyProcess = null
            })

            send({ type: 'attached', sessionName })
            break
          }

          case 'resize':
            if (ptyProcess) {
              ptyProcess.resize(data.cols, data.rows)
            }
            break

          case 'input':
            if (ptyProcess) {
              ptyProcess.write(data.data)
            }
            break

          case 'sessions':
            send({ type: 'sessions-list', sessions: data.sessions })
            break

          case 'session-created':
            send({ type: 'session-created', session: data.session })
            break

          case 'ping':
            send({ type: 'pong', timestamp: data.timestamp || Date.now() })
            break

          default:
            send({ type: 'error', message: `Unknown message type: ${data.type}` })
        }
      } catch (err) {
        send({ type: 'error', message: 'Invalid message format' })
      }
    })

    socket.on('close', () => {
      console.log('Client disconnected from stream')
      cleanup()
      if (agentId) {
        agentManager.unregister(agentId)
      }
    })

    send({ type: 'connected', timestamp: Date.now() })
  })
}
