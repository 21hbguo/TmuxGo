import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { apiUrl } from './endpoints'
import { ensureSession, openSession, TEST_SESSION_NAME } from './session'

// 编辑区真实浏览器延迟验收：输入 → 绘制、打开文件 → 可交互、命令 → 面板可见。
// 数据在页面内采样（keydown 时间戳 → 下一次「模型内容变化后的 rAF」），
// 不用 Playwright 往返时间冒充延迟；预算按 60Hz 两帧给（单帧 16.7ms）。
// 跑法：npx playwright test e2e/editor-latency.spec.ts（需 start.sh 起的 dev server）
test.setTimeout(180_000)

type FileRoot = { id: string; label: string; path: string }

interface LatencySample {
  keyToModel: number[]
  keyToPaint: number[]
  cursorToStatusBar: number[]
}

const BUDGET = {
  // 单键 keydown → Monaco 模型变更 + 一帧绘制
  typingP95: 50,
  typingMax: 120,
  // 打开文件（点击行）→ Monaco 模型挂载且可输入
  openToInteractive: 1500,
  // 光标移动 → 状态栏文案更新
  cursorToStatusBar: 100,
} as const

let fixtureDir = ''
let fixtureDirName = ''
let homeRoot: FileRoot = { id: '', label: 'home', path: '' }

const FILE_LINES = 400
const fixtureContent = Array.from({ length: FILE_LINES }, (_, index) =>
  index % 20 === 0
    ? `export function handler${index}(input: string) {`
    : index % 20 === 19
      ? '}'
      : `  const value${index} = input.length + ${index}`,
).join('\n')

async function openFixtureFile(page: Page, name: string) {
  await page
    .getByRole('button', { name: /^(资源管理|Explorer|Files)$/ })
    .first()
    .click()
  const panel = page
    .locator('.tmuxgo-content-surface')
    .filter({ has: page.getByRole('textbox', { name: /^(搜索文件名|Search file names)$/ }) })
  await expect(panel).toBeVisible()
  await panel.getByRole('combobox').click()
  await page.getByRole('option', { name: homeRoot.label, exact: true }).click()
  const dirRow = panel.locator(`[data-row-path="${fixtureDirName}"]`).first()
  await expect(dirRow).toBeVisible()
  await dirRow.click()
  const fileRow = panel.locator(`[data-row-path="${fixtureDirName}/${name}"]`).first()
  for (let attempt = 0; attempt < 10 && (await fileRow.count()) === 0; attempt += 1) {
    await panel.hover()
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(60)
  }
  await expect(fileRow).toBeVisible()
  return fileRow
}

// 页面内采样器：keydown 记 t0；Monaco 模型文本变化后下一帧记 t1（模型）与 t2（绘制）
async function installSampler(page: Page) {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __editorLatency?: LatencySample & { dispose?: () => void; reset?: () => void }
      monaco?: {
        editor: {
          getEditors: () => {
            getModel?: () => { onDidChangeContent?: (cb: () => void) => { dispose: () => void } }
            onDidChangeCursorPosition?: (cb: () => void) => { dispose: () => void }
            getDomNode?: () => HTMLElement | null
          }[]
        }
      }
    }
    const sample = {
      keyToModel: [] as number[],
      keyToPaint: [] as number[],
      cursorToStatusBar: [] as number[],
      reset() {
        this.keyToModel.length = 0
        this.keyToPaint.length = 0
        this.cursorToStatusBar.length = 0
      },
    }
    scope.__editorLatency = sample
    let keyDownAt = 0
    document.addEventListener(
      'keydown',
      () => {
        keyDownAt = performance.now()
      },
      true,
    )
    const attach = () => {
      const editor = scope.monaco?.editor?.getEditors?.()[0]
      const model = editor?.getModel?.()
      if (!model?.onDidChangeContent) return false
      model.onDidChangeContent(() => {
        if (!keyDownAt) return
        const modelAt = performance.now()
        sample.keyToModel.push(modelAt - keyDownAt)
        requestAnimationFrame(() => {
          sample.keyToPaint.push(performance.now() - keyDownAt)
          keyDownAt = 0
        })
      })
      return true
    }
    // 编辑器实例可能还没挂载：轮询直到挂上（最多 15s）
    const timer = window.setInterval(() => {
      if (attach()) window.clearInterval(timer)
    }, 50)
    sample.dispose = () => window.clearInterval(timer)
  })
}

async function readSamples(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __editorLatency?: LatencySample }).__editorLatency || {
        keyToModel: [],
        keyToPaint: [],
        cursorToStatusBar: [],
      },
  )
}

const percentile = (values: number[], ratio: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

async function waitEditorMounted(page: Page, timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const scope = window as typeof window & {
        monaco?: { editor: { getEditors: () => { getModel?: () => unknown; hasTextFocus?: () => boolean }[] } }
      }
      const editors = scope.monaco?.editor?.getEditors?.() || []
      return editors.some((editor) => !!editor.getModel?.())
    },
    undefined,
    { timeout },
  )
}

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  const rootsResponse = await request.get(`${apiUrl}/api/hosts/local/files/roots`)
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = (await rootsResponse.json()) as FileRoot[]
  homeRoot = roots.find((item) => item.label.toLowerCase() === 'home') || roots[0]
  fixtureDir = await mkdtemp(path.join(homeRoot.path, 'latency-fixture-'))
  fixtureDirName = path.basename(fixtureDir)
  await writeFile(path.join(fixtureDir, 'big.ts'), `${fixtureContent}\n`)
})

test.afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

test.beforeEach(async ({ page, request }) => {
  const session = await ensureSession(request, TEST_SESSION_NAME)
  await openSession(page, session, { expectHeader: false })
  await expect(page.getByRole('button', { name: /^(资源管理|Explorer|Files)$/ }).first()).toBeVisible({ timeout: 15000 })
})

test('opening a 400-line file becomes interactive within budget', async ({ page }) => {
  const started = Date.now()
  const fileRow = await openFixtureFile(page, 'big.ts')
  await fileRow.click()
  await waitEditorMounted(page)
  await page.waitForFunction(() => {
    const scope = window as typeof window & { monaco?: { editor: { getEditors: () => { getModel?: () => { getLineCount?: () => number } }[] } } }
    const editor = scope.monaco?.editor?.getEditors?.()[0]
    return (editor?.getModel?.()?.getLineCount?.() || 0) >= 400
  })
  const elapsed = Date.now() - started
  expect(elapsed).toBeLessThan(BUDGET.openToInteractive + 500)
})

test('typing latency stays inside two frames at p95', async ({ page }) => {
  const fileRow = await openFixtureFile(page, 'big.ts')
  await fileRow.click()
  await waitEditorMounted(page)
  await page.evaluate(() => {
    const scope = window as typeof window & { monaco?: { editor: { getEditors: () => { setPosition?: (p: unknown) => void; focus?: () => void }[] } } }
    const editor = scope.monaco?.editor?.getEditors?.()[0]
    editor?.setPosition?.({ lineNumber: 200, column: 3 })
    editor?.focus?.()
  })
  await installSampler(page)
  await page.keyboard.type('const measured = input.length + 1', { delay: 12 })
  const samples = await readSamples(page)
  expect(samples.keyToPaint.length).toBeGreaterThan(20)
  const p95 = percentile(samples.keyToPaint, 0.95)
  const max = Math.max(...samples.keyToPaint)
  console.log(`typing keydown→paint p50=${percentile(samples.keyToPaint, 0.5).toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms n=${samples.keyToPaint.length}`)
  expect(p95).toBeLessThan(BUDGET.typingP95)
  expect(max).toBeLessThan(BUDGET.typingMax)
})

test('cursor movement reaches the status bar within a frame budget', async ({ page }) => {
  const fileRow = await openFixtureFile(page, 'big.ts')
  await fileRow.click()
  await waitEditorMounted(page)
  const statusBar = page.getByTestId('editor-status-position')
  await expect(statusBar).toBeVisible()
  const started = Date.now()
  await page.evaluate(() => {
    const scope = window as typeof window & { monaco?: { editor: { getEditors: () => { setPosition?: (p: unknown) => void }[] } } }
    scope.monaco?.editor?.getEditors?.()[0]?.setPosition?.({ lineNumber: 120, column: 7 })
  })
  await expect(statusBar).toHaveText(/120/, { timeout: BUDGET.cursorToStatusBar + 2000 })
  console.log(`cursor→statusbar ${Date.now() - started}ms`)
})

test('editor command palette opens through the go-to-line shortcut', async ({ page }) => {
  const fileRow = await openFixtureFile(page, 'big.ts')
  await fileRow.click()
  await waitEditorMounted(page)
  const started = Date.now()
  await page.keyboard.press('Control+g')
  const picker = page.getByTestId('editor-quickpick')
  await expect(picker).toBeVisible()
  console.log(`Ctrl+G → picker ${Date.now() - started}ms`)
  // 面板出现后输入框还要一拍才拿到焦点：先点一下再打字，避免键序抖动导致丢字
  const input = picker.getByTestId('editor-quickpick-input')
  await input.click()
  // 122 行是 `  const value121 = input.length + 121`（列 7 落在标识符内），
  // 不要用 120 行：那是 fixture 里的 `}`，Monaco 会把列夹到 2，断言 7 会误判产品有 bug
  await input.fill('122:7')
  await expect(input).toHaveValue('122:7')
  const jumpStarted = Date.now()
  await input.press('Enter')
  await expect(picker).toBeHidden()
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scope = window as typeof window & {
            monaco?: { editor: { getEditors: () => { getPosition?: () => { lineNumber: number; column: number } | null }[] } }
          }
          return scope.monaco?.editor?.getEditors?.()[0]?.getPosition?.() || null
        }),
      { timeout: 3000 },
    )
    .toEqual({ lineNumber: 122, column: 7 })
  console.log(`Enter → 122:7 ${Date.now() - jumpStarted}ms`)
  await expect(page.getByTestId('editor-status-position')).toHaveText(/122.*7/)
})
