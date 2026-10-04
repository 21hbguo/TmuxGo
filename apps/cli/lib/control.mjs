// TmuxGo agent control 薄客户端（零依赖）：把 /api/v1/control 包成脚本可调用命令。
// 契约（docs/agent-control/PROTOCOL.md）：
//   stdout 只输出单行 JSON 结果（成功 {ok:true,...} / 失败 {ok:false,code,message}），
//   诊断信息只走 stderr；退出码 0=成功 1=远端/协议错误 2=本地用法或环境错误。
// 环境：TMUXGO_ENV=1（gateway 注入 pane 的守卫，help 除外全员强制）、
//   TMUXGO_AGENT_EVENT_TOKEN、TMUXGO_GATEWAY_URL（默认 http://127.0.0.1:3001）。
import { writeSync } from 'node:fs'

const GATEWAY_URL = (process.env.TMUXGO_GATEWAY_URL || 'http://127.0.0.1:3001')
  .replace(/\/api\/stream\/?$/, '')
  .replace(/\/$/, '')
const TOKEN = process.env.TMUXGO_AGENT_EVENT_TOKEN || ''
const PROTOCOL_VERSION = 'v1'

// 同步写 + 立即 exit：stdout.write 到 pipe 是异步，process.exit 会截断缓冲；
// writeSync(1/2) 保证契约输出（stdout 单行 JSON）与退出码同时生效且不继续执行
// 远端响应统一出口：ok:false 时 stdout 仍输出错误 envelope，退出码置 1
function finish(result) {
  writeSync(1, JSON.stringify(result) + '\n')
  process.exit(result.ok === false ? 1 : 0)
}
function failUsage(message) {
  writeSync(2, `${message}\nRun 'tmuxgo-ctl help' for usage.\n`)
  process.exit(2)
}
const USAGE = `tmuxgo-ctl — TmuxGo agent control client (protocol ${PROTOCOL_VERSION})

Usage:
  tmuxgo-ctl initialize                 握手：协商协议版本 + 探测 gateway + 上报本地 env 状态
  tmuxgo-ctl schema                     打印 gateway 导出的协议 JSON Schema（单行 JSON）
  tmuxgo-ctl panes split --pane-id <host:%n> [--direction horizontal|vertical] [--cwd <dir>]
  tmuxgo-ctl panes read --pane-id <host:%n> [--lines 1-2000]
  tmuxgo-ctl panes snapshot --pane-id <host:%n> [--lines 1-100]
  tmuxgo-ctl panes wait-output --pane-id <host:%n> [--match <s>] [--regex]
                                [--lines 1-200] [--timeout-ms 250-600000]
  tmuxgo-ctl panes run --pane-id <host:%n> --text <t> [--no-enter] [--allow-occupied]
  tmuxgo-ctl agent wait (--pane-id <host:%n> | --session <name> --agent <name>)
                        [--status idle|working|blocked|done|unknown] [--phase <p>]
                        [--last-event <e>] [--host-id <h>] [--timeout-ms 250-600000]
  tmuxgo-ctl help

Env: TMUXGO_ENV=1 (required), TMUXGO_AGENT_EVENT_TOKEN, TMUXGO_GATEWAY_URL
stdout carries one JSON line per command; diagnostics go to stderr.
Exit codes: 0 ok · 1 remote/protocol error (JSON on stdout) · 2 usage/env error (stderr).`

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) failUsage(`Unexpected argument: ${arg}`)
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

function requireEnv(command) {
  if (process.env.TMUXGO_ENV !== '1') failUsage(`${command}: TMUXGO_ENV=1 is required (run inside a TmuxGo pane)`)
  if (!TOKEN) failUsage(`${command}: TMUXGO_AGENT_EVENT_TOKEN is not set`)
}

async function request(method, pathname, body, timeoutMs = 30000) {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/control${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-tmuxgo-env': '1',
        'x-tmuxgo-agent-token': TOKEN,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // wait 服务端挂起最长 600s，client 超时按其放宽 +10s 余量
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, code: 'BAD_GATEWAY_RESPONSE', message: `HTTP ${res.status}: non-JSON response` }
    }
    if (res.ok && payload && payload.ok !== false) return payload
    // 错误 envelope 保留服务端附加字段（如 supportedVersions），code/message 兜底
    const extra = payload && typeof payload === 'object' ? payload : {}
    return {
      ...extra,
      ok: false,
      code: extra.code || `HTTP_${res.status}`,
      message: extra.message || text || `HTTP ${res.status}`,
    }
  } catch (error) {
    return { ok: false, code: 'GATEWAY_UNREACHABLE', message: error instanceof Error ? error.message : String(error) }
  }
}
const post = (pathname, body, timeoutMs = 30000) => request('POST', pathname, body, timeoutMs)
const get = (pathname, timeoutMs = 30000) => request('GET', pathname, undefined, timeoutMs)

// /health 探测：旧 gateway（无 initialize 协商端点）的兼容路径
async function probeHealth() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(5000) })
    const body = await res.json().catch(() => ({}))
    return { reachable: res.ok, status: body.status || `HTTP_${res.status}` }
  } catch (error) {
    return { reachable: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function initialize() {
  const env = { tmuxgoEnv: process.env.TMUXGO_ENV === '1', token: !!TOKEN, gatewayUrl: GATEWAY_URL }
  // 版本协商：上报本地版本，gateway 返回协商结果（版本/capability/支持列表）
  const negotiated = await post('/initialize', { protocolVersion: PROTOCOL_VERSION }, 5000)
  let protocolVersion = PROTOCOL_VERSION
  let supportedVersions = [PROTOCOL_VERSION]
  let capabilities = []
  let gateway
  if (negotiated.ok !== false) {
    protocolVersion = negotiated.protocolVersion || PROTOCOL_VERSION
    supportedVersions = negotiated.supportedVersions || supportedVersions
    capabilities = negotiated.capabilities || []
    gateway = { reachable: true, status: 'ok' }
  } else if (negotiated.code === 'HTTP_404') {
    gateway = await probeHealth() // 旧 gateway 无协商端点，退回 /health 探测
  } else if (negotiated.code === 'GATEWAY_UNREACHABLE' || negotiated.code === 'BAD_GATEWAY_RESPONSE') {
    gateway = { reachable: false, message: negotiated.message }
  } else {
    // 协商被明确拒绝（含 UNSUPPORTED_PROTOCOL_VERSION）：gateway 可达但握手失败
    writeSync(
      1,
      JSON.stringify({
        ok: false,
        code: negotiated.code,
        message: negotiated.message,
        protocolVersion,
        supportedVersions: negotiated.supportedVersions || supportedVersions,
        gateway: { reachable: true, status: negotiated.code },
        env,
      }) + '\n',
    )
    process.exit(1)
  }
  const ok = gateway.reachable && env.tmuxgoEnv && env.token
  writeSync(1, JSON.stringify({ ok, protocolVersion, supportedVersions, capabilities, gateway, env }) + '\n')
  process.exit(ok ? 0 : 1)
}

async function main() {
  const [group, action] = process.argv.slice(2)
  const argv = process.argv.slice(4)
  if (group === 'help' || group === '--help' || group === '-h' || !group) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (group === 'initialize') await initialize()
  if (group === 'schema') {
    requireEnv('schema')
    const doc = await get('/schema', 10000)
    if (doc.ok === false) finish(doc)
    writeSync(1, JSON.stringify(doc) + '\n')
    process.exit(0)
  }
  const flags = parseFlags(argv)
  if (group === 'panes' && (action === 'split' || action === 'read' || action === 'snapshot')) {
    requireEnv(`panes ${action}`)
    if (typeof flags.paneId !== 'string' || !flags.paneId) failUsage('panes: --pane-id is required (e.g. local:%0)')
    if (action === 'split') {
      if (flags.direction !== undefined && !['horizontal', 'vertical'].includes(flags.direction))
        failUsage('panes split: --direction must be horizontal|vertical')
      const body = { paneId: flags.paneId, direction: flags.direction || 'horizontal' }
      if (typeof flags.cwd === 'string' && flags.cwd) body.cwd = flags.cwd
      finish(await post('/panes/split', body))
    } else {
      const body = { paneId: flags.paneId }
      if (flags.lines !== undefined) {
        const lines = Number(flags.lines)
        if (!Number.isInteger(lines) || lines < 1 || lines > (action === 'snapshot' ? 100 : 2000))
          failUsage(`panes ${action}: --lines must be an integer 1-${action === 'snapshot' ? 100 : 2000}`)
        body.lines = lines
      }
      finish(await post(`/panes/${action}`, body))
    }
  } else if (group === 'panes' && action === 'wait-output') {
    requireEnv('panes wait-output')
    if (typeof flags.paneId !== 'string' || !flags.paneId)
      failUsage('panes wait-output: --pane-id is required (e.g. local:%0)')
    const body = { paneId: flags.paneId }
    if (typeof flags.match === 'string' && flags.match) body.match = flags.match
    if (flags.regex === true) body.regex = true
    if (flags.lines !== undefined) {
      const lines = Number(flags.lines)
      if (!Number.isInteger(lines) || lines < 1 || lines > 200)
        failUsage('panes wait-output: --lines must be an integer 1-200')
      body.lines = lines
    }
    let timeoutMs = 60000
    if (flags.timeoutMs !== undefined) {
      timeoutMs = Number(flags.timeoutMs)
      if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 600000)
        failUsage('panes wait-output: --timeout-ms must be an integer 250-600000')
      body.timeoutMs = timeoutMs
    }
    finish(await post('/panes/wait-output', body, timeoutMs + 10000))
  } else if (group === 'panes' && action === 'run') {
    requireEnv('panes run')
    if (typeof flags.paneId !== 'string' || !flags.paneId) failUsage('panes run: --pane-id is required (e.g. local:%0)')
    if (typeof flags.text !== 'string' || !flags.text) failUsage('panes run: --text is required')
    const body = { paneId: flags.paneId, text: flags.text }
    if (flags.noEnter === true) body.enter = false
    if (flags.allowOccupied === true) body.allowOccupied = true
    finish(await post('/panes/run', body))
  } else if (group === 'agent' && action === 'wait') {
    requireEnv('agent wait')
    const target = flags.paneId
      ? { paneId: flags.paneId }
      : flags.session && flags.agent
        ? { sessionName: flags.session, agent: flags.agent }
        : null
    if (!target) failUsage('agent wait: need --pane-id <host:%n> or --session <name> --agent <name>')
    const condition = {}
    if (flags.status !== undefined) condition.status = flags.status
    if (flags.phase !== undefined) condition.phase = flags.phase
    if (flags.lastEvent !== undefined) condition.lastEvent = flags.lastEvent
    if (!Object.keys(condition).length)
      failUsage('agent wait: at least one of --status/--phase/--last-event is required')
    const body = { target, condition }
    if (flags.hostId !== undefined) body.hostId = flags.hostId
    let timeoutMs = 60000
    if (flags.timeoutMs !== undefined) {
      timeoutMs = Number(flags.timeoutMs)
      if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 600000)
        failUsage('agent wait: --timeout-ms must be an integer 250-600000')
      body.timeoutMs = timeoutMs
    }
    finish(await post('/agent/wait', body, timeoutMs + 10000))
  } else {
    failUsage(`Unknown command: ${[group, action].filter(Boolean).join(' ')}`)
  }
}

await main()
