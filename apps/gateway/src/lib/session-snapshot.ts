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
import { applyTemplateLayout, buildSessionCreateArgs, type TmuxExec } from './session-layout-apply.js'

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
// 远端 host 的独立预算（防饿设计）：ssh 建连本身就要几百毫秒，真机实测 2 pane 采集约
// 86ms（含连接），预算给小了会把本来抓得到的远端会话一起砍掉；给大了则一个不可达的
// host 就能吃光全局 3s，把排在后面的本机会话饿死。1500 够握手 + 两次元信息查询 + 若干 tail
export const SNAPSHOT_REMOTE_HOST_BUDGET_MS = 1500
// 单次远端调用的硬上限：execTmux 默认 30s、ssh 连不上时 connect 超时约 5s，都远大于快照
// 总预算。不逐调用封顶的话，一个挂住的连接就能把「本该 1.5s 放弃」的 host 拖成分钟级
export const SNAPSHOT_REMOTE_CALL_CAP_MS = 600

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
    // 首 pane 的 cwd 交给 new-session -c：否则它继承 tmux server 的 cwd（远端 = home）
    await exec(hostId, buildSessionCreateArgs(sessionName, layout))
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

/**
 * 远端 exec 包装：每次调用把 timeoutMs 截到 min(host 剩余预算, 单次上限)。
 * 只在远端 host 上套（本地 tmux 没有连接握手，维持既有超时语义不变）。
 */
function capRemoteExec(exec: TmuxExec, hostDeadline: number): TmuxExec {
  return (hostId, args, execOptions) =>
    exec(hostId, args, {
      ...execOptions,
      // 每次调用重新算：剩余预算可能已被上一个调用吃掉大半，再叠 cap 上限，
      // 保证单次调用不会越过 host 截止点太多（也不会早于它）
      timeoutMs: Math.max(1, Math.min(hostDeadline - Date.now(), SNAPSHOT_REMOTE_CALL_CAP_MS)),
    })
}

/** skipped 条目形如 `host:name:reason`；host 级失败（拿不到会话名）记 `host:*:reason` */
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

/**
 * 负向名单拆成「裸名（对所有 host 生效）」与「host 名 → 该 host 的排除集」。
 * 裸名与 `host:name` 用第一个冒号切：session 名里允许出现冒号（tmux 不禁止），
 * 所以只有「冒号前那段是已知 host 形态」时才当 host 限定，其余整体当裸名。
 */
function parseExcludeList(entries: string[]) {
  const bare = new Set<string>()
  const byHost = new Map<string, Set<string>>()
  for (const entry of entries) {
    const idx = entry.indexOf(':')
    if (idx > 0 && idx < entry.length - 1) {
      const host = entry.slice(0, idx)
      const name = entry.slice(idx + 1)
      const set = byHost.get(host) ?? new Set<string>()
      set.add(name)
      byHost.set(host, set)
    } else {
      bare.add(entry)
    }
  }
  return { bare, byHost }
}

/**
 * 退出前自动快照：远端 host 与本机走同一条采集路径（execTmux over ssh 已支持 capture-pane）。
 * 防饿是这里的关键：远端不可达时 ssh 连接超时（~5s）大于整体预算，所以每个远端 host 有
 * 独立预算 + 逐调用超时封顶，一个 host 卡住不影响排在后面的 host。
 */
export async function snapshotSessionsOnShutdown(options: {
  hostIds: string[]
  /**
   * 只快照这些 session（空/未给 = 扫全部，维持原有默认）。生产机关停时没必要把所有
   * 无关会话都抓一遍；白名单也让真机验证能在不碰用户会话的前提下跑通关停路径。
   * 由组装根从 TMUXGO_SNAPSHOT_SESSIONS 解析后传入，lib 不直接读 env。
   */
  include?: string[]
  /**
   * 永不快照的 session（负向名单，硬否决 include）。敏感会话（ssh 到堡垒机、prod 操作、
   * 含密钥输出）要靠它挡住，光有 include 不够——漏配一个名字就等于把它拍下来。
   * 条目支持 `host:name`（只挡该 host）与裸 `name`（挡所有 host），均为精确匹配、
   * 不做 glob：关停路径上要的是可预测，不是模式匹配的威力。
   * 由组装根从 TMUXGO_SNAPSHOT_EXCLUDE 解析后传入，lib 不直接读 env。
   */
  exclude?: string[]
  deadlineMs?: number
  capture?: typeof captureSessionSnapshot
  exec?: TmuxExec
  logWarn?: (message: string) => void
}) {
  const { hostIds } = options
  const include = options.include?.filter(Boolean) ?? []
  const includeSet = include.length ? new Set(include) : null
  const { bare: excludeBare, byHost: excludeByHost } = parseExcludeList(options.exclude ?? [])
  const logWarn = options.logWarn || (() => {})
  const capture = options.capture || captureSessionSnapshot
  const exec = options.exec || execTmux
  const deadline = Date.now() + (options.deadlineMs ?? SNAPSHOT_DEADLINE_MS)
  const saved: string[] = []
  const skipped: string[] = []
  for (const hostId of hostIds) {
    const remoteHost = hostId !== 'local'
    // 一个远端 host 一个截止点：min(全局剩余, per-host 预算)。本地不设 per-host 预算、
    // 也不包装 exec，行为与之前完全一致
    const hostDeadline = remoteHost ? Math.min(deadline, Date.now() + SNAPSHOT_REMOTE_HOST_BUDGET_MS) : deadline
    const hostExec = remoteHost ? capRemoteExec(exec, hostDeadline) : exec
    let names: string[]
    try {
      names = await listSessionNames(hostId, hostExec)
    } catch (err) {
      // 远端连不上不是「没有会话」：留一条 host 级痕迹（* = 连会话名都没拿到）。
      // 本地沿用原语义——除 server 未起之外的错误也只是跳过，不刷日志
      if (remoteHost) {
        skipped.push(`${hostId}:*:error`)
        logWarn(`session snapshot skipped host ${hostId}: ${err instanceof Error ? err.message : String(err)}`)
      }
      continue
    }
    for (const name of names) {
      // 白名单外的会话直接记原因跳过，和 deadline/error 保持同一套 skipped 语义
      if (includeSet && !includeSet.has(name)) {
        skipped.push(`${hostId}:${name}:not-in-whitelist`)
        continue
      }
      // 负向名单是硬否决：include 通过也照样挡下（安全语义上「别拍」优先于「要拍」）
      if (excludeBare.has(name) || excludeByHost.get(hostId)?.has(name)) {
        skipped.push(`${hostId}:${name}:excluded`)
        continue
      }
      if (Date.now() >= hostDeadline) {
        skipped.push(`${hostId}:${name}:deadline`)
        continue
      }
      try {
        assertSessionAllowed(name)
        await capture({
          hostId,
          sessionId: buildSessionId(hostId, name),
          deadlineMs: Math.max(1, hostDeadline - Date.now()),
          // 远端把封顶后的 exec 一起传下去：capture 内部每 pane 一次 capture-pane，
          // 不封顶时 N 个 pane 能各自等满一次 ssh 超时
          exec: hostExec,
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
