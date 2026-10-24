import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { apiUrl } from './endpoints'
import { ensureSession, openSession } from './session'

// recovery 候选 manifest 由 gateway 从 $TMUXGO_CONFIG_DIR/agent-recovery.json 懒读
// （JsonStore 每请求重读，无内存缓存），e2e 直接落文件模拟 agent 退出留下的候选。
// 页面侧只呈现与确认，任何 resume 都必须经用户显式确认后由 gateway 复检执行。

interface RecoveryCandidate {
  id: string
  hostId: string
  sessionName: string
  reason: string
  status: string
  lastSeenAt: string
  createdAt: string
  tmuxPaneId?: string
  blockReason?: string
  [key: string]: unknown
}
interface PaneSummary {
  id: string
  tmuxPaneId: string
  windowId?: string
}

const hostId = 'local'
const configDir = process.env.TMUXGO_CONFIG_DIR || ''
const tmuxDir = process.env.TMUX_TMPDIR || ''
const manifestPath = join(configDir, 'agent-recovery.json')
const tmuxSocket = join(tmuxDir, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`, 'default')

// 显式 -S socket + 清 TMUX：只打隔离 server，绝不触达用户 default server（AGENTS.md 约定）
function tmux(args: string[]) {
  return execFileSync('tmux', ['-S', tmuxSocket, ...args], {
    env: { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir },
    encoding: 'utf8',
  })
}
function paneCommand(tmuxPaneId: string) {
  return tmux(['display-message', '-p', '-t', tmuxPaneId, '#{pane_current_command}']).trim()
}
// tmux 3.4 对 %N pane-id 的 send-keys 目标解析有 bug（agent-recovery.ts 同款注释）：
// client 已附着时按键会落进 active pane 而非目标 pane，必须换算成坐标 target
function paneTarget(tmuxPaneId: string) {
  return tmux(['display-message', '-p', '-t', tmuxPaneId, '#{session_name}:#{window_index}.#{pane_index}']).trim()
}
async function waitPaneCommand(tmuxPaneId: string, ready: (command: string) => boolean) {
  await expect.poll(async () => ready(await paneCommand(tmuxPaneId)), { timeout: 15000 }).toBe(true)
}
async function paneOutput(request: APIRequestContext, paneId: string) {
  const res = await request.get(`${apiUrl}/api/panes/${encodeURIComponent(paneId)}/output`)
  return ((await res.json()) as { data: string }).data
}
async function listCandidates(request: APIRequestContext) {
  const res = await request.get(`${apiUrl}/api/hosts/${hostId}/agent-recovery`)
  return ((await res.json()) as { candidates: RecoveryCandidate[] }).candidates
}
function seedCandidates(candidates: RecoveryCandidate[]) {
  if (!configDir) throw new Error('TMUXGO_CONFIG_DIR is required for agent-recovery e2e')
  writeFileSync(manifestPath, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), candidates })}\n`, {
    mode: 0o600,
  })
}
let candidateSeq = 0
function candidate(overrides: Record<string, unknown>): RecoveryCandidate {
  const now = new Date().toISOString()
  return {
    id: `e2e-${Date.now().toString(36)}-${candidateSeq++}`,
    hostId,
    sessionName: 'test',
    reason: 'pane_exited',
    status: 'pending',
    lastSeenAt: now,
    createdAt: now,
    ...overrides,
  }
}
// 在隔离 server 的 test session 开独立 window 取真实 pane 作候选目标
async function newTestPane(request: APIRequestContext, windowName: string) {
  const session = await ensureSession(request, 'test')
  const res = await request.post(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/windows`, {
    data: { name: windowName },
  })
  const window = (await res.json()) as { id: string }
  const panes = (await (
    await request.get(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/panes`)
  ).json()) as PaneSummary[]
  const pane = panes.find((item) => item.windowId === window.id)
  if (!pane) throw new Error(`No pane found for window ${windowName}`)
  // pane 进程异步就绪：occupant 判定前先等 shell 命令出现
  await waitPaneCommand(pane.tmuxPaneId, (command) => !!command && command !== 'tmux')
  return { session, pane }
}
// send-keys -l 文本 + 单独 Enter：同条命令发会被当成 key name 逐个解析。
// 文本 send-keys 需要已附着 client（gateway 在 openSession 后经 -C attach 建立）；
// attach 异步就绪，期间报 'no current client'，有界重试直到 client 上线
async function typeInPane(tmuxPaneId: string, text: string) {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const target = paneTarget(tmuxPaneId)
      tmux(['send-keys', '-l', '-t', target, text])
      tmux(['send-keys', '-t', target, 'Enter'])
      return
    } catch (error) {
      lastError = error
      if (!String(error).includes('no current client')) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}

// 注意：页面上「可恢复的 Agent」徽标当前没有挂载（SessionPanel 里保留但未接线，
// 见 T-211 结论），所以这组用例只断言 API 层语义：候选可见、显式 resume 生效、
// 受阻候选不被执行、失败后仍保持 pending。UI 呈现（徽标计数、弹窗、确认二次点击）
// 在徽标重新挂载前无法 e2e 断言，不在这里假装覆盖。
const hostIdPath = `/api/hosts/${hostId}/agent-recovery`

async function resumeViaApi(request: APIRequestContext, target: RecoveryCandidate) {
  const res = await request.post(`${apiUrl}${hostIdPath}/${encodeURIComponent(target.id)}/resume`, {
    data: { paneId: target.paneId, agentSessionId: target.agentSessionId || '' },
  })
  return { status: res.status(), body: (await res.json()) as { code?: string; message?: string } }
}

test('candidate shows up and resumes only after an explicit resume call', async ({ request }) => {
  const { pane } = await newTestPane(request, `rec-ok-${Date.now().toString(36)}`)
  seedCandidates([
    candidate({ paneId: pane.id, tmuxPaneId: pane.tmuxPaneId, agent: 'claude', agentSessionId: 'e2e-resume-1' }),
  ])
  // 只读列表：候选可见、可恢复，但不得有任何命令注入
  const listed = await listCandidates(request)
  const pending = listed.filter((item) => item.status === 'pending')
  expect(pending).toHaveLength(1)
  expect(pending[0].resumable).toBe(true)
  expect(await paneOutput(request, pane.id)).not.toContain('claude --resume')

  const result = await resumeViaApi(request, pending[0])
  expect(result.status).toBe(200)
  // 恢复命令真实落进 pane，候选转 resumed 后不再出现在待确认列表
  await expect.poll(() => paneOutput(request, pane.id), { timeout: 15000 }).toContain('claude --resume e2e-resume-1')
  expect((await listCandidates(request)).filter((item) => item.status === 'pending')).toHaveLength(0)
})

test('occupied, missing and unsupported-provider candidates are all refused', async ({ page, request }) => {
  const { session, pane } = await newTestPane(request, `rec-block-${Date.now().toString(36)}`)
  const { pane: idlePane } = await newTestPane(request, `rec-block2-${Date.now().toString(36)}`)
  // 只为让 gateway 建立 attach client：typeInPane 的文本 send-keys 依赖它，与徽标无关
  await openSession(page, session)
  await typeInPane(pane.tmuxPaneId, 'sleep 300')
  await waitPaneCommand(pane.tmuxPaneId, (command) => command === 'sleep')
  seedCandidates([
    candidate({ paneId: pane.id, tmuxPaneId: pane.tmuxPaneId, agent: 'claude', agentSessionId: 'blk-occ' }),
    candidate({ paneId: 'local:%99997', tmuxPaneId: '%99997', agent: 'claude', agentSessionId: 'blk-miss' }),
    candidate({ paneId: idlePane.id, tmuxPaneId: idlePane.tmuxPaneId, agent: 'gemini', agentSessionId: 'blk-prov' }),
  ])
  const listed = await listCandidates(request)
  const byPane = new Map(listed.map((item) => [item.tmuxPaneId, item]))
  expect(byPane.get(pane.tmuxPaneId)?.blockReason).toBe('pane_occupied')
  expect(byPane.get('%99997')?.blockReason).toBe('pane_missing')
  expect(byPane.get(idlePane.tmuxPaneId)?.blockReason).toBe('provider_not_supported')
  // 三类受阻候选中至少被占/不支持两类由服务端权威拒绝（missing 类目标 pane 已不存在）
  for (const [tmuxPaneId, code] of [
    [pane.tmuxPaneId, 'pane_occupied'],
    [idlePane.tmuxPaneId, 'provider_not_supported'],
  ] as const) {
    const item = byPane.get(tmuxPaneId)!
    const result = await resumeViaApi(request, item)
    expect(result.body.code).toBe(code)
    expect(result.status).toBe(code === 'pane_occupied' ? 409 : 400)
  }
  // 被拒的候选全部保持 pending，pane 内没有注入恢复命令
  expect((await listCandidates(request)).filter((item) => item.status === 'pending')).toHaveLength(3)
  expect(await paneOutput(request, pane.id)).not.toContain('claude --resume')
})

test('failed resume reports the block reason and leaves the candidate pending', async ({ request }) => {
  const { pane } = await newTestPane(request, `rec-fail-${Date.now().toString(36)}`)
  seedCandidates([
    candidate({ paneId: pane.id, tmuxPaneId: pane.tmuxPaneId, agent: 'claude', agentSessionId: 'e2e-fail-1' }),
  ])
  const [target] = (await listCandidates(request)).filter((item) => item.status === 'pending')
  // 取数后再把 pane 占住：resume 的权威复检必须拦下并给出可解释错误
  await typeInPane(pane.tmuxPaneId, 'sleep 300')
  await waitPaneCommand(pane.tmuxPaneId, (command) => command === 'sleep')
  const result = await resumeViaApi(request, target)
  expect(result.status).toBe(409)
  expect(result.body.code).toBe('pane_occupied')
  expect(result.body.message || '').toMatch(/occupied/i)
  expect((await listCandidates(request)).filter((item) => item.status === 'pending')).toHaveLength(1)
  expect(await paneOutput(request, pane.id)).not.toContain('claude --resume')
})
