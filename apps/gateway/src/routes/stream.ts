import type { FastifyInstance } from 'fastify'
import type { SocketStream } from '@fastify/websocket'
import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { agentManager } from '../agent-manager.js'
import { assertSessionAllowed, prepareSessionAttach } from '../lib/tmux-policy.js'

const execFileAsync = promisify(execFile)

export async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/stream', { websocket: true }, (connection: SocketStream) => {
    console.log('Client connected to stream')

    const OUTPUT_FLUSH_INTERVAL = 12
    const OUTPUT_MAX_CHARS = 32768
    const SCROLL_FLUSH_INTERVAL = 16
    const SCROLL_MAX_LINES = 24
    let ptyProcess: pty.IPty | null = null
    let attachedSessionName: string | null = null
    let attachedExclusive = false
    let attachedCols = 0
    let attachedRows = 0
    let agentId: string | null = null
    let outputCarry = ''
    let outputBuffer = ''
    let outputTimer: ReturnType<typeof setTimeout> | null = null
    const scrollBuffers = new Map<string, number>()
    const scrollTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const socket = connection.socket

    function send(data: any) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data))
      }
    }

    function flushOutput() {
      if (!outputBuffer) return
      send({ type: 'output', data: outputBuffer })
      outputBuffer = ''
    }
    function queueOutput(output: string) {
      if (!output) return
      outputBuffer += output
      if (outputBuffer.length >= OUTPUT_MAX_CHARS) {
        if (outputTimer) {
          clearTimeout(outputTimer)
          outputTimer = null
        }
        flushOutput()
        return
      }
      if (outputTimer) return
      outputTimer = setTimeout(() => {
        outputTimer = null
        flushOutput()
      }, OUTPUT_FLUSH_INTERVAL)
    }
    async function applyScroll(sessionName: string, lines: number) {
      if (!lines) return
      if (lines > 0) {
        await execFileAsync('tmux', ['copy-mode', '-e', '-t', sessionName])
      }
      const action = lines > 0 ? 'scroll-up' : 'scroll-down'
      let remaining = Math.abs(lines)
      while (remaining > 0) {
        const step = Math.min(remaining, SCROLL_MAX_LINES)
        await execFileAsync('tmux', ['send-keys', '-t', sessionName, '-X', '-N', String(step), action])
        remaining -= step
      }
    }
    function flushScroll(sessionName: string) {
      scrollTimers.delete(sessionName)
      const lines = scrollBuffers.get(sessionName) || 0
      scrollBuffers.delete(sessionName)
      if (!lines) return
      void applyScroll(sessionName, lines).catch(() => {})
    }
    function queueScroll(sessionName: string, lines: number) {
      if (!sessionName || !lines) return
      const next = (scrollBuffers.get(sessionName) || 0) + lines
      scrollBuffers.set(sessionName, Math.max(-SCROLL_MAX_LINES * 4, Math.min(SCROLL_MAX_LINES * 4, next)))
      const existing = scrollTimers.get(sessionName)
      if (existing) return
      const timer = setTimeout(() => flushScroll(sessionName), SCROLL_FLUSH_INTERVAL)
      scrollTimers.set(sessionName, timer)
    }
    function cleanup() {
      if (ptyProcess) {
        ptyProcess.kill()
        ptyProcess = null
      }
      attachedSessionName = null
      attachedExclusive = false
      attachedCols = 0
      attachedRows = 0
      if (outputTimer) {
        clearTimeout(outputTimer)
        outputTimer = null
      }
      outputBuffer = ''
      outputCarry = ''
      for (const timer of scrollTimers.values()) {
        clearTimeout(timer)
      }
      scrollTimers.clear()
      scrollBuffers.clear()
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
            const sessionName = data.sessionName
            await prepareSessionAttach(sessionName)
            const requestedCols = data.cols || 80
            const requestedRows = data.rows || 24
            const exclusive = !!data.exclusive
            if (ptyProcess && attachedSessionName === sessionName && attachedExclusive === exclusive) {
              if (exclusive && requestedCols > 0 && requestedRows > 0 && (requestedCols !== attachedCols || requestedRows !== attachedRows)) {
                ptyProcess.resize(requestedCols, requestedRows)
                attachedCols = requestedCols
                attachedRows = requestedRows
              }
              send({ type: 'attached', sessionName, cols: attachedCols || requestedCols, rows: attachedRows || requestedRows, exclusive })
              break
            }
            cleanup()
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
            attachedSessionName = sessionName
            attachedExclusive = exclusive
            attachedCols = cols
            attachedRows = rows

            ptyProcess.onData((output: string) => {
              const filtered = sanitizeOutput(output)
              if (filtered) {
                queueOutput(filtered)
              }
            })

            ptyProcess.onExit(({ exitCode }) => {
              flushOutput()
              send({ type: 'session-exit', exitCode })
              ptyProcess = null
              attachedSessionName = null
              attachedExclusive = false
              attachedCols = 0
              attachedRows = 0
            })

            send({ type: 'attached', sessionName, cols, rows, exclusive })
            break
          }

          case 'resize':
            if (ptyProcess) {
              ptyProcess.resize(data.cols, data.rows)
              attachedCols = data.cols
              attachedRows = data.rows
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
            assertSessionAllowed(sessionName)
            queueScroll(sessionName, scrollLines)
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
