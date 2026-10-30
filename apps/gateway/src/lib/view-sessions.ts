// 多端视角（grouped session）的命名与 id 规范化：纯函数，不碰 tmux。
//
// 为什么单独一层：view 名会同时出现在 attach 参数、list-sessions 输出、会话过滤和
// 生命周期清理里；如果各处自己拼字符串，迟早出现「前端传的 viewId 与后端清理时算出的
// 名字不一致」这类幽灵会话。这里固定唯一算法，并用 session option 标记归属——
// 名字只用于寻址，**判定一个 session 是不是 view 必须看 @tmuxgo_view_base**，
// 因为用户完全可能自己建一个同名前缀的 session。

import { createHash } from 'crypto'

export const VIEW_SESSION_PREFIX = 'tmuxgo-view-'
export const VIEW_BASE_OPTION = '@tmuxgo_view_base'
export const VIEW_CLIENT_OPTION = '@tmuxgo_view_client'

// viewId 由浏览器 localStorage 生成：只允许 URL 安全字符，长度限制避免把整段
// 用户输入塞进 tmux 名字或日志。短于 8 的 id 碰撞概率不可接受，直接拒绝。
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function normalizeViewId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return VIEW_ID_PATTERN.test(value) ? value : null
}

/** 稳定、无歧义的 view session 名：同 host + base + viewId 永远得到同一个名字 */
export function viewSessionName(hostId: string, baseSession: string, viewId: string): string {
  const digest = createHash('sha1').update(`${hostId}\0${baseSession}\0${viewId}`).digest('hex')
  return `${VIEW_SESSION_PREFIX}${digest.slice(0, 16)}`
}

/** 仅用于日志/诊断的前缀判定；是否隐藏会话以 session option 为准 */
export function hasViewSessionPrefix(name: string): boolean {
  return name.startsWith(VIEW_SESSION_PREFIX)
}

// ---- 运行时：grouped session 的创建 / 校验 / 清理 --------------------------
// 上面是纯命名契约；这里是真正碰 tmux 的一层。tmux-executor 用动态 import：
// 前端/纯单测只读命名与 id 校验时不必把 gateway 的 host/agent 单例拖进来。

export const DEFAULT_VIEW_TTL_MS = 10 * 60 * 1000

export interface ViewSessionRecord {
  name: string
  base: string
  client: string
  attached: number
  /** session_activity（epoch 秒）：只用于判断空闲时长 */
  activity: number
}

export interface SweepViewSessionsOptions {
  /** 只清理 @tmuxgo_view_base 等于该值的 view；省略 = 扫描全部 base */
  base?: string
  /** 无人附着且空闲超过该时长才清理；默认 10 分钟 */
  ttlMs?: number
  /** 明确保留的名字（例如当前正在 attach 的 view） */
  keepNames?: Iterable<string>
}

/** 一键回退：TMUXGO_VIEWS=0 时 attach 完全走旧行为（忽略 viewId、不建 view、不查 option） */
export function viewsEnabled(): boolean {
  return process.env.TMUXGO_VIEWS !== '0'
}

// 字段顺序即解析顺序；中间用真实 tab 分隔（tmux 不展开格式串里的 \t 转义）
const VIEW_SESSION_LIST_FORMAT = [
  '#{session_name}',
  `#{${VIEW_BASE_OPTION}}`,
  `#{${VIEW_CLIENT_OPTION}}`,
  '#{session_attached}',
  '#{session_activity}',
].join('\t')

async function runTmux(hostId: string, args: string[]) {
  const { execTmux } = await import('./tmux-executor.js')
  return execTmux(hostId, args)
}

/** 一次 list-sessions 拿到全部 session 的 view 归属与空闲信息；名字只用于寻址 */
export async function listViewSessions(hostId: string): Promise<ViewSessionRecord[]> {
  const { stdout } = await runTmux(hostId, ['list-sessions', '-F', VIEW_SESSION_LIST_FORMAT])
  return String(stdout)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', base = '', client = '', attached = '0', activity = '0'] = line.split('\t')
      return {
        name,
        base,
        client,
        attached: Number(attached) || 0,
        activity: Number(activity) || 0,
      }
    })
}

function assertViewOwnership(record: ViewSessionRecord, baseSession: string, viewId: string) {
  // 名字只用于寻址：归属以 option 为准。同名 session 没有标记或标记不属于当前
  // base/view 时一律 collision——绝不推测、更不 kill 用户自己的 session
  if (record.base !== baseSession || record.client !== viewId)
    throw new Error(
      `View session collision: ${record.name} already exists ` +
        `(base=${record.base || 'unset'}, client=${record.client || 'unset'})`,
    )
  return record.name
}

async function createOrVerifyViewSession(
  hostId: string,
  baseSession: string,
  viewId: string,
  name: string,
): Promise<string> {
  const sessions = await listViewSessions(hostId)
  if (!sessions.some((session) => session.name === baseSession))
    throw new Error(`Base session not found: ${baseSession}`)
  const existing = sessions.find((session) => session.name === name)
  if (existing) return assertViewOwnership(existing, baseSession, viewId)

  // grouped session 的 current window 不继承 base（tmux 3.4 实测：base 停在
  // window 2 时新 view 仍指向窗口表第一项）。创建前记下 base 的活动窗口，
  // 建好后对齐，否则第二台设备首次打开会跳到第一个窗口。
  const activeWindow = await runTmux(hostId, ['display-message', '-p', '-t', baseSession, '#{window_index}'])
    .then((result) => result.stdout.trim())
    .catch(() => '')
  try {
    await runTmux(hostId, ['new-session', '-d', '-t', baseSession, '-s', name])
  } catch (err) {
    // 进程外并发（另一个 gateway/人工）抢先建了同名：归属正确就接受，否则 collision
    const raced = (await listViewSessions(hostId).catch(() => [])).find((session) => session.name === name)
    if (raced) return assertViewOwnership(raced, baseSession, viewId)
    throw err
  }
  try {
    await runTmux(hostId, ['set-option', '-t', name, VIEW_BASE_OPTION, baseSession])
    await runTmux(hostId, ['set-option', '-t', name, VIEW_CLIENT_OPTION, viewId])
  } catch (err) {
    // 半成品没有归属标记，sweep 永远看不见：就地删掉，避免永久孤儿。
    // 这里刚由本进程创建完成，直接 kill 不需要 option 校验
    await runTmux(hostId, ['kill-session', '-t', name]).catch(() => {})
    throw err
  }
  if (activeWindow)
    await runTmux(hostId, ['select-window', '-t', `${name}:${activeWindow}`]).catch((err: unknown) => {
      // 窗口恰好被关掉：不阻塞 attach，view 退回窗口表第一项即可
      console.warn('Failed to align view session window', { base: baseSession, view: name, activeWindow, err })
    })
  return name
}

// 同进程并发 ensure 同一 view 时只建一次：key = host + view 名。成功/失败都清
// map——成功也不缓存，因为宽限销毁后同名 view 可能已被清理，必须重新校验
const inflightEnsures = new Map<string, Promise<string>>()

/** 确认 view 存在且归属正确，不存在则建 grouped session；返回 view 名 */
export function ensureViewSession(hostId: string, baseSession: string, viewIdRaw: unknown): Promise<string> {
  const viewId = normalizeViewId(viewIdRaw)
  if (!viewId) return Promise.reject(new Error('Invalid view id'))
  const name = viewSessionName(hostId, baseSession, viewId)
  const key = `${hostId}\0${name}`
  const pending = inflightEnsures.get(key)
  if (pending) return pending
  const tracked = createOrVerifyViewSession(hostId, baseSession, viewId, name).finally(() => {
    if (inflightEnsures.get(key) === tracked) inflightEnsures.delete(key)
  })
  inflightEnsures.set(key, tracked)
  return tracked
}

/**
 * 只 kill 归属校验通过的 view（@tmuxgo_view_base 非空，且等于 expectedBase 时匹配）。
 * base 已不存在也能清（view 的 option 仍指向它）；目标已消失按幂等返回 false。
 */
export async function killViewSession(hostId: string, name: string, expectedBase?: string): Promise<boolean> {
  let base: string
  try {
    const { stdout } = await runTmux(hostId, ['show-options', '-qv', '-t', name, VIEW_BASE_OPTION])
    base = stdout.trim()
  } catch {
    // session 已经不在了：没有可 kill 的目标
    return false
  }
  if (!base) return false
  if (expectedBase && base !== expectedBase) return false
  try {
    await runTmux(hostId, ['kill-session', '-t', name])
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/can't find session|no such session|session not found/i.test(message)) return false
    throw err
  }
}

/**
 * 保守清扫孤儿 view：只动带 @tmuxgo_view_base 的 session。满足任一条件即删：
 *   1) option 指向的 base 已不存在；
 *   2) 无人附着（session_attached=0）且空闲超过 ttl。
 * 有附着者的 live view 绝不清。失败（server 不在/list 失败）按无孤儿处理，
 * 启动清扫不应阻塞 gateway。
 */
export async function sweepViewSessions(hostId: string, opts: SweepViewSessionsOptions = {}): Promise<string[]> {
  const ttlMs =
    typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) ? Math.max(0, opts.ttlMs) : DEFAULT_VIEW_TTL_MS
  let sessions: ViewSessionRecord[]
  try {
    sessions = await listViewSessions(hostId)
  } catch {
    return []
  }
  const names = new Set(sessions.map((session) => session.name))
  const keep = new Set(opts.keepNames ?? [])
  const now = Date.now()
  const killed: string[] = []
  for (const view of sessions) {
    if (!view.base) continue
    if (opts.base && view.base !== opts.base) continue
    if (keep.has(view.name) || view.name === opts.base) continue
    const baseMissing = !names.has(view.base)
    const idleMs = now - view.activity * 1000
    const idle = view.attached <= 0 && idleMs >= ttlMs
    if (!baseMissing && !idle) continue
    if (await killViewSession(hostId, view.name, view.base).catch(() => false)) killed.push(view.name)
  }
  return killed
}
