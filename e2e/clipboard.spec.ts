import { test, expect } from '@playwright/test'
import { ensureSession, getActivePaneOutput, openSession } from './session'
const manualPasteTitle = /^(Paste manually|手动粘贴)$/
const confirmPasteTitle = /^(Confirm paste|确认粘贴)$/
const clipboardUnavailableText = /(clipboard unavailable|剪贴板不可用)/i
const pasteFromAppText = /^(Pasted from app clipboard|已从应用剪贴板粘贴)$/
const sendButtonName = /^(Send|发送)$/
function pasteTextarea(page: any) {
  return page.locator('textarea').last()
}

test('shows manual paste dialog when system clipboard throws', async ({ page, request }) => {
  const session = await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, session)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error('failed to paste image: clipboard unavailable:Unkonwn error while interacting with the clipboard: x11 server connection timed out because it was unreachable')
        },
      },
    })
  })
  await page.getByRole('button', { name: '粘贴' }).click()
  await expect(page.getByText(manualPasteTitle)).toBeVisible()
  await expect(page.getByText(clipboardUnavailableText)).toBeVisible()
})

test('keyboard paste shortcut falls back when system clipboard throws', async ({ page, request }) => {
  const session = await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, session)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error('failed to paste image: clipboard unavailable:Unkonwn error while interacting with the clipboard: x11 server connection timed out because it was unreachable')
        },
      },
    })
  })
  await page.getByRole('textbox', { name: 'Terminal input' }).focus()
  await page.keyboard.press('Control+V')
  await expect(page.getByText(manualPasteTitle)).toBeVisible()
})

test('can paste manual fallback text into tmux session', async ({ page, request }) => {
  const session = await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, session)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error('clipboard unavailable')
        },
      },
    })
  })
  await page.getByRole('button', { name: '粘贴' }).click()
  await expect(page.getByText(manualPasteTitle)).toBeVisible()
  await pasteTextarea(page).fill("printf 'clip_manual_ok'")
  await page.getByRole('button', { name: sendButtonName }).click()
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.waitForTimeout(700)
  const pane = await getActivePaneOutput(request, session.id)
  expect(pane.data).toContain('clip_manual_ok')
})

test('send keeps terminal focus so typing can continue immediately', async ({ page, request }) => {
  const session = await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, session)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error('clipboard unavailable')
        },
      },
    })
  })
  await page.getByRole('button', { name: '粘贴' }).click()
  await expect(page.getByText(manualPasteTitle)).toBeVisible()
  await pasteTextarea(page).fill("printf 'focus_send_ok'")
  await page.getByRole('button', { name: sendButtonName }).click()
  await page.keyboard.type(" && printf 'focus_more_ok'")
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.waitForTimeout(700)
  const pane = await getActivePaneOutput(request, session.id)
  expect(pane.data).toContain('focus_send_ok')
  expect(pane.data).toContain('focus_more_ok')
})

test('send restores desktop ime helper geometry after confirmed paste', async ({ page, request }) => {
  const session = await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, session)
  await page.waitForFunction(() => !!document.querySelector('[data-terminal] .xterm-helper-textarea'))
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-request-terminal-paste', { detail: { text: 'printf "ime_geometry_ok"', source: 'system' } }))
  })
  await expect(page.getByText(confirmPasteTitle)).toBeVisible()
  await page.getByRole('button', { name: sendButtonName }).click()
  const metrics = await page.waitForFunction(() => {
    const helper = document.querySelector('[data-terminal] .xterm-helper-textarea') as HTMLTextAreaElement | null
    if (!helper) return null
    const rect = helper.getBoundingClientRect()
    return document.activeElement === helper && rect.width > 0 && rect.height > 0 && helper.style.left !== '-9999em' ? { left: helper.style.left, top: helper.style.top, width: helper.style.width, height: helper.style.height, zIndex: helper.style.zIndex } : null
  })
  const value = await metrics.jsonValue()
  expect(value).toMatchObject({ width: expect.stringMatching(/px$/), height: expect.stringMatching(/px$/), zIndex: '-5' })
})

test('can copy into app clipboard and paste back when system clipboard is unavailable', async ({ page, request }) => {
  const session = await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, session)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('clipboard unavailable')
        },
        readText: async () => {
          throw new Error('clipboard unavailable')
        },
      },
    })
    document.execCommand = () => false
  })
  await page.evaluate(() => {
    window.addEventListener('tmuxgo-copy-terminal-selection', (event) => {
      const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId
      window.dispatchEvent(new CustomEvent('tmuxgo-terminal-selection', { detail: { requestId, selection: 'printf "memory_path_ok"' } }))
    }, { once: true, capture: true })
  })
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.getByText(clipboardUnavailableText)).toBeVisible()
  await page.getByRole('button', { name: '粘贴' }).click()
  await expect(page.getByText(confirmPasteTitle)).toBeVisible()
  await page.getByRole('button', { name: sendButtonName }).click()
  await expect(page.getByText(pasteFromAppText)).toBeVisible()
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.waitForTimeout(700)
  const pane = await getActivePaneOutput(request, session.id)
  expect(pane.data).toContain('memory_path_ok')
})
