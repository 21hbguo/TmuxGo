import assert from 'node:assert/strict'
import test from 'node:test'
import { detectAgentPaneState, resolveAgentStatus, summarizeAgentPanes } from './agent-state.js'

test('detects codex lifecycle from terminal output', () => {
  assert.deepEqual(detectAgentPaneState('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)\n›'), { agent: 'codex', agentStatus: 'working' })
  assert.deepEqual(detectAgentPaneState('node', 'Action Required', 'Allow command?\n[y/n]'), { agent: 'codex', agentStatus: 'blocked' })
  assert.deepEqual(detectAgentPaneState('node', 'TmuxGo', '› Use /skills to list available skills\n\n  gpt-5.6 medium · ~/project'), { agent: 'codex', agentStatus: 'idle' })
})
test('ignores ordinary node processes', () => {
  assert.equal(detectAgentPaneState('node', 'gateway', 'Gateway listening on port 3001'), null)
})
test('turns completed work into unseen done state', () => {
  assert.equal(resolveAgentStatus('idle', 'working'), 'done')
  assert.equal(resolveAgentStatus('idle', 'done'), 'done')
  assert.equal(resolveAgentStatus('working', 'idle'), 'working')
})
test('summarizes pane states', () => {
  const summary = summarizeAgentPanes([
    { paneId: 'local:%1', tmuxPaneId: '%1', sessionName: 'dev', agent: 'codex', agentStatus: 'working', revision: 1 },
    { paneId: 'local:%2', tmuxPaneId: '%2', sessionName: 'dev', agent: 'claude', agentStatus: 'blocked', revision: 2 },
  ])
  assert.deepEqual(summary, { idle: 0, working: 1, blocked: 1, done: 0, unknown: 0, total: 2 })
})
