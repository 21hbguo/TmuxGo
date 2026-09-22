import { expect, test } from '@playwright/test'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appUrl = process.env.TMUXGO_AUTH_E2E_URL || 'http://127.0.0.1:3130'
const apiUrl = process.env.TMUXGO_AUTH_E2E_API_URL || 'http://127.0.0.1:3131'

test.beforeAll(() => {
  const configDir = process.env.TMUXGO_CONFIG_DIR?.trim()
  const realConfig = join(homedir(), '.tmuxgo')
  if (!configDir || resolve(configDir) === resolve(realConfig) || !resolve(configDir).startsWith(resolve(tmpdir()))) {
    throw new Error('default-password e2e requires an isolated TMUXGO_CONFIG_DIR under the system temp dir')
  }
  if (!process.env.TMUXGO_AUTH_E2E_URL) {
    throw new Error('default-password e2e requires TMUXGO_AUTH_E2E_URL (run via scripts/run-auth-e2e.ts)')
  }
})

async function browserStatus(page: any, path: string, method = 'GET') {
  return page.evaluate(async ({ apiUrl, path, method }: { apiUrl: string; path: string; method: string }) => (await fetch(`${apiUrl}${path}`, { method, credentials: 'include' })).status, { apiUrl, path, method })
}

test('default credentials require a password change before access', async ({ page }) => {
  await page.goto(appUrl)
  const usernameInput = page.locator('input[autocomplete="username"]')
  await expect(usernameInput).toBeVisible()
  await usernameInput.fill('admin')
  await page.locator('input[autocomplete="current-password"]').fill('admin123')
  await page.locator('form').getByRole('button').click()
  const newPassword = page.locator('input[autocomplete="new-password"]')
  await expect(newPassword).toBeVisible()
  expect(await browserStatus(page, '/api/hosts')).toBe(403)
  await page.locator('input[autocomplete="current-password"]').fill('admin123')
  await newPassword.fill('changed-e2e-password')
  await page.locator('form').getByRole('button').click()
  await expect(usernameInput).toBeVisible()
  await usernameInput.fill('admin')
  await page.locator('input[autocomplete="current-password"]').fill('changed-e2e-password')
  await page.locator('form').getByRole('button').click()
  await expect(usernameInput).toBeHidden()
  expect(await browserStatus(page, '/api/hosts')).toBe(200)
})
