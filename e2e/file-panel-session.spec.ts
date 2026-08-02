import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { apiUrl } from './endpoints'
import { openSession } from './session'

type FileRoot = { id: string; label: string; path: string }

async function createSession(request: any, name: string) {
  const response = await request.post(`${apiUrl}/api/hosts/local/sessions`, { data: { name } })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

test.setTimeout(60000)

test('file explorer stays interactive across session switches and file opens', async ({ page, request }) => {
  const rootsResponse = await request.get(`${apiUrl}/api/hosts/local/files/roots`)
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = await rootsResponse.json() as FileRoot[]
  const homeRoot = roots.find((item) => item.label.toLowerCase() === 'home') || roots[0]
  const tempDir = await mkdtemp(path.join(homeRoot.path, 'tmuxgo-file-session-'))
  const dirName = path.basename(tempDir)
  const firstSession = `tmuxgo_file_a_${Date.now()}`
  const secondSession = `tmuxgo_file_b_${Date.now()}`
  await mkdir(path.join(tempDir, 'nested'))
  await writeFile(path.join(tempDir, 'alpha.txt'), 'alpha content\n')
  await writeFile(path.join(tempDir, 'nested', 'gamma.txt'), 'gamma content\n')
  const first = await createSession(request, firstSession)
  const second = await createSession(request, secondSession)
  try {
    await openSession(page, first)
    await page.getByRole('button', { name: /^(资源管理|Files)$/ }).click()
    const rootSelect = page.locator('select').first()
    const fileSearch = page.getByRole('textbox', { name: /^(搜索文件名|Search file name)$/ })
    await expect(rootSelect).toBeVisible()
    await rootSelect.selectOption(homeRoot.id)
    await fileSearch.fill(dirName)
    const directory = page.getByRole('button', { name: new RegExp(dirName) }).last()
    await expect(directory).toBeVisible()
    await directory.click()
    await expect(page.getByRole('button', { name: /alpha\.txt/ }).last()).toBeVisible()
    await expect(page.getByRole('button', { name: /nested/ }).last()).toBeVisible()
    await page.getByRole('button', { name: /alpha\.txt/ }).last().click()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('tmuxgo-console-state:desktop') || '{}').state?.activeEditorId)).toContain('alpha.txt')
    await page.getByRole('button', { name: new RegExp(secondSession) }).last().click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'))).toBe(second.id)
    await expect(rootSelect).toHaveValue(homeRoot.id)
    await fileSearch.fill(dirName)
    await page.getByRole('button', { name: new RegExp(dirName) }).last().click()
    const nested = page.getByRole('button', { name: /nested/ }).last()
    await expect(nested).toBeVisible()
    await nested.click()
    await expect(page.getByRole('button', { name: /gamma\.txt/ }).last()).toBeVisible()
    await page.getByRole('button', { name: new RegExp(firstSession) }).last().click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'))).toBe(first.id)
    await expect(rootSelect).toHaveValue(homeRoot.id)
    await expect(page.locator('body')).not.toContainText('客户端异常')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
