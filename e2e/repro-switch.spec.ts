import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ensureSession, openSession } from './session'
import type { TerminalProbe } from './probe-types'

// POST /api/hosts/:hostId/sessions/:id/input 已下线（终端输入统一走 WS 的 input 消息，
// 见 routes/stream.ts）。这里直接对 e2e 的隔离 tmux server 发 send-keys：
// 显式 -S socket + 清 TMUX，绝不触达用户的 default server
function sendKeys(sessionName: string, data: string) {
  const tmuxDir = process.env.TMUX_TMPDIR || ''
  const socket = join(tmuxDir, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`, 'default')
  const env = { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir }
  execFileSync('tmux', ['-S', socket, 'send-keys', '-l', '-t', sessionName, data], { env, encoding: 'utf8' })
  execFileSync('tmux', ['-S', socket, 'send-keys', '-t', sessionName, 'Enter'], { env, encoding: 'utf8' })
}

async function terminalState(page: Page) {
  return page.evaluate(() => {
    const terminal = document.querySelector('[data-terminal]') as HTMLElement | null
    const rows = terminal?.querySelector('.xterm-rows') as HTMLElement | null
    const t = (window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal
    const rect = terminal?.getBoundingClientRect()
    return {
      termWidth: rect?.width || 0,
      termHeight: rect?.height || 0,
      cols: t?.cols || 0,
      rows: t?.rows || 0,
      rowsText: rows?.textContent?.slice(0, 400) || '',
      visible: !!terminal && rect && rect.width > 50 && rect.height > 50,
    }
  })
}

test('switch session keeps terminal visible', async ({ page, request }) => {
  const a = await ensureSession(request, 'repro-switch-a')
  const b = await ensureSession(request, 'repro-switch-b')
  sendKeys(a.name, 'printf "MARKER-A"')
  sendKeys(b.name, 'printf "MARKER-B"')
  await openSession(page, { id: a.id, name: 'repro-switch-a' })
  await page.waitForFunction(
    () => !!(window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal,
    null,
    { timeout: 15000 },
  )
  await page.waitForTimeout(1500)
  const before = await terminalState(page)
  console.log('BEFORE switch:', JSON.stringify(before))
  expect(before.visible).toBe(true)
  await page.getByRole('button', { name: 'repro-switch-b' }).first().click()
  await page.waitForTimeout(4000)
  const after = await terminalState(page)
  console.log('AFTER switch:', JSON.stringify(after))
  expect(after.visible).toBe(true)
})
