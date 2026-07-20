import { test, expect } from '@playwright/test'
import { ensureSession, openSession } from './session'

test('home page smoke flow', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('TmuxGo')).toBeVisible()
  await expect(page.getByText(/(Sessions|会话)/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^(New|新建)$/ })).toBeVisible()
  await expect(page.locator('main').nth(1)).toBeVisible()
  await expect(page.locator('header').getByRole('button', { name: '⚙' })).toBeVisible()
})
test('mobile viewport fits visible screen', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('[data-mobile-nav]')).toBeVisible()
  const metrics = await page.evaluate(() => {
    const app = document.querySelector('main > div') as HTMLElement
    const nav = document.querySelector('[data-mobile-nav]') as HTMLElement
    const appRect = app.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      appWidth: appRect.width,
      appHeight: appRect.height,
      navBottom: navRect.bottom,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }
  })
  expect(metrics.appWidth).toBeLessThanOrEqual(metrics.innerWidth)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
  expect(metrics.appHeight).toBeLessThanOrEqual(metrics.innerHeight)
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.innerHeight)
  expect(Math.abs(metrics.navBottom - metrics.innerHeight)).toBeLessThanOrEqual(1)
  await context.close()
})
test('mobile stable page loads without application error', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await page.goto('/')
  await expect(page.locator('[data-mobile-nav]')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Application error')
  expect(pageErrors).toEqual([])
  await context.close()
})
test('mobile dock restores nav after keyboard closes in compact viewport', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('[data-mobile-nav]')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('mobile-keyboard-change', { detail: { open: true, inset: 280 } })))
  await expect(page.locator('[data-mobile-nav]')).not.toBeVisible()
  await expect(page.locator('[data-shortcut-bar]')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('mobile-keyboard-change', { detail: { open: false, inset: 0 } })))
  await expect(page.locator('[data-mobile-nav]')).toBeVisible()
  await expect(page.locator('[data-shortcut-bar]')).not.toBeVisible()
  await context.close()
})
test('mobile terminal stays within viewport and renders active session output', async ({ browser, baseURL, request }) => {
  const name = `tmuxgo_mobile_${Date.now()}`
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  const session = await ensureSession(request, name)
  await openSession(page, session, { expectHeader: false })
  await page.waitForFunction(() => {
    const t = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    if (!t?.cols || !t?.rows) return false
    for (let i = 0; i < Math.min(12, t?.buffer?.active?.length || 0); i += 1) {
      const line = t.buffer.active.getLine(i)?.translateToString(true) || ''
      if (line.includes('$') || line.includes('~') || line.includes('/')) return true
    }
    return false
  }, undefined, { timeout: 15000 })
  const metrics = await page.evaluate(() => {
    const term = document.querySelector('[data-terminal]') as HTMLElement | null
    const xterm = term?.querySelector('.xterm') as HTMLElement | null
    const t = (window as typeof window & { __tmuxgoTerminal?: any }).__tmuxgoTerminal
    const lines: string[] = []
    for (let i = 0; i < Math.min(12, t?.buffer?.active?.length || 0); i += 1) {
      const line = t.buffer.active.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      if (text.trim()) lines.push(text)
    }
    const termRect = term?.getBoundingClientRect()
    const xtermRect = xterm?.getBoundingClientRect()
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      termWidth: termRect?.width || 0,
      xtermWidth: xtermRect?.width || 0,
      cols: t?.cols || 0,
      rows: t?.rows || 0,
      lines,
    }
  })
  expect(metrics.termWidth).toBeLessThanOrEqual(metrics.innerWidth)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
  expect(metrics.xtermWidth).toBeLessThanOrEqual(metrics.innerWidth)
  expect(metrics.cols).toBeGreaterThan(0)
  expect(metrics.rows).toBeGreaterThan(0)
  expect(metrics.lines.some((line) => line.includes('$') || line.includes('~') || line.includes('/'))).toBeTruthy()
  await context.close()
})
