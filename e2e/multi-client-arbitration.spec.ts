import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { ensureSession, openSession } from './session'

function tmuxSize(sessionName: string) {
  // window_height 是 pane 内容区，不含状态行；独占 client 的 pty/xterm 行数
  // = window_height + status 行数（status on=1，数字即行数，off=0）
  const out = execFileSync('tmux', [
    'display-message',
    '-p',
    '-t',
    sessionName,
    '#{window_width}|#{window_height}|#{status}',
  ])
    .toString()
    .trim()
  const [cols, height, status] = out.split('|')
  const statusRows = status === 'off' ? 0 : /^\d+$/.test(status) ? Number(status) : 1
  return { cols: Number(cols), rows: Number(height) + statusRows }
}

function paneInMode(sessionName: string) {
  return execFileSync('tmux', ['display-message', '-p', '-t', sessionName, '#{pane_in_mode}']).toString().trim()
}

async function termState(page: any) {
  return page.evaluate(() => {
    const t = (window as any).__tmuxgoTerminal
    const rows = document.querySelector('[data-terminal] .xterm-rows') as HTMLElement | null
    return {
      cols: t?.cols || 0,
      rows: t?.rows || 0,
      rowsWidth: rows?.getBoundingClientRect().width || 0,
      vis: document.visibilityState,
      focus: document.hasFocus(),
    }
  })
}

// 激活页独占会话尺寸：tmux window 与 xterm 行列数一致才放行
async function expectSizeSync(page: any, sessionName: string) {
  let lastT: any = null
  let lastW: any = null
  await expect
    .poll(
      async () => {
        lastT = await termState(page)
        lastW = tmuxSize(sessionName)
        return lastT.cols > 0 && lastT.cols === lastW.cols && lastT.rows === lastW.rows
      },
      { timeout: 8000, intervals: [200, 400, 800] },
    )
    .toBe(true)
    .catch((error: any) => {
      console.log('size mismatch, xterm=', JSON.stringify(lastT), 'tmux=', JSON.stringify(lastW))
      throw error
    })
}

test('background tmuxgo pages cannot disturb the active page', async ({ browser, baseURL, request }) => {
  const nameA = `mc_a_${Date.now()}`
  const nameB = `mc_b_${Date.now()}`
  const sessionA = await ensureSession(request, nameA)
  const sessionB = await ensureSession(request, nameB)

  const contextA = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } })
  const pageA = await contextA.newPage()
  await openSession(pageA, sessionA, { expectHeader: false })
  await pageA.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })

  // B 附着同一 session 后压成后台态（hidden + 失焦），等价于切走的标签页
  const contextB = await browser.newContext({ baseURL, viewport: { width: 880, height: 600 } })
  const pageB = await contextB.newPage()
  await openSession(pageB, sessionA, { expectHeader: false })
  await pageB.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })
  await pageB.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    ;(document as any).hasFocus = () => false
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('blur'))
  })
  // 250ms blur 防抖 + attach 往返；B 开窗会抢走焦点，显式把 A 拉回激活
  await pageA.bringToFront()
  await pageA.waitForTimeout(1200)
  await expectSizeSync(pageA, nameA)

  // B 在后台改视口：共享附着 ignore-size，不得推动 tmux window
  for (let i = 0; i < 5; i += 1) {
    await pageB.setViewportSize({ width: 700 + i * 60, height: 480 + i * 30 })
    await pageB.waitForTimeout(250)
    await expectSizeSync(pageA, nameA)
  }

  // B 在后台注入输入：passive 附着被网关丢弃，pane 不得出现该 marker
  await pageB.evaluate(() => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: 'printf "BG_LEAK_MARKER\\n"\r' } }))
  })
  await pageA.waitForTimeout(800)
  const paneText = execFileSync('tmux', ['capture-pane', '-p', '-t', nameA]).toString()
  expect(paneText).not.toContain('BG_LEAK_MARKER')

  // A 开关侧边栏 x10：每次容器宽度变化后 tmux size 必须跟上 xterm
  const sessionsToggle = pageA.getByRole('button', { name: '会话', exact: true }).first()
  const filesToggle = pageA.getByRole('button', { name: '资源管理', exact: true }).first()
  for (let i = 0; i < 10; i += 1) {
    await sessionsToggle.click()
    await filesToggle.click()
    await expectSizeSync(pageA, nameA)
  }

  // A 切换 session x10：切到哪边，哪边的 tmux window 尺寸归 A 所有
  await pageA.getByRole('button', { name: nameB }).first().waitFor({ state: 'visible', timeout: 10000 })
  for (let i = 0; i < 10; i += 1) {
    await pageA.getByRole('button', { name: nameB }).first().click()
    await expectSizeSync(pageA, nameB)
    await pageA.getByRole('button', { name: nameA }).first().click()
    await expectSizeSync(pageA, nameA)
  }

  // A 终端区滚动 x10（mouse on → copy-mode）：尺寸不受影响
  const term = pageA.locator('[data-terminal]')
  const box = await term.boundingBox()
  expect(box).toBeTruthy()
  for (let i = 0; i < 10; i += 1) {
    await pageA.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await pageA.mouse.wheel(0, -240)
    await pageA.waitForTimeout(80)
  }
  await expectSizeSync(pageA, nameA)
  await pageA.mouse.wheel(0, 2400)
  await expectSizeSync(pageA, nameA)
  expect(paneInMode(nameA)).toBeDefined()

  await contextA.close()
  await contextB.close()
})
