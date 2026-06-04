import { expect } from '@playwright/test'
export async function ensureSession(request: any, name: string) {
  const response = await request.post('http://127.0.0.1:3001/api/hosts/local/sessions', { data: { name } })
  if (!response.ok()) throw new Error(await response.text())
  return response.json()
}
export async function openSession(page: any, session: { id: string; name: string }, options: { debugMobile?: boolean; expectHeader?: boolean } = {}) {
  await page.goto('/')
  await page.evaluate(({ id, debugMobile }) => {
    if (debugMobile) localStorage.setItem('tmuxgo-debug-mobile', '1')
    localStorage.setItem('tmuxgo-active-host', 'local')
    localStorage.setItem('tmuxgo-active-session:local', id)
    localStorage.setItem('tmuxgo-active-session', id)
  }, { id: session.id, debugMobile: options.debugMobile === true })
  await page.goto('/')
  await page.waitForFunction((id) => localStorage.getItem('tmuxgo-active-session:local') === id || localStorage.getItem('tmuxgo-active-session') === id, session.id, { timeout: 15000 })
  if (options.expectHeader !== false) await expect(page.locator('header').getByText(session.name)).toBeVisible({ timeout: 15000 })
}
export async function getActivePaneOutput(request: any, sessionId: string) {
  const snapshot = await request.get(`http://127.0.0.1:3001/api/hosts/local/sessions/${sessionId}/snapshot`)
  const data = await snapshot.json()
  const output = await request.get(`http://127.0.0.1:3001/api/panes/${encodeURIComponent(data.activePaneId)}/output`)
  return output.json()
}
