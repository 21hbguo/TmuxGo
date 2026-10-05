import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_CAPABILITIES, CONTROL_ERROR_CODES } from '../apps/gateway/src/lib/control-protocol.js'
import { buildControlProtocolSchema } from '../apps/gateway/src/lib/control-schema.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const doc = buildControlProtocolSchema()
const methods = doc.methods as Record<string, { http: string; path: string; params?: any }>

// 三方共享同一份协议定义：gateway 运行时生成 = 静态导出文件 = CLI/MCP 引用的约束。
// 不触真实 :3001、不用真实凭据、不碰用户 tmux。

test('every control method (Task9/Task12 included) is present in the schema doc', () => {
  for (const name of [
    // Task9 编排原语
    'panes.snapshot',
    'panes.wait-output',
    'panes.run',
    // Task12 agent actions
    'agent.start',
    'agent.prompt',
    'agent.cancel',
    // 基线方法
    'initialize',
    'schema',
    'panes.split',
    'panes.read',
    'agent.wait',
    'push',
    'open-target',
    'inbox',
    'browser',
  ]) {
    assert.ok(methods[name], `schema doc missing method ${name}`)
    assert.ok(methods[name].http && methods[name].path, `${name} incomplete`)
    if (name !== 'schema') assert.ok(methods[name].params, `${name} missing params schema`)
  }
  assert.deepEqual(doc.errorCodes, [...CONTROL_ERROR_CODES])
  assert.deepEqual(doc.capabilities, [...CONTROL_CAPABILITIES])
})

test('checked-in schema doc is fresh (regenerate with scripts/generate-control-schema.ts)', () => {
  const file = join(root, 'skills/tmuxgo-control', `control-protocol.${doc.protocolVersion}.schema.json`)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), doc)
})

test('cli thin client validates against the same bounds as the protocol doc', () => {
  const cliSrc = readFileSync(join(root, 'apps/cli/lib/control.mjs'), 'utf8')
  // CLI 本地校验的边界（它暴露的 flag）必须与 params schema 一致：lines 上限、timeoutMs 范围
  const linesMax = [
    methods['panes.read'].params!.properties.lines.maximum,
    methods['panes.snapshot'].params!.properties.lines.maximum,
    methods['panes.wait-output'].params!.properties.lines.maximum,
  ]
  const timeout = methods['panes.wait-output'].params!.properties.timeoutMs
  for (const bound of [...linesMax, timeout.minimum, timeout.maximum]) {
    assert.ok(cliSrc.includes(String(bound)), `cli source missing protocol bound ${bound}`)
  }
  for (const direction of methods['panes.split'].params!.properties.direction.enum) {
    assert.ok(cliSrc.includes(direction), `cli source missing direction ${direction}`)
  }
  // 版本协商：CLI 上报的协议版本与文档一致
  assert.equal(doc.protocolVersion, 'v1')
  assert.match(cliSrc, /const PROTOCOL_VERSION = 'v1'/)
})

test('mcp pane tools mirror the protocol params constraints', async (t) => {
  // stdio spawn tools/list（无 token 即可列工具），inputSchema 与文档逐字段比对
  const configDir = mkdtempSync(join(tmpdir(), 'tmuxgo-mcp-'))
  const child = spawn(process.execPath, [join(root, 'apps/mcp/index.mjs')], {
    env: { ...process.env, TMUXGO_AGENT_EVENT_TOKEN: '', TMUXGO_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  t.after(() => {
    child.kill()
    rmSync(configDir, { recursive: true, force: true })
  })
  let buffer = ''
  const list = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tools/list timeout')), 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      resolve(JSON.parse(buffer.slice(0, index)))
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
  })

  const toolByName = new Map(list.result.tools.map((tool: any) => [tool.name, tool]))
  const mirror: Record<string, string> = {
    tmuxgo_pane_snapshot: 'panes.snapshot',
    tmuxgo_pane_wait_output: 'panes.wait-output',
    tmuxgo_pane_run: 'panes.run',
    tmuxgo_control_schema: 'schema',
  }
  const constraintKeys = ['type', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'enum', 'default']
  for (const [toolName, methodName] of Object.entries(mirror)) {
    const tool = toolByName.get(toolName)
    assert.ok(tool, `tools/list missing ${toolName}`)
    const params = methods[methodName].params
    if (!params) continue // schema 方法无 params
    const toolProps = tool.inputSchema.properties
    for (const [prop, propSchema] of Object.entries<any>(params.properties)) {
      const toolProp = toolProps[prop]
      assert.ok(toolProp, `${toolName} missing param ${prop}`)
      for (const key of constraintKeys) {
        if (propSchema[key] !== undefined && propSchema.type !== 'array') {
          assert.deepEqual(toolProp[key], propSchema[key], `${toolName}.${prop}.${key} drifted from protocol`)
        }
      }
    }
    assert.deepEqual(tool.inputSchema.required, params.required, `${toolName} required drifted`)
  }
})
