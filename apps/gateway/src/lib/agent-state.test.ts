import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { detectAgentEvidence, detectAgentPaneState, detectProcessAgent, resolveAgentStatus, shouldSkipCapture, summarizeAgentPanes } from './agent-state.js'
import { createTerminalOutputSanitizer } from './terminal-output.js'
import { execTmux } from './tmux-executor.js'
import { forgetAgentPane, getHostAgentPanes } from './agent-state.js'

const execFileAsync = promisify(execFile)

test('detects codex lifecycle from terminal output', () => {
  assert.deepEqual(detectAgentPaneState('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)\n›'), { agent: 'codex', agentStatus: 'working' })
  assert.deepEqual(detectAgentPaneState('node', 'Action Required', 'Allow command?\n[y/n]'), { agent: 'codex', agentStatus: 'blocked' })
  assert.deepEqual(detectAgentPaneState('node', 'TmuxGo', '› Use /skills to list available skills\n\n  gpt-5.6 medium · ~/project'), { agent: 'codex', agentStatus: 'idle' })
})
test('ignores ordinary node processes', () => {
  assert.equal(detectAgentPaneState('node', 'gateway', 'Gateway listening on port 3001'), null)
})
test('skips capture only when last output time is stable and non-empty', () => {
  const previous: any = { paneId: 'local:%1', lastOutputTime: '1723000000', paneDead: false }
  const noTime: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '', paneDead: false }
  const stable: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '1723000000', paneDead: false }
  const changed: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '1723000500', paneDead: false }
  const hookEvent: any = { paneId: 'local:%1', tmuxHookEvent: { paneId: '%1', event: 'pane-command-started' }, lastOutputTime: '1723000000', paneDead: false }
  const deadChanged: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '1723000000', paneDead: true }
  assert.equal(shouldSkipCapture(previous, noTime), false)
  assert.equal(shouldSkipCapture(previous, stable), true)
  assert.equal(shouldSkipCapture(previous, changed), false)
  assert.equal(shouldSkipCapture(previous, hookEvent), false)
  assert.equal(shouldSkipCapture(previous, deadChanged), false)
  assert.equal(shouldSkipCapture(undefined, stable), false)
})
test('detects agents from pane child processes', () => {  assert.equal(detectProcessAgent('node /home/guo/.nvm/versions/node/v22.22.0/bin/codex --dangerously-bypass-approvals-and-sandbox'), 'codex')
  assert.equal(detectProcessAgent('/usr/local/bin/claude --dangerously-skip-permissions'), 'claude')
  assert.equal(detectProcessAgent('/usr/local/bin/reasonix'), 'reasonix')
  assert.equal(detectProcessAgent('node /srv/gateway.js'), null)
  assert.deepEqual(detectAgentPaneState('node', 'TmuxGo', '', 'codex'), { agent: 'codex', agentStatus: 'idle' })
  assert.equal(detectAgentPaneState('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)', null), null)
})
test('classifies phase evidence with source and confidence', () => {
  assert.deepEqual(detectAgentEvidence('codex', 'TmuxGo', 'Allow command?\n[y/n]'), { agent: 'codex', agentStatus: 'blocked', phase: 'permission_required', source: 'tmux', confidence: 'medium', message: 'Agent is waiting for permission' })
  assert.deepEqual(detectAgentEvidence('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)'), { agent: 'codex', agentStatus: 'working', phase: 'working', source: 'pane_output', confidence: 'low' })
  assert.deepEqual(detectAgentEvidence('node', 'TmuxGo', '', 'codex'), { agent: 'codex', agentStatus: 'idle', phase: 'idle', source: 'process', confidence: 'medium' })
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
test('sanitizes terminal device attributes across chunks', () => {
  const sanitize=createTerminalOutputSanitizer()
  assert.equal(sanitize('ready\u001b[?1;'), 'ready')
  assert.equal(sanitize('2cnext'), 'next')
})

test('scans a local tmux Agent pane through the real executor path', async () => {
  const sessionName = `tmuxgo-agent-scan-${process.pid}-${Date.now()}`
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-agent-scan-'))
  const agentPath = path.join(tempDir, 'worker')
  const agentScript = ['#!/usr/bin/env node', "process.stdout.write('\\u001b]2;Action Required\\u0007Use /skills to list available skills\\ngpt-5.6 medium · ~/project\\n')", 'setTimeout(() => {}, 30000)', ''].join('\n')
  await writeFile(agentPath, agentScript)
  await chmod(agentPath, 0o700)
  let paneId = ''
  try {
    await execTmux('local', ['new-session', '-d', '-s', sessionName, agentPath])
    await new Promise((resolve) => setTimeout(resolve, 200))
    const states = await getHostAgentPanes('local', [sessionName])
    assert.equal(states.length, 1)
    paneId = states[0]?.paneId || ''
    assert.equal(states[0]?.sessionName, sessionName)
    assert.equal(states[0]?.agent, 'codex')
    assert.equal(states[0]?.source, 'pane_output')
    assert.equal(states[0]?.confidence, 'low')
  } finally {
    if (paneId) forgetAgentPane(paneId)
    await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => {})
    await rm(tempDir, { recursive: true, force: true })
  }
})
test('detects reasonix working state from in-pane braille spinner', () => {
  assert.deepEqual(detectAgentEvidence('node /home/guo/.nvm/versions/node/v22.22.0/bin/reasonix', '', '  ⣽  思考中… (242 秒 · Esc 取消) · ↓12.7K', 'reasonix')?.phase, 'working')
  assert.deepEqual(detectAgentEvidence('node /home/guo/.nvm/versions/node/v22.22.0/bin/reasonix', '', '⎿  ⠙ 运行中 · 0 秒', 'reasonix')?.phase, 'working')
})
