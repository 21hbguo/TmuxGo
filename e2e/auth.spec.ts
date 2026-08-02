import { expect, test } from '@playwright/test'
const appUrl = process.env.TMUXGO_AUTH_E2E_URL || 'http://127.0.0.1:3130'
const apiUrl = process.env.TMUXGO_AUTH_E2E_API_URL || 'http://127.0.0.1:3131'
const username = process.env.TMUXGO_AUTH_E2E_USERNAME || 'e2e-user'
const password = process.env.TMUXGO_AUTH_E2E_PASSWORD || 'e2e-password'
async function browserRequest(page: any, path: string, method = 'GET') {
  return page.evaluate(async ({ apiUrl, path, method }: { apiUrl: string; path: string; method: string }) => {
    const response = await fetch(`${apiUrl}${path}`, { method, credentials: 'include' })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, { apiUrl, path, method })
}
test('authentication persists per device and protects resources after logout', async ({ browser }) => {
  const firstContext = await browser.newContext({ baseURL: appUrl, userAgent: 'TmuxGo auth E2E first device' })
  const secondContext = await browser.newContext({ baseURL: appUrl, userAgent: 'TmuxGo auth E2E second device' })
  const page = await firstContext.newPage()
  const secondPage = await secondContext.newPage()
  try {
    await page.goto(appUrl)
    const usernameInput = page.locator('input[autocomplete="username"]')
    await expect(usernameInput).toBeVisible()
    await usernameInput.fill(username)
    await page.locator('input[autocomplete="current-password"]').fill(password)
    const loginResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login')
    await page.locator('form').getByRole('button').click()
    const firstLogin = await (await loginResponse).json() as { sessionId: string }
    await expect(usernameInput).toBeHidden()
    expect((await browserRequest(page, '/api/hosts')).status).toBe(200)
    await page.reload()
    await expect(usernameInput).toBeHidden()
    expect((await browserRequest(page, '/api/hosts')).status).toBe(200)
    await secondPage.goto(appUrl)
    await secondPage.locator('input[autocomplete="username"]').fill(username)
    await secondPage.locator('input[autocomplete="current-password"]').fill(password)
    const secondLoginResponse = secondPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/login')
    await secondPage.locator('form').getByRole('button').click()
    const secondLogin = await (await secondLoginResponse).json() as { sessionId: string }
    expect(secondLogin.sessionId).not.toBe(firstLogin.sessionId)
    expect((await browserRequest(secondPage, '/api/hosts')).status).toBe(200)
    const sessions = await browserRequest(page, '/api/auth/sessions')
    expect(sessions.status).toBe(200)
    expect(sessions.body.sessions.map((session: { id: string }) => session.id)).toEqual(expect.arrayContaining([firstLogin.sessionId, secondLogin.sessionId]))
    expect((await browserRequest(page, '/api/auth/logout', 'POST')).status).toBe(200)
    expect((await browserRequest(page, '/api/hosts')).status).toBe(401)
    expect((await browserRequest(secondPage, '/api/hosts')).status).toBe(200)
    await page.reload()
    await expect(usernameInput).toBeVisible()
  } finally {
    await secondContext.close()
    await firstContext.close()
  }
})
