import { devices, expect, test } from '@playwright/test'
import { ensureTestWindow, openSession } from './session'

// 手机端上传的「上传后将路径插入终端」默认值：默认勾选，且真的把服务端返回的
// 绝对路径送进粘贴确认（不自动写入终端）。
// 跑在 scripts/run-e2e.ts 的隔离环境里（临时 config/HOME/tmux socket），不触碰线上实例。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// Pixel 5 描述符自带 defaultBrowserType，只能放在文件顶层（describe 内会强制换 worker）
test.use({ ...devices['Pixel 5'] })

test.describe('mobile upload insert default', () => {
  test.setTimeout(60000)

  test('pre-checks insert on a phone and delivers the uploaded path to paste confirmation', async ({
    page,
    request,
  }) => {
    const stamp = Date.now()
    const fileName = `insert-${stamp}.png`
    const { session } = await ensureTestWindow(request, `upload_insert_${stamp}`)
    // 非紧凑底栏没有上传入口（9 个固定位），用紧凑底栏并把上传提到栏位
    await page.addInitScript(() => {
      localStorage.setItem('tmuxgo-mobile-nav-compact', 'true')
      localStorage.setItem('tmuxgo-mobile-nav-bar-items', JSON.stringify(['upload']))
    })
    await openSession(page, session)

    await page.getByRole('button', { name: '上传', exact: true }).click()

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: '选择文件', exact: true }).click(),
    ])
    await chooser.setFiles({ name: fileName, mimeType: 'image/png', buffer: PNG })

    // 暂存区就绪后进确认弹窗
    await page.getByRole('button', { name: /^上传 1 个/ }).click()

    // 手机端默认勾选，并直接给出可切换的目标窗格
    await expect(page.getByRole('checkbox', { name: '上传后将路径插入终端' })).toBeChecked()
    await expect(page.getByRole('combobox', { name: '目标窗格' })).toBeVisible()

    // 确认弹窗的「上传」与底栏同名；弹窗 portal 挂在 body 末尾，取最后一个即它
    await page.getByRole('button', { name: '上传', exact: true }).last().click()

    // 上传完成后路径进粘贴确认弹窗（quoteShellPath 产物），而不是直写终端
    // 终端本身也有隐藏 textarea（mobile-kb-input/xterm），用粘贴弹窗的样式类收窄
    // 文件名带时间戳：不会被冲突重命名成 "(1)"，可断言完整落点
    await expect(page.locator('textarea.tmuxgo-textarea')).toHaveValue(
      new RegExp(`/uploads/${fileName.replace(/\./g, '\\.')}'$`),
      { timeout: 20000 },
    )
    await page.keyboard.press('Escape')
  })
})
