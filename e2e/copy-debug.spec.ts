import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'

test('copy observability smoke', async ({ page, request }) => {
  const name = `tmuxgo_copy_debug_${Date.now()}`
  const session = await ensureSession(request, name)
  await openSession(page, session)
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.getByText(/Copy (native|fallback): (ready|blocked)/)).toBeVisible({ timeout: 5000 })
})
