import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildResumeCommand,
  describeRecoveryCandidate,
  getRecoveryCandidate,
  inspectPaneRowFromList,
  listRecoveryCandidates,
  markRecoveryCandidateResumed,
  upsertRecoveryCandidate,
  type AgentRecoveryCandidate,
} from './agent-recovery.js'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-test-'))
process.env.TMUXGO_CONFIG_DIR = tmpDir
const recoveryPath = path.join(tmpDir, 'agent-recovery.json')
const candidate = (overrides: Partial<AgentRecoveryCandidate> = {}): AgentRecoveryCandidate => ({
  id: 'c1',
  hostId: 'local',
  sessionName: 'dev',
  paneId: 'local:%5',
  tmuxPaneId: '%5',
  agent: 'claude',
  agentSessionId: 'sess-abc-123',
  lastSeenAt: new Date().toISOString(),
  reason: 'pane_exited',
  status: 'pending',
  createdAt: new Date().toISOString(),
  ...overrides,
})
const input = {
  hostId: 'local',
  sessionName: 'dev',
  paneId: 'local:%5',
  tmuxPaneId: '%5',
  agent: 'claude',
  agentSessionId: 'sess-abc-123',
  reason: 'pane_exited',
}

test('upsert records a candidate and dedupes by pane + agentSessionId', async () => {
  const first = await upsertRecoveryCandidate(input, recoveryPath)
  assert.ok(first)
  const second = await upsertRecoveryCandidate({ ...input, reason: 'process_exited' }, recoveryPath)
  assert.equal(second!.id, first!.id)
  assert.equal(second!.reason, 'process_exited')
  const listed = await listRecoveryCandidates('local')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].agentSessionId, 'sess-abc-123')
  // 不同 agentSessionId → 独立候选
  await upsertRecoveryCandidate({ ...input, agentSessionId: 'sess-other' }, recoveryPath)
  assert.equal((await listRecoveryCandidates('local')).length, 2)
})
test('store persists across reloads (gateway restart restores candidates)', async () => {
  // manifest 是纯文件：「重启」= 换 config dir 重新读盘
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-restart-'))
  const file = path.join(dir, 'agent-recovery.json')
  const saved = await upsertRecoveryCandidate({ ...input, paneId: 'local:%9', tmuxPaneId: '%9' }, file)
  assert.ok(saved)
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  const listed = await listRecoveryCandidates('local')
  process.env.TMUXGO_CONFIG_DIR = previousDir
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, saved!.id)
  assert.equal(listed[0].status, 'pending')
})
test('expired and malformed entries are dropped on read', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-exp-'))
  const file = path.join(dir, 'agent-recovery.json')
  const stale = candidate({ id: 'old', lastSeenAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() })
  writeFileSync(file, JSON.stringify({ version: 1, candidates: [stale, { garbage: true }] }))
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  assert.equal((await listRecoveryCandidates('local')).length, 0)
  writeFileSync(file, JSON.stringify({ version: 2, candidates: [candidate()] }))
  // 版本不匹配走 JsonStore 损坏语义：主文件无 .bak 可救 → 报错而不是静默清空
  await assert.rejects(listRecoveryCandidates('local'), { code: 'JSON_STORE_CORRUPT' })
  process.env.TMUXGO_CONFIG_DIR = previousDir
})
test('mark resumed hides the candidate from the pending list', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-mark-'))
  const file = path.join(dir, 'agent-recovery.json')
  const saved = await upsertRecoveryCandidate({ ...input, paneId: 'local:%7', tmuxPaneId: '%7' }, file)
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  assert.equal((await listRecoveryCandidates('local')).length, 1)
  const marked = await markRecoveryCandidateResumed('local', saved!.id)
  assert.equal(marked!.status, 'resumed')
  assert.equal((await listRecoveryCandidates('local')).length, 0)
  assert.equal((await getRecoveryCandidate('local', saved!.id))?.status, 'resumed')
  process.env.TMUXGO_CONFIG_DIR = previousDir
})
test('concurrent upserts serialize without losing candidates and write mode 0600', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-conc-'))
  const file = path.join(dir, 'agent-recovery.json')
  const count = 15
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      upsertRecoveryCandidate({ ...input, paneId: `local:%${50 + index}`, tmuxPaneId: `%${50 + index}` }, file),
    ),
  )
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  const listed = await listRecoveryCandidates('local')
  process.env.TMUXGO_CONFIG_DIR = previousDir
  assert.equal(listed.length, count)
  assert.equal(new Set(listed.map((item) => item.id)).size, count)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})
test('corrupted manifest falls back to .bak instead of wiping candidates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-bak-'))
  const file = path.join(dir, 'agent-recovery.json')
  // 两次写入后 .bak 持有一条候选；主文件损坏 → 读回备份数据
  const first = await upsertRecoveryCandidate({ ...input, paneId: 'local:%60', tmuxPaneId: '%60' }, file)
  await upsertRecoveryCandidate({ ...input, paneId: 'local:%61', tmuxPaneId: '%61' }, file)
  writeFileSync(file, '{ not json')
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  const listed = await listRecoveryCandidates('local')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, first!.id)
  // 备份也坏 → 报错而不是清空数据
  writeFileSync(`${file}.bak`, 'broken')
  await assert.rejects(listRecoveryCandidates('local'), { code: 'JSON_STORE_CORRUPT' })
  // 损坏文件原样保留不被覆盖，可人工恢复
  assert.equal(readFileSync(file, 'utf8'), '{ not json')
  process.env.TMUXGO_CONFIG_DIR = previousDir
})
test('resume commands only build for allowlisted providers and safe ids', () => {
  assert.equal(buildResumeCommand('claude', 'abc-123'), 'claude --resume abc-123')
  assert.equal(buildResumeCommand('codex', 't-1'), 'codex resume t-1')
  assert.equal(buildResumeCommand('gemini', 'abc'), null)
  assert.equal(buildResumeCommand('claude', ''), null)
  assert.equal(buildResumeCommand('claude', undefined), null)
  for (const hostile of ['x; rm -rf /', 'x`id`', 'x && y', 'x$(id)', 'x"q"', 'x q']) {
    assert.equal(buildResumeCommand('claude', hostile), null, hostile)
  }
})
test('describe gates resumability on occupant, native id and provider', () => {
  const rows = new Map([
    ['%5', ['%5', 'zsh', '0', '/repo', 'dev', '1', '1', '0']],
    ['%6', ['%6', 'vim', '0', '/repo', 'dev', '1', '2', '0']],
    ['%7', ['%7', 'zsh', '1', '/repo', 'dev', '1', '3', '0']],
    ['%8', ['%8', 'zsh', '0', '/repo', 'dev', '1', '4', '1']],
  ])
  const inspect = (paneId: string) => inspectPaneRowFromList(rows, paneId)
  assert.deepEqual(describeRecoveryCandidate(candidate(), inspect('%5')), {
    resumable: true,
    blockReason: undefined,
    occupant: 'shell',
  })
  assert.equal(inspect('%5').target, 'dev:1.1')
  assert.equal(describeRecoveryCandidate(candidate(), inspect('%6')).blockReason, 'pane_occupied')
  assert.equal(describeRecoveryCandidate(candidate(), inspect('%7')).blockReason, 'pane_dead')
  assert.equal(describeRecoveryCandidate(candidate(), inspect('%8')).blockReason, 'pane_in_mode')
  assert.equal(describeRecoveryCandidate(candidate(), inspect('%99')).blockReason, 'pane_missing')
  assert.equal(
    describeRecoveryCandidate(candidate({ agentSessionId: undefined }), inspect('%5')).blockReason,
    'missing_session_id',
  )
  assert.equal(
    describeRecoveryCandidate(candidate({ agent: 'gemini' }), inspect('%5')).blockReason,
    'provider_not_supported',
  )
  assert.equal(describeRecoveryCandidate(candidate(), inspectPaneRowFromList(null, '%5')).blockReason, 'pane_unknown')
})
