import { expect, test, type Page } from '@playwright/test'
import { apiUrl } from './endpoints'

// 侧边栏「任务中心」入口 tab 已在 c73efe2 移除，页面没有可点的按钮了；
// 唯一入口是任务完成通知派发的 tmuxgo-open-tasks 事件（TaskNotifications.tsx:53），
// 这里直接派发同一个应用内事件，与 clipboard/fluency 等 spec 的用法一致
async function openTaskCenter(page: Page) {
  // 事件监听在 ConsoleLayout 挂载后才生效：goto 刚返回时可能尚未 hydrate，
  // 派发会被丢弃，所以以"标题出现"为准重试派发，而不是固定 sleep
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('tmuxgo-open-tasks')))
        return page.getByRole('heading', { name: /^(Tasks|任务中心)$/ }).isVisible()
      },
      { timeout: 15000 },
    )
    .toBe(true)
}

test('task center keeps completed tasks after page reload', async ({ page, request }) => {
  const started = await request.post(`${apiUrl}/api/hosts/local/test-tasks`)
  expect(started.ok()).toBeTruthy()
  const task = (await started.json()) as { task: { id: string; title: string } }
  await expect
    .poll(async () => {
      const response = await request.get(`${apiUrl}/api/system/tasks`)
      const tasks = (await response.json()) as { tasks: { id: string; status: string }[] }
      return tasks.tasks.find((item) => item.id === task.task.id)?.status
    })
    .toBe('success')
  await page.goto('/')
  await openTaskCenter(page)
  await expect(page.getByText(task.task.title).first()).toBeVisible()
  await page.reload()
  await openTaskCenter(page)
  await expect(page.getByText(task.task.title).first()).toBeVisible()
})
