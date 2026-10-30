// 面向用户的 tmux session 枚举：grouped view session 只在 tmux 内部存在，
// 任何会话列表、扫描、快照都不该看到它们。
//
// 判定依据只有一个：session option @tmuxgo_view_base 非空。绝不按名字前缀过滤——
// 用户完全可能自建一个 tmuxgo-view-* 的普通会话，按前缀隐藏会把真实会话吞掉。
//
// 字段用 tab 分隔而不是 '|'：session 名可以含空格，也可能含 '|'；tab 是 tmux
// 名字里实际不会出现的字符。view 名本身由 view-sessions.ts 统一生成。

import { buildSessionId } from './tmux-target.js'
import { isValidSessionName } from './tmux-policy.js'
import { execTmux } from './tmux-executor.js'
import { VIEW_BASE_OPTION } from './view-sessions.js'

export interface UserTmuxSession {
  id: string
  hostId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
  attached: boolean
}

// session 名放在第二列，view option 放最后一列：即使 name 中有 '|' 也不影响解析，
// 解析时只按 tab 切分。
export const USER_SESSION_LIST_FORMAT =
  `#{session_id}\t#{session_name}\t#{session_windows}\t#{session_created}\t#{session_activity}\t#{session_attached}\t` +
  `#{${VIEW_BASE_OPTION}}`

export const VIEW_SESSION_LIST_FORMAT = `#{session_name}\t#{${VIEW_BASE_OPTION}}`

function nonEmptyLines(stdout: string) {
  return stdout.split(/\r?\n/).filter(Boolean)
}

/** list-sessions 输出 → 用户会话；@tmuxgo_view_base 非空的行直接丢弃 */
export function parseUserSessions(hostId: string, stdout: string): UserTmuxSession[] {
  const sessions: UserTmuxSession[] = []
  for (const line of nonEmptyLines(stdout)) {
    const [id, name, windows, created, activity, attached, viewBase] = line.split('\t')
    if (!id || !name || viewBase) continue
    // tmux 允许空格等字符，但网关的 session 命名契约不接受；旧实现先经
    // assertSessionAllowed 过滤，这里提前跳过，避免一个非法名让整张列表抛错。
    if (!isValidSessionName(name)) continue
    const createdAtUnix = parseInt(created, 10)
    const activityUnix = parseInt(activity, 10)
    const attachedCount = parseInt(attached, 10)
    const createdAt = Number.isFinite(createdAtUnix)
      ? new Date(createdAtUnix * 1000).toISOString()
      : new Date().toISOString()
    const lastActiveAt = Number.isFinite(activityUnix) ? new Date(activityUnix * 1000).toISOString() : createdAt
    sessions.push({
      id: buildSessionId(hostId, name),
      hostId,
      name,
      createdAt,
      lastActiveAt,
      windowCount: parseInt(windows, 10),
      attached: Number.isFinite(attachedCount) && attachedCount > 0,
    })
  }
  return sessions
}

/** 一次 list-sessions 拿下所有 view session 名；空 socket 等失败按「没有 view」处理 */
export async function listUserSessions(hostId: string): Promise<UserTmuxSession[]> {
  const { stdout } = await execTmux(hostId, ['list-sessions', '-F', USER_SESSION_LIST_FORMAT])
  return parseUserSessions(hostId, stdout)
}

/** 解析 `session_name<TAB>view_base` 输出，只收集 option 非空的行 */
export function parseViewSessionNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of nonEmptyLines(stdout)) {
    const tab = line.indexOf('\t')
    const name = tab === -1 ? line : line.slice(0, tab)
    const viewBase = tab === -1 ? '' : line.slice(tab + 1)
    if (name && viewBase !== '') names.add(name)
  }
  return names
}

/** 解析 `session_name<TAB>view_base` 输出，只收集 option 为空的行（真实用户会话） */
export function parseUserSessionNames(stdout: string): string[] {
  const names: string[] = []
  for (const line of nonEmptyLines(stdout)) {
    const tab = line.indexOf('\t')
    const name = tab === -1 ? line : line.slice(0, tab)
    const viewBase = tab === -1 ? '' : line.slice(tab + 1)
    if (name && viewBase === '') names.push(name)
  }
  return names
}

/**
 * 全量扫描前取 view 名集合。失败返回空集合而不是抛错：真正的扫描命令随后会以
 * 原有语义报错（no server/SSH 掉线），这里不该提前改变错误路径。
 */
export async function getViewSessionNames(hostId: string): Promise<Set<string>> {
  try {
    const { stdout } = await execTmux(hostId, ['list-sessions', '-F', VIEW_SESSION_LIST_FORMAT])
    return parseViewSessionNames(stdout)
  } catch {
    return new Set()
  }
}
