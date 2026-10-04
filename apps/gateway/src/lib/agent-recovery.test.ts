import '../test-env.js'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
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

test('upsert records a candidate and dedupes by pane + agentSessionId', () => {
  const first = upsertRecoveryCandidate(input, recoveryPath)
  assert.ok(first)
  const second = upsertRecoveryCandidate({ ...input, reason: 'process_exited' }, recoveryPath)
  assert.equal(second!.id, first!.id)
  assert.equal(second!.reason, 'process_exited')
  const listed = listRecoveryCandidates('local')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].agentSessionId, 'sess-abc-123')
  // 不同 agentSessionId → 独立候选
  upsertRecoveryCandidate({ ...input, agentSessionId: 'sess-other' }, recoveryPath)
  assert.equal(listRecoveryCandidates('local').length, 2)
})
test('store persists across reloads (gateway restart restores candidates)', () => {
  // manifest 是纯文件：「重启」= 换 config dir 重新读盘
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-restart-'))
  const file = path.join(dir, 'agent-recovery.json')
  const saved = upsertRecoveryCandidate({ ...input, paneId: 'local:%9', tmuxPaneId: '%9' }, file)
  assert.ok(saved)
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = dir
  const listed = listRecoveryCandidates('local')
  process.env.TMUXGO_CONFIG_DIR = previousDir
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, saved!.id)
  assert.equal(listed[0].status, 'pending')
})
test('expired and malformed entries are dropped on read', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-exp-')), 'agent-recovery.json')
  const stale = candidate({ id: 'old', lastSeenAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() })
  writeFileSync(file, JSON.stringify({ version: 1, candidates: [stale, { garbage: true }] }))
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = path.dirname(file)
  assert.equal(listRecoveryCandidates('local').length, 0)
  writeFileSync(file, JSON.stringify({ version: 2, candidates: [candidate()] }))
  assert.equal(listRecoveryCandidates('local').length, 0)
  process.env.TMUXGO_CONFIG_DIR = previousDir
})
test('mark resumed hides the candidate from the pending list', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'tmuxgo-recovery-mark-')), 'agent-recovery.json')
  const saved = upsertRecoveryCandidate({ ...input, paneId: 'local:%7', tmuxPaneId: '%7' }, file)
  const previousDir = process.env.TMUXGO_CONFIG_DIR
  process.env.TMUXGO_CONFIG_DIR = path.dirname(file)
  assert.equal(listRecoveryCandidates('local').length, 1)
  const marked = markRecoveryCandidateResumed('local', saved!.id)
  assert.equal(marked!.status, 'resumed')
  assert.equal(listRecoveryCandidates('local').length, 0)
  assert.equal(getRecoveryCandidate('local', saved!.id)?.status, 'resumed')
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
