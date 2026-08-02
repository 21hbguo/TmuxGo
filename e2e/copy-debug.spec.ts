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
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: 'printf "copy_debug_ok"\r' } }))
  })
  await page.waitForFunction(() => {
    const terminal = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    const buffer = terminal?.buffer?.active
    if (!buffer) return false
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || ''
      const column = line.indexOf('copy_debug_ok')
      if (column < 0) continue
      terminal.select(column, index, 'copy_debug_ok'.length)
      return true
    }
    return false
  })
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.getByText(clipboardUnavailableText)).toBeVisible({ timeout: 5000 })
})
