import { test, expect } from '@playwright/test'
import path from 'node:path'

const appUrl = process.env.TMUXGO_PLUGIN_E2E_URL || 'http://127.0.0.1:3000'
const apiUrl = process.env.TMUXGO_PLUGIN_E2E_API_URL || 'http://127.0.0.1:3001'
let linkedByTest = false

test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => {
  const response = await request.post(`${apiUrl}/api/plugins/link`, { data: { path: path.resolve('examples/plugins/hello-tmuxgo') } })
  linkedByTest = response.ok()
  expect([200, 409]).toContain(response.status())
})
test.afterAll(async ({ request }) => {
  if (linkedByTest) await request.delete(`${apiUrl}/api/plugins/examples.hello-tmuxgo?keepData=true`)
})

async function openPluginSettings(page: any) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  await page.getByRole('button', { name: /^插件$|^Plugins$/ }).click()
  await expect(page.getByText('Hello TmuxGo').last()).toBeVisible()
}
function collectPageErrors(page: any) {
  const errors: string[] = []
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`.trim()) })
  page.on('response', (response: any) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`) })
  return errors
}

test('previews commands and opens a sandboxed desktop plugin view', async ({ page }) => {
  const errors = collectPageErrors(page)
  await page.route('**/api/plugins/github/preview', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'owner/repo/plugin', resolvedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', replacing: false, manifest: { schemaVersion: 1, id: 'preview.fixture', name: 'Preview Fixture', version: '1.0.0', minTmuxGoVersion: '0.1.0', platforms: ['linux'], build: [{ command: ['npm', 'run', 'build'] }], contributes: { actions: [{ id: 'inspect', title: 'Inspect', command: ['node', 'action.mjs'] }], events: [{ on: 'session.created', command: ['node', 'event.mjs'] }] } } }) })
  })
  await openPluginSettings(page)
  await page.getByPlaceholder('owner/repo[/subdir]').fill('owner/repo/plugin')
  await page.getByRole('button', { name: /预览|Preview/ }).click()
  await expect(page.getByText('build $ npm run build')).toBeVisible()
  await expect(page.getByText('action:inspect $ node action.mjs')).toBeVisible()
  await expect(page.getByText('event:session.created $ node event.mjs')).toBeVisible()
  await page.screenshot({ path: '/tmp/tmuxgo-plugin-completion-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Hello TmuxGo' }).last().click()
  await expect(page.getByRole('heading', { name: /设置|Settings/ })).toBeHidden()
  const iframe = page.locator('iframe')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
  const plugin = page.frameLocator('iframe')
  await expect(plugin.getByText(/local \/ session-/)).toBeVisible()
  await plugin.getByRole('button', { name: 'Run action' }).click()
  await expect(plugin.getByText(/host=local session=session-/)).toBeVisible()
  await page.screenshot({ path: '/tmp/tmuxgo-plugin-completion-view-desktop.png', fullPage: true })
  expect(errors).toEqual([])
})

test('opens and closes the mobile plugin view without leaving settings behind', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const errors = collectPageErrors(page)
  await openPluginSettings(page)
  await page.getByRole('button', { name: 'Hello TmuxGo' }).last().click()
  await expect(page.getByRole('heading', { name: /设置|Settings/ })).toBeHidden()
  const plugin = page.frameLocator('iframe')
  await expect(plugin.getByText(/local \/ session-/)).toBeVisible()
  await plugin.getByRole('button', { name: 'Run action' }).click()
  await expect(plugin.getByText(/host=local session=session-/)).toBeVisible()
  await page.screenshot({ path: '/tmp/tmuxgo-plugin-completion-mobile.png', fullPage: true })
  await page.getByRole('button', { name: /关闭|Close/ }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /设置|Settings/ }).last()).toBeVisible()
  expect(errors).toEqual([])
})
