import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { apiUrl } from './endpoints'
import { ensureSession, openSession } from './session'

// recovery 候选 manifest 由 gateway 从 $TMUXGO_CONFIG_DIR/agent-recovery.json 懒读
// （JsonStore 每请求重读，无内存缓存），e2e 直接落文件模拟 agent 退出留下的候选。
// 页面侧只呈现与确认，任何 resume 都必须经用户显式确认后由 gateway 复检执行。

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
async function paneOutput(request: any, paneId: string) {
  const res = await request.get(`${apiUrl}/api/panes/${encodeURIComponent(paneId)}/output`)
  return ((await res.json()) as { data: string }).data
}
async function listCandidates(request: any) {
  const res = await request.get(`${apiUrl}/api/hosts/${hostId}/agent-recovery`)
  return ((await res.json()) as { candidates: any[] }).candidates
}
function seedCandidates(candidates: any[]) {
  if (!configDir) throw new Error('TMUXGO_CONFIG_DIR is required for agent-recovery e2e')
  writeFileSync(manifestPath, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), candidates })}\n`, {
    mode: 0o600,
  })
}
let candidateSeq = 0
function candidate(overrides: Record<string, unknown>) {
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
async function newTestPane(request: any, windowName: string) {
  const session = await ensureSession(request, 'test')
  const res = await request.post(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/windows`, {
    data: { name: windowName },
  })
  const window = await res.json()
  const panes = await (
    await request.get(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/panes`)
  ).json()
  const pane = panes.find((item: any) => item.windowId === window.id)
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

// 徽标 aria-label 与 dialog 标题同文案：锚定精确名 + role=button 区分
const badgeName = /^(Recoverable agents|可恢复的 Agent)$/
const recoveryDialogName = /Recoverable agents|可恢复的 Agent/i
const resumeName = /^(Resume|恢复)$/

test('candidate shows up and resumes only after explicit confirmation', async ({ page, request }) => {
  const { session, pane } = await newTestPane(request, `rec-ok-${Date.now().toString(36)}`)
  seedCandidates([
    candidate({ paneId: pane.id, tmuxPaneId: pane.tmuxPaneId, agent: 'claude', agentSessionId: 'e2e-resume-1' }),
  ])
  await openSession(page, session)
  const badge = page.getByRole('button', { name: badgeName })
  await expect(badge).toBeVisible()
  // 默认加载只展示候选：未确认前不得向 pane 注入任何 resume 命令
  expect(await paneOutput(request, pane.id)).not.toContain('claude --resume')
  expect((await listCandidates(request)).filter((item) => item.status === 'pending')).toHaveLength(1)

  await badge.click()
  const dialog = page.getByRole('dialog', { name: recoveryDialogName })
  const row = dialog.locator('div.border-b', { hasText: `claude · ${pane.tmuxPaneId}` })
  await row.getByRole('button', { name: resumeName }).click()
  const confirm = page.getByRole('dialog', { name: /Resume agent|恢复 Agent/i })
  await confirm.getByRole('button', { name: resumeName }).click()
  await expect(page.getByRole('status').filter({ hasText: /resumed|已恢复/ })).toBeVisible()
  // 恢复命令真实落进 pane
  await expect.poll(() => paneOutput(request, pane.id)).toContain('claude --resume e2e-resume-1')
  // 候选标记 resumed 后徽标消失
  await expect(badge).toHaveCount(0)
})

test('occupied, missing and unsupported-provider candidates are blocked in the UI', async ({ page, request }) => {
  const { session, pane } = await newTestPane(request, `rec-block-${Date.now().toString(36)}`)
  const { pane: idlePane } = await newTestPane(request, `rec-block2-${Date.now().toString(36)}`)
  // 先 attach 再占 pane（文本 send-keys 依赖 gateway 的 control client），
  // 占用成立后落 manifest，挂载拉取即见 blocked 终态，不等 15s 轮询
  await openSession(page, session)
  await typeInPane(pane.tmuxPaneId, 'sleep 300')
  await waitPaneCommand(pane.tmuxPaneId, (command) => command === 'sleep')
  seedCandidates([
    candidate({ paneId: pane.id, tmuxPaneId: pane.tmuxPaneId, agent: 'claude', agentSessionId: 'blk-occ' }),
    candidate({ paneId: 'local:%99997', tmuxPaneId: '%99997', agent: 'claude', agentSessionId: 'blk-miss' }),
    candidate({ paneId: idlePane.id, tmuxPaneId: idlePane.tmuxPaneId, agent: 'gemini', agentSessionId: 'blk-prov' }),
  ])
  await page.reload()
  const listed = await listCandidates(request)
  expect(listed.find((item) => item.tmuxPaneId === pane.tmuxPaneId)?.blockReason).toBe('pane_occupied')
  expect(listed.find((item) => item.tmuxPaneId === '%99997')?.blockReason).toBe('pane_missing')
  expect(listed.find((item) => item.tmuxPaneId === idlePane.tmuxPaneId)?.blockReason).toBe('provider_not_supported')
  const badge = page.getByRole('button', { name: badgeName })
  await expect(badge).toBeVisible({ timeout: 20000 })
  await badge.click()
  const dialog = page.getByRole('dialog', { name: recoveryDialogName })
  await expect(dialog.getByText(/Pane is occupied|Pane 被占用/)).toBeVisible()
  await expect(dialog.getByText(/Pane no longer exists|Pane 已不存在/)).toBeVisible()
  await expect(dialog.getByText(/Agent does not support resume|该 Agent 不支持恢复/)).toBeVisible()
  // 三类受阻候选的 Resume 全部禁用，不产生任何执行路径
  const resumeButtons = dialog.getByRole('button', { name: resumeName })
  await expect(resumeButtons).toHaveCount(3)
  for (let index = 0; index < 3; index += 1) await expect(resumeButtons.nth(index)).toBeDisabled()
})

test('failed resume surfaces the error and leaves the candidate pending', async ({ page, request }) => {
  const { session, pane } = await newTestPane(request, `rec-fail-${Date.now().toString(36)}`)
  seedCandidates([
    candidate({ paneId: pane.id, tmuxPaneId: pane.tmuxPaneId, agent: 'claude', agentSessionId: 'e2e-fail-1' }),
  ])
  await openSession(page, session)
  await page.getByRole('button', { name: badgeName }).click()
  const dialog = page.getByRole('dialog', { name: recoveryDialogName })
  await expect(dialog.getByText(`claude · ${pane.tmuxPaneId}`)).toBeVisible()
  // 列表取数后再把 pane 占住：resume 的权威复检必须拦下并报错
  await typeInPane(pane.tmuxPaneId, 'sleep 300')
  await waitPaneCommand(pane.tmuxPaneId, (command) => command === 'sleep')
  await dialog.getByRole('button', { name: resumeName }).click()
  const confirm = page.getByRole('dialog', { name: /Resume agent|恢复 Agent/i })
  await confirm.getByRole('button', { name: resumeName }).click()
  await expect(page.getByRole('alert')).toContainText(/occupied|占用/i)
  // 未执行的候选保持 pending，pane 内无 resume 命令
  expect((await listCandidates(request)).filter((item) => item.status === 'pending')).toHaveLength(1)
  expect(await paneOutput(request, pane.id)).not.toContain('claude --resume')
})
