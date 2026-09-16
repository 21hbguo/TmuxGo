import { execTmux } from '../tmux-executor.js'
import { SCROLL_MAX_LINES } from './stream-config.js'
export function buildPaneSnapshot(content: string, left: number, top: number, width: number, height: number) {
  const lines = content.replace(/\r/g, '').split('\n')
  const parts: string[] = []
  for (let row = 0; row < height; row++) {
    const line = lines[row] || ''
    parts.push(`\u001b[${top + row + 1};${left + 1}H${line}\u001b[0m\u001b[K`)
  }
  return parts.join('')
}
export async function captureWindowSnapshot(
  hostId: string,
  sessionName: string,
  fallbackCols: number,
  fallbackRows: number,
) {
  const { stdout } = await execTmux(hostId, [
    'list-panes',
    '-t',
    sessionName,
    '-F',
    '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}',
  ])
  const panes = String(stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [paneId, leftRaw, topRaw, widthRaw, heightRaw] = line.split('|')
      const left = Number(leftRaw)
      const top = Number(topRaw)
      const width = Number(widthRaw)
      const height = Number(heightRaw)
      return {
        paneId,
        left: Number.isFinite(left) ? left : 0,
        top: Number.isFinite(top) ? top : 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
      }
    })
  panes.sort((a, b) => a.left - b.left || a.top - b.top)
  const parts: string[] = []
  for (const pane of panes) {
    if (!pane.paneId || pane.width <= 0 || pane.height <= 0) continue
    const { stdout: paneOutput } = await execTmux(hostId, ['capture-pane', '-e', '-pt', pane.paneId, '-p'])
    const content = String(paneOutput || '')
    if (!content) continue
    parts.push(buildPaneSnapshot(content, pane.left, pane.top, pane.width, pane.height))
  }
  if (!parts.length) {
    const { stdout: fallback } = await execTmux(hostId, ['capture-pane', '-e', '-pt', sessionName, '-p'])
    const content = String(fallback || '')
    if (!content) return ''
    return buildPaneSnapshot(content, 0, 0, fallbackCols || 80, fallbackRows || 24)
  }
  return parts.join('')
}
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
