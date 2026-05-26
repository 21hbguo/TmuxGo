import { test, expect } from '@playwright/test'

async function ensureSession(request: any, name: string) {
  await request.post('http://127.0.0.1:3001/api/hosts/local/sessions', {
    data: { name },
  })
}

async function openSession(page: any, name: string) {
  await page.goto('/')
  await page.evaluate((sessionName) => {
    localStorage.setItem('tmuxgo-active-host', 'local')
    localStorage.setItem('tmuxgo-active-session', `session-${sessionName}`)
  }, name)
  await page.goto('/')
  await expect(page.locator('header').getByText(name)).toBeVisible()
}

async function getActivePaneOutput(request: any, name: string) {
  const snapshot = await request.get(`http://127.0.0.1:3001/api/hosts/local/sessions/session-${name}/snapshot`)
  const data = await snapshot.json()
  const output = await request.get(`http://127.0.0.1:3001/api/panes/${encodeURIComponent(data.activePaneId)}/output`)
  return output.json()
}

test('shows manual paste dialog when system clipboard throws', async ({ page, request }) => {
  await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, 'tmuxgo_e2e_clip')
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
  await expect(page.getByText('Paste manually')).toBeVisible()
  await expect(page.getByText('clipboard unavailable')).toBeVisible()
})

test('keyboard paste shortcut falls back when system clipboard throws', async ({ page, request }) => {
  await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, 'tmuxgo_e2e_clip')
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
  await expect(page.getByText('Paste manually')).toBeVisible()
})

test('can paste manual fallback text into tmux session', async ({ page, request }) => {
  await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, 'tmuxgo_e2e_clip')
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
  const dialog = page.getByText('Paste manually').locator('..')
  const textarea = dialog.locator('textarea')
  await textarea.fill("printf 'clip_manual_ok'")
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.waitForTimeout(700)
  const pane = await getActivePaneOutput(request, 'tmuxgo_e2e_clip')
  expect(pane.data).toContain('clip_manual_ok')
})

test('send keeps terminal focus so typing can continue immediately', async ({ page, request }) => {
  await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, 'tmuxgo_e2e_clip')
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
  const dialog = page.getByText('Paste manually').locator('..')
  await dialog.locator('textarea').fill("printf 'focus_send_ok'")
  await page.getByRole('button', { name: 'Send' }).click()
  await page.keyboard.type(" && printf 'focus_more_ok'")
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.waitForTimeout(700)
  const pane = await getActivePaneOutput(request, 'tmuxgo_e2e_clip')
  expect(pane.data).toContain('focus_send_ok')
  expect(pane.data).toContain('focus_more_ok')
})

test('can copy into app clipboard and paste back when system clipboard is unavailable', async ({ page, request }) => {
  await ensureSession(request, 'tmuxgo_e2e_clip')
  await openSession(page, 'tmuxgo_e2e_clip')
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
    }, { once: true })
  })
  await page.getByRole('button', { name: '复制' }).click()
  await expect(page.getByText('Clipboard unavailable, kept in app')).toBeVisible()
  await page.getByRole('button', { name: '粘贴' }).click()
  await expect(page.getByText('Confirm paste')).toBeVisible()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Pasted from app clipboard')).toBeVisible()
  await page.getByRole('button', { name: 'Enter' }).click()
  await page.waitForTimeout(700)
  const pane = await getActivePaneOutput(request, 'tmuxgo_e2e_clip')
  expect(pane.data).toContain('memory_path_ok')
})
