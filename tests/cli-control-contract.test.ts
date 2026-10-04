import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ctlBin = join(root, 'apps/cli/bin/tmuxgo-ctl.mjs')

// 隔离 mock gateway（node:http，随机端口）：断言请求头/body 契约并返回罐装响应，
// 不触碰真实 :3001。requests 记录收到的请求供断言。
interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, unknown>
  body: any
}
function startMockGateway() {
  const requests: RecordedRequest[] = []
  const responses: Record<string, { status: number; body: unknown }> = {
    '/health': { status: 200, body: { status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' } },
    'POST /api/v1/control/initialize': {
      status: 200,
      body: {
        ok: true,
        protocolVersion: 'v1',
        supportedVersions: ['v1'],
        capabilities: ['initialize', 'schema', 'panes.split', 'agent.wait'],
      },
    },
    'GET /api/v1/control/schema': {
      status: 200,
      body: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        protocolVersion: 'v1',
        supportedVersions: ['v1'],
        basePath: '/api/v1/control',
        methods: { 'panes.read': { http: 'POST', path: '/panes/read' } },
      },
    },
    '/api/v1/control/panes/split': { status: 200, body: { ok: true, paneId: 'local:%9' } },
    '/api/v1/control/panes/read': { status: 200, body: { ok: true, paneId: 'local:%0', output: 'line1\nline2' } },
    '/api/v1/control/panes/snapshot': {
      status: 200,
      body: {
        ok: true,
        paneId: 'local:%0',
        snapshot: { tmuxPaneId: '%0', command: 'zsh', tail: ['prompt$'] },
      },
    },
    '/api/v1/control/panes/wait-output': {
      status: 200,
      body: { ok: true, matched: true, changed: false, waitId: 'w-2', elapsedMs: 3, output: 'done\n' },
    },
    '/api/v1/control/panes/run': { status: 200, body: { ok: true, paneId: 'local:%0', target: 'dev:0.1' } },
    '/api/v1/control/agent/wait': {
      status: 200,
      body: { ok: true, waitId: 'w-1', elapsedMs: 5, pane: { paneId: 'local:%1' } },
    },
  }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      requests.push({
        method: req.method || '',
        url: req.url || '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      })
      // 兼容旧键（裸 url）与新键（'METHOD url'）：方法限定键优先，保证 GET/POST 同路径可区分
      const canned = responses[`${req.method} ${req.url}`] || responses[req.url || '']
      if (!canned) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'Not found' }))
        return
      }
      res.writeHead(canned.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(canned.body))
    })
  })
  return new Promise<{ url: string; requests: RecordedRequest[]; responses: typeof responses; close: () => void }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        resolve({ url: `http://127.0.0.1:${port}`, requests, responses, close: () => server.close() })
      })
    },
  )
}

type SpawnResult = { status: number | null; stdout: string; stderr: string }
// 必须 async spawn：spawnSync 会阻塞本进程事件循环，进程内 mock gateway 无法应答
function runCtl(args: string[], env: Record<string, string> = {}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ctlBin, ...args], {
      env: {
        ...process.env,
        TMUXGO_ENV: '1',
        TMUXGO_AGENT_EVENT_TOKEN: 'ctl-secret',
        TMUXGO_GATEWAY_URL: 'http://127.0.0.1:1',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}
// stdout 契约：单行 JSON（或纯 help 文本），不得混入诊断日志
function stdoutJson(result: SpawnResult) {
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `stdout should be a single JSON line, got: ${result.stdout}`)
  return JSON.parse(lines[0])
}

test('cli help/initialize contract', async (t) => {
  const gateway = await startMockGateway()
  t.after(() => gateway.close())

  const help = await runCtl(['help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /protocol v1/)
  assert.match(help.stdout, /panes split/)

  const init = await runCtl(['initialize'], { TMUXGO_GATEWAY_URL: gateway.url })
  assert.equal(init.status, 0, init.stderr)
  const initBody = stdoutJson(init)
  assert.deepEqual(Object.keys(initBody).sort(), [
    'capabilities',
    'env',
    'gateway',
    'ok',
    'protocolVersion',
    'supportedVersions',
  ])
  assert.equal(initBody.ok, true)
  assert.equal(initBody.protocolVersion, 'v1')
  assert.deepEqual(initBody.supportedVersions, ['v1'])
  assert.ok(initBody.capabilities.includes('panes.split'))
  assert.equal(initBody.gateway.reachable, true)
  // 协商请求把客户端版本带上
  const initReq = gateway.requests.at(-1)!
  assert.equal(initReq.url, '/api/v1/control/initialize')
  assert.deepEqual(initReq.body, { protocolVersion: 'v1' })

  // 旧 gateway 无协商端点（404）→ 退回 /health 探测，仍兼容初始化
  delete gateway.responses['POST /api/v1/control/initialize']
  const legacy = await runCtl(['initialize'], { TMUXGO_GATEWAY_URL: gateway.url })
  assert.equal(legacy.status, 0, legacy.stderr)
  assert.equal(stdoutJson(legacy).protocolVersion, 'v1')
  assert.equal(stdoutJson(legacy).gateway.reachable, true)

  // 协商被明确拒绝（版本不支持）→ exit 1，错误码透出
  gateway.responses['POST /api/v1/control/initialize'] = {
    status: 400,
    body: { ok: false, code: 'UNSUPPORTED_PROTOCOL_VERSION', message: 'unsupported', supportedVersions: ['v2'] },
  }
  const rejected = await runCtl(['initialize'], { TMUXGO_GATEWAY_URL: gateway.url })
  assert.equal(rejected.status, 1)
  const rejectedBody = stdoutJson(rejected)
  assert.equal(rejectedBody.code, 'UNSUPPORTED_PROTOCOL_VERSION')
  assert.deepEqual(rejectedBody.supportedVersions, ['v2'])
  assert.equal(rejectedBody.gateway.reachable, true)

  // gateway 不可达：ok=false、exit 1、stdout 仍是合法 JSON
  const down = await runCtl(['initialize'], { TMUXGO_GATEWAY_URL: 'http://127.0.0.1:1' })
  assert.equal(down.status, 1)
  const downBody = stdoutJson(down)
  assert.equal(downBody.ok, false)
  assert.equal(downBody.gateway.reachable, false)
})

test('cli schema prints the gateway-exported protocol document', async (t) => {
  const gateway = await startMockGateway()
  t.after(() => gateway.close())
  const schema = await runCtl(['schema'], { TMUXGO_GATEWAY_URL: gateway.url })
  assert.equal(schema.status, 0, schema.stderr)
  const doc = stdoutJson(schema)
  assert.equal(doc.protocolVersion, 'v1')
  assert.equal(doc.basePath, '/api/v1/control')
  assert.ok(doc.methods['panes.read'])
  const req = gateway.requests.at(-1)!
  assert.equal(req.method, 'GET')
  assert.equal(req.headers['x-tmuxgo-agent-token'], 'ctl-secret')

  // schema 同样吃 env/token 本地守卫
  const noEnv = await runCtl(['schema'], { TMUXGO_ENV: '' })
  assert.equal(noEnv.status, 2)
  assert.equal(noEnv.stdout, '')
})

test('cli panes split/read forward contract and surface error envelope', async (t) => {
  const gateway = await startMockGateway()
  t.after(() => gateway.close())
  const env = { TMUXGO_GATEWAY_URL: gateway.url }

  const split = await runCtl(
    ['panes', 'split', '--pane-id', 'local:%0', '--direction', 'vertical', '--cwd', '/tmp'],
    env,
  )
  assert.equal(split.status, 0, `${split.stderr} ${split.stdout}`)
  assert.deepEqual(stdoutJson(split), { ok: true, paneId: 'local:%9' })
  const splitReq = gateway.requests.at(-1)!
  assert.equal(splitReq.headers['x-tmuxgo-env'], '1')
  assert.equal(splitReq.headers['x-tmuxgo-agent-token'], 'ctl-secret')
  assert.deepEqual(splitReq.body, { paneId: 'local:%0', direction: 'vertical', cwd: '/tmp' })

  const read = await runCtl(['panes', 'read', '--pane-id', 'local:%0', '--lines', '50'], env)
  assert.equal(read.status, 0, read.stderr)
  assert.deepEqual(stdoutJson(read), { ok: true, paneId: 'local:%0', output: 'line1\nline2' })
  assert.deepEqual(gateway.requests.at(-1)!.body, { paneId: 'local:%0', lines: 50 })

  // Task9 编排命令契约：body 字段精确转发、stdout 单行 JSON
  const snap = await runCtl(['panes', 'snapshot', '--pane-id', 'local:%0', '--lines', '20'], env)
  assert.equal(snap.status, 0, snap.stderr)
  assert.equal(stdoutJson(snap).snapshot.command, 'zsh')
  assert.deepEqual(gateway.requests.at(-1)!.body, { paneId: 'local:%0', lines: 20 })

  const waitOut = await runCtl(
    ['panes', 'wait-output', '--pane-id', 'local:%0', '--match', 'done', '--regex', '--timeout-ms', '5000'],
    env,
  )
  assert.equal(waitOut.status, 0, waitOut.stderr)
  assert.equal(stdoutJson(waitOut).matched, true)
  assert.deepEqual(gateway.requests.at(-1)!.body, {
    paneId: 'local:%0',
    match: 'done',
    regex: true,
    timeoutMs: 5000,
  })

  const run = await runCtl(['panes', 'run', '--pane-id', 'local:%0', '--text', 'echo hi', '--no-enter'], env)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(stdoutJson(run).ok, true)
  assert.deepEqual(gateway.requests.at(-1)!.body, { paneId: 'local:%0', text: 'echo hi', enter: false })

  // 远端错误 envelope 原样透出：exit 1、code/message 稳定
  gateway.responses['/api/v1/control/agent/wait'] = {
    status: 409,
    body: { ok: false, code: 'TIMEOUT', message: 'Agent wait timed out after 250ms' },
  }
  const waitErr = await runCtl(
    ['agent', 'wait', '--pane-id', 'local:%1', '--status', 'done', '--timeout-ms', '250'],
    env,
  )
  assert.equal(waitErr.status, 1)
  assert.deepEqual(stdoutJson(waitErr), { ok: false, code: 'TIMEOUT', message: 'Agent wait timed out after 250ms' })
  gateway.responses['/api/v1/control/agent/wait'] = {
    status: 200,
    body: { ok: true, waitId: 'w-1', elapsedMs: 5, pane: { paneId: 'local:%1' } },
  }

  const wait = await runCtl(['agent', 'wait', '--session', 'dev', '--agent', 'codex', '--status', 'blocked'], env)
  assert.equal(wait.status, 0, wait.stderr)
  const waitReq = gateway.requests.at(-1)!
  assert.deepEqual(waitReq.body.target, { sessionName: 'dev', agent: 'codex' })
  assert.deepEqual(waitReq.body.condition, { status: 'blocked' })
})

test('cli local validation and env guard contract', async () => {
  // 缺 TMUXGO_ENV → exit 2、stderr 有诊断、stdout 空
  const noEnv = await runCtl(['panes', 'read', '--pane-id', 'local:%0'], { TMUXGO_ENV: '' })
  assert.equal(noEnv.status, 2)
  assert.equal(noEnv.stdout, '')
  assert.match(noEnv.stderr, /TMUXGO_ENV=1 is required/)

  const noToken = await runCtl(['panes', 'read', '--pane-id', 'local:%0'], { TMUXGO_AGENT_EVENT_TOKEN: '' })
  assert.equal(noToken.status, 2)
  assert.match(noToken.stderr, /TMUXGO_AGENT_EVENT_TOKEN is not set/)

  // 缺必填 flag / 非法 flag → exit 2，stdout 空
  for (const args of [
    ['panes', 'read'],
    ['panes', 'split', '--pane-id', 'local:%0', '--direction', 'diagonal'],
    ['panes', 'read', '--pane-id', 'local:%0', '--lines', '99999'],
    ['panes', 'snapshot', '--pane-id', 'local:%0', '--lines', '500'],
    ['panes', 'wait-output', '--pane-id', 'local:%0', '--timeout-ms', '10'],
    ['panes', 'run', '--pane-id', 'local:%0'], // 无 --text
    ['panes', 'run', '--text', 'ls'], // 无 --pane-id
    ['agent', 'wait', '--status', 'done'], // 无 target
    ['agent', 'wait', '--pane-id', 'local:%1'], // 无 condition
    ['bogus'],
  ]) {
    const bad = await runCtl(args)
    assert.equal(bad.status, 2, `args=${args.join(' ')}`)
    assert.equal(bad.stdout, '', `stdout must stay clean on usage error: ${args.join(' ')}`)
  }

  // gateway 不可达 → exit 1 + 稳定 GATEWAY_UNREACHABLE envelope
  const down = await runCtl(['panes', 'read', '--pane-id', 'local:%0'])
  assert.equal(down.status, 1)
  assert.equal(stdoutJson(down).code, 'GATEWAY_UNREACHABLE')
})
