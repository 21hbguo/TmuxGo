import { expect } from '@playwright/test'
import { apiUrl } from './endpoints'
export async function ensureSession(request: any, name: string) {
  const response = await request.post(`${apiUrl}/api/hosts/local/sessions`, { data: { name } })
  if (!response.ok()) throw new Error(await response.text())
  return response.json()
}
export async function openSession(page: any, session: { id: string; name: string }, options: { debugMobile?: boolean; expectHeader?: boolean } = {}) {
  await page.addInitScript(({ id, debugMobile }) => {
    if (debugMobile) localStorage.setItem('tmuxgo-debug-mobile', '1')
    localStorage.setItem('tmuxgo-active-host', 'local')
    localStorage.setItem('tmuxgo-active-session:local', id)
    localStorage.setItem('tmuxgo-active-session', id)
    const key = `tmuxgo-console-state:${/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop'}`
    const persisted = JSON.parse(localStorage.getItem(key) || '{}')
    localStorage.setItem(key, JSON.stringify({ ...persisted, state: { ...persisted.state, activeHostId: 'local', activeSessionId: id } }))
  }, { id: session.id, debugMobile: options.debugMobile === true })
  await page.goto('/')
  await page.waitForFunction((id) => localStorage.getItem('tmuxgo-active-session:local') === id || localStorage.getItem('tmuxgo-active-session') === id, session.id, { timeout: 15000 })
  if (options.expectHeader !== false) await expect(page.getByRole('button', { name: session.name, exact: false }).first()).toBeVisible({ timeout: 15000 })
}
export async function getActivePaneOutput(request: any, sessionId: string) {
  const snapshot = await request.get(`${apiUrl}/api/hosts/local/sessions/${sessionId}/snapshot`)
  const data = await snapshot.json()
  const output = await request.get(`${apiUrl}/api/panes/${encodeURIComponent(data.activePaneId)}/output`)
  return output.json()
}
