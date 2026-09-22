import { expect, test } from '@playwright/test'
import { appUrl, apiUrl } from './endpoints'
import { ensureTestWindow } from './session'

test('share link stays read-only and closes after revocation', async ({ page, request }) => {
  const { session } = await ensureTestWindow(request, 'share')
  const created = await request.post(`${apiUrl}/api/shares`, {
    data: { hostId: 'local', sessionName: session.name, expiresInMinutes: 5 },
  })
  expect(created.ok()).toBeTruthy()
  const link = (await created.json()) as { id: string; token: string }
  const sentFrames: string[] = []
  page.on('websocket', (socket) =>
    socket.on('framesent', (frame) => sentFrames.push(typeof frame === 'string' ? frame : frame.toString())),
  )
  await page.goto(`${appUrl}/share#token=${encodeURIComponent(link.token)}`)
  await expect(page.getByText(/只读|Read-only/)).toBeVisible({ timeout: 15000 })
  await page.locator('.xterm').click()
  await page.keyboard.type('forbidden-input')
  await page.waitForTimeout(200)
  expect(
    sentFrames
      .map((frame) => {
        try {
          return JSON.parse(frame)
        } catch {
          return null
        }
      })
      .filter((frame) => frame?.type === 'input'),
  ).toEqual([])
  await expect((await request.delete(`${apiUrl}/api/shares/${encodeURIComponent(link.id)}`)).ok()).toBeTruthy()
  await expect(page.getByText(/已断开连接|Disconnected/)).toBeVisible({ timeout: 5000 })
})
