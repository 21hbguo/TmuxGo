import { test, expect } from '@playwright/test'
import { ensureTestWindow, openSession } from './session'

// PR 冒烟：终端附着 + 真实键盘输入的执行证据（重量级 fluency/multiclient 用例仍走手动 e2e）
// 真实 tmux 行为只在隔离 server 的 test session 内组织，用例各占一个 window 串行

async function openTestTerminal(page: any, request: any, windowName: string) {
  const { session } = await ensureTestWindow(request, windowName)
  await openSession(page, session)
  await expect(page.locator('[data-terminal] .xterm').first()).toBeVisible({ timeout: 15000 })
  await page.waitForFunction(() => (window as any).__tmuxgoTerminal, null, { timeout: 15000 })
  // 走真实输入链路：xterm textarea 聚焦 + key 事件 → onData → PaneGrid.handleInput → WS → tmux
  await page.getByRole('textbox', { name: 'Terminal input' }).focus()
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, {
    timeout: 15000,
  })
}

function bufferHasResultLine(page: any, expected: string) {
  return page.evaluate((want) => {
    const buffer = (window as any).__tmuxgoTerminal?.buffer?.active
    if (!buffer) return false
    for (let i = 0; i < buffer.length; i += 1) {
      if ((buffer.getLine(i)?.translateToString(true) || '').trim() === want) return true
    }
    return false
  }, expected)
}

// 断言输出中出现「运行时计算得到」的独立结果行：如 echo $((6*7)) 期望独立一行 42，
// 命令串本身不含答案，命令行回显不算执行证据。扫全 buffer（含 scrollback），
// 不限前 240 行，避免长跑后误失败
async function waitForResultLine(page: any, expected: string) {
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
    { timeout: 15000 },
  )
}

test('attaches terminal and executes typed input', async ({ page, request }) => {
  await openTestTerminal(page, request, 'pr-smoke')
  const a = 3 + Math.floor(Math.random() * 40)
  const b = 3 + Math.floor(Math.random() * 40)
  await page.keyboard.type(`echo $((${a}*${b}))`)
  await page.keyboard.press('Enter')
  await waitForResultLine(page, String(a * b))
})

// 负向用例：只发字符不按回车不得判为执行成功；随后 Enter 作对照证明输入链路有效
test('typing without Enter is not counted as execution', async ({ page, request }) => {
  await openTestTerminal(page, request, 'pr-smoke-negative')
  const a = 50 + Math.floor(Math.random() * 40)
  const b = 50 + Math.floor(Math.random() * 40)
  const expected = String(a * b)
  const command = `echo $((${a}*${b}))`
  await page.keyboard.type(command)
  // 先确认字符真实到达 tmux（命令回显上屏），再断言未执行——排除输入链路失效的假阴性
  await page.waitForFunction(
    (text) => {
      const buffer = (window as any).__tmuxgoTerminal?.buffer?.active
      if (!buffer) return false
      for (let i = 0; i < buffer.length; i += 1) {
        if ((buffer.getLine(i)?.translateToString(true) || '').includes(text)) return true
      }
      return false
    },
    command,
    { timeout: 15000 },
  )
  await page.waitForTimeout(800)
  expect(await bufferHasResultLine(page, expected)).toBe(false)
  await page.keyboard.press('Enter')
  await waitForResultLine(page, expected)
})
