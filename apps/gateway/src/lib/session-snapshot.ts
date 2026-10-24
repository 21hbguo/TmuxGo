import os from 'os'
import path from 'path'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { assertSessionAllowed, prepareSessionAttach } from './tmux-policy.js'
import { execTmux } from './tmux-executor.js'
import { buildSessionId, parseSessionRef } from './tmux-target.js'
import {
  buildSessionLayoutDocument,
  sessionLayoutToTemplateLayout,
  type SessionLayoutDocument,
  type SessionLayoutPaneRow,
} from './session-layout.js'
import { applyTemplateLayout, type TmuxExec } from './session-layout-apply.js'

// session 快照 L1（lean 档）：layout 元信息 + 每 pane cwd/前台命令 + 尾部 200 行纯文本。
// 恢复语义是「同结构 + 同 cwd + 同命令重跑」，进程不会复活，scrollbackTail 只用于预览展示
// （写回 pane 会出现重复提示符，与 agent-recovery「只打字不重放」的既定语义一致）。
export const SESSION_SNAPSHOT_KIND = 'tmuxgo.session-snapshot'
export const SESSION_SNAPSHOT_VERSION = 1
// L1 档位参数：200 行 + 每 pane 32KB 上限，实测 4 pane ≈ 10-16KB（research §2）
export const SNAPSHOT_TAIL_LINES = 200
export const SNAPSHOT_TAIL_BYTES = 32 * 1024
export const SNAPSHOT_TTL_DAYS = 7
export const SNAPSHOT_MAX_COUNT = 100
// 退出前自动快照的整体预算：关停序列本身有 5s 兜底，快照必须更快，超了就当没有
export const SNAPSHOT_DEADLINE_MS = 3000

export interface SessionSnapshotPane {
  tmuxPaneId: string
  windowIndex: number
  paneIndex: number
  title: string
  cwd: string
  command: string
  inMode: boolean
  /** 尾部纯文本；本轮预算用尽或远端降级时为空串 */
  scrollbackTail: string
}

export interface SessionSnapshotStats {
  paneCount: number
  tailLines: number
  bytes: number
}

export interface SessionSnapshot {
  kind: typeof SESSION_SNAPSHOT_KIND
  version: typeof SESSION_SNAPSHOT_VERSION
  id: string
  hostId: string
  sessionId: string
  sessionName: string
  createdAt: string
  expiresAt: string
  layout: SessionLayoutDocument
  panes: SessionSnapshotPane[]
  stats: SessionSnapshotStats
  /** 采集期间降级的项（如远端 host 只存结构不抓内容），给 UI 提示，不静默 */
  degraded: string[]
}

export function getSnapshotDir(hostId: string) {
  const root = process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo')
  return path.join(root, 'session-snapshots', Buffer.from(hostId).toString('base64url'))
}

// 尾部按字节截断（多字节字符可能被切半个，解码用 utf8 容错；与 archives 的 trimOutput 同策略）
function trimOutput(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ''
  const data = Buffer.from(value, 'utf8')
  if (data.length <= maxBytes) return value
  return data.subarray(data.length - maxBytes).toString('utf8')
}

function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as SessionSnapshot
  return (
    snapshot.kind === SESSION_SNAPSHOT_KIND &&
    typeof snapshot.id === 'string' &&
    typeof snapshot.hostId === 'string' &&
    typeof snapshot.sessionName === 'string' &&
    typeof snapshot.createdAt === 'string' &&
    !!snapshot.layout &&
    Array.isArray(snapshot.panes)
  )
}

export async function readSnapshots(hostId: string) {
  const dir = getSnapshotDir(hostId)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
  } catch {
    return []
  }
  const now = Date.now()
  const snapshots: SessionSnapshot[] = []
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      const snapshot = JSON.parse(await readFile(file, 'utf8'))
      if (!isSnapshot(snapshot) || snapshot.hostId !== hostId || Date.parse(snapshot.expiresAt) <= now) {
        await rm(file, { force: true })
        continue
      }
      snapshots.push(snapshot)
    } catch {
      await rm(file, { force: true })
    }
  }
  snapshots.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  // 上限修剪按创建时间倒序保留最新 N 份（与 archives 对齐）
  for (const snapshot of snapshots.slice(SNAPSHOT_MAX_COUNT))
    await rm(path.join(dir, `${snapshot.id}.json`), { force: true })
  return snapshots.slice(0, SNAPSHOT_MAX_COUNT)
}

export function toSnapshotSummary(snapshot: SessionSnapshot) {
  // 列表不回传 panes（尾部内容可能几十 KB），只给统计
  const { panes: _panes, layout: _layout, ...summary } = snapshot
  return summary
}

async function writeSnapshot(hostId: string, snapshot: SessionSnapshot) {
  const dir = getSnapshotDir(hostId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${snapshot.id}.json`)
  const temp = `${file}.tmp-${Date.now()}`
  await writeFile(temp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
  await readSnapshots(hostId)
  return snapshot
}

export async function deleteSnapshot(hostId: string, snapshotId: string) {
  await rm(path.join(getSnapshotDir(hostId), `${snapshotId}.json`), { force: true })
}

interface CaptureRow {
  windowIndex: number
  paneIndex: number
  tmuxPaneId: string
  title: string
  cwd: string
  command: string
  inMode: boolean
  width: number
  height: number
  left: number
  top: number
}

async function listSnapshotRows(hostId: string, sessionName: string, exec: TmuxExec) {
  const { stdout: windowsOut } = await exec(hostId, [
    'list-windows',
    '-t',
    sessionName,
    '-F',
    '#{window_index}|#{window_name}',
  ])
  const { stdout: panesOut } = await exec(hostId, [
    'list-panes',
    '-s',
    '-t',
    sessionName,
    '-F',
    [
      '#{window_index}',
      '#{pane_index}',
      '#{pane_id}',
      '#{pane_title}',
      '#{pane_current_path}',
      '#{pane_current_command}',
      '#{pane_in_mode}',
      '#{pane_width}',
      '#{pane_height}',
      '#{pane_left}',
      '#{pane_top}',
    ].join('|'),
  ])
  const rows: CaptureRow[] = panesOut
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, paneIndex, tmuxPaneId, title, cwd, command, inMode, width, height, left, top] =
        line.split('|')
      return {
        windowIndex: parseInt(windowIndex || '0', 10) || 0,
        paneIndex: parseInt(paneIndex || '0', 10) || 0,
        tmuxPaneId: tmuxPaneId || '',
        title: title || 'shell',
        cwd: cwd || '',
        command: command || '',
        inMode: inMode === '1',
        width: parseInt(width || '0', 10) || 0,
        height: parseInt(height || '0', 10) || 0,
        left: parseInt(left || '0', 10) || 0,
        top: parseInt(top || '0', 10) || 0,
      }
    })
    .filter((row) => /^%\d+$/.test(row.tmuxPaneId))
  // window_name 可能含 '|'：首段取 index，其余并回名字
  const windows = windowsOut
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, ...nameParts] = line.split('|')
      const panes: SessionLayoutPaneRow[] = rows
        .filter((row) => String(row.windowIndex) === windowIndex)
        .map((row) => ({
          index: row.paneIndex,
          cwd: row.cwd,
          command: row.command,
          width: row.width,
          height: row.height,
          left: row.left,
          top: row.top,
        }))
      return { name: nameParts.join('|') || `win-${windowIndex}`, panes }
    })
    .filter((window) => window.panes.length)
  return { rows, windows }
}

export async function captureSessionSnapshot(options: {
  hostId: string
  sessionId: string
  withTail?: boolean
  deadlineMs?: number
  now?: number
  exec?: TmuxExec
}): Promise<SessionSnapshot> {
  const { hostId, sessionId } = options
  const withTail = options.withTail !== false
  const deadline = (options.now ?? Date.now()) + (options.deadlineMs ?? SNAPSHOT_DEADLINE_MS)
  const sessionName = parseSessionRef(hostId, sessionId).sessionName
  assertSessionAllowed(sessionName)
  const exec = options.exec || execTmux
  const { rows, windows } = await listSnapshotRows(hostId, sessionName, exec)
  const layout = buildSessionLayoutDocument({ sessionName, hostId, windows })
  const degraded: string[] = []
  if (!withTail) degraded.push('scrollback')
  const panes: SessionSnapshotPane[] = []
  for (const row of rows) {
    let scrollbackTail = ''
    // 预算用尽就只留结构：退出前的自动快照宁可少内容，不能拖着进程不退出
    if (withTail && Date.now() < deadline) {
      try {
        const { stdout } = await exec(hostId, [
          'capture-pane',
          '-p',
          '-t',
          row.tmuxPaneId,
          '-S',
          `-${SNAPSHOT_TAIL_LINES}`,
        ])
        scrollbackTail = trimOutput(stdout, SNAPSHOT_TAIL_BYTES)
      } catch {
        if (!degraded.includes('scrollback')) degraded.push('scrollback')
      }
    } else if (withTail && !degraded.includes('scrollback')) degraded.push('scrollback')
    panes.push({
      tmuxPaneId: row.tmuxPaneId,
      windowIndex: row.windowIndex,
      paneIndex: row.paneIndex,
      title: row.title,
      cwd: row.cwd,
      command: row.command,
      inMode: row.inMode,
      scrollbackTail,
    })
  }
  const now = options.now ?? Date.now()
  const snapshot: SessionSnapshot = {
    kind: SESSION_SNAPSHOT_KIND,
    version: SESSION_SNAPSHOT_VERSION,
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    hostId,
    sessionId,
    sessionName,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SNAPSHOT_TTL_DAYS * 86400000).toISOString(),
    layout,
    panes,
    stats: {
      paneCount: panes.length,
      tailLines: SNAPSHOT_TAIL_LINES,
      bytes: panes.reduce((sum, pane) => sum + Buffer.byteLength(pane.scrollbackTail, 'utf8'), 0),
    },
    degraded,
  }
  return writeSnapshot(hostId, snapshot)
}

export async function getSnapshot(hostId: string, snapshotId: string) {
  return (await readSnapshots(hostId)).find((item) => item.id === snapshotId) || null
}

// tmux server 完全没起来时（机器重启后首开网关），任何 tmux 子命令都会失败：
// 报 "no server running on <socket>" 或 "error connecting to <socket> (No such file or directory)"。
// 这恰好是快照最该救命的场景，所以 restore 必须把这种情况当「没有会话」处理，
// 让后面的 new-session 顺手把 server 拉起来；其余错误（SSH 掉线、权限）保持原样抛。
// tmux 自身的错误串不随 locale 变化，但 socket 路径会变，所以只匹配稳定片段。
function isTmuxServerUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('no server running on') ||
    message.includes('no sessions') ||
    (message.includes('error connecting to') && message.includes('No such file or directory'))
  )
}

/** 列会话：server 没起来视为空列表（不是失败），其余错误照抛 */
async function listSessionNames(hostId: string, exec: TmuxExec) {
  try {
    const { stdout } = await exec(hostId, ['list-sessions', '-F', '#{session_name}'])
    return stdout.trim().split('\n').filter(Boolean)
  } catch (err) {
    if (isTmuxServerUnavailable(err)) return []
    throw err
  }
}

/**
 * 一键重建：只重放结构与 cwd/命令（layout apply 同一条实现），
 * scrollbackTail 不回填，返回值里带回去做「历史回显」预览。
 */
export async function restoreSnapshot(options: {
  hostId: string
  snapshotId: string
  name?: string
  replace?: boolean
  exec?: TmuxExec
  /** 单测注入：默认走真实的 attach 预处理（会调 tmux） */
  prepareAttach?: (hostId: string, sessionName: string) => Promise<void>
}) {
  const { hostId, snapshotId, replace } = options
  const exec = options.exec || execTmux
  const snapshot = await getSnapshot(hostId, snapshotId)
  if (!snapshot) throw new Error('Snapshot not found')
  const sessionName = (options.name || snapshot.sessionName).trim()
  if (!sessionName) throw new Error('Missing session name')
  assertSessionAllowed(sessionName)
  const layout = sessionLayoutToTemplateLayout(snapshot.layout)
  const names = await listSessionNames(hostId, exec)
  const exists = names.includes(sessionName)
  // 覆盖同名 session 必须显式 replace，避免一键恢复把正在用的会话干掉
  if (exists && !replace) throw new Error(`Session already exists: ${sessionName} (set replace=true to overwrite)`)
  if (exists) await exec(hostId, ['kill-session', '-t', `=${sessionName}`])
  try {
    await exec(hostId, ['new-session', '-d', '-s', sessionName, '-e', 'TMUXGO_ENV=1'])
    await applyTemplateLayout(hostId, sessionName, layout, exec)
  } catch (err) {
    // 半成品 session 留着比删掉更碍事：失败就清干净再抛
    try {
      await exec(hostId, ['kill-session', '-t', `=${sessionName}`])
    } catch {}
    throw err instanceof Error ? err : new Error(String(err))
  }
  await (options.prepareAttach || prepareSessionAttach)(hostId, sessionName)
  return {
    sessionName,
    restoredFrom: snapshot.id,
    paneCount: snapshot.panes.length,
    // 进程不会复活：这里只是同目录同命令重跑，尾部内容仅供预览
    panes: snapshot.panes,
    degraded: snapshot.degraded,
  }
}

/** skipped 条目形如 `host:name:reason` 或 `host:remote-host`：按最后一段聚合原因计数 */
export function summarizeSkipReasons(skipped: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of skipped) {
    const reason = entry.slice(entry.lastIndexOf(':') + 1)
    counts[reason] = (counts[reason] ?? 0) + 1
  }
  return counts
}

/**
 * 关停快照摘要的日志级别与载荷：生产默认 level=warn，走 info 等于白名单/跳过效果对运维
 * 不可见，所以有 saved 或有 skipped 就提到 warn，并带上原因分布（reason 计数，不铺明细）。
 * 全 0（没有 session 可抓）是正常退出路径，不打日志以免每次关停都刷一行。
 */
export function describeShutdownSnapshots(result: {
  saved: string[]
  skipped: string[]
}): { level: 'warn'; payload: Record<string, unknown>; message: string } | null {
  if (!result.saved.length && !result.skipped.length) return null
  return {
    level: 'warn',
    payload: {
      saved: result.saved.length,
      skipped: result.skipped.length,
      reasons: summarizeSkipReasons(result.skipped),
      // 明细限长：关停路径不铺全量列表，排查时按 reasons + 日志里的单条失败信息定位
      savedSessions: result.saved.slice(0, 10),
    },
    message: 'session snapshots on shutdown',
  }
}

/** 退出前自动快照：只做本机 host，远端 host 无等价 capture-pane 通道，按单降级跳过并标记 */
export async function snapshotSessionsOnShutdown(options: {
  hostIds: string[]
  /**
   * 只快照这些 session（空/未给 = 扫全部，维持原有默认）。生产机关停时没必要把所有
   * 无关会话都抓一遍；白名单也让真机验证能在不碰用户会话的前提下跑通关停路径。
   * 由组装根从 TMUXGO_SNAPSHOT_SESSIONS 解析后传入，lib 不直接读 env。
   */
  include?: string[]
  deadlineMs?: number
  capture?: typeof captureSessionSnapshot
  exec?: TmuxExec
  logWarn?: (message: string) => void
}) {
  const { hostIds } = options
  const include = options.include?.filter(Boolean) ?? []
  const includeSet = include.length ? new Set(include) : null
  const logWarn = options.logWarn || (() => {})
  const capture = options.capture || captureSessionSnapshot
  const exec = options.exec || execTmux
  const deadline = Date.now() + (options.deadlineMs ?? SNAPSHOT_DEADLINE_MS)
  const saved: string[] = []
  const skipped: string[] = []
  for (const hostId of hostIds) {
    if (hostId !== 'local') {
      skipped.push(`${hostId}:remote-host`)
      continue
    }
    let names: string[]
    try {
      const { stdout } = await exec(hostId, ['list-sessions', '-F', '#{session_name}'])
      names = stdout.trim().split('\n').filter(Boolean)
    } catch {
      // 没有 tmux server / 无 session 都算正常退出路径
      continue
    }
    for (const name of names) {
      // 白名单外的会话直接记原因跳过，和 remote-host/deadline/error 保持同一套 skipped 语义
      if (includeSet && !includeSet.has(name)) {
        skipped.push(`${hostId}:${name}:not-in-whitelist`)
        continue
      }
      if (Date.now() >= deadline) {
        skipped.push(`${hostId}:${name}:deadline`)
        continue
      }
      try {
        assertSessionAllowed(name)
        await capture({
          hostId,
          sessionId: buildSessionId(hostId, name),
          deadlineMs: Math.max(1, deadline - Date.now()),
        })
        saved.push(`${hostId}:${name}`)
      } catch (err) {
        skipped.push(`${hostId}:${name}:error`)
        logWarn(`session snapshot failed for ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return { saved, skipped }
}
