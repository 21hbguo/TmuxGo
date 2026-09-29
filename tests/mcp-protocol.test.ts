import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mcpEntry = join(root, 'apps/mcp/index.mjs')

// 无 token 环境：置空 TMUXGO_AGENT_EVENT_TOKEN + 指向空 config dir，
// callGateway 在取 fetch 前就短路返回，测试不触网、不依赖真实 gateway
function startMcp() {
  const configDir = mkdtempSync(join(tmpdir(), 'tmuxgo-mcp-'))
  const child = spawn(process.execPath, [mcpEntry], {
    env: { ...process.env, TMUXGO_AGENT_EVENT_TOKEN: '', TMUXGO_CONFIG_DIR: configDir },
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
