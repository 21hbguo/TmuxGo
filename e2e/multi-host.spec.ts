import { spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { apiUrl } from './endpoints'
import { ensureSession } from './session'

test.setTimeout(60000)

test('switches between local and Agent hosts without mixing active sessions', async ({ page, request }) => {
  const hostId = `browser-agent-${Date.now()}`
  const session = await ensureSession(request, `tmuxgo_multi_host_${Date.now()}`)
  const agent = spawn(`${process.cwd()}/node_modules/.bin/tsx`, ['apps/agent/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, GATEWAY_URL: `${apiUrl.replace(/^http/, 'ws')}/api/stream`, HOST_ID: hostId, HOST_NAME: 'Browser Agent' }, stdio: 'ignore' })
  try {
    await expect.poll(async () => {
      const response = await request.get(`${apiUrl}/api/hosts/${hostId}`)
      const host = await response.json() as { connectionMode?: string; agent?: { online?: boolean } }
      return response.ok() && host.connectionMode === 'agent' && host.agent?.online === true
    }).toBe(true)
    const agentSession = await ensureSession(request, `tmuxgo_agent_multi_host_${Date.now()}`, hostId)
    await page.addInitScript(({ id, hostId, agentSessionId }) => {
      localStorage.setItem('tmuxgo-active-host', 'local')
      localStorage.setItem('tmuxgo-active-session', id)
      localStorage.setItem('tmuxgo-active-session:local', id)
      localStorage.setItem(`tmuxgo-active-session:${hostId}`, agentSessionId)
      const key = `tmuxgo-console-state:${/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop'}`
      const persisted = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(key, JSON.stringify({ ...persisted, state: { ...persisted.state, activeHostId: 'local', activeSessionId: id } }))
    }, { id: session.id, hostId, agentSessionId: agentSession.id })
    await page.goto('/')
    const hostSwitcher = page.locator('.tmuxgo-select-inline')
    await expect(hostSwitcher).toHaveValue('local')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local'))).toBe(session.id)
    await hostSwitcher.selectOption(hostId)
    await expect(hostSwitcher).toHaveValue(hostId)
    await expect.poll(() => page.evaluate(({ hostId }) => ({ host: localStorage.getItem('tmuxgo-active-host'), session: localStorage.getItem(`tmuxgo-active-session:${hostId}`) }), { hostId })).toEqual({ host: hostId, session: agentSession.id })
    await expect(page.getByRole('button', { name: agentSession.name, exact: false }).first()).toBeVisible()
    await hostSwitcher.selectOption('local')
    await expect(hostSwitcher).toHaveValue('local')
    await expect.poll(() => page.evaluate(({ hostId }) => ({ host: localStorage.getItem('tmuxgo-active-host'), local: localStorage.getItem('tmuxgo-active-session:local'), agent: localStorage.getItem(`tmuxgo-active-session:${hostId}`) }), { hostId })).toEqual({ host: 'local', local: session.id, agent: agentSession.id })
  } finally {
    if (agent.exitCode === null) agent.kill('SIGTERM')
    await Promise.race([new Promise<void>((resolve) => agent.once('exit', () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 5000))])
    if (agent.exitCode === null) agent.kill('SIGKILL')
  }
})
