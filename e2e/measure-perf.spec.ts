import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSession, ensureTestWindow } from './session'

// U5 交互性能验收（pnpm measure:perf 驱动，TMUXGO_MEASURE_PERF=1 时才进入套件）：
// 任务时间而非包体大小——冷启动到可输入、面板打开到可交互、切会话到正确输出出现；
// 同设备同网络多轮取中位数+较慢样本；构建预算统计静态依赖闭包与初始请求

const ROUNDS = Math.max(1, Number(process.env.TMUXGO_MEASURE_ROUNDS || 5))
const SWITCH_SESSION = 'measure-switch-b'
const KB = 1024
const BUDGET = {
  entryJs: Number(process.env.TMUXGO_BUDGET_ENTRY_KB || 600) * KB,
  staticClosureJs: Number(process.env.TMUXGO_BUDGET_CLOSURE_KB || 1300) * KB,
  css: Number(process.env.TMUXGO_BUDGET_CSS_KB || 120) * KB,
  initialRequests: Number(process.env.TMUXGO_BUDGET_INITIAL_KB || 1500) * KB,
  novnc: Number(process.env.TMUXGO_BUDGET_NOVNC_KB || 250) * KB,
}

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const summary = (xs: number[]) => ({ samples: xs, median: median(xs), max: Math.max(...xs) })

// init script 会被序列化注入页面，session id 必须走参数不能靠闭包
function seedSession(id: string) {
  localStorage.setItem('tmuxgo-preferences', JSON.stringify({ language: 'en' }))
  localStorage.setItem('tmuxgo-active-host', 'local')
  localStorage.setItem('tmuxgo-active-session:local', id)
  localStorage.setItem('tmuxgo-active-session', id)
  const key = `tmuxgo-console-state:${/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop'}`
  const persisted = JSON.parse(localStorage.getItem(key) || '{}')
  localStorage.setItem(
    key,
    JSON.stringify({ ...persisted, state: { ...persisted.state, activeHostId: 'local', activeSessionId: id } }),
  )
}

function bufferLines(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const buffer = (window as any).__tmuxgoTerminal?.buffer?.active
    if (!buffer) return []
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) || '')
    return lines
  })
}

async function waitForBufferLine(page: any, expected: string, timeout = 15000) {
  await page.waitForFunction(
    (want) => {
      const buffer = (window as any).__tmuxgoTerminal?.buffer?.active
      if (!buffer) return false
      for (let i = 0; i < buffer.length; i += 1) {
        if ((buffer.getLine(i)?.translateToString(true) || '').trim() === want) return true
      }
      return false
    },
    expected,
    { timeout },
  )
}

// 往隔离 tmux server 的目标 session 直接注入输出（spec 进程持有 TMUX_TMPDIR
// 指向隔离 server，不碰用户 session）；使切换目标带有可断言的正确输出
function tmuxType(target: string, text: string) {
  execFileSync('tmux', ['send-keys', '-t', target, text, 'Enter'])
}

async function focusTerminal(page: any) {
  await page.getByRole('textbox', { name: 'Terminal input' }).focus()
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, {
    timeout: 15000,
  })
}

function analyzeBundle(dist: string) {
  const manifestPath = join(dist, '.vite', 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`missing vite manifest: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    { file: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; css?: string[] }
  >
  const entryKey = Object.keys(manifest).find((key) => manifest[key]!.isEntry)
  if (!entryKey) throw new Error('manifest has no entry chunk')
  // 静态依赖闭包：entry 的 imports 递归
  const closure = new Set<string>()
  const visit = (key: string) => {
    if (closure.has(key) || !manifest[key]) return
    closure.add(key)
    for (const next of manifest[key]!.imports ?? []) visit(next)
  }
  visit(entryKey)
  const fileSize = (file: string) => statSync(join(dist, file)).size
  const closureJsBytes = [...closure].reduce((sum, key) => sum + fileSize(manifest[key]!.file), 0)
  const cssFiles = new Set<string>()
  for (const key of closure) for (const css of manifest[key]!.css ?? []) cssFiles.add(css)
  const cssBytes = [...cssFiles].reduce((sum, file) => sum + fileSize(file), 0)
  const novncPath = join(dist, 'novnc-rfb.js')
  const novncBytes = existsSync(novncPath) ? statSync(novncPath).size : 0
  return {
    entry: { file: manifest[entryKey]!.file, bytes: fileSize(manifest[entryKey]!.file) },
    staticClosure: { chunks: closure.size, jsBytes: closureJsBytes, cssBytes },
    dynamicImports: manifest[entryKey]!.dynamicImports ?? [],
    novnc: { file: 'novnc-rfb.js', bytes: novncBytes, present: novncBytes > 0 },
  }
}

test.setTimeout(ROUNDS * 60000 + 60000)

test('interactive task-time metrics over multiple rounds', async ({ browser, request }, testInfo) => {
  const { session } = await ensureTestWindow(request, 'measure-a')
  // 切换指标的对端会话：fixture 本身就是会话切换，故允许 test 之外的命名 session；
  // 仍落在隔离 server 上，不触碰用户 session
  await ensureSession(request, SWITCH_SESSION)

  const coldStart: number[] = []
  const paletteOpen: number[] = []
  const filePanelOpen: number[] = []
  const sessionSwitch: number[] = []
  const initialRequests: { count: number; jsBytes: number; cssBytes: number; docBytes: number; totalBytes: number }[] =
    []
  let wrongSessionInputs = 0

  for (let round = 0; round < ROUNDS; round += 1) {
    const markerA = `PERF_A_${round}_${Math.random().toString(36).slice(2, 8)}`
    const markerB = `PERF_B_${round}_${Math.random().toString(36).slice(2, 8)}`
    tmuxType('test', `echo ${markerA}`)
    tmuxType(SWITCH_SESSION, `echo ${markerB}`)

    const context = await browser.newContext()
    const page = await context.newPage()
    const requestSizes: Promise<{ type: string; bytes: number }>[] = []
    page.on('response', (response) => {
      const type = response.request().resourceType()
      if (!['document', 'script', 'stylesheet'].includes(type)) return
      requestSizes.push(
        response
          .body()
          .then((body) => ({ type, bytes: body.length }))
          .catch(() => ({ type, bytes: 0 })),
      )
    })
    await context.addInitScript(seedSession, session.id)

    // 冷启动：goto 起算到终端 attach 完成（data-ownership=owned 即可输入）
    const t0 = Date.now()
    await page.goto('/')
    await page.locator('[data-ownership="owned"]').waitFor({ state: 'attached', timeout: 20000 })
    coldStart.push(Date.now() - t0)

    const sizes = await Promise.all(requestSizes)
    initialRequests.push({
      count: sizes.length,
      jsBytes: sizes.filter((s) => s.type === 'script').reduce((n, s) => n + s.bytes, 0),
      cssBytes: sizes.filter((s) => s.type === 'stylesheet').reduce((n, s) => n + s.bytes, 0),
      docBytes: sizes.filter((s) => s.type === 'document').reduce((n, s) => n + s.bytes, 0),
      totalBytes: sizes.reduce((n, s) => n + s.bytes, 0),
    })

    // 面板计时前先把焦点移出终端（快捷键处理器忽略终端内按键）
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // 命令面板：Ctrl+K 到输入框可交互（含懒加载 chunk；autofocus 落地才算可输入）
    const paletteInput = page.getByPlaceholder('Search hosts, sessions, windows...')
    const t1 = Date.now()
    await page.keyboard.press('Control+k')
    await paletteInput.waitFor({ state: 'visible', timeout: 10000 })
    await expect(paletteInput).toBeEditable()
    await expect(paletteInput).toBeFocused()
    paletteOpen.push(Date.now() - t1)
    await page.keyboard.press('Escape')
    // 确认 scrim 真正关闭，否则后续点击会被浮层拦截
    await page.locator('.tmuxgo-scrim').waitFor({ state: 'detached', timeout: 5000 })

    // 文件面板：Ctrl+E 到搜索框可交互（FilePanel 为 dynamic import）
    const fileSearch = page.getByPlaceholder('Search file names')
    const t2 = Date.now()
    await page.keyboard.press('Control+e')
    await fileSearch.waitFor({ state: 'visible', timeout: 10000 })
    await expect(fileSearch).toBeEditable()
    filePanelOpen.push(Date.now() - t2)

    // 会话切换：点击 rail 里的 B 到 B 的正确输出（注入 marker）上屏
    const t3 = Date.now()
    await page.getByRole('button', { name: SWITCH_SESSION, exact: false }).first().click()
    await waitForBufferLine(page, markerB)
    sessionSwitch.push(Date.now() - t3)

    // 错误主机/会话输入次数=0：切换后立即输入（走 pending 队列补发路径），
    // 输入只能落在 B；回切 A 后 A 的 buffer 不得出现该命令回显或结果
    const a1 = 20 + Math.floor(Math.random() * 30)
    const b1 = 20 + Math.floor(Math.random() * 30)
    const probe = `echo $((${a1}*${b1}))`
    await focusTerminal(page)
    await page.keyboard.type(probe)
    await page.keyboard.press('Enter')
    await waitForBufferLine(page, String(a1 * b1))
    await page
      .getByRole('button', { name: /^test\b/ })
      .first()
      .click()
    await waitForBufferLine(page, markerA)
    const linesA = await bufferLines(page)
    if (linesA.some((line) => line.includes(probe) || line.trim() === String(a1 * b1))) wrongSessionInputs += 1

    await context.close()
  }

  const dist = process.env.TMUXGO_FRONTEND_DIST
  if (!dist) throw new Error('TMUXGO_FRONTEND_DIST not set; run via pnpm measure:perf')
  const bundle = analyzeBundle(dist)
  const initialMedianBytes = median(initialRequests.map((r) => r.totalBytes))
  const budget = {
    limits: BUDGET,
    checks: {
      entryJs: bundle.entry.bytes <= BUDGET.entryJs,
      staticClosureJs: bundle.staticClosure.jsBytes <= BUDGET.staticClosureJs,
      css: bundle.staticClosure.cssBytes <= BUDGET.css,
      initialRequests: initialMedianBytes <= BUDGET.initialRequests,
      novnc: bundle.novnc.present && bundle.novnc.bytes <= BUDGET.novnc,
    },
  }
  const report = {
    rounds: ROUNDS,
    metrics: {
      cold_start_to_input_ms: summary(coldStart),
      command_palette_open_ms: summary(paletteOpen),
      file_panel_open_ms: summary(filePanelOpen),
      session_switch_ms: summary(sessionSwitch),
    },
    wrong_session_inputs: wrongSessionInputs,
    initial_requests: { per_round: initialRequests, median_total_bytes: initialMedianBytes },
    bundle: { ...bundle, budget },
  }
  console.log(`MEASURE_PERF_REPORT ${JSON.stringify(report)}`)
  const reportPath = testInfo.outputPath('measure-perf.json')
  await testInfo.attach('measure-perf', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  expect(wrongSessionInputs).toBe(0)
  expect(Object.values(budget.checks).every(Boolean)).toBe(true)
})
