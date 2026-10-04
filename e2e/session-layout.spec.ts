import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { apiUrl } from './endpoints'
import { ensureSession, openSession } from './session'

// layout 导出/导入的浏览器闭环：UI 导出 JSON → 模板弹窗导入 → CreateSessionDialog 建 session。
// 负向覆盖两层：前端解析失败（非法版本）在弹窗内报错；gateway 拒绝（非法 preset /
// 危险 cwd / replace 保护）经 toast 或 apply API 断言清晰错误。

const LAYOUT_KIND = 'tmuxgo.session-layout'
let seq = 0
const uniqueName = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${seq++}`

// 命令面板「New Session」最终也是派发到该事件（ConsoleLayout 转发）；
// e2e 直接派发，聚焦测弹窗内部链路而非打开入口
async function openTemplatePicker(page: any) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tmuxgo-open-session-templates')))
  await expect(page.getByRole('heading', { name: /New Session Template|新建会话模板/ })).toBeVisible()
}

async function importLayoutFile(page: any, doc: unknown) {
  await page.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: 'layout.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  })
}

test('exports session layout JSON from the session list', async ({ page, request }) => {
  const session = await ensureSession(request, uniqueName('layexp'))
  await request.post(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(session.id)}/windows`, {
    data: { name: 'extra' },
  })
  await openSession(page, session)
  const row = page.locator('.tmuxgo-list-row', { hasText: session.name }).first()
  await row.hover()
  const downloadPromise = page.waitForEvent('download')
  await row.getByRole('button', { name: /Export layout JSON|导出布局 JSON/ }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`${session.name}.layout.json`)
  const doc = JSON.parse(readFileSync((await download.path()) as string, 'utf8'))
  expect(doc.kind).toBe(LAYOUT_KIND)
  expect(doc.version).toBe(1)
  expect(doc.name).toBe(session.name)
  expect(doc.windows.length).toBeGreaterThanOrEqual(2)
  expect(doc.windows.every((window: any) => Array.isArray(window.panes) && window.panes.length)).toBeTruthy()
  await expect(page.getByRole('status').filter({ hasText: /exported|已导出/ })).toBeVisible()
})

test('imports a layout JSON and creates the session through the dialog', async ({ page, request }) => {
  const name = uniqueName('layimp')
  const session = await ensureSession(request, 'test')
  await openSession(page, session)
  await openTemplatePicker(page)
  await importLayoutFile(page, {
    kind: LAYOUT_KIND,
    version: 1,
    name,
    windows: [
      { name: 'main', panes: [{}] },
      {
        name: 'ops',
        splitDirection: 'horizontal',
        layoutPreset: 'tiled',
        panes: [{ command: 'echo imported-ok' }, {}],
      },
    ],
  })
  // 导入成功 → CreateSessionDialog 以 layout 名预填 session 名
  await expect(page.getByPlaceholder(/Session name|会话名/)).toHaveValue(name)
  await page.getByRole('button', { name: /^(Create|创建)$/ }).click()
  await expect(page.getByRole('status').filter({ hasText: /created|已创建/ })).toBeVisible()
  await expect(page.locator('.tmuxgo-list-row', { hasText: name }).first()).toBeVisible()
  // gateway 侧落盘核对：窗口/分栏真实建立
  const sessions = await (await request.get(`${apiUrl}/api/hosts/local/sessions`)).json()
  const created = sessions.find((item: any) => item.name === name)
  expect(created).toBeTruthy()
  const layout = await (
    await request.get(`${apiUrl}/api/hosts/local/sessions/${encodeURIComponent(created.id)}/layout`)
  ).json()
  expect(layout.windows.map((window: any) => window.name)).toEqual(['main', 'ops'])
  expect(layout.windows.find((window: any) => window.name === 'ops').panes).toHaveLength(2)
})

test('shows an inline error for an unsupported layout version', async ({ page, request }) => {
  const session = await ensureSession(request, 'test')
  await openSession(page, session)
  await openTemplatePicker(page)
  await importLayoutFile(page, {
    kind: LAYOUT_KIND,
    version: 99,
    name: 'badver',
    windows: [{ name: 'w', panes: [{}] }],
  })
  await expect(page.locator('.tmuxgo-glass-dialog .text-danger')).toContainText(/version|版本/)
  // 解析失败不进入创建弹窗
  await expect(page.getByRole('button', { name: /^(Create|创建)$/ })).toHaveCount(0)
})

test('surfaces a clear error toast when the gateway rejects the layout', async ({ page, request }) => {
  const name = uniqueName('laybad')
  const session = await ensureSession(request, 'test')
  await openSession(page, session)
  await openTemplatePicker(page)
  // 非法 layoutPreset 过了前端粗检，gateway 应用时 select-layout 失败 → 错误必须可读
  await importLayoutFile(page, {
    kind: LAYOUT_KIND,
    version: 1,
    name,
    windows: [{ name: 'main', layoutPreset: 'bogus-preset', panes: [{}] }],
  })
  await page.getByRole('button', { name: /^(Create|创建)$/ }).click()
  await expect(page.getByRole('alert')).toContainText(/fail|layout|unknown|invalid/i)
  const sessions = await (await request.get(`${apiUrl}/api/hosts/local/sessions`)).json()
  expect(sessions.some((item: any) => item.name === name)).toBeFalsy()
})

// 危险 cwd / replace 保护只在 session-layouts/apply 校验（POST /sessions 不拦截，
// tmux -c 对坏目录静默降级）：在 e2e 里直接断言契约级错误文案
test('layout apply refuses unsafe cwd and overwriting existing sessions', async ({ request }) => {
  const apply = (layout: unknown, extra: Record<string, unknown> = {}) =>
    request.post(`${apiUrl}/api/hosts/local/session-layouts/apply`, { data: { layout, mode: 'create', ...extra } })
  const doc = { kind: LAYOUT_KIND, version: 1, name: 'test', windows: [{ name: 'w', panes: [{}] }] }
  const conflict = await apply(doc, { name: 'test' })
  expect(conflict.ok()).toBeFalsy()
  expect(await conflict.text()).toContain('Session already exists')
  const relative = await apply({
    ...doc,
    name: uniqueName('layrel'),
    windows: [{ name: 'w', panes: [{ cwd: '../outside' }] }],
  })
  expect(await relative.text()).toContain('cwd must be absolute')
  const missing = await apply({
    ...doc,
    name: uniqueName('laymiss'),
    windows: [{ name: 'w', panes: [{ cwd: '/nonexistent-tmuxgo-e2e-dir' }] }],
  })
  expect(await missing.text()).toContain('does not exist')
})
