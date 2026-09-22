/**
 * 修复后路径复测：StreamSession + 真实 tmux attach，双尺寸 × 4 pane × 各 10 次。
 * 记录每次 select 后 client xterm(attachedCols/Rows) vs tmux window/pane。
 *
 * 运行: npx tsx scripts/repro-pane-size-drift-stream.ts --cycles=10
 */
import * as pty from 'node-pty'
import { execFileSync } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  StreamSession,
  schedulePeerWindowSync,
  resetExclusiveOwnershipForTest,
  setWindowSizeQueryForTest,
} from '../apps/gateway/src/lib/stream/stream-session.js'
import { createTerminalAttachment } from '../apps/gateway/src/lib/terminal-attachment.js'

// 测试缝：让 createTerminalAttachment 走真实 pty（默认就是），无需 mock
const SESSION = 'test'
const CYCLES = Number(process.argv.find((a) => a.startsWith('--cycles='))?.split('=')[1] || 10)
const OUT_DIR = path.resolve('test-results/pane-size-drift')
const stamp = Date.now()
const OUT_FILE = path.join(OUT_DIR, `stream-repro-${stamp}.jsonl`)
const SUMMARY_FILE = path.join(OUT_DIR, `stream-summary-${stamp}.json`)

function tmux(args: string[]) {
  return execFileSync('tmux', args, { encoding: 'utf8' })
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function ensureFourPaneTestSession() {
  try {
    tmux(['kill-session', '-t', SESSION])
  } catch {}
  tmux(['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50'])
  tmux(['split-window', '-t', SESSION, '-h'])
  tmux(['split-window', '-t', SESSION, '-v'])
  tmux(['split-window', '-t', SESSION, '-v'])
  tmux(['select-layout', '-t', SESSION, 'tiled'])
  const first = tmux(['list-panes', '-t', SESSION, '-F', '#{pane_id}']).trim().split('\n')[0]
  tmux(['select-pane', '-t', first])
}

function readTmux() {
  const out = tmux([
    'list-panes',
    '-t',
    SESSION,
    '-F',
    '#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}|#{window_width}|#{window_height}',
  ])
  let winW = 0
  let winH = 0
  const panes: any[] = []
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [paneId, paneIndex, w, h, active, ww, wh] = line.split('|')
    panes.push({ paneId, paneIndex: +paneIndex, w: +w, h: +h, active: active === '1' })
    winW = +ww
    winH = +wh
  }
  panes.sort((a, b) => a.paneIndex - b.paneIndex)
  return { panes, winW, winH }
}

function makeClient(name: string) {
  const sent: any[] = []
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | Buffer) {
      try {
        sent.push(JSON.parse(String(data)))
      } catch {
        sent.push({ type: 'raw' })
      }
    },
    close() {},
  }
  const session = new StreamSession(socket as any, null)
  return { name, session, sent }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  ensureFourPaneTestSession()
  resetExclusiveOwnershipForTest()
  // 用真实 getSessionWindowSize，与生产一致
  setWindowSizeQueryForTest(null)

  const desk = makeClient('desk-120x36')
  const phone = makeClient('phone-80x24')

  // 真实 attach：desk exclusive 120x36 → phone exclusive 80x24 steal
  await desk.session.attach({ hostId: 'local', sessionName: SESSION, exclusive: true, cols: 120, rows: 36 })
  await sleep(80)
  await phone.session.attach({ hostId: 'local', sessionName: SESSION, exclusive: true, cols: 80, rows: 24 })
  await sleep(80)
  // 降级后前端会以 shared 重附着
  await desk.session.attach({
    hostId: 'local',
    sessionName: SESSION,
    exclusive: false,
    passive: true,
    cols: 80,
    rows: 24,
  })
  await sleep(80)

  const clients = [desk, phone]
  writeFileSync(OUT_FILE, '')
  const all: any[] = []
  let step = 0

  const record = (action: string, target: string) => {
    const { panes, winW, winH } = readTmux()
    for (const c of clients) {
      const xc = c.session.attachedCols
      const xr = c.session.attachedRows
      // getSessionWindowSize 语义：client 高度 ≈ window_height + status(1)
      const expectH = winH + 1
      const drift = xc !== winW || (xr !== winH && xr !== expectH)
      const rec = {
        step: step++,
        action,
        targetPane: target,
        client: c.name,
        exclusive: c.session.attachedExclusive,
        owner: c.session.isExclusiveOwner(),
        passive: c.session.attachedPassive,
        xterm_cols: xc,
        xterm_rows: xr,
        win_w: winW,
        win_h: winH,
        expect_rows_with_status: expectH,
        drift_strict: xc !== winW || xr !== winH,
        drift_status_tolerant: drift,
        panes,
      }
      all.push(rec)
      appendFileSync(OUT_FILE, JSON.stringify(rec) + '\n')
    }
  }

  record('init', '-')
  const paneIds = readTmux().panes.map((p) => p.paneId)

  for (let round = 0; round < CYCLES; round++) {
    for (const pid of paneIds) {
      tmux(['select-pane', '-t', pid])
      // 模拟另一端也点同一 pane
      tmux(['select-pane', '-t', pid])
      schedulePeerWindowSync('local', SESSION, 0)
      await sleep(40)
      record(`select-round-${round + 1}`, pid)
    }
  }
  record('final', '-')

  const summarize = (name: string) => {
    const rows = all.filter((r) => r.client === name)
    return {
      samples: rows.length,
      drift_strict: rows.filter((r) => r.drift_strict).length,
      drift_status_tolerant: rows.filter((r) => r.drift_status_tolerant).length,
      uniqueXterm: [...new Set(rows.map((r) => `${r.xterm_cols}x${r.xterm_rows}`))],
      uniqueWin: [...new Set(rows.map((r) => `${r.win_w}x${r.win_h}`))],
      ownerAlways: rows.every((r) => r.owner || name.startsWith('phone') === r.owner),
      sampleFinal: rows.at(-1),
    }
  }

  const summary = {
    mode: 'stream-session-after-fix',
    cycles: CYCLES,
    paneCount: paneIds.length,
    outFile: OUT_FILE,
    desk: summarize('desk-120x36'),
    phone: summarize('phone-80x24'),
  }
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))

  desk.session.cleanup()
  phone.session.cleanup()
  resetExclusiveOwnershipForTest()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
