/**
 * 复现：两个不同尺寸的 TmuxGo client，4 pane 来回切换，记录 xterm size vs tmux size。
 *
 * 场景：
 *   Client A（桌面）: 120x36, exclusive attach
 *   Client B（手机）: 80x24, exclusive 或 shared(-f ignore-size,active-pane)
 *   Session: 仅使用名为 test 的 tmux session（AGENTS 约定）
 *   布局: 2x2 四个 pane
 *   循环: 对 4 个 pane 各 select-pane 10 次（交错）
 *
 * 记录（JSONL）：
 *   xterm_cols/rows  — client pty 当前尺寸（xterm.js 等价）
 *   win_w/win_h      — tmux window_width/height
 *   panes[]          — 每个 pane 的 pane_width/height、pane_active
 *   drift            — xterm 与 window 是否不一致
 *
 * 运行:
 *   npx tsx scripts/repro-pane-size-drift.ts
 *   npx tsx scripts/repro-pane-size-drift.ts --mode=both-exclusive --cycles=10
 */
import { spawn, execFileSync } from 'node:child_process'
import * as pty from 'node-pty'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SESSION = 'test'
const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] || 'shared') as
  'shared' | 'both-exclusive'
const CYCLES = Number(process.argv.find((a) => a.startsWith('--cycles='))?.split('=')[1] || 10)
const OUT_DIR = path.resolve('test-results/pane-size-drift')
const OUT_FILE = path.join(OUT_DIR, `repro-${MODE}-${Date.now()}.jsonl`)
const SUMMARY_FILE = path.join(OUT_DIR, `summary-${MODE}-${Date.now()}.json`)

function tmux(args: string[], input?: string) {
  return execFileSync('tmux', args, { encoding: 'utf8', input })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function ensureFourPaneTestSession() {
  // 只动 test 会话
  try {
    tmux(['kill-session', '-t', SESSION])
  } catch {}
  tmux(['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50'])
  // 用 session 名定位，避免 window index 猜测
  tmux(['split-window', '-t', SESSION, '-h'])
  tmux(['split-window', '-t', SESSION, '-v'])
  tmux(['split-window', '-t', SESSION, '-v'])
  tmux(['select-layout', '-t', SESSION, 'tiled'])
  const first = tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}']).trim().split('\n')[0]
  tmux(['select-pane', '-t', first])
}

interface PaneSnap {
  paneId: string
  paneIndex: number
  w: number
  h: number
  active: boolean
}

function readTmuxSizes() {
  const out = tmux([
    'list-panes',
    '-t',
    SESSION,
    '-F',
    '#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}|#{window_width}|#{window_height}',
  ])
  const panes: PaneSnap[] = []
  let winW = 0
  let winH = 0
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [paneId, paneIndex, w, h, active, ww, wh] = line.split('|')
    panes.push({
      paneId,
      paneIndex: Number(paneIndex),
      w: Number(w),
      h: Number(h),
      active: active === '1',
    })
    winW = Number(ww)
    winH = Number(wh)
  }
  panes.sort((a, b) => a.paneIndex - b.paneIndex)
  return { panes, winW, winH }
}

function attachClient(opts: { cols: number; rows: number; exclusive: boolean; name: string }) {
  const args = ['attach']
  if (!opts.exclusive) args.push('-f', 'ignore-size,active-pane')
  args.push('-t', SESSION)
  const proc = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  return proc
}

type Rec = {
  step: number
  action: string
  targetPane: string
  mode: string
  client: string
  xterm_cols: number
  xterm_rows: number
  win_w: number
  win_h: number
  activePane: string
  activePane_w: number
  activePane_h: number
  panes: PaneSnap[]
  drift_xterm_vs_win: boolean
  xterm_vs_win_delta: [number, number]
}

function record(
  step: number,
  action: string,
  targetPane: string,
  clients: Array<{ name: string; proc: pty.IPty }>,
): Rec[] {
  const { panes, winW, winH } = readTmuxSizes()
  const active = panes.find((p) => p.active) || panes[0]
  return clients.map(({ name, proc }) => {
    const xc = proc.cols
    const xr = proc.rows
    const drift = xc !== winW || xr !== winH
    return {
      step,
      action,
      targetPane,
      mode: MODE,
      client: name,
      xterm_cols: xc,
      xterm_rows: xr,
      win_w: winW,
      win_h: winH,
      activePane: active.paneId,
      activePane_w: active.w,
      activePane_h: active.h,
      panes,
      drift_xterm_vs_win: drift,
      xterm_vs_win_delta: [xc - winW, xr - winH] as [number, number],
    }
  })
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  ensureFourPaneTestSession()
  await sleep(80)

  const A = attachClient({ cols: 120, rows: 36, exclusive: true, name: 'desk-120x36' })
  const B = attachClient({
    cols: 80,
    rows: 24,
    exclusive: MODE === 'both-exclusive',
    name: MODE === 'both-exclusive' ? 'phone-80x24-ex' : 'phone-80x24-shared',
  })
  await sleep(120)

  const clients = [
    { name: 'desk-120x36', proc: A },
    { name: B.cols === 80 ? 'phone-80x24' : 'phone', proc: B },
  ]

  writeFileSync(OUT_FILE, '')
  const all: Rec[] = []
  let step = 0

  // 初始
  all.push(...record(step++, 'init', '-', clients))

  const paneIds = readTmuxSizes().panes.map((p) => p.paneId)
  if (paneIds.length < 4) {
    console.error('expected 4 panes, got', paneIds)
    process.exitCode = 1
  }

  // 每个 pane 切回来 CYCLES 次：交错 panes[0..3] 循环
  for (let round = 0; round < CYCLES; round++) {
    for (const pid of paneIds) {
      tmux(['select-pane', '-t', pid])
      await sleep(30)
      // 模拟两边 UI 各自点选同一 pane（双端同时 select）
      tmux(['select-pane', '-t', pid])
      await sleep(20)
      all.push(...record(step++, `select-round-${round + 1}`, pid, clients))
    }
  }

  // 末态
  all.push(...record(step++, 'final', '-', clients))

  for (const r of all) appendFileSync(OUT_FILE, JSON.stringify(r) + '\n')

  const desk = all.filter((r) => r.client === 'desk-120x36')
  const driftDesk = desk.filter((r) => r.drift_xterm_vs_win)
  const phone = all.filter((r) => r.client.startsWith('phone'))
  const driftPhone = phone.filter((r) => r.drift_xterm_vs_win)

  // 同一 pane 尺寸序列是否随切换抖动
  const paneFlips: Record<string, Array<{ step: number; w: number; h: number }>> = {}
  for (const r of desk) {
    for (const p of r.panes) {
      const arr = paneFlips[p.paneId] || (paneFlips[p.paneId] = [])
      const last = arr[arr.length - 1]
      if (!last || last.w !== p.w || last.h !== p.h) arr.push({ step: r.step, w: p.w, h: p.h })
    }
  }

  const summary = {
    mode: MODE,
    cycles: CYCLES,
    paneCount: paneIds.length,
    steps: step,
    records: all.length,
    outFile: OUT_FILE,
    desk: {
      samples: desk.length,
      driftCount: driftDesk.length,
      driftRatio: desk.length ? driftDesk.length / desk.length : 0,
      uniqueXtermSizes: [...new Set(desk.map((r) => `${r.xterm_cols}x${r.xterm_rows}`))],
      uniqueWinSizes: [...new Set(desk.map((r) => `${r.win_w}x${r.win_h}`))],
    },
    phone: {
      samples: phone.length,
      driftCount: driftPhone.length,
      driftRatio: phone.length ? driftPhone.length / phone.length : 0,
      uniqueXtermSizes: [...new Set(phone.map((r) => `${r.xterm_cols}x${r.xterm_rows}`))],
      uniqueWinSizes: [...new Set(phone.map((r) => `${r.win_w}x${r.win_h}`))],
    },
    paneSizeFlips: paneFlips,
    driftExamples: driftDesk.slice(0, 5),
  }
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))

  A.kill()
  B.kill()
  // 不杀 test 会话本体，便于人工复看；布局保留
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
