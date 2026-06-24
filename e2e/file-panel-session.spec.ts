import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

type FileRoot = { id: string; label: string; path: string }

async function createSession(request: any, name: string) {
  const response = await request.post('http://127.0.0.1:3001/api/hosts/local/sessions', { data: { name } })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

test.setTimeout(60000)

test('file explorer stays interactive across session switches and file opens', async ({ page, request }) => {
  const rootsResponse = await request.get('http://127.0.0.1:3001/api/hosts/local/files/roots')
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = await rootsResponse.json() as FileRoot[]
  const homeRoot = roots.find((item) => item.label.toLowerCase() === 'home') || roots[0]
  const tempDir = await mkdtemp(path.join(homeRoot.path, 'tmuxgo-file-session-'))
  const dirName = path.basename(tempDir)
  const firstSession = `tmuxgo_file_a_${Date.now()}`
  const secondSession = `tmuxgo_file_b_${Date.now()}`
  await mkdir(path.join(tempDir, 'nested'))
  await writeFile(path.join(tempDir, 'alpha.txt'), 'alpha content\n')
  await writeFile(path.join(tempDir, 'beta.md'), 'beta search needle xyz\n')
  await writeFile(path.join(tempDir, 'nested', 'gamma.txt'), 'gamma content\n')
  const first = await createSession(request, firstSession)
  const second = await createSession(request, secondSession)
  try {
    await page.addInitScript((sessionId) => {
      localStorage.setItem('tmuxgo-active-session:local', sessionId)
      localStorage.setItem('tmuxgo-active-session', sessionId)
    }, first.id)
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'))).toBe(first.id)
    await page.getByRole('button', { name: '≡', exact: true }).click()
    const rootSelect = page.locator('select').first()
    await expect(rootSelect).toBeVisible()
    await rootSelect.selectOption(homeRoot.id)
    await page.locator('input').nth(1).fill(dirName)
    await expect(page.locator(`[title="${tempDir}"]`)).toBeVisible()
    await page.locator(`button[aria-label="Favorite ${dirName}"]`).click({ force: true })
    await page.locator('input').nth(1).fill('')
    await page.waitForFunction((name) => Array.from(document.querySelectorAll('select option')).some((option) => option.textContent === name), dirName)
    await rootSelect.selectOption({ label: dirName })
    await expect(page.locator(`[title="${tempDir}/alpha.txt"]`)).toBeVisible()
    await expect(page.locator(`[title="${tempDir}/nested"]`)).toBeVisible()
    await page.locator(`[title="${tempDir}/alpha.txt"]`).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-editor'))).toContain('alpha.txt')
    await page.locator(`button[title="${secondSession}"]`).first().click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'))).toBe(second.id)
    await expect(rootSelect).toHaveValue(homeRoot.id)
    await rootSelect.selectOption({ label: dirName })
    await page.locator(`[title="${tempDir}/nested"]`).click()
    await expect(page.locator(`[title="${tempDir}/nested/gamma.txt"]`)).toBeVisible()
    await page.locator(`button[title="${secondSession}"]`).first().click()
    await expect(page.locator(`[title="${tempDir}/nested"]`)).toBeVisible()
    await expect(page.locator('body')).not.toContainText('客户端异常')
    await page.locator(`button[title="${firstSession}"]`).first().click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'))).toBe(first.id)
    await expect(rootSelect).toHaveValue(homeRoot.id)
    await rootSelect.selectOption({ label: dirName })
    await page.getByRole('button', { name: 'content', exact: true }).click()
    await page.locator('input[placeholder="搜索文件内容"],input[placeholder="Search file content"]').first().fill('beta search needle xyz')
    await expect(page.locator(`[title="${tempDir}/beta.md"]`)).toBeVisible()
    await page.locator(`[title="${tempDir}/beta.md"]`).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tmuxgo-active-editor'))).toContain('beta.md')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
