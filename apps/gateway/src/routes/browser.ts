import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { consumeWebSocketTicket, isAuthEnabled } from '../lib/auth.js'
import { browserManager, resolveBrowserBinary } from '../lib/browser-manager.js'
import { getAgentEventToken, isAgentEventToken } from '../lib/agent-events.js'

type StreamSocket = {
  send: (d: string) => void
  close: (c?: number, r?: string) => void
  on: (e: string, f: (d: Buffer) => void) => void
  readyState: number
}

const BROWSER_DEBUG = process.env.TMUXGO_BROWSER_DEBUG === '1'

const navigateSchema = z.object({ url: z.string().min(1).max(4096), targetId: z.string().max(256).optional() })
const pickSchema = z.object({
  targetId: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(1).max(600000).optional(),
})
const pickCancelSchema = z.object({ targetId: z.string().max(256).optional() })
// agent 控制面：单端点 + op 分发，ops 多而薄，逐个开路由只会膨胀 auth 豁免表
const controlSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), url: z.string().min(1).max(4096), targetId: z.string().max(256).optional() }),
  z.object({ op: z.enum(['back', 'forward', 'reload']), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('snapshot'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('click'), ref: z.string().max(64), targetId: z.string().max(256).optional() }),
  z.object({
    op: z.literal('type'),
    ref: z.string().max(64),
    text: z.string().max(8192),
    targetId: z.string().max(256).optional(),
  }),
  z.object({ op: z.literal('press'), key: z.string().max(64), targetId: z.string().max(256).optional() }),
  z.object({
    op: z.literal('scroll'),
    dx: z.number().default(0),
    dy: z.number().default(0),
    targetId: z.string().max(256).optional(),
  }),
  z.object({ op: z.literal('screenshot'), targetId: z.string().max(256).optional() }),
  z.object({
    op: z.literal('eval'),
    expression: z.string().min(1).max(65536),
    targetId: z.string().max(256).optional(),
  }),
  // pick 上限 120s：控制面调用方（MCP/agent）不适合无限挂起，超时走 {cancelled:true}
  z.object({
    op: z.literal('pick'),
    targetId: z.string().max(256).optional(),
    timeoutMs: z.number().int().min(1).max(120000).optional(),
  }),
  z.object({ op: z.literal('pickCancel'), targetId: z.string().max(256).optional() }),
  z.object({ op: z.literal('tabs') }),
  z.object({ op: z.literal('open'), url: z.string().min(1).max(4096) }),
  z.object({ op: z.literal('close'), targetId: z.string().min(1).max(256) }),
  z.object({ op: z.literal('activate'), targetId: z.string().min(1).max(256) }),
  z.object({ op: z.literal('launch') }),
  z.object({ op: z.literal('stop') }),
  z.object({ op: z.literal('status') }),
])

export async function browserRoutes(fastify: FastifyInstance) {
  const dbg = (request: FastifyRequest, msg: string, extra?: Record<string, unknown>) => {
    if (BROWSER_DEBUG) request.log.info({ browser: true, ...extra }, msg)
  }

  const instance = () => browserManager.get('local')!

  // ---- 前端 REST ----

  fastify.get('/browser/status', async () => instance().status())

  fastify.get('/browser/setup', async () => {
    const bin = resolveBrowserBinary()
    return {
      status: { installed: !!bin, binary: bin?.bin ?? null, headlessShell: bin?.headlessShell ?? false },
      hint: bin ? '' : 'npx playwright install chromium-headless-shell',
    }
  })

  fastify.post('/browser/launch', async (_request, reply) => {
    try {
      await instance().launch()
      return { ok: true, ...instance().status() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply
        .code(msg === 'NO_BROWSER_BINARY' ? 400 : 502)
        .send({ error: msg, hint: 'npx playwright install chromium-headless-shell' })
    }
  })

  fastify.post('/browser/stop', async () => {
    await instance().stop()
    return { ok: true }
  })

  fastify.post('/browser/navigate', async (request, reply) => {
    try {
      const body = navigateSchema.parse(request.body)
      await instance().navigate(body.url, body.targetId)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'navigate failed' })
    }
  })

  fastify.post('/browser/pick', async (request, reply) => {
    try {
      const body = pickSchema.parse(request.body ?? {})
      return { ok: true, result: await instance().pickElement(body.targetId, body.timeoutMs) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'pick failed'
      return reply.code(msg === 'PICK_ALREADY_ACTIVE' ? 409 : 400).send({ error: msg })
    }
  })

  fastify.post('/browser/pick/cancel', async (request, reply) => {
    try {
      const body = pickCancelSchema.parse(request.body ?? {})
      await instance().cancelPick(body.targetId)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'pick cancel failed' })
    }
  })

  // ---- 前端 WS 画面流 ----

  fastify.get('/browser/stream', { websocket: true }, (rawSocket, request: FastifyRequest) => {
    const socket = rawSocket as unknown as StreamSocket
    const query = request.query as { ticket?: unknown }
    const ticket = typeof query.ticket === 'string' ? query.ticket : ''
    if (isAuthEnabled() && !consumeWebSocketTicket(ticket)) {
      socket.close(1008, 'Authentication required')
      return
    }
    const inst = instance()
    let client: Awaited<ReturnType<typeof inst.addClient>> | null = null
    // addClient 是异步绑页：其完成前到达的 pause/resume 若只看 client 会被丢，
    // 先记账最后意图，bind 落地后统一应用
    let wantPaused = false
    // 画面帧经 JSON 文本帧下发；send 仅在 OPEN 时尝试，避免断线瞬间抛错
    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg))
    }
    inst
      .addClient(send)
      .then(async (c) => {
        client = c
        if (wantPaused) await inst.clientPause(c, true).catch(() => {})
      })
      .catch((err) => {
        dbg(request, 'browser addClient failed', { error: String(err) })
        socket.close(1011, 'browser attach failed')
      })
    socket.on('message', (data: Buffer) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 'pause' || msg.type === 'resume') {
        wantPaused = msg.type === 'pause'
        if (client) void inst.clientPause(client, wantPaused)
        return
      }
      if (!client) return
      if (msg.type === 'input') void inst.clientInput(client, msg)
      else if (msg.type === 'resize')
        void inst.clientResize(client, Number(msg.width) || 1280, Number(msg.height) || 800)
      else if (msg.type === 'tab')
        void inst.clientTab(client, msg as { action: string; url?: string; targetId?: string })
      else if (msg.type === 'navigate' && typeof msg.url === 'string')
        void inst.navigate(msg.url, client.targetId ?? undefined).catch(() => {})
      else if (msg.type === 'back' || msg.type === 'forward' || msg.type === 'reload')
        void inst.history(msg.type, client.targetId ?? undefined).catch(() => {})
    })
    socket.on('close', () => {
      if (client) void inst.removeClient(client)
    })
    socket.on('error', () => {
      if (client) void inst.removeClient(client)
    })
  })

  // ---- agent 控制面 ----

  fastify.post('/v1/control/browser', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    if (!isAgentEventToken(getAgentEventToken(request.headers)))
      return reply.code(401).send({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' })
    if (request.headers['x-tmuxgo-env'] !== '1')
      return reply.code(403).send({ message: 'TMUXGO_ENV=1 guard required', code: 'TMUXGO_ENV_GUARD' })
    const inst = instance()
    try {
      const body = controlSchema.parse(request.body)
      switch (body.op) {
        case 'launch':
          await inst.launch()
          return { ok: true, ...inst.status() }
        case 'stop':
          await inst.stop()
          return { ok: true }
        case 'status':
          return { ok: true, ...inst.status() }
        case 'navigate':
          return { ok: true, result: await inst.navigate(body.url, body.targetId) }
        case 'back':
        case 'forward':
        case 'reload':
          return { ok: true, result: await inst.history(body.op, body.targetId) }
        case 'snapshot':
          return { ok: true, result: await inst.snapshot(body.targetId) }
        case 'click':
          return { ok: true, result: await inst.click(body.ref, body.targetId) }
        case 'type':
          return { ok: true, result: await inst.type(body.ref, body.text, body.targetId) }
        case 'press':
          return { ok: true, result: await inst.press(body.key, body.targetId) }
        case 'scroll':
          return { ok: true, result: await inst.scroll(body.dx, body.dy, body.targetId) }
        case 'screenshot':
          return { ok: true, jpeg: await inst.screenshot(body.targetId) }
        case 'eval':
          return { ok: true, result: await inst.evalJs(body.expression, body.targetId) }
        case 'pick':
          return { ok: true, result: await inst.pickElement(body.targetId, body.timeoutMs) }
        case 'pickCancel':
          await inst.cancelPick(body.targetId)
          return { ok: true }
        case 'tabs':
          return { ok: true, targets: [...inst.status().pages], activeTargetId: inst.activeTargetId }
        case 'open':
          return { ok: true, target: await inst.openPage(body.url) }
        case 'close':
          await inst.closePage(body.targetId)
          return { ok: true }
        case 'activate':
          inst.activeTargetId = body.targetId
          return { ok: true }
        default:
          return reply.code(400).send({ message: 'unknown op', code: 'BROWSER_BAD_OP' })
      }
    } catch (err) {
      if (err instanceof z.ZodError) throw err
      const message = err instanceof Error ? err.message : 'browser op failed'
      return reply.code(400).send({ message, code: 'BROWSER_OP_FAILED' })
    }
  })
}
