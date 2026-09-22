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
  await ensureSession(request, nameB)

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

// 不同尺寸设备附着同一 session：后到的窄 client 抢走 window 尺寸后，宽 client
// 的 client pty 与 window 发散，tmux 只在左上角画 window 区域（画面残缺）。
// 网关仲裁须把被抢占端 pty/xterm 同步到 window 尺寸；窄 client 断开后再回弹
test('a narrower client demotes then restores the wider client view', async ({ browser, baseURL, request }) => {
  const name = `mc_d_${Date.now()}`
  const session = await ensureSession(request, name)

  const contextA = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } })
  const pageA = await contextA.newPage()
  await openSession(pageA, session, { expectHeader: false })
  await pageA.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })
  await expectSizeSync(pageA, name)
  const wide = tmuxSize(name)

  // B 更窄、激活态附着：window-size latest 让 B 抢走 window 尺寸
  const contextB = await browser.newContext({ baseURL, viewport: { width: 760, height: 500 } })
  const pageB = await contextB.newPage()
  await openSession(pageB, session, { expectHeader: false })
  await pageB.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })
  await pageB.bringToFront()
  await expectSizeSync(pageB, name)
  const narrow = tmuxSize(name)
  expect(narrow.cols).toBeLessThan(wide.cols)

  // A 失焦被动但 client pty 已被仲裁同步：xterm 收敛到 window 尺寸，
  // 不能停在旧列宽（发散态正是"内容只有一半"的来源）
  await expectSizeSync(pageA, name)
  const demotedA = await termState(pageA)
  expect(demotedA.cols).toBe(narrow.cols)

  // B 断开：tmux 不会自动回弹 window，网关须由幸存的独占端拉回期望尺寸
  await contextB.close()
  await pageA.bringToFront()
  await expect.poll(() => tmuxSize(name).cols, { timeout: 10000, intervals: [200, 400, 800] }).toBe(wide.cols)
  await expectSizeSync(pageA, name)
  const restoredA = await termState(pageA)
  expect(restoredA.cols).toBe(wide.cols)

  await contextA.close()
})

// 焦点在 app 间来回切换的回归:失焦页降级共享附着,网关按 window_height 起 pty
// 会少掉状态行,xterm 收缩后回前台独占 attach 再推回会话——每循环 -1 行
test('focus in/out cycles keep tmux window size stable', async ({ browser, baseURL, request }) => {
  const name = `mc_c_${Date.now()}`
  const session = await ensureSession(request, name)

  // 同视口两个页面附着同一 session:焦点交替等价于 alt-tab 进出 TmuxGo,
  // 同尺寸下任何收缩只能来自共享/独占尺寸语义失配
  const contextA = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } })
  const pageA = await contextA.newPage()
  await openSession(pageA, session, { expectHeader: false })
  await pageA.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })
  await expectSizeSync(pageA, name)

  const contextB = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } })
  const pageB = await contextB.newPage()
  await openSession(pageB, session, { expectHeader: false })
  await pageB.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })

  // B 新开抢焦点 → 先回到 A 取得基线
  await pageA.bringToFront()
  await pageA.waitForTimeout(900)
  await expectSizeSync(pageA, name)
  const baseline = tmuxSize(name)

  for (let i = 0; i < 6; i += 1) {
    await pageB.bringToFront()
    await pageB.waitForTimeout(800)
    await pageA.bringToFront()
    await pageA.waitForTimeout(800)
  }
  const after = tmuxSize(name)
  console.log('size after focus cycles:', JSON.stringify(baseline), '->', JSON.stringify(after))
  expect(after).toEqual(baseline)
  await expectSizeSync(pageA, name)

  await contextA.close()
  await contextB.close()
})
