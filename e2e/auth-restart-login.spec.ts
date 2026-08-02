import { expect, test } from '@playwright/test'

const appUrl = process.env.TMUXGO_AUTH_E2E_URL || 'http://127.0.0.1:3130'
const storagePath = process.env.TMUXGO_AUTH_E2E_STORAGE || '/tmp/tmuxgo-auth-restart.json'

test('stores an authenticated browser session before Gateway restart', async ({ page }) => {
  await page.goto(appUrl)
  await page.locator('input[autocomplete="username"]').fill(process.env.TMUXGO_AUTH_E2E_USERNAME || 'e2e-user')
  await page.locator('input[autocomplete="current-password"]').fill(process.env.TMUXGO_AUTH_E2E_PASSWORD || 'e2e-password')
  await page.locator('form').getByRole('button').click()
  await expect(page.locator('input[autocomplete="username"]')).toBeHidden()
  await page.context().storageState({ path: storagePath })
})
