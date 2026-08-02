import { expect, test } from '@playwright/test'
import { apiUrl } from './endpoints'

test('task center keeps completed tasks after page reload', async ({ page, request }) => {
  const started = await request.post(`${apiUrl}/api/hosts/local/test-tasks`)
  expect(started.ok()).toBeTruthy()
  const task = await started.json() as { task: { id: string; title: string } }
  await expect.poll(async () => {
    const response = await request.get(`${apiUrl}/api/system/tasks`)
    const tasks = await response.json() as { tasks: { id: string; status: string }[] }
    return tasks.tasks.find((item) => item.id === task.task.id)?.status
  }).toBe('success')
  await page.goto('/')
  await page.getByRole('button', { name: /^(Tasks|任务)$/ }).click()
  await expect(page.getByText(task.task.title).first()).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /^(Tasks|任务)$/ }).click()
  await expect(page.getByText(task.task.title).first()).toBeVisible()
})
