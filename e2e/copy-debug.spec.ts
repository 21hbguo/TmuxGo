import { test, expect } from '@playwright/test'

async function ensureSession(request: any, name: string) {
  await request.post('http://127.0.0.1:3001/api/hosts/local/sessions', {
    data: { name },
  })
}

test('copy observability smoke', async ({ page, request }) => {
  const name = `tmuxgo_copy_debug_${Date.now()}`
  await ensureSession(request, name)
  await page.goto('/')
  await page.evaluate((sessionName) => {
    localStorage.setItem('tmuxgo-active-host', 'local')
    localStorage.setItem('tmuxgo-active-session', `session-${sessionName}`)
  }, name)
  await page.goto('/')
  await expect(page.locator('header').getByText(name)).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.getByText(/Copy (native|fallback): (ready|blocked)/)).toBeVisible({ timeout: 5000 })
})
