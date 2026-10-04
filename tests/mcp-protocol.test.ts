import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mcpEntry = join(root, 'apps/mcp/index.mjs')

// 无 token 环境：置空 TMUXGO_AGENT_EVENT_TOKEN + 指向空 config dir，
// callGateway 在取 fetch 前就短路返回，测试不触网、不依赖真实 gateway
function startMcp(env: Record<string, string> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'tmuxgo-mcp-'))
  const child = spawn(process.execPath, [mcpEntry], {
    env: { ...process.env, TMUXGO_AGENT_EVENT_TOKEN: '', TMUXGO_CONFIG_DIR: configDir, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let buffer = ''
  const received: any[] = []
  const waiters: { pred: (message: any) => boolean; resolve: (message: any) => void }[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      received.push(message)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(message)) {
          waiters[i].resolve(message)
          waiters.splice(i, 1)
        }
      }
    }
  })
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n')
  const waitFor = (pred: (message: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const hit = received.find(pred)
      if (hit) return resolve(hit)
      waiters.push({ pred, resolve })
      setTimeout(() => reject(new Error('timed out waiting for mcp response')), 5000)
    })
  const rpc = (id: number, method: string, params?: object) => {
    send({ jsonrpc: '2.0', id, method, params })
    return waitFor((message) => message.id === id)
  }
  const close = () => {
    child.kill()
    rmSync(configDir, { recursive: true, force: true })
  }
  return { send, waitFor, rpc, close }
}

test('mcp handshake, tools/list and no-token tool-call contract', async (t) => {
  const server = startMcp()
  t.after(() => server.close())

  const init = await server.rpc(1, 'initialize', { protocolVersion: '2025-06-18' })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'tmuxgo-mcp')
  assert.ok(init.result.capabilities.tools)

  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const list = await server.rpc(2, 'tools/list')
  const names = list.result.tools.map((tool: { name: string }) => tool.name)
  for (const name of ['tmuxgo_push_text', 'tmuxgo_push_file', 'tmuxgo_inbox_list']) {
    assert.ok(names.includes(name), `tools/list is missing ${name}`)
  }

  const noToken = await server.rpc(3, 'tools/call', { name: 'tmuxgo_push_text', arguments: { text: 'hi' } })
  assert.equal(noToken.result.isError, true)
  assert.match(noToken.result.content[0].text, /TMUXGO_AGENT_EVENT_TOKEN is not set/)

  const missingArg = await server.rpc(4, 'tools/call', { name: 'tmuxgo_push_file', arguments: {} })
  assert.equal(missingArg.result.isError, true)
  assert.match(missingArg.result.content[0].text, /path is required/)

  const unknownTool = await server.rpc(5, 'tools/call', { name: 'tmuxgo_nope', arguments: {} })
  assert.equal(unknownTool.result.isError, true)
  assert.match(unknownTool.result.content[0].text, /Unknown tool: tmuxgo_nope/)
})

test('mcp tools/call proxies to isolated gateway with contract headers', async (t) => {
  // 随机端口 mock gateway：验证 tools/call 的 HTTP 契约（头、body、响应透出），不触 :3001
  const received: { url: string; headers: Record<string, unknown>; body: any }[] = []
  const gateway: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received.push({ url: req.url || '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, messageId: 'msg-1' }))
    })
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const port = (gateway.address() as AddressInfo).port
  t.after(() => gateway.close())

  const server = startMcp({
    TMUXGO_AGENT_EVENT_TOKEN: 'mcp-secret',
    TMUXGO_GATEWAY_URL: `http://127.0.0.1:${port}`,
  })
  t.after(() => server.close())

  const call = await server.rpc(1, 'tools/call', { name: 'tmuxgo_push_text', arguments: { text: 'hello', title: 't' } })
  assert.notEqual(call.result.isError, true, JSON.stringify(call.result))
  assert.match(call.result.content[0].text, /msg-1/)

  assert.equal(received.length, 1)
  const req = received[0]
  assert.equal(req.url, '/api/v1/control/push')
  assert.equal(req.headers['x-tmuxgo-env'], '1')
  assert.equal(req.headers['x-tmuxgo-agent-token'], 'mcp-secret')
  assert.equal(req.body.type, 'text')
  assert.equal(req.body.text, 'hello')

  // gateway 错误 → isError + 状态码/正文透出（不吞错）
  const failGateway: Server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Agent control token required', code: 'AGENT_CONTROL_AUTH_REQUIRED' }))
  })
  await new Promise<void>((resolve) => failGateway.listen(0, '127.0.0.1', resolve))
  const failPort = (failGateway.address() as AddressInfo).port
  t.after(() => failGateway.close())
  const badServer = startMcp({ TMUXGO_AGENT_EVENT_TOKEN: 'wrong', TMUXGO_GATEWAY_URL: `http://127.0.0.1:${failPort}` })
  t.after(() => badServer.close())
  const failed = await badServer.rpc(2, 'tools/call', { name: 'tmuxgo_push_text', arguments: { text: 'x' } })
  assert.equal(failed.result.isError, true)
  assert.match(failed.result.content[0].text, /401/)
  assert.match(failed.result.content[0].text, /AGENT_CONTROL_AUTH_REQUIRED/)
})

test('mcp rejects malformed requests and unknown methods', async (t) => {
  const server = startMcp()
  t.after(() => server.close())

  // 缺 method 字段的请求应回 -32600 Invalid Request
  server.send({ jsonrpc: '2.0', id: 10 })
  const invalid = await server.waitFor((message) => message.id === 10)
  assert.equal(invalid.error.code, -32600)

  const unknownMethod = await server.rpc(11, 'bogus/method')
  assert.equal(unknownMethod.error.code, -32601)
  assert.match(unknownMethod.error.message, /Method not found/)
})
