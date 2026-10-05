import { test, expect } from '@playwright/test'
import { ensureTestWindow, openSession } from './session'
const clipboardUnavailableText = /(clipboard unavailable|剪贴板不可用)/i

test('copy observability smoke', async ({ page, request }) => {
  const { session } = await ensureTestWindow(request, 'copy-debug')
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
  const copyButton = page.getByRole('button', { name: '复制' })
  await page.waitForFunction(() => {
    const terminal = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    const buffer = terminal?.buffer?.active
    if (!buffer) return false
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || ''
      const column = line.indexOf('copy_debug_ok')
      if (column >= 0) return true
    }
    return false
  })
  await copyButton.evaluate((button) => {
    const terminal = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    const buffer = terminal?.buffer?.active
    for (let index = 0; index < (buffer?.length || 0); index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || ''
      const column = line.indexOf('copy_debug_ok')
      if (column < 0) continue
      terminal.select(column, index, 'copy_debug_ok'.length)
      button.click()
      return
    }
  })
  await expect(page.getByText(clipboardUnavailableText)).toBeVisible({ timeout: 5000 })
})
