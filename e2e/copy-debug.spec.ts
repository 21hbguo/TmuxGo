import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'
const clipboardUnavailableText = /(clipboard unavailable|剪贴板不可用)/i

test('copy observability smoke', async ({ page, request }) => {
  const name = `tmuxgo_copy_debug_${Date.now()}`
  const session = await ensureSession(request, name)
  await openSession(page, session)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('clipboard unavailable')
        },
      },
    })
    document.execCommand = () => false
    window.addEventListener('tmuxgo-copy-terminal-selection', (event) => {
      const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId
      window.dispatchEvent(new CustomEvent('tmuxgo-terminal-selection', { detail: { requestId, selection: 'copy_debug_ok' } }))
    }, { once: true, capture: true })
  })
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.getByText(clipboardUnavailableText)).toBeVisible({ timeout: 5000 })
})
