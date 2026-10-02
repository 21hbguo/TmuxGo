import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { decodeAgentOutput } from './lib/agent-terminal-output.js'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const HEARTBEAT_TIMEOUT_MS = 45000
// TMUXGO_VNC_DEBUG=1 时输出 VNC 中继排障日志
const VNC_DEBUG = process.env.TMUXGO_VNC_DEBUG === '1'
const vncDbg = (...args: unknown[]) => {
  if (VNC_DEBUG) console.log('[vnc]', ...args)
}
export interface AgentSocket {
  readyState: number
  bufferedAmount?: number
  send(data: string | Buffer): void
  on(event: string, listener: (...args: any[]) => void): unknown
  close?: (code?: number, reason?: string) => void
}
export interface AgentStatus {
  id: string
  name: string
  address: string
  version: string
  online: boolean
  connectedAt: string | null
  lastSeenAt: string
  lastDisconnectedAt: string | null
  disconnectReason: string | null
  reconnectCount: number
}
interface AgentCaps {
  compressTerminalOutput?: boolean
  // agent 支持 file-download-* 分块下载协议（gateway→agent 拉流）
  fileDownload?: boolean
}
// 上传/下载共用的在途分块窗口：ack 逐块有序，按计数滑动；
// 8×192KB≈1.5MB 在途上限，RTT 高时吞吐不再被单块 ack 卡死
const AGENT_CHUNK_BYTES = 192 * 1024
const AGENT_CHUNK_WINDOW = 8
interface Agent extends AgentStatus {
  socket: AgentSocket
  caps?: AgentCaps
}
interface PendingTmuxRequest {
  agentId: string
  socket: AgentSocket
  resolve: (value: { stdout: string; stderr: string }) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
interface PendingShellRequest {
  agentId: string
  socket: AgentSocket
  resolve: (value: { stdout: string; stderr: string; exitCode: number }) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
interface AgentUploadState {
  agentId: string
  socket: AgentSocket
  uploadId: string
  ready: { resolve: () => void; reject: (error: Error) => void }
  complete: { resolve: () => void; reject: (error: Error) => void } | null
  // inflight = 已发未 ack 的块数；达到窗口上限时生产者进 waiters 等位
  inflight: number
  waiters: { resolve: () => void; reject: (error: Error) => void }[]
  error: Error | null
  timer: NodeJS.Timeout | null
}
interface AgentDownloadState {
  agentId: string
  socket: AgentSocket
  downloadId: string
  stream: Readable
  queue: Buffer[]
  ended: boolean
  ready: { resolve: () => void; reject: (error: Error) => void }
  timer: NodeJS.Timeout | null
}
export interface AgentTerminal {
  id: string
  pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (exitCode: number) => void) => void
}
interface AgentTerminalState {
  agentId: string
  socket: AgentSocket
  terminal: AgentTerminal
  dataListener: ((data: string) => void) | null
  exitListener: ((exitCode: number) => void) | null
  pendingData: string[]
  exitCode: number | null
}
interface PendingTerminalRequest {
  agentId: string
  socket: AgentSocket
  attachmentId: string
  resolve: (terminal: AgentTerminal) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
interface VncConnection {
  agentId: string
  agentSocket: AgentSocket
  socket: AgentSocket
}
export interface AgentManagerOptions {
  historyPath?: string | null
}
function getHistoryPath() {
  return path.join(process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo'), 'agent-history.json')
}
function readHistory(historyPath: string) {
  try {
    const parsed = JSON.parse(readFileSync(historyPath, 'utf8')) as { agents?: unknown }
    if (!Array.isArray(parsed.agents)) return [] as AgentStatus[]
    return parsed.agents
      .filter(
        (value): value is AgentStatus =>
          !!value &&
          typeof value === 'object' &&
          typeof (value as AgentStatus).id === 'string' &&
          typeof (value as AgentStatus).name === 'string' &&
          typeof (value as AgentStatus).address === 'string' &&
          typeof (value as AgentStatus).version === 'string' &&
          typeof (value as AgentStatus).online === 'boolean' &&
          typeof (value as AgentStatus).lastSeenAt === 'string' &&
          typeof (value as AgentStatus).reconnectCount === 'number',
      )
      .map((value) => ({
        ...value,
        connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : null,
        lastDisconnectedAt: typeof value.lastDisconnectedAt === 'string' ? value.lastDisconnectedAt : null,
        disconnectReason: typeof value.disconnectReason === 'string' ? value.disconnectReason : null,
        reconnectCount: Math.max(0, Math.floor(value.reconnectCount)),
      }))
  } catch {
    return [] as AgentStatus[]
  }
}
function writeHistory(historyPath: string, agents: AgentStatus[]) {
  try {
    mkdirSync(path.dirname(historyPath), { recursive: true, mode: 0o700 })
    chmodSync(path.dirname(historyPath), 0o700)
    const temporary = `${historyPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ agents })}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, historyPath)
    chmodSync(historyPath, 0o600)
  } catch {}
}
export class AgentManager {
  private readonly historyPath: string | null
  private agents = new Map<string, Agent>()
  private history = new Map<string, AgentStatus>()
  private pendingTmuxRequests = new Map<string, PendingTmuxRequest>()
  private pendingShellRequests = new Map<string, PendingShellRequest>()
  private uploads = new Map<string, AgentUploadState>()
  private downloads = new Map<string, AgentDownloadState>()
  private terminals = new Map<string, AgentTerminalState>()
  private pendingTerminalRequests = new Map<string, PendingTerminalRequest>()
  private vncConnections = new Map<string, VncConnection>()
  constructor(options: AgentManagerOptions = {}) {
    this.historyPath = options.historyPath === undefined ? getHistoryPath() : options.historyPath
    if (!this.historyPath) return
    const timestamp = new Date().toISOString()
    let changed = false
    for (const status of readHistory(this.historyPath)) {
      if (status.online) {
        status.online = false
        status.connectedAt = null
        status.lastDisconnectedAt = timestamp
        status.disconnectReason = 'Gateway restarted'
        changed = true
      }
      this.history.set(status.id, status)
    }
    if (changed) this.persistHistory()
  }
  register(id: string, name: string, address: string, version: string, socket: AgentSocket, caps?: AgentCaps) {
    const previous = this.agents.get(id)
    if (previous?.socket === socket) {
      const current = previous
      current.name = name
      current.address = address
      current.version = version
      if (caps) current.caps = caps
      current.lastSeenAt = new Date().toISOString()
      this.history.set(id, this.toStatus(current))
      this.persistHistory()
      return this.toStatus(current)
    }
    if (previous && previous.socket !== socket) {
      this.rejectTmuxRequests(id, previous.socket, 'Agent reconnected')
      this.rejectShellRequests(id, previous.socket, 'Agent reconnected')
      this.rejectUploads(id, previous.socket, 'Agent reconnected')
      this.rejectDownloads(id, previous.socket, 'Agent reconnected')
      this.closeTerminals(id, previous.socket, -1)
      this.closeVncConnections(id, previous.socket, 'Agent reconnected')
    }
    const history = this.history.get(id)
    const timestamp = new Date().toISOString()
    const agent: Agent = {
      id,
      name,
      address,
      version,
      caps,
      online: true,
      connectedAt: timestamp,
      lastSeenAt: timestamp,
      lastDisconnectedAt: null,
      disconnectReason: null,
      reconnectCount: (history?.reconnectCount || 0) + (previous || history ? 1 : 0),
      socket,
    }
    this.agents.set(id, agent)
    this.history.set(id, this.toStatus(agent))
    this.persistHistory()
    console.log(`Agent registered: ${id} (${name})`)
    return this.toStatus(agent)
  }
  /** Caps echoed to agent on register (only fields Gateway accepts). */
  getRegisterCaps(id: string): AgentCaps | undefined {
    const caps = this.agents.get(id)?.caps
    if (!caps?.compressTerminalOutput) return undefined
    return { compressTerminalOutput: true }
  }
  agentAcceptsTerminalGzip(id: string, socket: AgentSocket) {
    const agent = this.agents.get(id)
    return !!agent && agent.socket === socket && agent.caps?.compressTerminalOutput === true
  }
  // getAgent() 只回 AgentStatus 不带 caps，下载能力判定要拿内部记录的 socket+caps
  supportsFileDownload(id: string) {
    const agent = this.agents.get(id)
    return !!agent && this.toStatus(agent).online && agent.socket.readyState === 1 && agent.caps?.fileDownload === true
  }
  unregister(id: string, socket: AgentSocket, reason = 'Disconnected') {
    const agent = this.agents.get(id)
    if (!agent || agent.socket !== socket) return false
    this.rejectTmuxRequests(id, socket, `Agent disconnected: ${reason}`)
    this.rejectShellRequests(id, socket, `Agent disconnected: ${reason}`)
    this.rejectUploads(id, socket, `Agent disconnected: ${reason}`)
    this.rejectDownloads(id, socket, `Agent disconnected: ${reason}`)
    this.closeTerminals(id, socket, -1)
    this.closeVncConnections(id, socket, `Agent disconnected: ${reason}`)
    this.agents.delete(id)
    const status: AgentStatus = {
      ...this.toStatus(agent),
      online: false,
      lastDisconnectedAt: new Date().toISOString(),
      disconnectReason: reason,
    }
    this.history.set(id, status)
    this.persistHistory()
    console.log(`Agent unregistered: ${id}`)
    return true
  }
  /** Gateway 主动关停：先以重启原因批量下线，避免随后 ws close 把原因覆盖成 socket 错误 */
  unregisterAll(reason: string) {
    for (const agent of Array.from(this.agents.values())) this.unregister(agent.id, agent.socket, reason)
  }
  removeAgent(id: string) {
    const agent = this.agents.get(id)
    const existed = !!agent || this.history.has(id)
    if (agent) {
      this.rejectTmuxRequests(id, agent.socket, 'Agent removed')
      this.rejectShellRequests(id, agent.socket, 'Agent removed')
      this.rejectUploads(id, agent.socket, 'Agent removed')
      this.rejectDownloads(id, agent.socket, 'Agent removed')
      this.closeTerminals(id, agent.socket, -1)
      this.closeVncConnections(id, agent.socket, 'Agent removed')
      this.agents.delete(id)
    }
    this.history.delete(id)
    this.persistHistory()
    console.log(`Agent removed: ${id}`)
    return existed
  }
  heartbeat(id: string, socket: AgentSocket, version?: string) {
    const agent = this.agents.get(id)
    if (!agent || agent.socket !== socket) return false
    agent.lastSeenAt = new Date().toISOString()
    if (version) agent.version = version
    this.history.set(id, this.toStatus(agent))
    this.persistHistory()
    return true
  }
  getAgent(id: string) {
    const agent = this.agents.get(id)
    if (!agent) return undefined
    const status = this.toStatus(agent)
    if (!status.online && this.history.get(id)?.online !== false) {
      this.history.set(id, status)
      this.persistHistory()
    }
    return status
  }
  getAgentStatus(id: string) {
    return this.getAgent(id) || this.history.get(id)
  }
  getAllAgents() {
    return Array.from(this.agents.keys())
      .map((id) => this.getAgent(id))
      .filter((agent): agent is AgentStatus => !!agent?.online)
  }
  getAllAgentStatuses() {
    const statuses = new Map(this.history)
    for (const agent of this.agents.values()) statuses.set(agent.id, this.getAgent(agent.id)!)
    return Array.from(statuses.values()).sort((left, right) => left.name.localeCompare(right.name))
  }
  executeTmux(id: string, args: string[], timeoutMs = 30000) {
    const agent = this.agents.get(id)
    if (!agent || !this.toStatus(agent).online || agent.socket.readyState !== 1)
      return Promise.reject(new Error(`Agent "${id}" is not connected`))
    if (
      !Array.isArray(args) ||
      !args.length ||
      args.length > 64 ||
      args.some((item) => typeof item !== 'string' || item.length > 4096)
    )
      return Promise.reject(new Error('Invalid tmux arguments'))
    const requestId = randomUUID()
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const pending = this.pendingTmuxRequests.get(requestId)
          if (!pending) return
          this.pendingTmuxRequests.delete(requestId)
          reject(new Error('Agent tmux command timed out'))
        },
        Math.max(1000, Math.min(timeoutMs, 120000)),
      )
      this.pendingTmuxRequests.set(requestId, { agentId: id, socket: agent.socket, resolve, reject, timer })
      try {
        agent.socket.send(JSON.stringify({ type: 'tmux', requestId, args }))
      } catch (error) {
        clearTimeout(timer)
        this.pendingTmuxRequests.delete(requestId)
        reject(error instanceof Error ? error : new Error('Failed to send Agent tmux command'))
      }
    })
  }
  executeShell(id: string, command: string, timeoutMs = 30000) {
    const agent = this.agents.get(id)
    if (!agent || !this.toStatus(agent).online || agent.socket.readyState !== 1)
      return Promise.reject(new Error(`Agent "${id}" is not connected`))
    if (!command || command.length > 524288) return Promise.reject(new Error('Invalid Agent shell command'))
    const requestId = randomUUID()
    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const pending = this.pendingShellRequests.get(requestId)
          if (!pending) return
          this.pendingShellRequests.delete(requestId)
          reject(new Error('Agent shell command timed out'))
        },
        Math.max(1000, Math.min(timeoutMs, 120000)),
      )
      this.pendingShellRequests.set(requestId, { agentId: id, socket: agent.socket, resolve, reject, timer })
      try {
        agent.socket.send(
          JSON.stringify({ type: 'shell', requestId, command, timeoutMs: Math.max(1000, Math.min(timeoutMs, 120000)) }),
        )
      } catch (error) {
        clearTimeout(timer)
        this.pendingShellRequests.delete(requestId)
        reject(error instanceof Error ? error : new Error('Failed to send Agent shell command'))
      }
    })
  }
  async uploadFile(id: string, absolutePath: string, source: AsyncIterable<Buffer | string>, signal?: AbortSignal) {
    const agent = this.agents.get(id)
    if (!agent || !this.toStatus(agent).online || agent.socket.readyState !== 1)
      throw new Error(`Agent "${id}" is not connected`)
    if (!absolutePath || absolutePath.length > 4096) throw new Error('Invalid Agent upload path')
    if (signal?.aborted) throw new Error('Task cancelled')
    const uploadId = randomUUID()
    let state!: AgentUploadState
    const ready = new Promise<void>((resolve, reject) => {
      state = {
        agentId: id,
        socket: agent.socket,
        uploadId,
        ready: { resolve, reject },
        complete: null,
        inflight: 0,
        waiters: [],
        error: null,
        timer: null,
      }
    })
    const clearTimer = () => {
      if (!state!.timer) return
      clearTimeout(state!.timer)
      state!.timer = null
    }
    const fail = (error: Error) => {
      clearTimer()
      if (this.uploads.get(uploadId) !== state) return
      this.uploads.delete(uploadId)
      state!.error = error
      state!.ready.reject(error)
      for (const waiter of state!.waiters.splice(0)) waiter.reject(error)
      state!.complete?.reject(error)
    }
    const armTimeout = () => {
      clearTimer()
      state!.timer = setTimeout(() => fail(new Error('Agent file upload timed out')), 120000)
    }
    const abort = () => {
      try {
        agent.socket.send(JSON.stringify({ type: 'file-upload-abort', uploadId }))
      } catch {}
      fail(new Error('Task cancelled'))
    }
    this.uploads.set(uploadId, state!)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      armTimeout()
      agent.socket.send(JSON.stringify({ type: 'file-upload-start', uploadId, path: absolutePath }))
      await ready
      if (state!.error) throw state!.error
      for await (const raw of source) {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        for (let offset = 0; offset < data.length; offset += AGENT_CHUNK_BYTES) {
          if (state!.error) throw state!.error
          if (signal?.aborted) throw new Error('Task cancelled')
          // 窗口满则等一个 ack 腾位；ack 逐块有序，用计数即可不需序号
          if (state!.inflight >= AGENT_CHUNK_WINDOW) {
            armTimeout()
            await new Promise<void>((resolve, reject) => state!.waiters.push({ resolve, reject }))
            if (state!.error) throw state!.error
          }
          state!.inflight++
          try {
            agent.socket.send(
              JSON.stringify({
                type: 'file-upload-chunk',
                uploadId,
                data: data.subarray(offset, offset + AGENT_CHUNK_BYTES).toString('base64'),
              }),
            )
          } catch (error) {
            state!.inflight--
            throw error
          }
        }
      }
      if (state!.error) throw state!.error
      const complete = new Promise<void>((resolve, reject) => {
        state!.complete = { resolve, reject }
      })
      armTimeout()
      agent.socket.send(JSON.stringify({ type: 'file-upload-end', uploadId }))
      await complete
    } catch (error) {
      if (this.uploads.get(uploadId) === state) {
        try {
          agent.socket.send(JSON.stringify({ type: 'file-upload-abort', uploadId }))
        } catch {}
        fail(error instanceof Error ? error : new Error('Agent file upload failed'))
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      clearTimer()
      if (this.uploads.get(uploadId) === state) this.uploads.delete(uploadId)
    }
  }
  // agent 侧拉流式下载：agent 读盘分块上行，gateway 每消费一块回 ack，
  // agent 端在途窗口（AGENT_CHUNK_WINDOW）即内存上限；abort/cancel 发 abort 让对端收流
  async downloadFile(
    id: string,
    absolutePath: string,
    options: { directory?: boolean; offset?: number; signal?: AbortSignal } = {},
  ): Promise<Readable> {
    const agent = this.agents.get(id)
    if (!agent || !this.toStatus(agent).online || agent.socket.readyState !== 1)
      throw new Error(`Agent "${id}" is not connected`)
    if (!agent.caps?.fileDownload) throw new Error(`Agent "${id}" does not support file download`)
    if (!absolutePath || !absolutePath.startsWith('/') || absolutePath.length > 4096)
      throw new Error('Invalid Agent download path')
    const offset = Math.max(0, Math.floor(options.offset || 0))
    if (options.signal?.aborted) throw new Error('Task cancelled')
    const downloadId = randomUUID()
    const state: AgentDownloadState = {
      agentId: id,
      socket: agent.socket,
      downloadId,
      // 先占位再回填：stream.destroy 回调需要 state.timer，stream 字段需要 stream
      stream: undefined as unknown as Readable,
      queue: [],
      ended: false,
      ready: { resolve: () => {}, reject: () => {} },
      timer: null,
    }
    const stream = new Readable({
      read: () => this.flushDownload(downloadId),
      destroy: (error, callback) => {
        if (state.timer) clearTimeout(state.timer)
        this.downloads.delete(downloadId)
        if (state.socket.readyState === 1) {
          try {
            state.socket.send(JSON.stringify({ type: 'file-download-abort', downloadId }))
          } catch {}
        }
        callback(error)
      },
    })
    state.stream = stream
    const ready = new Promise<void>((resolve, reject) => {
      state.ready = { resolve, reject }
    })
    const abort = () => stream.destroy(new Error('Task cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    stream.once('close', () => options.signal?.removeEventListener('abort', abort))
    this.downloads.set(downloadId, state)
    try {
      this.armDownloadTimer(downloadId)
      agent.socket.send(
        JSON.stringify({
          type: 'file-download-start',
          downloadId,
          path: absolutePath,
          offset,
          directory: options.directory === true,
        }),
      )
      await ready
      return stream
    } catch (error) {
      this.downloads.delete(downloadId)
      stream.destroy()
      throw error
    }
  }
  attachTerminal(id: string, sessionName: string, cols: number, rows: number, exclusive: boolean, timeoutMs = 30000) {
    const agent = this.agents.get(id)
    if (!agent || !this.toStatus(agent).online || agent.socket.readyState !== 1)
      return Promise.reject(new Error(`Agent "${id}" is not connected`))
    if (
      !sessionName ||
      sessionName.length > 256 ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    )
      return Promise.reject(new Error('Invalid Agent terminal attachment'))
    const requestId = randomUUID()
    const attachmentId = randomUUID()
    let state: AgentTerminalState
    const terminal: AgentTerminal = {
      id: attachmentId,
      pid: 0,
      write: (data) => this.sendTerminalInput(state, data),
      resize: (nextCols, nextRows) => this.resizeTerminal(state, nextCols, nextRows),
      kill: () => this.detachTerminal(state),
      onData: (listener) => {
        state.dataListener = listener
        for (const data of state.pendingData.splice(0)) listener(data)
      },
      onExit: (listener) => {
        state.exitListener = listener
        if (state.exitCode !== null) listener(state.exitCode)
      },
    }
    state = {
      agentId: id,
      socket: agent.socket,
      terminal,
      dataListener: null,
      exitListener: null,
      pendingData: [],
      exitCode: null,
    }
    this.terminals.set(attachmentId, state)
    return new Promise<AgentTerminal>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const pending = this.pendingTerminalRequests.get(requestId)
          if (!pending) return
          this.pendingTerminalRequests.delete(requestId)
          this.terminals.delete(attachmentId)
          reject(new Error('Agent terminal attachment timed out'))
        },
        Math.max(1000, Math.min(timeoutMs, 120000)),
      )
      this.pendingTerminalRequests.set(requestId, {
        agentId: id,
        socket: agent.socket,
        attachmentId,
        resolve,
        reject,
        timer,
      })
      try {
        agent.socket.send(
          JSON.stringify({ type: 'terminal-attach', requestId, attachmentId, sessionName, cols, rows, exclusive }),
        )
      } catch (error) {
        clearTimeout(timer)
        this.pendingTerminalRequests.delete(requestId)
        this.terminals.delete(attachmentId)
        reject(error instanceof Error ? error : new Error('Failed to send Agent terminal attachment'))
      }
    })
  }
  handleMessage(id: string, socket: AgentSocket, message: unknown) {
    if (!message || typeof message !== 'object') return false
    const payload = message as {
      type?: unknown
      requestId?: unknown
      attachmentId?: unknown
      uploadId?: unknown
      downloadId?: unknown
      connectionId?: unknown
      stdout?: unknown
      stderr?: unknown
      message?: unknown
      pid?: unknown
      data?: unknown
      exitCode?: unknown
    }
    if ((payload.type === 'tmux-result' || payload.type === 'tmux-error') && typeof payload.requestId === 'string') {
      const pending = this.pendingTmuxRequests.get(payload.requestId)
      if (!pending || pending.agentId !== id || pending.socket !== socket) return false
      clearTimeout(pending.timer)
      this.pendingTmuxRequests.delete(payload.requestId)
      if (payload.type === 'tmux-error')
        pending.reject(
          new Error(
            typeof payload.message === 'string' && payload.message ? payload.message : 'Agent tmux command failed',
          ),
        )
      else
        pending.resolve({
          stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
          stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
        })
      return true
    }
    if (payload.type === 'shell-result' && typeof payload.requestId === 'string') {
      const pending = this.pendingShellRequests.get(payload.requestId)
      if (!pending || pending.agentId !== id || pending.socket !== socket) return false
      clearTimeout(pending.timer)
      this.pendingShellRequests.delete(payload.requestId)
      pending.resolve({
        stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
        stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
        exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 1,
      })
      return true
    }
    if (
      (payload.type === 'file-upload-ready' ||
        payload.type === 'file-upload-ack' ||
        payload.type === 'file-upload-result' ||
        payload.type === 'file-upload-error') &&
      typeof payload.uploadId === 'string'
    ) {
      const upload = this.uploads.get(payload.uploadId)
      if (!upload || upload.agentId !== id || upload.socket !== socket) return false
      if (payload.type === 'file-upload-ready') upload.ready.resolve()
      else if (payload.type === 'file-upload-ack') {
        upload.inflight = Math.max(0, upload.inflight - 1)
        upload.waiters.shift()?.resolve()
      } else if (payload.type === 'file-upload-result') {
        if (upload.timer) clearTimeout(upload.timer)
        this.uploads.delete(payload.uploadId)
        if (upload.complete) upload.complete.resolve()
        else {
          const error = new Error('Agent file upload completed unexpectedly')
          upload.error = error
          upload.ready.reject(error)
          for (const waiter of upload.waiters.splice(0)) waiter.reject(error)
        }
      } else {
        const error = new Error(
          typeof payload.message === 'string' && payload.message ? payload.message : 'Agent file upload failed',
        )
        if (upload.timer) clearTimeout(upload.timer)
        this.uploads.delete(payload.uploadId)
        upload.error = error
        upload.ready.reject(error)
        for (const waiter of upload.waiters.splice(0)) waiter.reject(error)
        upload.complete?.reject(error)
      }
      return true
    }
    if (
      (payload.type === 'file-download-ready' ||
        payload.type === 'file-download-chunk' ||
        payload.type === 'file-download-end' ||
        payload.type === 'file-download-error') &&
      typeof payload.downloadId === 'string'
    ) {
      const download = this.downloads.get(payload.downloadId)
      if (!download || download.agentId !== id || download.socket !== socket) return false
      if (payload.type === 'file-download-ready') download.ready.resolve()
      else if (payload.type === 'file-download-chunk') {
        if (typeof payload.data !== 'string') return false
        // base64 体积 ~1.33x；queue 在消费端水位压不住时缓冲，ack 节流即背压
        download.queue.push(Buffer.from(payload.data, 'base64'))
        this.armDownloadTimer(payload.downloadId)
        this.flushDownload(payload.downloadId)
      } else if (payload.type === 'file-download-end') {
        download.ended = true
        this.flushDownload(payload.downloadId)
      } else
        this.failDownload(
          payload.downloadId,
          new Error(
            typeof payload.message === 'string' && payload.message ? payload.message : 'Agent file download failed',
          ),
        )
      return true
    }
    if (
      (payload.type === 'terminal-attached' || payload.type === 'terminal-error') &&
      typeof payload.requestId === 'string'
    ) {
      const pending = this.pendingTerminalRequests.get(payload.requestId)
      if (!pending || pending.agentId !== id || pending.socket !== socket) return false
      const state = this.terminals.get(pending.attachmentId)
      if (payload.type === 'terminal-error') {
        clearTimeout(pending.timer)
        this.pendingTerminalRequests.delete(payload.requestId)
        this.terminals.delete(pending.attachmentId)
        pending.reject(
          new Error(
            typeof payload.message === 'string' && payload.message
              ? payload.message
              : 'Agent terminal attachment failed',
          ),
        )
      } else {
        if (payload.attachmentId !== pending.attachmentId || typeof payload.pid !== 'number' || payload.pid <= 0)
          return false
        clearTimeout(pending.timer)
        this.pendingTerminalRequests.delete(payload.requestId)
        if (!state || state.agentId !== id || state.socket !== socket) {
          pending.reject(new Error('Agent terminal exited before attaching'))
          return true
        }
        state.terminal.pid = payload.pid
        pending.resolve(state.terminal)
      }
      return true
    }
    if (
      (payload.type === 'terminal-output' || payload.type === 'terminal-exit') &&
      typeof payload.attachmentId === 'string'
    ) {
      const state = this.terminals.get(payload.attachmentId)
      if (!state || state.agentId !== id || state.socket !== socket) return false
      if (payload.type === 'terminal-output') {
        if (typeof payload.data !== 'string') return false
        const encoding = (payload as { encoding?: unknown }).encoding
        const text = decodeAgentOutput(payload.data, typeof encoding === 'string' ? encoding : undefined)
        // gzip decode failure: drop frame, keep connection (PROTOCOL.extend.md A.2)
        if (text === null) return true
        if (state.dataListener) state.dataListener(text)
        else state.pendingData.push(text)
      } else {
        this.terminals.delete(payload.attachmentId)
        state.exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : -1
        state.exitListener?.(state.exitCode)
        for (const [requestId, pending] of this.pendingTerminalRequests) {
          if (pending.attachmentId !== payload.attachmentId) continue
          clearTimeout(pending.timer)
          this.pendingTerminalRequests.delete(requestId)
          pending.reject(new Error('Agent terminal exited before attaching'))
        }
      }
      return true
    }
    // vnc-data 新协议走二进制帧（见 handleVncBinary）；JSON 分支留作旧 agent 兼容
    if (
      (payload.type === 'vnc-opened' ||
        payload.type === 'vnc-data' ||
        payload.type === 'vnc-closed' ||
        payload.type === 'vnc-error') &&
      typeof payload.connectionId === 'string'
    ) {
      const conn = this.vncConnections.get(payload.connectionId)
      // 清理竞态/断连重发的中继消息直接吞掉，fallthrough 会让 stream 回 error 打断 agent
      if (!conn || conn.agentId !== id || conn.agentSocket !== socket) {
        vncDbg('drop stale vnc message', payload.type, payload.connectionId)
        return true
      }
      if (payload.type === 'vnc-opened') {
        vncDbg('agent vnc opened', payload.connectionId)
        return true
      }
      if (payload.type === 'vnc-data') {
        if (typeof payload.data !== 'string') return false
        conn.socket.send(Buffer.from(payload.data, 'base64'))
        return true
      }
      this.vncConnections.delete(payload.connectionId)
      const reason =
        payload.type === 'vnc-error' && typeof payload.message === 'string' && payload.message
          ? payload.message
          : 'VNC connection closed'
      vncDbg('agent vnc closed', payload.connectionId, payload.type, reason)
      conn.socket.close?.(payload.type === 'vnc-error' ? 1011 : 1000, reason)
      return true
    }
    return false
  }
  openVnc(agentId: string, connectionId: string, port: number, socket: AgentSocket) {
    const agent = this.agents.get(agentId)
    if (!agent || !this.toStatus(agent).online || agent.socket.readyState !== 1) {
      vncDbg('openVnc refused', {
        agentId,
        hasAgent: !!agent,
        online: agent ? this.toStatus(agent).online : false,
        socketState: agent?.socket.readyState,
      })
      return false
    }
    this.vncConnections.set(connectionId, { agentId, agentSocket: agent.socket, socket })
    try {
      agent.socket.send(JSON.stringify({ type: 'vnc-open', connectionId, port }))
    } catch {
      this.vncConnections.delete(connectionId)
      return false
    }
    return true
  }
  sendVncData(connectionId: string, data: Buffer) {
    const conn = this.vncConnections.get(connectionId)
    const agent = conn && this.agents.get(conn.agentId)
    if (!conn || !agent || agent.socket !== conn.agentSocket || agent.socket.readyState !== 1) return
    try {
      agent.socket.send(Buffer.concat([Buffer.from(`vnc-data ${connectionId}\n`, 'ascii'), data]))
    } catch {}
  }
  handleVncBinary(agentId: string, socket: AgentSocket, frame: Buffer) {
    const separator = frame.indexOf(0x0a)
    if (separator < 0) return
    const header = frame.toString('ascii', 0, separator)
    if (!header.startsWith('vnc-data ')) return
    const connectionId = header.slice(9).trim()
    const conn = this.vncConnections.get(connectionId)
    if (!conn || conn.agentId !== agentId || conn.agentSocket !== socket) {
      vncDbg('drop unmatched vnc binary', { agentId, connectionId, found: !!conn })
      return
    }
    conn.socket.send(frame.subarray(separator + 1))
  }
  closeVnc(connectionId: string) {
    const conn = this.vncConnections.get(connectionId)
    if (!conn) return
    this.vncConnections.delete(connectionId)
    const agent = this.agents.get(conn.agentId)
    if (!agent || agent.socket !== conn.agentSocket || agent.socket.readyState !== 1) return
    try {
      agent.socket.send(JSON.stringify({ type: 'vnc-close', connectionId }))
    } catch {}
  }
  private closeVncConnections(agentId: string, socket: AgentSocket, reason: string) {
    for (const [connectionId, conn] of this.vncConnections) {
      if (conn.agentId !== agentId || conn.agentSocket !== socket) continue
      this.vncConnections.delete(connectionId)
      conn.socket.close?.(1011, reason)
    }
  }
  private rejectTmuxRequests(agentId: string, socket: AgentSocket, message: string) {
    for (const [requestId, pending] of this.pendingTmuxRequests) {
      if (pending.agentId !== agentId || pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.pendingTmuxRequests.delete(requestId)
      pending.reject(new Error(message))
    }
  }
  private rejectShellRequests(agentId: string, socket: AgentSocket, message: string) {
    for (const [requestId, pending] of this.pendingShellRequests) {
      if (pending.agentId !== agentId || pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.pendingShellRequests.delete(requestId)
      pending.reject(new Error(message))
    }
  }
  private rejectUploads(agentId: string, socket: AgentSocket, message: string) {
    for (const [uploadId, upload] of this.uploads) {
      if (upload.agentId !== agentId || upload.socket !== socket) continue
      if (upload.timer) clearTimeout(upload.timer)
      this.uploads.delete(uploadId)
      const error = new Error(message)
      upload.error = error
      upload.ready.reject(error)
      for (const waiter of upload.waiters.splice(0)) waiter.reject(error)
      upload.complete?.reject(error)
    }
  }
  private rejectDownloads(agentId: string, socket: AgentSocket, message: string) {
    for (const [downloadId, download] of this.downloads) {
      if (download.agentId !== agentId || download.socket !== socket) continue
      this.failDownload(downloadId, new Error(message))
    }
  }
  private armDownloadTimer(downloadId: string) {
    const download = this.downloads.get(downloadId)
    if (!download) return
    if (download.timer) clearTimeout(download.timer)
    download.timer = setTimeout(() => this.failDownload(downloadId, new Error('Agent file download timed out')), 120000)
  }
  private failDownload(downloadId: string, error: Error) {
    const download = this.downloads.get(downloadId)
    if (!download) return
    if (download.timer) clearTimeout(download.timer)
    this.downloads.delete(downloadId)
    download.ready.reject(error)
    download.stream.destroy(error)
  }
  private flushDownload(downloadId: string) {
    const download = this.downloads.get(downloadId)
    if (!download) return
    while (download.queue.length) {
      const chunk = download.queue.shift()!
      // push 返回值仅表示消费侧是否还吃得下；push=false 停止回 ack，agent 在途窗口压住即背压
      const wantsMore = download.stream.push(chunk)
      if (download.socket.readyState === 1) {
        try {
          download.socket.send(JSON.stringify({ type: 'file-download-ack', downloadId }))
        } catch {}
      }
      if (!wantsMore) break
    }
    if (!download.queue.length && download.ended) download.stream.push(null)
  }
  private sendTerminalInput(state: AgentTerminalState, data: string) {
    if (!data || state.exitCode !== null || state.socket.readyState !== 1) return
    try {
      state.socket.send(JSON.stringify({ type: 'terminal-input', attachmentId: state.terminal.id, data }))
    } catch {}
  }
  private resizeTerminal(state: AgentTerminalState, cols: number, rows: number) {
    if (
      state.exitCode !== null ||
      state.socket.readyState !== 1 ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    )
      return
    try {
      state.socket.send(JSON.stringify({ type: 'terminal-resize', attachmentId: state.terminal.id, cols, rows }))
    } catch {}
  }
  private detachTerminal(state: AgentTerminalState) {
    if (this.terminals.get(state.terminal.id) !== state) return
    this.terminals.delete(state.terminal.id)
    if (state.socket.readyState !== 1) return
    try {
      state.socket.send(JSON.stringify({ type: 'terminal-detach', attachmentId: state.terminal.id }))
    } catch {}
  }
  private closeTerminals(agentId: string, socket: AgentSocket, exitCode: number) {
    for (const [attachmentId, state] of this.terminals) {
      if (state.agentId !== agentId || state.socket !== socket) continue
      this.terminals.delete(attachmentId)
      state.exitCode = exitCode
      state.exitListener?.(exitCode)
    }
    for (const [requestId, pending] of this.pendingTerminalRequests) {
      if (pending.agentId !== agentId || pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.pendingTerminalRequests.delete(requestId)
      pending.reject(new Error('Agent terminal disconnected'))
    }
  }
  private persistHistory() {
    if (!this.historyPath) return
    const agents = Array.from(this.history.values())
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, 100)
    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of this.history.keys()) if (!ids.has(id)) this.history.delete(id)
    writeHistory(this.historyPath, agents)
  }
  private toStatus(agent: Agent): AgentStatus {
    const { socket: _socket, ...status } = agent
    if (Date.now() - Date.parse(status.lastSeenAt) <= HEARTBEAT_TIMEOUT_MS) return status
    return { ...status, online: false, lastDisconnectedAt: status.lastSeenAt, disconnectReason: 'Heartbeat timed out' }
  }
}
export const agentManager = new AgentManager()
