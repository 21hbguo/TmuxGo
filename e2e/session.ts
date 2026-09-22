import { expect } from '@playwright/test'
import { apiUrl } from './endpoints'
export async function ensureSession(request: any, name: string, hostId = 'local') {
  const response = await request.post(`${apiUrl}/api/hosts/${encodeURIComponent(hostId)}/sessions`, { data: { name } })
  if (!response.ok()) throw new Error(await response.text())
  return response.json()
}
// 真实 tmux 行为场景统一在隔离 server 的 test session 内组织（对齐
// apps/gateway/src/test-tmux.ts 约定）：每个用例在 test 里建独立 window
// 区分场景、串行执行。仅被测对象本身是 session 管理（多 session 切换/仲裁/
// 多 host）的用例允许另行建 session——fixture 就是 session API，且仍落在
// 隔离 server 上，不触碰用户日常 session
export const TEST_SESSION_NAME = 'test'
export async function ensureTestWindow(request: any, name: string) {
  const session = await ensureSession(request, TEST_SESSION_NAME)
  const response = await request.post(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/windows`, {
    data: { name },
  })
  if (!response.ok()) throw new Error(await response.text())
  return { session, window: await response.json() }
}
export async function openSession(
  page: any,
  session: { id: string; name: string },
  options: { debugMobile?: boolean; expectHeader?: boolean } = {},
) {
  await page.addInitScript(
    ({ id, debugMobile }) => {
      if (debugMobile) localStorage.setItem('tmuxgo-debug-mobile', '1')
      localStorage.setItem('tmuxgo-active-host', 'local')
      localStorage.setItem('tmuxgo-active-session:local', id)
      localStorage.setItem('tmuxgo-active-session', id)
      const key = `tmuxgo-console-state:${/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop'}`
      const persisted = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(
        key,
        JSON.stringify({ ...persisted, state: { ...persisted.state, activeHostId: 'local', activeSessionId: id } }),
      )
    },
    { id: session.id, debugMobile: options.debugMobile === true },
  )
  await page.goto('/')
  await page.waitForFunction(
    (id) =>
      localStorage.getItem('tmuxgo-active-session:local') === id ||
      localStorage.getItem('tmuxgo-active-session') === id,
    session.id,
    { timeout: 15000 },
  )
  if (options.expectHeader !== false)
    await expect(page.getByRole('button', { name: session.name, exact: false }).first()).toBeVisible({ timeout: 15000 })
}
export async function getActivePaneOutput(request: any, sessionId: string) {
  const snapshot = await request.get(`${apiUrl}/api/hosts/local/sessions/${sessionId}/snapshot`)
  const data = await snapshot.json()
  const output = await request.get(`${apiUrl}/api/panes/${encodeURIComponent(data.activePaneId)}/output`)
  return output.json()
}
