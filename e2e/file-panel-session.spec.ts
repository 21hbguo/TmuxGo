import { test, expect, type APIRequestContext } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { apiUrl } from './endpoints'
import { openSession } from './session'

type FileRoot = { id: string; label: string; path: string }

async function createSession(request: APIRequestContext, name: string) {
  const response = await request.post(`${apiUrl}/api/hosts/local/sessions`, { data: { name } })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

test.setTimeout(60000)

test('file explorer stays interactive across session switches and file opens', async ({ page, request }) => {
  const rootsResponse = await request.get(`${apiUrl}/api/hosts/local/files/roots`)
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = (await rootsResponse.json()) as FileRoot[]
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
    await page
      .getByRole('button', { name: /^(资源管理|Files)$/ })
      .first()
      .click()
    // 根目录选择器已从原生 <select> 换成自定义 combobox：点击后从弹层里选 option
    const rootSelect = page.getByRole('combobox').first()
    await expect(rootSelect).toBeVisible()
    const pickRoot = async () => {
      await rootSelect.click()
      await page.getByRole('option', { name: homeRoot.label, exact: true }).click()
    }
    await pickRoot()
    // 不再用「文件名搜索」当定位手段：过滤只保留命中项，展开目录也看不到不匹配的子项，
    // 而且过滤与展开状态互相重置。改用 data-row-path 定位（与 editor-navigation 一致）
    const dirRow = page.locator(`[data-row-path="${dirName}"]`).first()
    await expect(dirRow).toBeVisible({ timeout: 15000 })
    const alphaRow = page.locator(`[data-row-path="${dirName}/alpha.txt"]`).first()
    if ((await alphaRow.count()) === 0) await dirRow.click()
    await expect(alphaRow).toBeVisible()
    await expect(page.locator(`[data-row-path="${dirName}/nested"]`).first()).toBeVisible()
    await alphaRow.click()
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('tmuxgo-console-state:desktop') || '{}').state?.activeEditorId,
        ),
      )
      .toContain('alpha.txt')
    await page
      .getByRole('button', { name: new RegExp(secondSession) })
      .last()
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          () => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'),
        ),
      )
      .toBe(second.id)
    await expect(rootSelect).toContainText(homeRoot.label)
    // 切 session 回来：目录展开状态应保留，直接点 nested → gamma.txt
    const nestedRow = page.locator(`[data-row-path="${dirName}/nested"]`).first()
    await expect(nestedRow).toBeVisible()
    const gammaRow = page.locator(`[data-row-path="${dirName}/nested/gamma.txt"]`).first()
    if ((await gammaRow.count()) === 0) await nestedRow.click()
    await expect(gammaRow).toBeVisible()
    await gammaRow.click()
    await page
      .getByRole('button', { name: new RegExp(firstSession) })
      .last()
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          () => localStorage.getItem('tmuxgo-active-session:local') || localStorage.getItem('tmuxgo-active-session'),
        ),
      )
      .toBe(first.id)
    await expect(rootSelect).toContainText(homeRoot.label)
    await expect(page.locator('body')).not.toContainText('客户端异常')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
