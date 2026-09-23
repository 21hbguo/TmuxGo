import { execTmux } from '../tmux-executor.js'
import { SCROLL_MAX_LINES } from './stream-config.js'
// 已删除手拼快照路径（captureWindowSnapshot/buildPaneSnapshot）：pane capture 不含
// tmux 边框，逐行 CSI K 越界抹邻 pane、行尾 SGR0 断跨行属性；整屏恢复改走
// refresh-client 真实重绘（见 stream-session 的 resync/attach 兜底）
// 测试缝：与 terminal-attachment 的 setPtySpawnForTest 同型，让 refresh 成败可控
let execTmuxForRefresh = execTmux
export function setRefreshExecForTest(fn: typeof execTmux | null) {
  execTmuxForRefresh = fn ?? execTmux
}
export async function refreshAttachedClient(hostId: string, sessionName: string, clientPid: number) {
  if (!sessionName) return
  const pid = String(clientPid)
  const { stdout } = await execTmuxForRefresh(hostId, [
    'list-clients',
    '-t',
    sessionName,
    '-F',
    '#{client_pid}|#{client_name}',
  ])
  const clients = String(stdout)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [clientPidField, ...nameParts] = line.split('|')
      return { pid: clientPidField, name: nameParts.join('|') }
    })
    .filter((client) => client.name)
  const owned = clients.filter((client) => client.pid === pid)
  // 远端 attach 时 tmux client 跑在远端主机，client_pid 永远对不上本地 ssh
  // 进程 pid，只能回退刷新该会话全部客户端；本地 host 下 owned 为空说明本连接
  // 客户端已不在列表，拿刷新别人冒充本连接恢复会掩盖 resync 失败
  const targets = owned.length ? owned : hostId === 'local' ? [] : clients
  if (!targets.length) throw new Error(`refreshAttachedClient: no client for pid ${pid} on ${sessionName}`)
  // 失败必须上抛：resync 已发清屏边界，吞掉 refresh 失败会留下清屏无重试的死屏；
  // 调用方需要 best-effort 时在调用处自行 catch（resize/attach 兜底已是如此）
  await Promise.all(targets.map((target) => execTmuxForRefresh(hostId, ['refresh-client', '-t', target.name])))
}
export async function getSessionWindowSize(hostId: string, sessionName: string) {
  try {
    const { stdout } = await execTmux(hostId, [
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{window_width}|#{window_height}|#{status}',
    ])
    const [colsText, rowsText, statusText] = stdout.trim().split('|')
    const cols = parseInt(colsText, 10)
    const rows = parseInt(rowsText, 10)
    // window_height 是 pane 内容区高度,不含状态行;附着所需的 client 等价
    // 高度 = window_height + status 行数。若直接按 window_height 起 pty,
    // 前端 xterm 会被收缩一行,回前台独占 attach 再把它推回会话尺寸——
    // 每次 失焦/回前台 循环会话高度 -1
    const statusRows = statusText === 'off' ? 0 : parseInt(statusText, 10) || 1
    if (cols > 0 && rows > 0) return { cols, rows: rows + statusRows }
  } catch {}
  return null
}
// 仲裁恢复兜底：幸存端全是 ignore-size 附着（非 fanout 共享端）时 pty resize
// 不驱动 window，需直连 resize-window。rows 入参是附着尺寸（含 status 行），
// resize-window -y 要 pane 内容区高度 window_height = rows - statusRows
export async function resizeSessionWindow(hostId: string, sessionName: string, cols: number, rows: number) {
  if (!sessionName || cols <= 0 || rows <= 0) return
  const { stdout } = await execTmux(hostId, ['display-message', '-p', '-t', sessionName, '#{status}'])
  const statusText = stdout.trim()
  const statusRows = statusText === 'off' ? 0 : parseInt(statusText, 10) || 1
  await execTmux(hostId, [
    'resize-window',
    '-t',
    sessionName,
    '-x',
    String(cols),
    '-y',
    String(Math.max(1, rows - statusRows)),
  ])
}
export async function applyScroll(hostId: string, sessionName: string, lines: number) {
  if (!lines) return
  const action = lines > 0 ? 'scroll-up' : 'scroll-down'
  let remaining = Math.abs(lines)
  if (lines > 0) {
    const step = Math.min(remaining, SCROLL_MAX_LINES)
    await execTmux(hostId, [
      'copy-mode',
      '-e',
      '-t',
      sessionName,
      ';',
      'send-keys',
      '-t',
      sessionName,
      '-X',
      '-N',
      String(step),
      action,
    ])
    remaining -= step
  }
  while (remaining > 0) {
    const step = Math.min(remaining, SCROLL_MAX_LINES)
    await execTmux(hostId, ['send-keys', '-t', sessionName, '-X', '-N', String(step), action])
    remaining -= step
  }
}
