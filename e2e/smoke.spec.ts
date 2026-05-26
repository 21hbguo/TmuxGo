import { test, expect } from '@playwright/test'

test('home page smoke flow', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('TmuxGo')).toBeVisible()
  await expect(page.locator('aside').getByText('会话', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ 新建会话' })).toBeVisible()
  await expect(page.locator('main').nth(1)).toBeVisible()
  await expect(page.getByRole('button', { name: '⚙' })).toBeVisible()
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
