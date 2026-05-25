import { test, expect } from '@playwright/test'

test('home page smoke flow', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('TmuxGo')).toBeVisible()
  await expect(page.locator('aside').getByText('会话', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ 新建会话' })).toBeVisible()
  await expect(page.getByText('没有打开的窗口')).toBeVisible()
  await expect(page.getByText('从侧边栏选择一个会话')).toBeVisible()
  await expect(page.getByRole('button', { name: '⚙' })).toBeVisible()
})
