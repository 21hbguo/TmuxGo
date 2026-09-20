import { execTmux } from '../tmux-executor.js'
import { SCROLL_MAX_LINES } from './stream-config.js'
// 已删除手拼快照路径（captureWindowSnapshot/buildPaneSnapshot）：pane capture 不含
// tmux 边框，逐行 CSI K 越界抹邻 pane、行尾 SGR0 断跨行属性；整屏恢复改走
// refresh-client 真实重绘（见 stream-session 的 resync/attach 兜底）
export async function refreshAttachedClient(hostId: string, sessionName: string, clientPid: number) {
  if (!sessionName) return
  const pid = String(clientPid)
  const { stdout } = await execTmux(hostId, ['list-clients', '-t', sessionName, '-F', '#{client_pid}|#{client_name}'])
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
  const targets = (owned.length ? owned : clients).map((client) => client.name)
  await Promise.all(targets.map((target) => execTmux(hostId, ['refresh-client', '-t', target]).catch(() => {})))
}
export async function getSessionWindowSize(hostId: string, sessionName: string) {
  try {
    const { stdout } = await execTmux(hostId, [
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{window_width}|#{window_height}',
    ])
    const [colsText, rowsText] = stdout.trim().split('|')
    const cols = parseInt(colsText, 10)
    const rows = parseInt(rowsText, 10)
    if (cols > 0 && rows > 0) return { cols, rows }
  } catch {}
  return null
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
