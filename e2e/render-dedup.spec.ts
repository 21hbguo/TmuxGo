import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiUrl } from './endpoints'
import { ensureSession, ensureTestWindow, openSession } from './session'

// ---- tmux 调用守卫：仅 run-e2e 隔离环境下允许（TMUX='' + 独立 TMUX_TMPDIR）。
// pane shell 自带 TMUX 指向用户默认 socket 且覆盖 TMUX_TMPDIR——缺一即拒，
// 避免 spec 被直跑时误操作用户 session
function tmux(args: string[]) {
  if (process.env.TMUX || !process.env.TMUX_TMPDIR)
    throw new Error('render-dedup: tmux commands only allowed inside run-e2e isolated env')
  return execFileSync('tmux', args).toString()
}

// ---- refresh-client 计数：tmux after-refresh-client hook 每执行一次向文件追加
// 一字节，文件长度即本轮 refresh-client 调用次数（协议层观察不到 tmux 命令，
// 注入探针是任务书允许的兜底计数方式）
const refreshDir = join(tmpdir(), `tmuxgo-render-rc-${process.pid}`)
const refreshLog = join(refreshDir, 'refresh.log')
mkdirSync(refreshDir, { recursive: true })
function installRefreshProbe() {
  tmux(['set-hook', '-g', 'after-refresh-client', `run-shell "printf x >> '${refreshLog}'"`])
}
function uninstallRefreshProbe() {
  tmux(['set-hook', '-gu', 'after-refresh-client'])
}
function refreshCount() {
  try {
    return readFileSync(refreshLog, 'utf8').length
  } catch {
    // 尚无 refresh 时文件不存在，按 0 计
    return 0
  }
}

// ---- WebSocket 入向报文计数探针：文本帧取 type；二进制流帧 TG magic + typeCode
// 映射 output/output_resync/cell_*（对齐 apps/frontend/src/lib/stream-binary.ts）
async function installWsProbe(page: any) {
  await page.addInitScript(() => {
    const w = window as any
    const counts: Record<string, number> = {}
    w.__tmuxgoWsCounts = counts
    const bump = (key: string) => {
      counts[key] = (counts[key] || 0) + 1
    }
    const KIND: Record<number, string> = {
      1: 'output',
      3: 'output',
      2: 'output_resync',
      4: 'output_resync',
      5: 'cell_snapshot',
      6: 'cell_snapshot',
      9: 'cell_snapshot',
      10: 'cell_snapshot',
      7: 'cell_diff',
      8: 'cell_diff',
      11: 'cell_diff',
      12: 'cell_diff',
    }
    const NativeWebSocket = window.WebSocket
    class ProbeWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        bump('sockets')
        w.__tmuxgoWsLast = this
        this.addEventListener('message', (event: MessageEvent) => {
          try {
            const data = event.data
            if (typeof data === 'string') {
              const type = JSON.parse(data)?.type
              if (typeof type === 'string') bump(`msg:${type}`)
              return
            }
            if (data instanceof ArrayBuffer && data.byteLength >= 4) {
              const view = new DataView(data)
              if (view.getUint8(0) === 0x54 && view.getUint8(1) === 0x47) {
                const kind = KIND[view.getUint8(3)]
                if (kind) bump(kind)
              }
            }
          } catch {
            // 解析失败的帧不纳入计数（异常不向外抛）
          }
        })
      }
    }
    window.WebSocket = ProbeWebSocket as unknown as typeof WebSocket
  })
}
async function wsCounts(page: any): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...((window as any).__tmuxgoWsCounts || {}) }))
}

// ---- gateway 侧 stream 指标出口：/api/system.stream（attachRequests/
// outputResync*/resizeRequests/redrawRequests 等）
async function streamMetrics(request: any): Promise<Record<string, number>> {
  const response = await request.get(`${apiUrl}/api/system`)
  const body = await response.json()
  return { ...(body?.stream || {}) }
}

function delta(before: Record<string, number>, after: Record<string, number>) {
  const out: Record<string, number> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[key] || 0) - (before[key] || 0)
    if (d) out[key] = d
  }
  return out
}
function logCounts(label: string, data: Record<string, number>) {
  console.log(`[render-dedup] ${label} ${JSON.stringify(data)}`)
}

// ---- tmux/xterm 状态
function tmuxSize(sessionName: string) {
  const out = tmux(['display-message', '-p', '-t', sessionName, '#{window_width}|#{window_height}|#{status}']).trim()
  const [cols, height, status] = out.split('|')
  const statusRows = status === 'off' ? 0 : /^\d+$/.test(status) ? Number(status) : 1
  return { cols: Number(cols), rows: Number(height) + statusRows }
}
function paneText(target: string) {
  return tmux(['capture-pane', '-pt', target])
}
function paneLineCount(target: string, marker: string) {
  return paneText(target)
    .split('\n')
    .filter((line) => line.trim() === marker).length
}
function seedMarker(target: string, marker: string) {
  tmux(['send-keys', '-t', target, `printf "${marker}\\n"`, 'Enter'])
}
// e2e 空 HOME 下新 pane 进 zsh-newuser-install 向导，键入会被向导吃掉
// （旧 spec 用 includes 断言把向导内回显误判为输出）。先 q 退出、C-u 清
// 输入行，再用 probe 独立行确认 shell 真的会执行命令
async function ensureShellReady(target: string) {
  const probe = `TMUXGO_RDY_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  for (let i = 0; i < 6; i += 1) {
    if (paneText(target).includes('zsh-newuser-install')) tmux(['send-keys', '-t', target, 'q'])
    tmux(['send-keys', '-t', target, 'C-u'])
    tmux(['send-keys', '-t', target, `printf "${probe}\\n"`, 'Enter'])
    try {
      await expect.poll(() => paneLineCount(target, probe), { timeout: 2500, intervals: [250, 500] }).toBe(1)
      return
    } catch {
      // 未就绪继续重试：向导可能晚于首轮判断出现
    }
  }
  throw new Error(`pane ${target} shell not ready`)
}
async function termState(page: any) {
  return page.evaluate(() => {
    const t = (window as any).__tmuxgoTerminal
    return { cols: t?.cols || 0, rows: t?.rows || 0 }
  })
}
// 同 multi-client-arbitration：激活页 xterm 行列与 tmux window 一致才算稳态
async function expectSizeSync(page: any, sessionName: string) {
  await expect
    .poll(
      async () => {
        const t = await termState(page)
        const w = tmuxSize(sessionName)
        return t.cols > 0 && t.cols === w.cols && t.rows === w.rows
      },
      { timeout: 10000, intervals: [200, 400, 800] },
    )
    .toBe(true)
}
async function waitTerminalReady(page: any) {
  await page.waitForFunction(() => (window as any).__tmuxgoTerminal?.cols > 0, null, { timeout: 15000 })
}

// ---- marker 独立行计数：整行文本 === marker 才算一次渲染，命令回显行
// （printf "MARKER\n"）天然不等，规避 includes 误报
async function markerLineCount(page: any, marker: string): Promise<number> {
  return page.evaluate((value) => {
    const t = (window as any).__tmuxgoTerminal
    const buffer = t?.buffer?.active
    if (!buffer) return -1
    let count = 0
    for (let i = 0; i < buffer.length; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true)?.trim()
      if (text === value) count += 1
    }
    return count
  }, marker)
}
async function writeMarker(page: any, marker: string) {
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: `printf "${value}\\n"\r` } }))
  }, marker)
  await expect.poll(() => markerLineCount(page, marker), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
}
// 先等 marker 出现、再等重绘窗口（attach/重连重绘都落在百毫秒级）后读终值
async function expectMarkerOnce(page: any, marker: string) {
  await expect.poll(() => markerLineCount(page, marker), { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(800)
  expect(await markerLineCount(page, marker)).toBe(1)
}

test.describe('render dedup regression', () => {
  test.beforeEach(() => installRefreshProbe())
  test.afterEach(() => uninstallRefreshProbe())

  test('marker renders once across initial attach redraw', async ({ browser, baseURL, request }) => {
    const marker = `TMUXGO_RENDER_MARKER_A${Date.now()}`
    const { session, window: win } = await ensureTestWindow(request, 'dedup-attach')
    await ensureShellReady(win.tmuxWindowId)
    // 先于 attach 写入 pane：attach 重绘若在错误位置重放内容，marker 即出现第二次
    seedMarker(win.tmuxWindowId, marker)
    await expect.poll(() => paneLineCount(win.tmuxWindowId, marker), { timeout: 15000 }).toBe(1)

    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await installWsProbe(page)
    const refreshBefore = refreshCount()
    await openSession(page, session, { expectHeader: false })
    await waitTerminalReady(page)
    await page.waitForTimeout(700)
    const counts = await wsCounts(page)
    const refreshes = refreshCount() - refreshBefore
    logCounts('attach', { ...counts, refreshClient: refreshes })
    await expectMarkerOnce(page, marker)
    expect(refreshes).toBeLessThanOrEqual(2)
    await context.close()
  })

  test('marker stays single after narrow client steals and disconnects', async ({ browser, baseURL, request }) => {
    const marker = `TMUXGO_RENDER_MARKER_B${Date.now()}`
    const session = await ensureSession(request, `dedup_steal_${Date.now()}`)
    await ensureShellReady(session.name)

    const contextA = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } })
    const pageA = await contextA.newPage()
    await installWsProbe(pageA)
    await openSession(pageA, session, { expectHeader: false })
    await waitTerminalReady(pageA)
    await writeMarker(pageA, marker)

    const contextB = await browser.newContext({ baseURL, viewport: { width: 760, height: 500 } })
    const pageB = await contextB.newPage()
    await openSession(pageB, session, { expectHeader: false })
    await waitTerminalReady(pageB)
    await pageB.bringToFront()
    const wsBefore = await wsCounts(pageA)
    const refreshBefore = refreshCount()
    await contextB.close()

    await pageA.bringToFront()
    // B 断开后 A 回前台重取独占：等一轮重附着+重绘落定再数 marker
    await expect
      .poll(async () => (await wsCounts(pageA))['msg:attached'] || 0, { timeout: 15000 })
      .toBeGreaterThanOrEqual((wsBefore['msg:attached'] || 0) + 1)
    await pageA.waitForTimeout(700)
    const countsDelta = delta(wsBefore, await wsCounts(pageA))
    const refreshes = refreshCount() - refreshBefore
    logCounts('steal-return', { ...countsDelta, refreshClient: refreshes })
    await expectMarkerOnce(pageA, marker)
    await contextA.close()
  })

  test('marker stays single across websocket reconnect', async ({ browser, baseURL, request }) => {
    const marker = `TMUXGO_RENDER_MARKER_C${Date.now()}`
    const { session, window: win } = await ensureTestWindow(request, 'dedup-reconnect')
    await ensureShellReady(win.tmuxWindowId)

    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await installWsProbe(page)
    await openSession(page, session, { expectHeader: false })
    await waitTerminalReady(page)
    await writeMarker(page, marker)
    expect(await markerLineCount(page, marker)).toBe(1)

    const refreshBefore = refreshCount()
    // 探针持有的 socket 引用直接 close：等价断线，autoReconnect 走完整重连+重附着
    await page.evaluate(() => (window as any).__tmuxgoWsLast?.close())
    await expect
      .poll(async () => (await wsCounts(page))['msg:attached'] || 0, { timeout: 15000 })
      .toBeGreaterThanOrEqual(2)
    await page.waitForTimeout(700)
    const counts = await wsCounts(page)
    const refreshes = refreshCount() - refreshBefore
    logCounts('reconnect', { ...counts, refreshClient: refreshes })
    await expectMarkerOnce(page, marker)
    expect(refreshes).toBeLessThanOrEqual(3)
    await context.close()
  })

  test('resize storm keeps redraw events bounded', async ({ browser, baseURL, request }) => {
    const { session } = await ensureTestWindow(request, 'dedup-resize')
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await installWsProbe(page)
    await openSession(page, session, { expectHeader: false })
    await waitTerminalReady(page)
    await page.waitForTimeout(400)

    const wsBefore = await wsCounts(page)
    const metricsBefore = await streamMetrics(request)
    const refreshBefore = refreshCount()
    const widths = [1200, 1500, 1180, 1460, 1240, 1400]
    for (const width of widths) {
      await page.setViewportSize({ width, height: 840 })
      await page.waitForTimeout(180)
    }
    await page.waitForTimeout(900)
    const countsDelta = delta(wsBefore, await wsCounts(page))
    const metricsDelta = delta(metricsBefore, await streamMetrics(request))
    const refreshes = refreshCount() - refreshBefore
    logCounts('resize-storm', { ws: countsDelta, metrics: metricsDelta, refreshClient: refreshes })
    expect(countsDelta['msg:attached'] || 0).toBeLessThanOrEqual(1)
    expect(countsDelta['output_resync'] || 0).toBeLessThanOrEqual(1)
    expect(refreshes).toBeLessThanOrEqual(widths.length + 2)
    expect(countsDelta['msg:resized'] || 0).toBeLessThanOrEqual(widths.length + 2)
    await context.close()
  })

  test('rapid window switches keep redraw events bounded', async ({ browser, baseURL, request }) => {
    const winA = await ensureTestWindow(request, 'dedup-swa')
    const winB = await ensureTestWindow(request, 'dedup-swb')
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await installWsProbe(page)
    await openSession(page, winA.session, { expectHeader: false })
    await waitTerminalReady(page)
    const chipA = page.getByRole('button', { name: winA.window.name })
    const chipB = page.getByRole('button', { name: winB.window.name })
    await chipA.waitFor({ state: 'visible', timeout: 10000 })
    await chipB.waitFor({ state: 'visible', timeout: 10000 })

    const wsBefore = await wsCounts(page)
    const metricsBefore = await streamMetrics(request)
    const refreshBefore = refreshCount()
    for (let i = 0; i < 6; i += 1) {
      await chipA.click()
      await page.waitForTimeout(120)
      await chipB.click()
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(900)
    const countsDelta = delta(wsBefore, await wsCounts(page))
    const metricsDelta = delta(metricsBefore, await streamMetrics(request))
    const refreshes = refreshCount() - refreshBefore
    logCounts('window-switch', { ws: countsDelta, metrics: metricsDelta, refreshClient: refreshes })
    // 切窗口只换 pane 视图：不应引发重附着，重绘/resync 也须有界
    expect(countsDelta['msg:attached'] || 0).toBeLessThanOrEqual(1)
    expect(countsDelta['output_resync'] || 0).toBeLessThanOrEqual(1)
    expect(refreshes).toBeLessThanOrEqual(6)
    await context.close()
  })

  test('background page restore keeps redraw events bounded', async ({ browser, baseURL, request }) => {
    const { session } = await ensureTestWindow(request, 'dedup-bg')
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await installWsProbe(page)
    await openSession(page, session, { expectHeader: false })
    await waitTerminalReady(page)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      ;(document as any).hasFocus = () => false
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('blur'))
    })
    await page.waitForTimeout(700)
    const wsBefore = await wsCounts(page)
    const metricsBefore = await streamMetrics(request)
    const refreshBefore = refreshCount()
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      ;(document as any).hasFocus = () => true
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await page.bringToFront()
    await page.waitForTimeout(1200)
    const countsDelta = delta(wsBefore, await wsCounts(page))
    const metricsDelta = delta(metricsBefore, await streamMetrics(request))
    const refreshes = refreshCount() - refreshBefore
    logCounts('bg-restore', { ws: countsDelta, metrics: metricsDelta, refreshClient: refreshes })
    expect(countsDelta['msg:attached'] || 0).toBeLessThanOrEqual(2)
    expect(countsDelta['output_resync'] || 0).toBeLessThanOrEqual(2)
    expect(refreshes).toBeLessThanOrEqual(3)
    await context.close()
  })

  test('second client attach does not multiply repaints on the first client', async ({ browser, baseURL, request }) => {
    const marker = `TMUXGO_RENDER_MARKER_D${Date.now()}`
    const session = await ensureSession(request, `dedup_dual_${Date.now()}`)
    await ensureShellReady(session.name)

    const contextA = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } })
    const pageA = await contextA.newPage()
    await installWsProbe(pageA)
    await openSession(pageA, session, { expectHeader: false })
    await waitTerminalReady(pageA)
    await writeMarker(pageA, marker)
    await pageA.waitForTimeout(400)

    const wsBefore = await wsCounts(pageA)
    const metricsBefore = await streamMetrics(request)
    const refreshBefore = refreshCount()
    const contextB = await browser.newContext({ baseURL, viewport: { width: 1400, height: 900 } })
    const pageB = await contextB.newPage()
    await openSession(pageB, session, { expectHeader: false })
    await waitTerminalReady(pageB)
    await pageB.bringToFront()
    await pageA.waitForTimeout(1200)
    const countsDelta = delta(wsBefore, await wsCounts(pageA))
    const metricsDelta = delta(metricsBefore, await streamMetrics(request))
    const refreshes = refreshCount() - refreshBefore
    logCounts('dual-attach', { ws: countsDelta, metrics: metricsDelta, refreshClient: refreshes })
    // B attach 的整帧重绘经共享 PTY 扇出：A 端必须以 resync 边界原子替换且
    // 至多一轮，不能在普通 output 上无界重放同屏内容
    await expectMarkerOnce(pageA, marker)
    expect(countsDelta['output_resync'] || 0).toBeLessThanOrEqual(1)
    expect(refreshes).toBeLessThanOrEqual(3)
    await contextA.close()
    await contextB.close()
  })

  test('narrow client disconnect restores wide view: window/xterm/DOM cols consistent', async ({
    browser,
    baseURL,
    request,
  }) => {
    const session = await ensureSession(request, `dedup_size_${Date.now()}`)

    const contextA = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } })
    const pageA = await contextA.newPage()
    await openSession(pageA, session, { expectHeader: false })
    await waitTerminalReady(pageA)
    // attach 完成≠window 已 resize：先等 A 与 tmux 收敛再记基线宽
    await expectSizeSync(pageA, session.name)
    const wide = tmuxSize(session.name)

    const contextB = await browser.newContext({ baseURL, viewport: { width: 760, height: 500 } })
    const pageB = await contextB.newPage()
    await openSession(pageB, session, { expectHeader: false })
    await waitTerminalReady(pageB)
    await pageB.bringToFront()
    await expect.poll(() => tmuxSize(session.name).cols, { timeout: 10000 }).toBeLessThan(wide.cols)

    await contextB.close()
    await pageA.bringToFront()
    // 宽端恢复：tmux window cols 必须回弹并与 xterm/DOM 三者一致
    await expect.poll(() => tmuxSize(session.name).cols, { timeout: 10000 }).toBe(wide.cols)
    await expect.poll(async () => (await termState(pageA)).cols, { timeout: 10000 }).toBe(wide.cols)

    const dom = await pageA.evaluate(() => {
      const t = (window as any).__tmuxgoTerminal
      const rowsEl = document.querySelector('[data-terminal] .xterm-rows') as HTMLElement | null
      const cell = t?._core?._renderService?.dimensions?.css?.cell
      return {
        cols: t?.cols || 0,
        rowsWidth: rowsEl?.getBoundingClientRect().width || 0,
        rowsScrollWidth: rowsEl?.scrollWidth || 0,
        rowsClientWidth: rowsEl?.clientWidth || 0,
        cellWidth: cell?.width || 0,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }
    })
    logCounts('size-consistency', { tmux: wide.cols, ...dom })
    // DOM 行区宽换算列数须与 window/xterm cols 一致（右侧无空半屏），
    // 且 .xterm-rows 不产生横向溢出
    if (dom.cellWidth > 0) expect(Math.round(dom.rowsWidth / dom.cellWidth)).toBe(dom.cols)
    expect(dom.rowsScrollWidth).toBeLessThanOrEqual(dom.rowsClientWidth + 2)
    expect(dom.docScrollWidth).toBeLessThanOrEqual(dom.innerWidth + 1)
    await contextA.close()
  })
})
