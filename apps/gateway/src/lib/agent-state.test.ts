import '../test-env.js'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import {
  detectAgentEvidence,
  detectAgentPaneState,
  detectProcessAgent,
  resolveAgentStatus,
  shouldSkipCapture,
  summarizeAgentPanes,
} from './agent-state.js'
import { createTerminalOutputSanitizer } from './terminal-output.js'
import { execTmux } from './tmux-executor.js'
import { forgetAgentPane, getHostAgentPanes } from './agent-state.js'
import { killTestTmuxSession, TEST_TMUX_SESSION } from '../test-tmux.js'

test('detects codex lifecycle from terminal output', () => {
  assert.deepEqual(detectAgentPaneState('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)\n›'), {
    agent: 'codex',
    agentStatus: 'working',
  })
  assert.deepEqual(detectAgentPaneState('node', 'Action Required', 'Allow command?\n[y/n]'), {
    agent: 'codex',
    agentStatus: 'blocked',
  })
  assert.deepEqual(
    detectAgentPaneState('node', 'TmuxGo', '› Use /skills to list available skills\n\n  gpt-5.6 medium · ~/project'),
    { agent: 'codex', agentStatus: 'idle' },
  )
})
test('ignores ordinary node processes', () => {
  assert.equal(detectAgentPaneState('node', 'gateway', 'Gateway listening on port 3001'), null)
})
test('skips capture only when last output time is stable and non-empty', () => {
  const previous: any = { paneId: 'local:%1', lastOutputTime: '1723000000', paneDead: false }
  const noTime: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '', paneDead: false }
  const stable: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '1723000000', paneDead: false }
  const changed: any = { paneId: 'local:%1', tmuxHookEvent: undefined, lastOutputTime: '1723000500', paneDead: false }
  const hookEvent: any = {
    paneId: 'local:%1',
    tmuxHookEvent: { paneId: '%1', event: 'pane-command-started' },
    lastOutputTime: '1723000000',
    paneDead: false,
  }
  const deadChanged: any = {
    paneId: 'local:%1',
    tmuxHookEvent: undefined,
    lastOutputTime: '1723000000',
    paneDead: true,
  }
  assert.equal(shouldSkipCapture(previous, noTime), false)
  assert.equal(shouldSkipCapture(previous, stable), true)
  assert.equal(shouldSkipCapture(previous, changed), false)
  assert.equal(shouldSkipCapture(previous, hookEvent), false)
  assert.equal(shouldSkipCapture(previous, deadChanged), false)
  assert.equal(shouldSkipCapture(undefined, stable), false)
})
test('detects agents from pane child processes', () => {
  assert.equal(
    detectProcessAgent(
      'node /home/user/.nvm/versions/node/v22.22.0/bin/codex --dangerously-bypass-approvals-and-sandbox',
    ),
    'codex',
  )
  assert.equal(detectProcessAgent('/usr/local/bin/claude --dangerously-skip-permissions'), 'claude')
  assert.equal(detectProcessAgent('/usr/local/bin/reasonix'), 'reasonix')
  assert.equal(detectProcessAgent('node /srv/gateway.js'), null)
  assert.deepEqual(detectAgentPaneState('node', 'TmuxGo', '', 'codex'), { agent: 'codex', agentStatus: 'idle' })
  assert.equal(detectAgentPaneState('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)', null), null)
})
test('classifies phase evidence with source and confidence', () => {
  assert.deepEqual(detectAgentEvidence('codex', 'TmuxGo', 'Allow command?\n[y/n]'), {
    agent: 'codex',
    agentStatus: 'blocked',
    phase: 'permission_required',
    source: 'tmux',
    confidence: 'medium',
    message: 'Agent is waiting for permission',
  })
  assert.deepEqual(detectAgentEvidence('node', '⠹ TmuxGo', '• Working (10s • esc to interrupt)'), {
    agent: 'codex',
    agentStatus: 'working',
    phase: 'working',
    source: 'pane_output',
    confidence: 'low',
  })
  assert.deepEqual(detectAgentEvidence('node', 'TmuxGo', '', 'codex'), {
    agent: 'codex',
    agentStatus: 'idle',
    phase: 'idle',
    source: 'process',
    confidence: 'medium',
  })
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
  const sanitize = createTerminalOutputSanitizer()
  assert.equal(sanitize('ready\u001b[?1;'), 'ready')
  assert.equal(sanitize('2cnext'), 'next')
})

// 真实 tmux 用例：只操作隔离 server 上的 test session（test-tmux.ts 约定）
test('scans a local tmux Agent pane through the real executor path', async () => {
  const sessionName = TEST_TMUX_SESSION
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-agent-scan-'))
  const agentPath = path.join(tempDir, 'worker')
  const agentScript = [
    '#!/usr/bin/env node',
    "process.stdout.write('\\u001b]2;Action Required\\u0007Use /skills to list available skills\\ngpt-5.6 medium · ~/project\\n')",
    'setTimeout(() => {}, 30000)',
    '',
  ].join('\n')
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
    await killTestTmuxSession()
    await rm(tempDir, { recursive: true, force: true })
  }
})
test('detects reasonix working state from in-pane braille spinner', () => {
  assert.deepEqual(
    detectAgentEvidence(
      'node /home/user/.nvm/versions/node/v22.22.0/bin/reasonix',
      '',
      '  ⣽  思考中… (242 秒 · Esc 取消) · ↓12.7K',
      'reasonix',
    )?.phase,
    'working',
  )
  assert.deepEqual(
    detectAgentEvidence('node /home/user/.nvm/versions/node/v22.22.0/bin/reasonix', '', '⎿  ⠙ 运行中 · 0 秒', 'reasonix')
      ?.phase,
    'working',
  )
})
test('per-agent screen rules classify kimi/devin/opencode states', () => {
  // kimi：月相 spinner→working；审批面板→blocked；提问面板→needs_input
  assert.equal(detectAgentEvidence('kimi', '', 'some output\n🌕\n')?.phase, 'working')
  assert.equal(
    detectAgentEvidence('kimi', '', 'run this command?\n↵ confirm · esc cancel\n▶ approve · 1/2/3 choose')?.phase,
    'permission_required',
  )
  assert.equal(detectAgentEvidence('kimi', '', 'question\n↵ choose · ↑↓ select · esc cancel')?.phase, 'needs_input')
  // devin：running tools 页脚→working；approve once 共存时 blocked 优先；❭ 提示框→idle
  assert.equal(
    detectAgentEvidence('devin', '', 'doing stuff\nrunning tools · esc to interrupt\nx\ny\nz')?.phase,
    'working',
  )
  assert.equal(
    detectAgentEvidence('devin', '', 'running tools · esc to interrupt\napprove once · select · confirm · esc cancel')
      ?.phase,
    'permission_required',
  )
  assert.equal(detectAgentEvidence('devin', '', 'context: 3%\n❭ ')?.phase, 'idle')
  // opencode/mimo（同源 TUI 词面）：权限条→blocked；进度条/esc hint→working
  assert.equal(detectAgentEvidence('opencode', '', '△ Permission required\nesc dismiss')?.phase, 'permission_required')
  assert.equal(detectAgentEvidence('opencode', '', 'working hard\nesc to interrupt')?.phase, 'working')
  assert.equal(detectAgentEvidence('mimo', '', '■■■■■▸ building')?.phase, 'working')
})
test('detects dsh launcher binary as dsh-tui agent', () => {
  assert.equal(detectProcessAgent('dsh --profile dsh-tui'), 'dsh-tui')
  assert.equal(detectProcessAgent('dst'), 'dsh-tui')
})
test('TOML override manifest replaces bundled rules for its agent', async () => {
  const dir = path.join(process.env.TMUXGO_CONFIG_DIR!, 'agent-detection')
  await mkdir(dir, { recursive: true })
  // herdr 原版 TOML 格式（含 [[rules]]/inline table/(?i) 旗标/'literal' 字符串）应可直接落库
  await writeFile(
    path.join(dir, 'kimi.toml'),
    `id = "kimi"
version = "test"
[[rules]]
id = "custom_blocker"
state = "blocked"
priority = 500
region = "whole_recent"
contains = ["my custom blocker"]
[[rules]]
id = "custom_working"
state = "working"
priority = 100
line_regex = ['(?i)^\\s*spin-kimi$']
`,
  )
  assert.equal(detectAgentEvidence('kimi', '', 'blah\nmy custom blocker\n')?.phase, 'permission_required')
  assert.equal(detectAgentEvidence('kimi', '', 'spin-kimi')?.phase, 'working')
  // override 整体替换 bundled：月相 spinner 规则被覆盖后不再命中
  assert.notEqual(detectAgentEvidence('kimi', '', '🌕')?.phase, 'working')
  // devin 无 override 文件，仍走 bundled manifest
  assert.equal(detectAgentEvidence('devin', '', 'context: 3%\n❭ ')?.phase, 'idle')
  // 坏 TOML 不炸、不影响其它 agent
  await writeFile(path.join(dir, 'devin.toml'), '[[rules]\nnot valid at all {{{')
  assert.equal(detectAgentEvidence('devin', '', 'context: 3%\n❭ ')?.phase, 'idle')
})
