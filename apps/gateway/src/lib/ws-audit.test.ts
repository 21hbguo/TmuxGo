import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { appendWsMessageAudit, wsMessageTarget } from './ws-audit.js'

// 隔离审计文件：TMUXGO_AUDIT_LOG 指向临时目录，不碰真实 ~/.tmuxgo
function useAuditFile(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-ws-audit-'))
  const file = path.join(dir, 'audit.ndjson')
  const previous = process.env.TMUXGO_AUDIT_LOG
  process.env.TMUXGO_AUDIT_LOG = file
  t.after(() => {
    if (previous === undefined) delete process.env.TMUXGO_AUDIT_LOG
    else process.env.TMUXGO_AUDIT_LOG = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return file
}

async function readEvents(file: string) {
  // appendAuditEvent 是 fire-and-forget，等一拍让 appendFile 落盘
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 10))
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('ws message audit records success/denied/invalid/error with stable envelope', async (t) => {
  const file = useAuditFile(t)
  appendWsMessageAudit({
    actor: 'alice',
    source: 'ws',
    channel: 'stream',
    type: 'input',
    data: { data: 'keystroke-content' },
    target: 'dev',
    result: 'success',
  })
  appendWsMessageAudit({
    actor: 'share',
    source: 'share',
    channel: 'stream',
    type: 'input',
    data: { sessionName: 'dev' },
    result: 'failure',
    error: 'denied',
  })
  appendWsMessageAudit({
    actor: 'anonymous',
    source: 'ws',
    channel: 'browser',
    type: 'bogus',
    result: 'failure',
    error: 'invalid',
  })
  appendWsMessageAudit({
    actor: 'alice',
    source: 'ws',
    channel: 'stream',
    type: 'attach',
    data: { sessionName: 'dev', hostId: 'local' },
    result: 'failure',
    error: 'error',
    hostId: 'local',
  })

  const events = await readEvents(file)
  assert.equal(events.length, 4)

  // appendAuditEvent 是 fire-and-forget，落盘顺序不保证——按字段查找而非按下标
  const input = events.find((e) => e.action === 'ws-stream-input' && e.result === 'success')!
  const denied = events.find((e) => e.message === 'denied')!
  const invalid = events.find((e) => e.action === 'ws-browser-bogus')!
  const attachErr = events.find((e) => e.action === 'ws-stream-attach')!
  assert.equal(input.action, 'ws-stream-input')
  assert.equal(input.method, 'WS')
  assert.equal(input.result, 'success')
  assert.equal(input.statusCode, 200)
  assert.equal(input.actor, 'alice')
  assert.equal(input.user, 'alice')
  assert.equal(input.source, 'ws')
  assert.equal(input.target, 'dev')
  assert.ok(input.timestamp)

  assert.equal(denied.result, 'failure')
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.message, 'denied')
  assert.equal(denied.source, 'share')
  assert.equal(denied.target, 'dev')

  assert.equal(invalid.action, 'ws-browser-bogus')
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.message, 'invalid')
  assert.equal(invalid.target, '/api/browser/stream')

  assert.equal(attachErr.statusCode, 500)
  assert.equal(attachErr.message, 'error')
  assert.equal(attachErr.hostId, 'local')
  assert.equal(attachErr.target, 'dev · local')
})

test('ws message audit never persists message bodies, tokens or terminal output', async (t) => {
  const file = useAuditFile(t)
  appendWsMessageAudit({
    actor: 'alice',
    source: 'ws',
    channel: 'stream',
    type: 'input',
    data: {
      type: 'input',
      data: 'SECRET-KEYSTROKE',
      token: 'SECRET-TOKEN',
      password: 'SECRET-PASSWORD',
      url: 'https://SECRET-HOST/path',
      payload: { prompt: 'SECRET-PROMPT' },
      event: { output: 'SECRET-OUTPUT' },
      text: 'SECRET-TEXT',
      sessionName: 'dev',
      paneId: 'local:%3',
    },
    result: 'success',
  })
  appendWsMessageAudit({
    actor: 'agent',
    source: 'agent-token',
    channel: 'stream',
    type: 'agent-event',
    data: { event: { message: 'SECRET-EVENT' }, payload: 'SECRET-PAYLOAD', paneId: 'local:%1' },
    result: 'success',
    hostId: 'h1',
  })

  await readEvents(file) // 等待 fire-and-forget 落盘
  const raw = readFileSync(file, 'utf8')
  for (const secret of [
    'SECRET-KEYSTROKE',
    'SECRET-TOKEN',
    'SECRET-PASSWORD',
    'SECRET-HOST',
    'SECRET-PROMPT',
    'SECRET-OUTPUT',
    'SECRET-TEXT',
    'SECRET-EVENT',
    'SECRET-PAYLOAD',
  ]) {
    assert.ok(!raw.includes(secret), `audit log leaked ${secret}`)
  }
  // 标识字段仍可审计
  assert.ok(raw.includes('dev · local:%3'))
  assert.ok(raw.includes('ws-stream-agent-event'))
})

test('wsMessageTarget only extracts routing identifiers', () => {
  assert.equal(wsMessageTarget(undefined), '')
  assert.equal(wsMessageTarget('string'), '')
  assert.equal(wsMessageTarget({ data: 'x', url: 'u' }), '')
  assert.equal(wsMessageTarget({ sessionName: 'dev', hostId: 'local', targetId: 't1' }), 'dev · local · t1')
  assert.equal(wsMessageTarget({ paneId: 'local:%1' }), 'local:%1')
})

test('ws message audit tolerates unparseable data and defaults', async (t) => {
  const file = useAuditFile(t)
  appendWsMessageAudit({ actor: 'anonymous', source: 'ws', channel: 'stream', result: 'failure', error: 'invalid' })
  const events = await readEvents(file)
  assert.equal(events.length, 1)
  assert.equal(events[0].action, 'ws-stream-message')
  assert.equal(events[0].target, '/api/stream')
  assert.equal(events[0].statusCode, 400)
})
