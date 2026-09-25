import { test, expect } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { apiUrl } from './endpoints'
import { ensureSession, openSession, TEST_SESSION_NAME } from './session'

// 编辑器 tab 切换视口还原回归：真实 Monaco。A 文件滚到中部 → 切 B → 回 A 必须回到
// 原滚动位置而非顶部。定位数据只存浏览器内存（viewStateRef），文件关闭即清。
test.setTimeout(120_000)

type Pos = { line: number; column: number }
type View = Pos & { top: number; left: number }
type FileRoot = { id: string; label: string; path: string }

const FILE_NAMES = ['scroll-a.ts', 'scroll-b.ts', 'scroll-c.ts']
// 420 行保证垂直滚动余量；行尾 160 字符撑开水平滚动
function buildContent(tag: string) {
  const lines: string[] = []
  for (let i = 1; i <= 420; i++) lines.push(`const ${tag}L${i} = '${'x'.repeat(160)}${i}'`)
  return `${lines.join('\n')}\n`
}

let fixtureDir = ''
let fixtureDirName = ''
let homeRoot: FileRoot = { id: '', label: 'home', path: '' }
const fileAbs = (name: string) => path.join(fixtureDir, name)
const fileTab = (name: string) => name.split('/').pop() || name

// 按模型路径找存活实例：切 tab 会卸载旧实例挂新实例，getEditors 只含当前组内可见实例
async function editorView(page: any, absPath: string) {
  return page.evaluate((p) => {
    const editors = (window as any).monaco?.editor?.getEditors?.() || []
    const editor = editors.find((item: any) => item?.getModel?.()?.uri?.path === p)
    if (!editor) return null
    return {
      scrollTop: editor.getScrollTop?.() ?? 0,
      scrollLeft: editor.getScrollLeft?.() ?? 0,
      line: editor.getPosition?.()?.lineNumber ?? 0,
      column: editor.getPosition?.()?.column ?? 0,
      scrollWidth: editor.getScrollWidth?.() ?? 0,
      viewWidth: editor.getLayoutInfo?.()?.width ?? 0,
      maxTop: Math.max(0, (editor.getScrollHeight?.() ?? 0) - (editor.getLayoutInfo?.()?.height ?? 0)),
    }
  }, absPath)
}
// 挂载早期 scrollWidth 未测量时 setScrollLeft 会被钳回 0（scrollHeight 由行数×行高立即可知、
// 纵向不受影响）：真实用户会拖到视口动为止，这里同样按帧补到光标+两个轴向都落位
async function setView(page: any, absPath: string, view: View) {
  await expect
    .poll(
      async () => {
        const last = await page.evaluate(
          ([p, v]) => {
            const editors = (window as any).monaco?.editor?.getEditors?.() || []
            const editor = editors.find((item: any) => item?.getModel?.()?.uri?.path === p)
            if (!editor) return null
            editor.setPosition?.({ lineNumber: v.line, column: v.column })
            editor.setScrollTop?.(v.top)
            editor.setScrollLeft?.(v.left)
            return {
              scrollTop: editor.getScrollTop?.() ?? 0,
              scrollLeft: editor.getScrollLeft?.() ?? 0,
              line: editor.getPosition?.()?.lineNumber ?? 0,
              column: editor.getPosition?.()?.column ?? 0,
            }
          },
          [absPath, view],
        )
        return (
          !!last &&
          Math.abs(last.scrollTop - view.top) <= 4 &&
          Math.abs(last.scrollLeft - view.left) <= 4 &&
          last.line === view.line &&
          last.column === view.column
        )
      },
      { timeout: 15000 },
    )
    .toBe(true)
}
// remount 恢复走 onMount+逐帧校验，轮询到目标容差内而不是定点读一次
async function expectView(page: any, absPath: string, view: View, timeout = 15000) {
  let last: Awaited<ReturnType<typeof editorView>> = null
  try {
    await expect
      .poll(
        async () => {
          last = await editorView(page, absPath)
          if (!last) return false
          return (
            Math.abs(last.scrollTop - view.top) <= 4 &&
            Math.abs(last.scrollLeft - view.left) <= 4 &&
            last.line === view.line &&
            last.column === view.column
          )
        },
        { timeout },
      )
      .toBe(true)
  } catch {
    throw new Error(`view mismatch: want ${JSON.stringify(view)} got ${JSON.stringify(last)}`)
  }
}
async function switchTab(page: any, name: string, absPath: string) {
  await page.getByRole('button', { name: fileTab(name), exact: true }).click()
  await expect.poll(async () => (await editorView(page, absPath)) !== null).toBe(true)
}
// 面板单开是预览 tab，下一个文件会原位替换；标脏即钉住才能并存多 tab
async function markDirty(page: any, absPath: string) {
  await page.evaluate((p) => {
    const editors = (window as any).monaco?.editor?.getEditors?.() || []
    const editor = editors.find((item: any) => item?.getModel?.()?.uri?.path === p)
    editor?.executeEdits?.('e2e', [
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        text: 'x',
      },
    ])
  }, absPath)
}

function filePanelBox(page: any) {
  // 根选择是自定义 combobox；文件面板是唯一含文件名搜索框的 content-surface
  return page
    .locator('.tmuxgo-content-surface')
    .filter({ has: page.getByRole('textbox', { name: /^(搜索文件名|Search file names)$/ }) })
}
async function openFixtureFile(page: any, name: string) {
  const panel = filePanelBox(page)
  // Explorer 按钮是 toggle：面板已开时再点会把它关掉
  if (!(await panel.isVisible()))
    await page
      .getByRole('button', { name: /^(资源管理|Explorer|Files)$/ })
      .first()
      .click()
  await expect(panel).toBeVisible()
  const rootBox = panel.getByRole('combobox')
  if ((await rootBox.textContent())?.includes(homeRoot.label) !== true) {
    await rootBox.click()
    await page.getByRole('option', { name: homeRoot.label, exact: true }).click()
  }
  const fileRow = panel.locator(`[data-row-path="${fixtureDirName}/${name}"]`).first()
  // 目录展开状态跨文件保留：已展开时点 dirRow 会折叠，只在文件行不可见时展开
  if (!(await fileRow.isVisible())) {
    const dirRow = panel.locator(`[data-row-path="${fixtureDirName}"]`).first()
    await expect(dirRow).toBeVisible()
    await dirRow.click()
  }
  await expect(fileRow).toBeVisible()
  await fileRow.click()
  await expect.poll(async () => (await editorView(page, fileAbs(name))) !== null, { timeout: 30000 }).toBe(true)
}

test.beforeAll(async ({ request }) => {
  const rootsResponse = await request.get(`${apiUrl}/api/hosts/local/files/roots`)
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = (await rootsResponse.json()) as FileRoot[]
  homeRoot = roots.find((item) => item.label.toLowerCase() === 'home') || roots[0]
  fixtureDir = await mkdtemp(path.join(homeRoot.path, 'scroll-fixture-'))
  fixtureDirName = path.basename(fixtureDir)
  for (const name of FILE_NAMES) await writeFile(path.join(fixtureDir, name), buildContent(name))
})
test.afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})
test.beforeEach(async ({ page, request }) => {
  const session = await ensureSession(request, TEST_SESSION_NAME)
  await openSession(page, session, { expectHeader: false })
  await expect(page.getByRole('button', { name: /^(资源管理|Explorer|Files)$/ }).first()).toBeVisible({
    timeout: 15000,
  })
})

test.describe('editor scroll restore on tab switch', () => {
  test('scroll offset, horizontal offset and cursor survive a tab round-trip', async ({ page }) => {
    await openFixtureFile(page, 'scroll-a.ts')
    await markDirty(page, fileAbs('scroll-a.ts'))
    await openFixtureFile(page, 'scroll-b.ts')
    await markDirty(page, fileAbs('scroll-b.ts'))
    // getEditors 只含活动 tab 实例：先切回 A 落位，再验证 B→A 往返后视口还原
    await switchTab(page, 'scroll-a.ts', fileAbs('scroll-a.ts'))
    const view = { top: 3200, left: 240, line: 160, column: 9 }
    await setView(page, fileAbs('scroll-a.ts'), view)
    await switchTab(page, 'scroll-b.ts', fileAbs('scroll-b.ts'))
    await switchTab(page, 'scroll-a.ts', fileAbs('scroll-a.ts'))
    await expectView(page, fileAbs('scroll-a.ts'), view)
  })

  // 10 组随机翻动+随机切换：每轮先落位再切走切回，断言滚回同一位置
  test('per-tab positions survive 10 randomized switch sequences', async ({ page }) => {
    await openFixtureFile(page, 'scroll-a.ts')
    await markDirty(page, fileAbs('scroll-a.ts'))
    await openFixtureFile(page, 'scroll-b.ts')
    await markDirty(page, fileAbs('scroll-b.ts'))
    await openFixtureFile(page, 'scroll-c.ts')
    const targets = FILE_NAMES.map(fileAbs)
    let seed = 20260924
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor((seed / 2147483648) * max)
    }
    for (let round = 0; round < 10; round++) {
      const from = targets[round % targets.length]
      // rand(len-1)∈[0,len-2]：目标索引落在 (i+1..i+len-1)%len，必与 from 不同
      const to = targets[(round + 1 + rand(targets.length - 1)) % targets.length]
      await switchTab(page, fileTab(from), from)
      const current = await editorView(page, from)
      if (!current) throw new Error(`editor for ${from} not mounted`)
      const view: View = {
        top: rand(Math.max(1, Math.floor(current.maxTop))),
        left: rand(600),
        line: 1 + rand(419),
        column: 1 + rand(40),
      }
      await setView(page, from, view)
      await switchTab(page, fileTab(to), to)
      await switchTab(page, fileTab(from), from)
      await expectView(page, from, view)
    }
  })

  test('bottom-of-file scroll position survives switching', async ({ page }) => {
    await openFixtureFile(page, 'scroll-a.ts')
    await markDirty(page, fileAbs('scroll-a.ts'))
    await openFixtureFile(page, 'scroll-b.ts')
    await switchTab(page, 'scroll-a.ts', fileAbs('scroll-a.ts'))
    const state = await editorView(page, fileAbs('scroll-a.ts'))
    if (!state) throw new Error('editor not mounted')
    const view = { top: state.maxTop, left: 0, line: 420, column: 1 }
    await setView(page, fileAbs('scroll-a.ts'), view)
    await switchTab(page, 'scroll-b.ts', fileAbs('scroll-b.ts'))
    await switchTab(page, 'scroll-a.ts', fileAbs('scroll-a.ts'))
    await expect
      .poll(async () => {
        const restored = await editorView(page, fileAbs('scroll-a.ts'))
        return restored ? Math.abs(restored.scrollTop - view.top) <= 8 : false
      })
      .toBe(true)
  })

  // 边界：定位数据只随打开中的文件存活，关闭即清——重开同一文件回到顶部而非旧位置
  test('closed file drops its position; reopening lands at the top', async ({ page }) => {
    await openFixtureFile(page, 'scroll-a.ts')
    await markDirty(page, fileAbs('scroll-a.ts'))
    await openFixtureFile(page, 'scroll-b.ts')
    const view = { top: 2400, left: 120, line: 130, column: 5 }
    await setView(page, fileAbs('scroll-b.ts'), view)
    await page.getByRole('button', { name: `Close ${fileTab('scroll-b.ts')}` }).click()
    await expect.poll(async () => (await editorView(page, fileAbs('scroll-b.ts'))) === null).toBe(true)
    await openFixtureFile(page, 'scroll-b.ts')
    await expect
      .poll(async () => {
        const state = await editorView(page, fileAbs('scroll-b.ts'))
        return state ? state.scrollTop : -1
      })
      .toBe(0)
  })
})
