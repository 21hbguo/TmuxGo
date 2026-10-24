import '../test-env.js'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execTmuxFile, killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'
import { agentControlRoutes } from './agent-control.js'
import { flushAuditWrites } from '../lib/audit-log.js'

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
const headers = { 'x-tmuxgo-agent-token': 'agent-control-secret', 'x-tmuxgo-env': '1' }
async function firstPaneId() {
  const { stdout } = await execTmuxFile('tmux', ['list-panes', '-s', '-t', TEST_TMUX_SESSION, '-F', '#{pane_id}'])
  return stdout.trim().split('\n')[0]
}
async function paneCommand(paneId: string) {
  const { stdout } = await execTmuxFile('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}'])
  return stdout.trim()
}
async function waitForPane(paneId: string, ready: (command: string) => boolean) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (ready(await paneCommand(paneId))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
async function freshServer(command?: string) {
  const args = ['-f', '/dev/null', 'new-session', '-d', '-s', TEST_TMUX_SESSION]
  if (command) args.push(command)
  await execTmuxFile('tmux', args)
}
function withFastify(t: test.TestContext) {
  const previousToken = process.env.TMUXGO_AGENT_EVENT_TOKEN
  process.env.TMUXGO_AGENT_EVENT_TOKEN = 'agent-control-secret'
  const fastify = Fastify()
  t.after(async () => {
    await fastify.close()
    await killTestTmuxSession()
    if (previousToken === undefined) delete process.env.TMUXGO_AGENT_EVENT_TOKEN
    else process.env.TMUXGO_AGENT_EVENT_TOKEN = previousToken
  })
  return fastify.register(agentControlRoutes).then(() => fastify)
}
const shellReady = (command: string) => !!command && command !== 'tmux'
const sendKeys = (fastify: ReturnType<typeof Fastify>, payload: Record<string, unknown>) =>
  fastify.inject({ method: 'POST', url: '/v1/control/panes/send-keys', headers, payload })

test('panes/send-keys delivers keys and returns canonical names', async (t) => {
  const fastify = await withFastify(t)
  await freshServer()
  const paneId = await firstPaneId()
  await waitForPane(paneId, shellReady)
  const res = await sendKeys(fastify, {
    paneId: `local:${paneId}`,
    // 别名 + 大小写混写：响应必须回 tmux 官方拼写
    keys: ['esc', 'TAB', 'C-a', 'pgup', 'F12', 'M-x'],
  })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.paneId, `local:${paneId}`)
  assert.ok(body.target)
  assert.deepEqual(body.keys, ['Escape', 'Tab', 'C-a', 'PPage', 'F12', 'M-x'])
})

test('panes/send-keys rejects the whole list when any key is unknown and writes no byte', async (t) => {
  const fastify = await withFastify(t)
  await freshServer('cat')
  const paneId = await firstPaneId()
  await waitForPane(paneId, (command) => command === 'cat')
  const res = await sendKeys(fastify, {
    paneId: `local:${paneId}`,
    // C-d 排在最前：若边校验边写，cat 会先收到 EOF 退出
    keys: ['C-d', 'bogus', 'ctrl+c'],
    allowOccupied: true,
  })
  assert.equal(res.statusCode, 400, res.body)
  const body = res.json()
  assert.equal(body.code, 'INVALID_KEY')
  assert.deepEqual(body.invalid, ['bogus', 'ctrl+c'])
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await paneCommand(paneId), 'cat', 'invalid request must not write any key')
})

test('panes/send-keys validates key names before writing or gating', async (t) => {
  const fastify = await withFastify(t)
  // cat 是「非 shell occupant」：键名非法时必须先报 INVALID_KEY（400），
  // 而不是先撞 occupant 门禁报 PANE_OCCUPIED——说明顺序是 校验 → 门禁 → 写字节
  await freshServer('cat')
  const paneId = await firstPaneId()
  await waitForPane(paneId, (command) => command === 'cat')
  const badKey = await sendKeys(fastify, { paneId: `local:${paneId}`, keys: ['nope'] })
  assert.equal(badKey.statusCode, 400, badKey.body)
  assert.equal(badKey.json().code, 'INVALID_KEY')
  assert.equal(await paneCommand(paneId), 'cat')
  // 空 keys：zod 兜住，按通用失败码返回
  const empty = await sendKeys(fastify, { paneId: `local:${paneId}`, keys: [] })
  assert.equal(empty.statusCode, 400, empty.body)
  assert.equal(empty.json().code, 'AGENT_CONTROL_SEND_KEYS_FAILED')
  // 超上限 16 键
  const tooMany = await sendKeys(fastify, {
    paneId: `local:${paneId}`,
    keys: Array.from({ length: 17 }, () => 'Esc'),
  })
  assert.equal(tooMany.statusCode, 400, tooMany.body)
})

test('panes/send-keys rejects missing panes and unknown hosts explicably', async (t) => {
  const fastify = await withFastify(t)
  await freshServer()
  const paneId = await firstPaneId()
  await waitForPane(paneId, (command) => !!command && command !== 'tmux')
  const missing = await sendKeys(fastify, { paneId: 'local:%999', keys: ['Esc'] })
  assert.equal(missing.statusCode, 409, missing.body)
  assert.equal(missing.json().code, 'PANE_MISSING')
  // 远端形状 paneId：host 未注册 → 400（不是 PANE_MISSING，host 问题不该伪装成 pane 问题）
  const unknownHost = await sendKeys(fastify, { paneId: 'nohost:%0', keys: ['Esc'] })
  assert.equal(unknownHost.statusCode, 400, unknownHost.body)
  assert.match(unknownHost.json().message, /not registered/)
})

test('panes/send-keys gates non-shell occupants behind allowOccupied', async (t) => {
  const fastify = await withFastify(t)
  await freshServer('cat')
  const paneId = await firstPaneId()
  await waitForPane(paneId, (command) => command === 'cat')
  const gated = await sendKeys(fastify, { paneId: `local:${paneId}`, keys: ['C-d'] })
  assert.equal(gated.statusCode, 409, gated.body)
  assert.equal(gated.json().code, 'PANE_OCCUPIED')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await paneCommand(paneId), 'cat', 'gated request must not write any key')
})

test('panes/send-keys audits only the action, pane, key names and result code', async (t) => {
  const auditPath = `${process.env.TMUXGO_CONFIG_DIR}/audit-send-keys.ndjson`
  const previousAudit = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = auditPath
  t.after(() => {
    if (previousAudit === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previousAudit
  })
  const fastify = await withFastify(t)
  await freshServer()
  const paneId = await firstPaneId()
  await waitForPane(paneId, shellReady)
  await sendKeys(fastify, { paneId: `local:${paneId}`, keys: ['esc', 'C-c'] })
  await sendKeys(fastify, { paneId: `local:${paneId}`, keys: ['Esc', 'bogus'] })
  await flushAuditWrites()
  const events = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, string | number>)
    .filter((event) => event.action === 'pane.send_keys')
  assert.equal(events.length, 2, JSON.stringify(events))
  const [ok, failed] = events
  assert.equal(ok.result, 'success')
  assert.equal(ok.target, `local:${paneId}`)
  assert.equal(ok.message, 'Escape C-c')
  assert.equal(failed.result, 'failure')
  assert.equal(failed.statusCode, 400)
  assert.equal(failed.message, 'INVALID_KEY Esc bogus')
})
