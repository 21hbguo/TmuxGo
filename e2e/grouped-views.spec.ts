import { expect, test, type APIRequestContext, type Browser } from '@playwright/test'
import { apiUrl } from './endpoints'
import { ensureTestWindow, openSession, type SessionInfo, type WindowInfo } from './session'

// 两个独立 browser context = 两台设备：localStorage 里的 viewId 不同，
// 同一个 base session 下各自停在不同的 window。验证前端 viewId 生成/attach/select/读路径
// 与网关 grouped session 真的串起来了，而不是只在单测里各自成立。
async function openProfile(browser: Browser, viewId: string) {
  const context = await browser.newContext()
  await context.addInitScript((id) => localStorage.setItem('tmuxgo.viewId.v1', id), viewId)
  return { context, page: await context.newPage() }
}
async function snapshot(request: APIRequestContext, session: SessionInfo, viewId: string) {
  const response = await request.get(
    `${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/snapshot?viewId=${encodeURIComponent(viewId)}`,
  )
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as { activeWindowId: string; sessionName: string }
}
async function selectTab(page: import('@playwright/test').Page, window: WindowInfo) {
  const tab = page.getByRole('tab', { name: new RegExp(window.name) })
  await expect(tab).toBeVisible({ timeout: 15000 })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 5000 })
}
test('two browser profiles keep independent current windows on one session', async ({ browser, request }) => {
  const alpha = await ensureTestWindow(request, 'gv-alpha')
  const beta = await ensureTestWindow(request, 'gv-beta')
  const a = await openProfile(browser, 'browserA0001')
  const b = await openProfile(browser, 'browserB0002')
  try {
    await openSession(a.page, alpha.session)
    await selectTab(a.page, alpha.window)
    await expect
      .poll(async () => (await snapshot(request, alpha.session, 'browserA0001')).activeWindowId, { timeout: 15000 })
      .toBe(alpha.window.id)

    await openSession(b.page, beta.session)
    await selectTab(b.page, beta.window)
    await expect
      .poll(async () => (await snapshot(request, beta.session, 'browserB0002')).activeWindowId, { timeout: 15000 })
      .toBe(beta.window.id)

    // 第二台设备切窗不能把第一台带走；协议里的 session 身份始终是 base
    expect((await snapshot(request, alpha.session, 'browserA0001')).activeWindowId).toBe(alpha.window.id)
    expect((await snapshot(request, beta.session, 'browserB0002')).sessionName).toBe(alpha.session.name)

    const list = await request.get(`${apiUrl}/api/hosts/local/sessions?agents=0`)
    const names = ((await list.json()) as { name: string }[]).map((session) => session.name)
    expect(names.filter((name) => name.startsWith('tmuxgo-view-'))).toEqual([])
  } finally {
    await a.context.close()
    await b.context.close()
  }
})
