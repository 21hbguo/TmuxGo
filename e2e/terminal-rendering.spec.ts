import { test, expect, type Page } from '@playwright/test'
import { ensureTestWindow, openSession } from './session'
import type { TerminalProbe } from './probe-types'

// mobile debug 探针事件：只读取 event/reason
type MobileDebugEvent = { event: string; reason: string }
async function writeMarker(page: Page, marker: string) {
  await page.evaluate((value) => {
    window.dispatchEvent(new CustomEvent('tmuxgo-terminal-input', { detail: { data: `printf "${value}\\n"\r` } }))
  }, marker)
  // 扫全 buffer（含 scrollback）：限前 240 行会在长跑后误失败
  await page.waitForFunction(
    (value) => {
      const t = (window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal
      const buffer = t?.buffer?.active
      if (!buffer) return false
      for (let i = 0; i < buffer.length; i += 1) {
        const text = buffer.getLine(i)?.translateToString(true) || ''
        if (text.includes(value)) return true
      }
      return false
    },
    marker,
    { timeout: 15000 },
  )
}
// 桌面端默认 WebGL 渲染器：行画在 canvas 里，DOM 没有 .xterm-rows，文本只能从 xterm
// buffer 读；渲染面尺寸取 .xterm-screen（DOM 渲染器下仍优先 .xterm-rows）
async function bufferVisibleText(page: Page) {
  return page.evaluate(() => {
    const t = (window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal
    const buffer = t?.buffer?.active
    if (!buffer) return ''
    const viewport = Math.max(1, Number(t?.rows) || 1)
    const start = Math.max(0, buffer.length - viewport)
    const lines: string[] = []
    for (let i = start; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) || '')
    return lines.join('\n')
  })
}
async function getRenderMetrics(page: Page) {
  return page.evaluate(() => {
    const terminal = document.querySelector('[data-terminal]') as HTMLElement | null
    const xterm = terminal?.querySelector('.xterm') as HTMLElement | null
    const screen = terminal?.querySelector('.xterm-screen') as HTMLElement | null
    const rows = terminal?.querySelector('.xterm-rows') as HTMLElement | null
    const t = (window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal
    const termRect = terminal?.getBoundingClientRect()
    const xtermRect = xterm?.getBoundingClientRect()
    const surface = rows || screen
    const rowsRect = surface?.getBoundingClientRect()
    const rowsStyle = surface ? getComputedStyle(surface) : null
    const events = (
      (window as typeof window & { __tmuxgoMobileDebug?: { events?: MobileDebugEvent[] } }).__tmuxgoMobileDebug
        ?.events || []
    ).filter((item) => item.event === 'terminal-recover' || item.event === 'terminal-soft-recover')
    const buffer = t?.buffer?.active
    const viewportRows = Math.max(1, Number(t?.rows) || 1)
    const visibleText = buffer
      ? Array.from({ length: viewportRows }, (_, index) =>
          buffer.getLine(Math.max(0, buffer.length - viewportRows) + index)?.translateToString(true),
        ).join('\n')
      : ''
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      termWidth: termRect?.width || 0,
      termHeight: termRect?.height || 0,
      xtermWidth: xtermRect?.width || 0,
      xtermHeight: xtermRect?.height || 0,
      rowsWidth: rowsRect?.width || 0,
      rowsHeight: rowsRect?.height || 0,
      rowsDisplay: rowsStyle?.display || '',
      rowsVisibility: rowsStyle?.visibility || '',
      rowsOpacity: rowsStyle?.opacity || '',
      cols: t?.cols || 0,
      rows: t?.rows || 0,
      visibleText,
      recoverReasons: events.map((item) => item.reason),
    }
  })
}
test('mobile terminal remains visibly rendered after viewport and dpr switch', async ({
  browser,
  baseURL,
  request,
}) => {
  const name = `tmuxgo_render_${Date.now()}`
  const before = `${name}_before`
  const after = `${name}_after`
  const { session } = await ensureTestWindow(request, 'render-mobile')
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  await openSession(page, session, { debugMobile: true, expectHeader: false })
  await page.waitForFunction(
    () => {
      const t = (window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal
      return !!t?.cols && !!t?.rows
    },
    undefined,
    { timeout: 15000 },
  )
  await page.evaluate(() => localStorage.setItem('tmuxgo-debug-mobile', '1'))
  await writeMarker(page, before)
  const recoverCount = await page.evaluate(
    () =>
      (
        (window as typeof window & { __tmuxgoMobileDebug?: { events?: MobileDebugEvent[] } }).__tmuxgoMobileDebug
          ?.events || []
      ).filter((item) => item.event === 'terminal-recover' || item.event === 'terminal-soft-recover').length,
  )
  const client = await context.newCDPSession(page)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 844,
    height: 390,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 844,
    screenHeight: 390,
  })
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('orientationchange'))
  })
  await page.waitForFunction(
    (count) => {
      const events =
        (window as typeof window & { __tmuxgoMobileDebug?: { events?: MobileDebugEvent[] } }).__tmuxgoMobileDebug
          ?.events || []
      return (
        events.filter((item) => item.event === 'terminal-recover' || item.event === 'terminal-soft-recover').length >
        count
      )
    },
    recoverCount,
    { timeout: 15000 },
  )
  await writeMarker(page, after)
  await expect.poll(async () => (await bufferVisibleText(page)).includes(after), { timeout: 15000 }).toBe(true)
  const metrics = await getRenderMetrics(page)
  expect(metrics.cols).toBeGreaterThan(0)
  expect(metrics.rows).toBeGreaterThan(0)
  expect(metrics.termWidth).toBeGreaterThan(0)
  expect(metrics.termHeight).toBeGreaterThan(0)
  expect(metrics.xtermWidth).toBeGreaterThan(0)
  expect(metrics.xtermHeight).toBeGreaterThan(0)
  expect(metrics.rowsWidth).toBeGreaterThan(0)
  expect(metrics.rowsHeight).toBeGreaterThan(0)
  expect(metrics.termWidth).toBeLessThanOrEqual(metrics.innerWidth + 1)
  expect(metrics.xtermWidth).toBeLessThanOrEqual(metrics.innerWidth + 1)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1)
  expect(metrics.rowsDisplay).not.toBe('none')
  expect(metrics.rowsVisibility).not.toBe('hidden')
  expect(Number(metrics.rowsOpacity || '1')).toBeGreaterThan(0)
  expect(metrics.visibleText).toContain(after)
  expect(
    metrics.recoverReasons.some((reason) =>
      ['window-resize', 'orientationchange', 'orientationchange-stable'].includes(reason),
    ),
  ).toBeTruthy()
  await context.close()
})
test('desktop terminal resize settles without repeated resize calls', async ({ browser, baseURL, request }) => {
  const name = `resize_desktop_${Date.now()}`
  const marker = `${name}_after`
  const { session } = await ensureTestWindow(request, 'render-desktop')
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openSession(page, session, { expectHeader: false })
  await page.waitForFunction(
    () => {
      const t = (window as typeof window & { __tmuxgoTerminal?: TerminalProbe }).__tmuxgoTerminal
      return !!t?.cols && !!t?.rows
    },
    undefined,
    { timeout: 15000 },
  )
  await page.evaluate(() => {
    const target = window as typeof window & {
      __tmuxgoTerminal?: TerminalProbe
      __tmuxgoResizeCalls?: Array<{ cols: number; rows: number }>
    }
    const terminal = target.__tmuxgoTerminal!
    const resize = terminal.resize.bind(terminal)
    target.__tmuxgoResizeCalls = []
    terminal.resize = (cols: number, rows: number) => {
      target.__tmuxgoResizeCalls!.push({ cols, rows })
      return resize(cols, rows)
    }
  })
  await page.setViewportSize({ width: 1180, height: 760 })
  await page.waitForTimeout(240)
  const settledCount = await page.evaluate(
    () => (window as typeof window & { __tmuxgoResizeCalls?: unknown[] }).__tmuxgoResizeCalls?.length || 0,
  )
  await page.waitForTimeout(240)
  const finalCalls = await page.evaluate(
    () =>
      (window as typeof window & { __tmuxgoResizeCalls?: Array<{ cols: number; rows: number }> }).__tmuxgoResizeCalls ||
      [],
  )
  await writeMarker(page, marker)
  await expect.poll(async () => (await bufferVisibleText(page)).includes(marker), { timeout: 15000 }).toBe(true)
  const metrics = await getRenderMetrics(page)
  expect(settledCount).toBeGreaterThan(0)
  expect(finalCalls.length).toBe(settledCount)
  expect(finalCalls.length).toBeLessThanOrEqual(2)
  expect(new Set(finalCalls.map((item) => `${item.cols}x${item.rows}`)).size).toBe(finalCalls.length)
  expect(metrics.termWidth).toBeLessThanOrEqual(metrics.innerWidth + 1)
  expect(metrics.termHeight).toBeGreaterThan(0)
  expect(metrics.visibleText).toContain(marker)
  await context.close()
})
