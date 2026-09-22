import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'

// PR 冒烟：终端附着 + 基本输入回显（重量级 fluency/multiclient 用例仍走手动 e2e）
test('attaches terminal and echoes basic input', async ({ page, request }) => {
  const session = await ensureSession(request, 'pr-smoke')
  await openSession(page, session)
  await expect(page.locator('[data-terminal] .xterm').first()).toBeVisible({ timeout: 15000 })
  await page.waitForFunction(() => (window as any).__tmuxgoTerminal, null, { timeout: 15000 })
  const marker = `PR_SMOKE_${Date.now()}`
  // 输入经 tmuxgo-terminal-input → PaneGrid.handleInput → WS 写入 tmux，覆盖真实输入链路
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: `printf "${value}\\n"\r` } }))
  }, marker)
  await page.waitForFunction(
    (value) => {
      const buffer = (window as any).__tmuxgoTerminal?.buffer?.active
      if (!buffer) return false
      for (let i = 0; i < Math.min(buffer.length || 0, 240); i += 1) {
        if ((buffer.getLine(i)?.translateToString(true) || '').includes(value)) return true
      }
      return false
    },
    marker,
    { timeout: 15000 },
  )
})
