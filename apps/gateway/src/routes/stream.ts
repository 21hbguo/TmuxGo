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
    let outputCarry = ''
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
      outputCarry = ''
    }

    function sanitizeOutput(chunk: string) {
      const merged = outputCarry + chunk
      const cleaned = merged
        .replace(/\u001b\[[0-9;?]*c/g, '')
        .replace(/(?:\u001b\[)?\??(?:\d+;)+\d+c/g, '')
        .replace(/0;(?:\d+;)*\d+c/g, '')
      const trailingEsc = cleaned.match(/\u001b(?:\[[0-9;?]*)?$/)
      const trailingDigits = cleaned.match(/[0-9;]{0,32}c?$/)
      if (trailingEsc && trailingEsc[0] && trailingEsc[0].length < cleaned.length) {
        outputCarry = trailingEsc[0]
        return cleaned.slice(0, cleaned.length - trailingEsc[0].length)
      }
      if (trailingDigits && trailingDigits[0] && trailingDigits[0].includes(';') && trailingDigits[0].length < cleaned.length) {
        outputCarry = trailingDigits[0]
        return cleaned.slice(0, cleaned.length - trailingDigits[0].length)
      }
      outputCarry = ''
      return cleaned
    }

    async function getSessionWindowSize(sessionName: string) {
      try {
        const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', sessionName, '#{window_width}|#{window_height}'])
        const [colsText, rowsText] = stdout.trim().split('|')
        const cols = parseInt(colsText, 10)
        const rows = parseInt(rowsText, 10)
        if (cols > 0 && rows > 0) {
          return { cols, rows }
        }
      } catch (err) {
      }
      return null
    }
    async function enableMouse(sessionName: string) {
      try {
        await execFileAsync('tmux', ['set-option', '-t', sessionName, '-g', 'mouse', 'on'])
      } catch {}
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
            await enableMouse(sessionName)
            const requestedCols = data.cols || 80
            const requestedRows = data.rows || 24
            const exclusive = !!data.exclusive
            const sharedSize = exclusive ? null : await getSessionWindowSize(sessionName)
            const cols = sharedSize?.cols || requestedCols
            const rows = sharedSize?.rows || requestedRows
            const attachArgs = ['attach']
            if (exclusive) {
              attachArgs.push('-d')
            } else {
              attachArgs.push('-f', 'ignore-size,active-pane')
            }
            attachArgs.push('-t', sessionName)
            ptyProcess = pty.spawn('tmux', attachArgs, {
              name: 'xterm-256color',
              cols,
              rows,
              env: { ...process.env, TERM: 'xterm-256color' },
            })

            ptyProcess.onData((output: string) => {
              const filtered = sanitizeOutput(output)
              if (filtered) {
                send({ type: 'output', data: filtered })
              }
            })

            ptyProcess.onExit(({ exitCode }) => {
              send({ type: 'session-exit', exitCode })
              ptyProcess = null
            })

            send({ type: 'attached', sessionName, cols, rows, exclusive })
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

          case 'pane_scroll': {
            const scrollLines = Number(data.lines) || 0
            if (scrollLines === 0) break
            const sessionName = data.sessionName
            if (!sessionName) break
            try {
              if (scrollLines > 0) {
                await execFileAsync('tmux', ['copy-mode', '-e', '-t', sessionName])
              }
              const action = scrollLines > 0 ? 'scroll-up' : 'scroll-down'
              const repeat = String(Math.abs(scrollLines))
              await execFileAsync('tmux', ['send-keys', '-t', sessionName, '-X', '-N', repeat, action])
            } catch {}
            break
          }

          case 'detach':
            cleanup()
            send({ type: 'detached' })
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
