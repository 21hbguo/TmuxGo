import { expect, test } from '@playwright/test'

const appUrl = process.env.TMUXGO_AUTH_E2E_URL || 'http://127.0.0.1:3130'
const apiUrl = process.env.TMUXGO_AUTH_E2E_API_URL || 'http://127.0.0.1:3131'
const storagePath = process.env.TMUXGO_AUTH_E2E_STORAGE || '/tmp/tmuxgo-auth-restart.json'

test('keeps the authenticated browser session after Gateway restart', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: appUrl, storageState: storagePath })
  const page = await context.newPage()
  try {
    await page.goto(appUrl)
    await expect(page.locator('input[autocomplete="username"]')).toBeHidden()
    const status = await page.evaluate(async (url) => (await fetch(`${url}/api/hosts`, { credentials: 'include' })).status, apiUrl)
    expect(status).toBe(200)
  } finally {
    await context.close()
  }
})
