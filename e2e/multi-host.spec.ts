import { spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { apiUrl } from './endpoints'
import { ensureSession } from './session'

test.setTimeout(60000)

test('switches between local and Agent hosts without mixing active sessions', async ({ page, request }) => {
  const hostId = `browser-agent-${Date.now()}`
  const session = await ensureSession(request, `tmuxgo_multi_host_${Date.now()}`)
  const agent = spawn(`${process.cwd()}/node_modules/.bin/tsx`, ['apps/agent/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GATEWAY_URL: `${apiUrl.replace(/^http/, 'ws')}/api/stream`,
      HOST_ID: hostId,
      HOST_NAME: 'Browser Agent',
    },
    stdio: 'ignore',
  })
  try {
    await expect
      .poll(async () => {
        const response = await request.get(`${apiUrl}/api/hosts/${hostId}`)
        const host = (await response.json()) as { connectionMode?: string; agent?: { online?: boolean } }
        return response.ok() && host.connectionMode === 'agent' && host.agent?.online === true
      })
      .toBe(true)
    const agentSession = await ensureSession(request, `tmuxgo_agent_multi_host_${Date.now()}`, hostId)
    await page.addInitScript(
      ({ id, hostId, agentSessionId }) => {
        localStorage.setItem('tmuxgo-active-host', 'local')
        localStorage.setItem('tmuxgo-active-session', id)
        localStorage.setItem('tmuxgo-active-session:local', id)
        localStorage.setItem(`tmuxgo-active-session:${hostId}`, agentSessionId)
        const key = `tmuxgo-console-state:${/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop'}`
        const persisted = JSON.parse(localStorage.getItem(key) || '{}')
        localStorage.setItem(
          key,
          JSON.stringify({ ...persisted, state: { ...persisted.state, activeHostId: 'local', activeSessionId: id } }),
        )
      },
      { id: session.id, hostId, agentSessionId: agentSession.id },
    )
    await page.goto('/')
    // 宿主切换器已从原生 <select> 换成自定义 combobox（Select.tsx inline 变体）：
    // 值挂在 data-value 上，选中要点击弹层里的 option，不再有 selectOption()
    const hostSwitcher = page.locator('.tmuxgo-select-inline')
    // 选项文案随 locale 变（本机/此设备/local-machine 都可能），按 data-value 选更稳。
    // 打开列表用键盘而不是点击：切换器外层是 <label>，点按钮会经 label 再转发一次 click，
    // 主机切换后重渲染时机不同，偶发开了又立刻关，等选项就永远等不到
    const pickHost = async (id: string) => {
      await hostSwitcher.focus()
      // 已展开时再按 Enter 是"确认当前项"，会把列表关掉；先看 aria-expanded 再决定开不开
      if ((await hostSwitcher.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('Enter')
      const option = page.locator(`[role="option"][data-value="${id}"]`).first()
      await option.waitFor({ state: 'visible', timeout: 5000 })
      await option.click()
      await expect(hostSwitcher).toHaveAttribute('data-value', id)
    }
    await expect(hostSwitcher).toHaveAttribute('data-value', 'local')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local'))).toBe(session.id)
    await pickHost(hostId)
    await expect(hostSwitcher).toHaveAttribute('data-value', hostId)
    await expect
      .poll(() =>
        page.evaluate(
          ({ hostId }) => ({
            host: localStorage.getItem('tmuxgo-active-host'),
            session: localStorage.getItem(`tmuxgo-active-session:${hostId}`),
          }),
          { hostId },
        ),
      )
      .toEqual({ host: hostId, session: agentSession.id })
    await expect(page.getByRole('button', { name: agentSession.name, exact: false }).first()).toBeVisible()
    await pickHost('local')
    await expect(hostSwitcher).toHaveAttribute('data-value', 'local')
    await expect
      .poll(() =>
        page.evaluate(
          ({ hostId }) => ({
            host: localStorage.getItem('tmuxgo-active-host'),
            local: localStorage.getItem('tmuxgo-active-session:local'),
            agent: localStorage.getItem(`tmuxgo-active-session:${hostId}`),
          }),
          { hostId },
        ),
      )
      .toEqual({ host: 'local', local: session.id, agent: agentSession.id })
  } finally {
    if (agent.exitCode === null) agent.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => agent.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
    if (agent.exitCode === null) agent.kill('SIGKILL')
  }
})
