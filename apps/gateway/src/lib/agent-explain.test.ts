import '../test-env.js'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { detectAgentEvidence, explainAgentEvidence } from './agent-state.js'
import { BUNDLED_MANIFEST_VERSION, matchAgentScreenRule, type ScreenRuleTrace } from './agent-screen-rules.js'

// 三条 trace 路径：bundled 命中 / manifest 存在但无规则命中 / 无 manifest 回落
test('explains a bundled manifest rule hit', () => {
  const { detected, trace } = explainAgentEvidence('kimi', '', 'run this command?\n choose approve\n↵ confirm')
  assert.equal(detected?.phase, 'permission_required')
  assert.equal(detected?.agentStatus, 'blocked')
  assert.deepEqual(trace.agent, { name: 'kimi', source: 'command', evidence: 'pane_current_command=kimi' })
  assert.deepEqual(trace.screen?.manifest, {
    name: 'kimi',
    source: 'bundled',
    version: BUNDLED_MANIFEST_VERSION,
    ruleCount: 6,
  })
  assert.equal(trace.screen?.rule?.id, 'current_approval_panel')
  assert.equal(trace.screen?.rule?.priority, 400)
  // 该 rule 未写 phase：blocked 默认落到 permission_required（见 detectRawPhase）
  assert.equal(trace.screen?.rule?.phase, undefined)
  assert.equal(detected?.phase, 'permission_required')
  assert.equal(trace.phaseReason, 'screen-rule:current_approval_panel')
  // 规则定状态时 status 与 phase 同源，不再走通用词面
  assert.equal(trace.statusReason, undefined)
  assert.equal(trace.phaseReason, 'screen-rule:current_approval_panel')
})

test('explains why an existing manifest did not match', () => {
  const { trace } = explainAgentEvidence('opencode', '', 'plain text with no manifest vocabulary')
  assert.equal(trace.screen?.manifest?.name, 'opencode')
  assert.equal(trace.screen?.manifest?.source, 'bundled')
  assert.equal(trace.screen?.rule, null)
  assert.match(String(trace.screen?.miss), /no rule matched in bundled manifest "opencode"/)
  assert.equal(trace.phaseReason, 'default:idle')
  assert.equal(trace.statusReason, 'default:idle')
})

test('explains the fallback when the agent has no manifest', () => {
  const { detected, trace } = explainAgentEvidence('claude', '', 'Allow command?\n[y/n]')
  assert.equal(detected?.phase, 'permission_required')
  assert.equal(trace.screen?.manifest, null)
  assert.match(String(trace.screen?.miss), /no detection manifest for agent "claude"/)
  assert.equal(trace.phaseReason, 'generic:permission-pattern')
})

test('reports no evidence instead of inventing an agent', () => {
  const { detected, trace } = explainAgentEvidence('node', 'gateway', 'Gateway listening on port 3001')
  assert.equal(detected, null)
  assert.deepEqual(trace.agent, { name: null, source: 'none', evidence: 'no process/command/screen evidence' })
  assert.equal(trace.screen, undefined)
})

test('keeps trace out of the hot-path return value', () => {
  // detect/monitor 走 detectAgentEvidence：返回值不得携带 trace 字段（每轮轮询零开销的前提）
  const detected = detectAgentEvidence('codex', 'TmuxGo', 'Allow command?\n[y/n]')
  assert.ok(detected)
  assert.deepEqual(Object.keys(detected).sort(), ['agent', 'agentStatus', 'confidence', 'message', 'phase', 'source'])
})

test('labels an override manifest with its file and rule', async () => {
  const dir = path.join(process.env.TMUXGO_CONFIG_DIR!, 'agent-detection')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'mockbot.toml')
  await writeFile(
    file,
    `id = "mockbot"
[[rules]]
id = "mock_waiting"
state = "blocked"
phase = "needs_input"
priority = 700
region = "whole_recent"
contains = ["<<wait>>"]
`,
  )
  // 逐条断言而不是 deepEqual：override 分支还要带回真实文件路径
  const trace: ScreenRuleTrace = { manifest: null, rule: null }
  const hit = matchAgentScreenRule('mockbot', '', 'filler\n<<wait>>\n', trace)
  assert.equal(hit?.id, 'mock_waiting')
  assert.equal(trace.manifest?.name, 'mockbot')
  assert.equal(trace.manifest?.source, 'override')
  assert.equal(trace.manifest?.version, 'custom')
  assert.equal(trace.manifest?.ruleCount, 1)
  assert.ok(trace.manifest?.file?.endsWith(path.join('agent-detection', 'mockbot.toml')))
  assert.equal(trace.rule?.state, 'blocked')
  assert.equal(trace.rule?.phase, 'needs_input')
})
