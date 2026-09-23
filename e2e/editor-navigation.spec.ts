import { test, expect } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { apiUrl } from './endpoints'
import { ensureSession, openSession, TEST_SESSION_NAME } from './session'

// 编辑器定义跳转/返回前进真实交互回归（评审文档 §六验收矩阵）：
// 真实 Monaco（CDN loader 加载，非替身），fixture 为调用行与定义行分离的长文件，
// 定义名列均 >1（防 1:1 假过）；位置读取走 window.monaco 编辑器实例（生产对象，
// 无新增调试接口）。N-A/N-B 未合并前中转导出、慢搜索回退、stale-pending 用例预期红
test.setTimeout(120_000)

type Pos = { line: number; column: number }
type FileRoot = { id: string; label: string; path: string }

interface BuiltFile {
  content: string
  marks: Record<string, Pos>
}
// mark() 在写行时同步记录 needle 的精确行列，断言不手数、不 includes
function buildFile(
  emit: (f: {
    pad: (toLine: number) => void
    put: (text: string) => void
    mark: (name: string, text: string, needle: string) => void
  }) => void,
): BuiltFile {
  const lines: string[] = []
  const marks: Record<string, Pos> = {}
  emit({
    pad: (toLine) => {
      while (lines.length < toLine - 1) lines.push(`// pad ${lines.length + 1}`)
    },
    put: (text) => {
      lines.push(text)
    },
    mark: (name, text, needle) => {
      lines.push(text)
      marks[name] = { line: lines.length, column: text.indexOf(needle) + 1 }
    },
  })
  return { content: `${lines.join('\n')}\n`, marks }
}
function reentryFile(specifier: string, call: string) {
  return buildFile((f) => {
    f.put(specifier)
    f.pad(10)
    f.put('export function useIt() {')
    f.mark('call', `  return ${call}()`, call)
    f.put('}')
  })
}
function buildFixtures() {
  return {
    'a-entry.ts': buildFile((f) => {
      f.put(`import { betaFn } from './b-mid'`)
      f.put(`import { deltaFn } from './d-branch'`)
      f.pad(53)
      f.put('export function entryMain() {')
      f.mark('betaCall', '  const b = betaFn()', 'betaFn')
      f.mark('deltaCall', '  const d = deltaFn()', 'deltaFn')
      f.mark('helperCall', '  const h = sameFileHelper()', 'sameFileHelper')
      f.mark('missingCall', '  const m = missingFn()', 'missingFn')
      f.put('  return b + d + h + m')
      f.put('}')
      f.pad(93)
      f.mark('helperDef', 'const sameFileHelper = () => 1', 'sameFileHelper')
    }),
    'b-mid.ts': buildFile((f) => {
      f.put(`import { gammaFn } from './c-deep'`)
      f.pad(39)
      f.mark('betaDef', 'export function betaFn() {', 'betaFn')
      f.mark('gammaCall', '  return gammaFn()', 'gammaFn')
      f.put('}')
      f.pad(71)
    }),
    'c-deep.ts': buildFile((f) => {
      f.put('// deep module')
      f.pad(69)
      f.mark('gammaDef', 'export function gammaFn() {', 'gammaFn')
      f.put('  return 42')
      f.put('}')
    }),
    'd-branch.ts': buildFile((f) => {
      f.put('// branch module')
      f.pad(29)
      f.mark('deltaDef', 'export function deltaFn() {', 'deltaFn')
      f.put('  return 7')
      f.put('}')
    }),
    'barrel-named.ts': buildFile((f) => {
      f.put('// named barrel')
      f.put(`export { gammaFn } from './c-deep'`)
    }),
    'barrel-star.ts': buildFile((f) => {
      f.put('// star barrel')
      f.put(`export * from './c-deep'`)
    }),
    'barrel-ie.ts': buildFile((f) => {
      f.put(`import { gammaFn } from './c-deep'`)
      f.put(`export { gammaFn }`)
    }),
    'barrel-alias.ts': buildFile((f) => {
      f.put('// alias barrel')
      f.put(`export { gammaFn as aliasFn } from './c-deep'`)
    }),
    'default-id.ts': buildFile((f) => {
      f.put('// default id module')
      f.mark('defDef', 'function deltaDefaultFn() { return 1 }', 'deltaDefaultFn')
      f.put('export default deltaDefaultFn')
    }),
    're-named.ts': reentryFile(`import { gammaFn } from './barrel-named'`, 'gammaFn'),
    're-star.ts': reentryFile(`import { gammaFn } from './barrel-star'`, 'gammaFn'),
    're-ie.ts': reentryFile(`import { gammaFn } from './barrel-ie'`, 'gammaFn'),
    're-alias.ts': reentryFile(`import { aliasFn } from './barrel-alias'`, 'aliasFn'),
    're-default.ts': reentryFile(`import deltaDefaultFn from './default-id'`, 'deltaDefaultFn'),
  }
}

let fixtureDir = ''
let fixtureDirName = ''
let homeRoot: FileRoot = { id: '', label: 'home', path: '' }
const marks: Record<string, Record<string, Pos>> = {}
const fileAbs = (name: string) => path.join(fixtureDir, name)

// ---- Monaco 观察：window.monaco 是 loader 注入的生产实例，直接读模型 URI/光标/可见区
async function editorState(page: any) {
  return page.evaluate(() => {
    const monaco = (window as any).monaco
    const editors = monaco?.editor?.getEditors?.() || []
    const editor = editors.find((item: any) => item?.hasTextFocus?.()) || editors[0]
    if (!editor) return null
    const model = editor.getModel?.()
    const position = editor.getPosition?.()
    const visible = (editor.getVisibleRanges?.() || []).map((range: any) => [
      range.startLineNumber,
      range.endLineNumber,
    ])
    return {
      path: model?.uri?.path || '',
      line: position?.lineNumber || 0,
      column: position?.column || 0,
      visible,
    }
  })
}
// 落位验证点：模型+精确行列+目标行进入视口（reveal 丢失不得算过）。
// 用于定义跳转落点——视口跟随是跳转正确性的一部分
async function expectEditorAt(page: any, absPath: string, pos: Pos, timeout = 15000) {
  await expect
    .poll(
      async () => {
        const state = await editorState(page)
        if (!state || state.path !== absPath || state.line !== pos.line || state.column !== pos.column) return false
        return state.visible.some(([first, last]: [number, number]) => first <= pos.line && pos.line <= last)
      },
      { timeout },
    )
    .toBe(true)
}
// 仅模型+精确行列的落位等待：历史链/中转导出/stale 用例验证的是位置语义，
// 中间落点不做视口断言，避免共享 reveal 缺陷掩盖真正的语义失败点
async function waitEditorPosition(page: any, absPath: string, pos: Pos, timeout = 15000) {
  await expect
    .poll(
      async () => {
        const state = await editorState(page)
        return !!state && state.path === absPath && state.line === pos.line && state.column === pos.column
      },
      { timeout },
    )
    .toBe(true)
}
// 头部 Ln/Col 文案由 cursorById 渲染：等到它说明 React 状态已提交，
// F12/Alt 快捷键读取的 getNavigationPosition 才不会拿到旧光标
async function waitCursorCommitted(page: any, pos: Pos) {
  await expect(page.getByText(new RegExp(`Ln ${pos.line}, Col ${pos.column}`)).first()).toBeVisible()
}
async function setCursor(page: any, pos: Pos) {
  await page.evaluate((p) => {
    const editor = (window as any).monaco?.editor?.getEditors?.()?.[0]
    editor?.setPosition?.({ lineNumber: p.line, column: p.column })
    editor?.revealPositionInCenter?.({ lineNumber: p.line, column: p.column })
    editor?.focus?.()
  }, pos)
  await waitCursorCommitted(page, pos)
}
// 词中点真实点击：getScrolledVisiblePosition 相对 editor domNode，加 bounding rect
// 得视口坐标；先 setScrollTop 瞬时定位规避 smoothScrolling 动画期坐标漂移
async function clickWord(page: any, pos: Pos & { len: number }, modifiers: 'ctrl' | null = null) {
  const handle = await page.waitForFunction(
    (p) => {
      const editor = (window as any).monaco?.editor?.getEditors?.()?.[0]
      if (!editor) return false
      const layout = editor.getLayoutInfo?.()
      if (layout) editor.setScrollTop?.(editor.getTopForLineNumber(p.line) - layout.height / 3)
      const start = editor.getScrolledVisiblePosition({ lineNumber: p.line, column: p.column })
      const end = editor.getScrolledVisiblePosition({ lineNumber: p.line, column: p.column + p.len })
      const rect = editor.getDomNode()?.getBoundingClientRect()
      if (!start || !end || !rect) return false
      return { x: rect.left + (start.left + end.left) / 2, y: rect.top + start.top + start.height / 2 }
    },
    pos,
    { timeout: 10000 },
  )
  const point = (await handle.jsonValue()) as { x: number; y: number }
  if (modifiers === 'ctrl') await page.keyboard.down('Control')
  await page.mouse.click(Math.round(point.x), Math.round(point.y))
  if (modifiers === 'ctrl') await page.keyboard.up('Control')
}

function filePanelBox(page: any) {
  // 根选择是自定义 combobox；文件面板是唯一含文件名搜索框的 content-surface
  return page
    .locator('.tmuxgo-content-surface')
    .filter({ has: page.getByRole('textbox', { name: /^(搜索文件名|Search file names)$/ }) })
}
async function openFixtureFile(page: any, name: string) {
  await page
    .getByRole('button', { name: /^(资源管理|Explorer|Files)$/ })
    .first()
    .click()
  const panel = filePanelBox(page)
  await expect(panel).toBeVisible()
  await panel.getByRole('combobox').click()
  await page.getByRole('option', { name: homeRoot.label, exact: true }).click()
  const dirRow = panel.locator(`[data-row-path="${fixtureDirName}"]`).first()
  await expect(dirRow).toBeVisible()
  await dirRow.click()
  const fileRow = panel.locator(`[data-row-path="${fixtureDirName}/${name}"]`).first()
  await expect(fileRow).toBeVisible()
  await fileRow.click()
  await expect.poll(async () => (await editorState(page))?.path, { timeout: 30000 }).toBe(fileAbs(name))
}
function navButton(page: any, kind: 'back' | 'forward' | 'definition') {
  const names = { back: /^(返回|Back)$/, forward: /^(前进|Forward)$/, definition: /^(跳转到定义|Go to definition)$/ }
  return page.locator('[data-editor-drop]').getByRole('button', { name: names[kind] })
}

test.beforeAll(async ({ request }) => {
  const rootsResponse = await request.get(`${apiUrl}/api/hosts/local/files/roots`)
  expect(rootsResponse.ok()).toBeTruthy()
  const roots = (await rootsResponse.json()) as FileRoot[]
  homeRoot = roots.find((item) => item.label.toLowerCase() === 'home') || roots[0]
  fixtureDir = await mkdtemp(path.join(homeRoot.path, 'nav-fixture-'))
  fixtureDirName = path.basename(fixtureDir)
  for (const [name, file] of Object.entries(buildFixtures())) {
    marks[name] = file.marks
    await writeFile(path.join(fixtureDir, name), file.content)
  }
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

test.describe('editor navigation regression', () => {
  test('F12 jumps cross-file to the declaration identifier', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].betaCall)
    await page.keyboard.press('F12')
    await expectEditorAt(page, fileAbs('b-mid.ts'), marks['b-mid.ts'].betaDef)
  })

  test('F12 jumps within the same file to the declaration', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].helperCall)
    await page.keyboard.press('F12')
    await expectEditorAt(page, fileAbs('a-entry.ts'), marks['a-entry.ts'].helperDef)
  })

  test('Ctrl+click on a call site jumps to the definition', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await clickWord(page, { ...marks['a-entry.ts'].deltaCall, len: 'deltaFn'.length }, 'ctrl')
    await expectEditorAt(page, fileAbs('d-branch.ts'), marks['d-branch.ts'].deltaDef)
  })

  test('toolbar definition button jumps to the definition', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].betaCall)
    await navButton(page, 'definition').click()
    await expectEditorAt(page, fileAbs('b-mid.ts'), marks['b-mid.ts'].betaDef)
  })

  test('Back/Forward buttons and Alt+arrows cross-restore exact positions', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    const source = marks['a-entry.ts'].betaCall
    const target = marks['b-mid.ts'].betaDef
    await setCursor(page, source)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), target)
    await expect(navButton(page, 'back')).toBeEnabled()
    await navButton(page, 'back').click()
    await waitEditorPosition(page, fileAbs('a-entry.ts'), source)
    await expect(navButton(page, 'forward')).toBeEnabled()
    await navButton(page, 'forward').click()
    await waitEditorPosition(page, fileAbs('b-mid.ts'), target)
    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('a-entry.ts'), source)
    await page.keyboard.press('Alt+ArrowRight')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), target)
    // 快捷键只触发应用内导航，不能让浏览器带离页面
    expect(page.url()).toBe(`${apiUrl}/`)
  })

  test('multi-hop A→B→C, back x2 forward x2, then jump D clears forward branch', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    const aCall = marks['a-entry.ts'].betaCall
    const bDef = marks['b-mid.ts'].betaDef
    const bCall = marks['b-mid.ts'].gammaCall
    const cDef = marks['c-deep.ts'].gammaDef
    await setCursor(page, aCall)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), bDef)
    await setCursor(page, bCall)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('c-deep.ts'), cDef)

    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), bCall)
    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('a-entry.ts'), aCall)
    await page.keyboard.press('Alt+ArrowRight')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), bCall)
    await page.keyboard.press('Alt+ArrowRight')
    await waitEditorPosition(page, fileAbs('c-deep.ts'), cDef)

    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), bCall)
    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('a-entry.ts'), aCall)
    await setCursor(page, marks['a-entry.ts'].deltaCall)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('d-branch.ts'), marks['d-branch.ts'].deltaDef)
    // 新定义跳转后旧 forward 分支必须清空
    await expect(navButton(page, 'forward')).toBeDisabled()
    await page.keyboard.press('Alt+ArrowRight')
    await page.waitForTimeout(500)
    await waitEditorPosition(page, fileAbs('d-branch.ts'), marks['d-branch.ts'].deltaDef)
  })

  test('Forward restores the position where B was left, not the original landing', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].betaCall)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), marks['b-mid.ts'].betaDef)
    const moved = { line: 60, column: 5 }
    await setCursor(page, moved)
    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('a-entry.ts'), marks['a-entry.ts'].betaCall)
    await page.keyboard.press('Alt+ArrowRight')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), moved)
  })

  // N-B 修复前预期红：慢定义搜索期间 Alt+Left 已返回，旧结果不得再抢导航
  test('stale slow-search result must not re-navigate after Back', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].betaCall)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), marks['b-mid.ts'].betaDef)
    // 拦截 c-deep.ts 内容请求制造慢搜索：resolver 与打开各走一次 files/content
    await page.route('**/api/hosts/local/files/content**', async (route) => {
      if (decodeURIComponent(route.request().url()).includes('c-deep.ts'))
        await new Promise((resolve) => setTimeout(resolve, 2500))
      await route.continue()
    })
    await setCursor(page, marks['b-mid.ts'].gammaCall)
    await page.keyboard.press('F12')
    await page.waitForTimeout(400)
    await page.keyboard.press('Alt+ArrowLeft')
    await waitEditorPosition(page, fileAbs('a-entry.ts'), marks['a-entry.ts'].betaCall)
    // 等慢解析链（resolver fetch + openFileInEditor fetch，各 ~2.5s）完全走完再定论
    await page.waitForTimeout(8000)
    const state = await editorState(page)
    if (!state) throw new Error('editor state unavailable')
    expect({ path: state.path, line: state.line, column: state.column }).toEqual({
      path: fileAbs('a-entry.ts'),
      ...marks['a-entry.ts'].betaCall,
    })
    // 过期结果也不得清空 forward 栈：Alt+Right 应能重做回离开 B 时的位置
    await page.keyboard.press('Alt+ArrowRight')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), marks['b-mid.ts'].gammaCall)
  })

  // N-B/N3 修复前预期红：跳转落位消费后 pending 仍保留 1500ms 复用窗口；
  // 窗口内经文件面板重开同一文件走 loading 门 remount，旧 pending 不得覆盖用户新位置
  test('re-opened file keeps user cursor instead of replaying stale pending location', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].betaCall)
    await page.keyboard.press('F12')
    await waitEditorPosition(page, fileAbs('b-mid.ts'), marks['b-mid.ts'].betaDef)
    const moved = { line: 60, column: 5 }
    await setCursor(page, moved)
    // 面板仍开着且目录已展开：直接点同一文件行触发 loading 门 remount（预览 tab 语义下同 id 复用）
    await filePanelBox(page).locator(`[data-row-path="${fixtureDirName}/b-mid.ts"]`).first().click()
    // remount+重放发生在点击后数百毫秒内，固定等待后一次性断言
    await page.waitForTimeout(2500)
    const state = await editorState(page)
    if (!state) throw new Error('editor state unavailable')
    expect({ path: state.path, line: state.line, column: state.column }).toEqual({
      path: fileAbs('b-mid.ts'),
      ...moved,
    })
  })

  // N-A 修复前预期红：中转/别名/default 导出链应解析到真实声明，不得落 barrel 顶部
  const reexportCases = [
    { name: 'named re-export', entry: 're-named.ts', want: 'c-deep.ts', mark: 'gammaDef' },
    { name: 'star re-export', entry: 're-star.ts', want: 'c-deep.ts', mark: 'gammaDef' },
    { name: 'import then export', entry: 're-ie.ts', want: 'c-deep.ts', mark: 'gammaDef' },
    { name: 'export alias', entry: 're-alias.ts', want: 'c-deep.ts', mark: 'gammaDef' },
    { name: 'default identifier', entry: 're-default.ts', want: 'default-id.ts', mark: 'defDef' },
  ]
  for (const item of reexportCases) {
    test(`re-export chain resolves to real declaration: ${item.name}`, async ({ page }) => {
      await openFixtureFile(page, item.entry)
      await setCursor(page, marks[item.entry].call)
      await page.keyboard.press('F12')
      await waitEditorPosition(page, fileAbs(item.want), marks[item.want][item.mark])
    })
  }

  test('missing symbol stays put and reports not found', async ({ page }) => {
    await openFixtureFile(page, 'a-entry.ts')
    await setCursor(page, marks['a-entry.ts'].missingCall)
    await page.keyboard.press('F12')
    await expect(page.getByText(/未找到定义|Definition not found/).first()).toBeVisible({ timeout: 10000 })
    await expectEditorAt(page, fileAbs('a-entry.ts'), marks['a-entry.ts'].missingCall)
  })
})
