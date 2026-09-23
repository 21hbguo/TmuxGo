import { expect, test } from '@playwright/test'

const appUrl = process.env.TMUXGO_AUTH_E2E_URL || 'http://127.0.0.1:3130'
const apiUrl = process.env.TMUXGO_AUTH_E2E_API_URL || 'http://127.0.0.1:3131'
const username = process.env.TMUXGO_AUTH_E2E_USERNAME || 'e2e-user'
const password = process.env.TMUXGO_AUTH_E2E_PASSWORD || 'e2e-password'

// PR 冒烟：登录 → 受保护资源 200 → 登出 → 401
test('login grants API access until logout', async ({ page }) => {
  const browserRequest = (path: string, method = 'GET') =>
    page.evaluate(
      async ({ apiUrl, path, method }: { apiUrl: string; path: string; method: string }) =>
        (await fetch(`${apiUrl}${path}`, { method, credentials: 'include' })).status,
      { apiUrl, path, method },
    )
  await page.goto(appUrl)
  const usernameInput = page.locator('input[autocomplete="username"]')
  await expect(usernameInput).toBeVisible()
  await usernameInput.fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  await page.locator('form').getByRole('button').click()
  await expect(usernameInput).toBeHidden()
  expect(await browserRequest('/api/hosts')).toBe(200)
  expect(await browserRequest('/api/auth/logout', 'POST')).toBe(200)
  expect(await browserRequest('/api/hosts')).toBe(401)
})
