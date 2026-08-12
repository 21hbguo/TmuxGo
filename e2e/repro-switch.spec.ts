import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'

async function sendKeys(request: any, sessionId: string, data: string) {
  const res = await request.post(`/api/hosts/local/sessions/${sessionId}/input`, { data: { data } })
  if (!res.ok()) throw new Error(await res.text())
}

async function terminalState(page: any) {
  return page.evaluate(() => {
    const terminal = document.querySelector('[data-terminal]') as HTMLElement | null
    const xterm = terminal?.querySelector('.xterm') as HTMLElement | null
    const rows = terminal?.querySelector('.xterm-rows') as HTMLElement | null
    const t = (window as any).__tmuxgoTerminal
    const rect = terminal?.getBoundingClientRect()
    const overlay = document.querySelector('[data-pane-grid] [class*="inset-0"]') as HTMLElement | null
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
  await sendKeys(request, a.id, 'printf "MARKER-A\\n"\r')
  await sendKeys(request, b.id, 'printf "MARKER-B\\n"\r')
  await openSession(page, { id: a.id, name: 'repro-switch-a' })
  await page.waitForFunction(() => (window as any).__tmuxgoTerminal, null, { timeout: 15000 })
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
