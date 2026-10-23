import os from 'node:os'
import path from 'node:path'
import { JsonStore } from './json-store.js'
import { execTmux } from './tmux-executor.js'
import { scopeAllowsHost, scopeAllowsSession, type AccessScope } from './access-scope.js'

// 同步输入广播组：一组 paneId（host:tmuxPaneId），成员 pane 收到键盘输入时扇出到其余成员。
// 不调 tmux 原生 synchronize-panes——那是 window 级全量开关，做不到"子集广播"，
// 也跨不了 host；这里在网关 input 路径自己复制字节。
export interface SyncPaneMember {
  /** hostId:tmuxPaneId，与前端 pane.id / panes 路由同一格式 */
  paneId: string
  sessionName: string
}

export const MAX_SYNC_PANES = 16
// 广播不复制超大块：send-keys -l 走命令行参数，几 KB 的粘贴应该走 paste-data 通道，
// 混进来会撞 ARG_MAX 且 tmux 侧也没有对应的粘贴语义
export const SYNC_INPUT_MAX_BYTES = 4096
const PANE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}:%\d+$/
const SESSION_NAME_MAX = 256

export function parseSyncPaneId(paneId: string) {
  const separator = paneId.indexOf(':')
  return { hostId: paneId.slice(0, separator), tmuxPaneId: paneId.slice(separator + 1) }
}

export function normalizeSyncMember(input: unknown): SyncPaneMember | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const paneId = typeof raw.paneId === 'string' ? raw.paneId.trim() : ''
  const sessionName = typeof raw.sessionName === 'string' ? raw.sessionName.trim() : ''
  if (!PANE_ID_PATTERN.test(paneId) || !sessionName || sessionName.length > SESSION_NAME_MAX) return null
  return { paneId, sessionName }
}

let syncStore: JsonStore<SyncPaneMember> | null = null
function getSyncStore() {
  if (syncStore) return syncStore
  const configDir = process.env.TMUXGO_CONFIG_DIR || path.join(os.homedir(), '.tmuxgo')
  syncStore = new JsonStore<SyncPaneMember>(path.join(configDir, 'sync-panes.json'), {
    key: 'members',
    normalize: (input) =>
      (Array.isArray(input) ? input : [])
        .map(normalizeSyncMember)
        .filter((item): item is SyncPaneMember => !!item)
        .slice(0, MAX_SYNC_PANES),
  })
  return syncStore
}

// input 帧是热路径（每次击键批量可能几十帧/秒），不能每帧读盘：
// 组状态缓存在内存，只由本进程写回时刷新。多进程同时改同一 config dir 属配置错误场景，
// 那种情况下别的进程要重启才会看到新组——广播组本来就是当前这台网关的会话级状态
let cachedMembers: SyncPaneMember[] | null = null

export async function readSyncMembers(): Promise<SyncPaneMember[]> {
  if (cachedMembers) return cachedMembers
  cachedMembers = await getSyncStore().read()
  return cachedMembers
}

export async function replaceSyncMembers(members: SyncPaneMember[]): Promise<SyncPaneMember[]> {
  const unique: SyncPaneMember[] = []
  const seen = new Set<string>()
  for (const member of members) {
    if (seen.has(member.paneId)) continue
    seen.add(member.paneId)
    unique.push(member)
    if (unique.length >= MAX_SYNC_PANES) break
  }
  await getSyncStore().write(unique)
  cachedMembers = unique
  return unique
}

export async function clearSyncMembers(): Promise<void> {
  await replaceSyncMembers([])
}

export interface SyncFanOutInput {
  data: string
  /** 发起输入的 pane：成员 pane 的输入才会广播；缺省时不扇出（见下方注释） */
  sourcePaneId?: string
  /** 请求方 scope：越权 pane 一律不写，保持与 REST 侧同一判定依据 */
  scope?: AccessScope
}

export interface SyncFanOutResult {
  delivered: number
  skipped: number
  pruned: number
}

/**
 * 把一次输入复制给广播组内其他成员。
 * 发起 pane 不重复投递：它的输入已经由 attach 的 pty 送给 tmux（那是用户真正敲的那个窗格），
 * 再发一次会在该 pane 出现重复字符。
 */
export async function fanOutSyncInput(input: SyncFanOutInput): Promise<SyncFanOutResult> {
  const result: SyncFanOutResult = { delivered: 0, skipped: 0, pruned: 0 }
  const members = await readSyncMembers()
  if (members.length < 2 || !input.sourcePaneId) return result
  if (!input.data || Buffer.byteLength(input.data, 'utf8') > SYNC_INPUT_MAX_BYTES) return result
  const source = input.sourcePaneId
  const targets = members.filter((member) => member.paneId !== source)
  if (!targets.length) return result
  const dead: string[] = []
  await Promise.all(
    targets.map(async (member) => {
      const { hostId, tmuxPaneId } = parseSyncPaneId(member.paneId)
      if (
        input.scope &&
        (!scopeAllowsHost(input.scope, hostId) || !scopeAllowsSession(input.scope, hostId, member.sessionName))
      ) {
        result.skipped += 1
        return
      }
      try {
        // -l 关掉键名解析：data 是终端原始字节（含 ESC 序列），必须原样写进 pane
        await execTmux(hostId, ['send-keys', '-t', tmuxPaneId, '-l', '--', input.data])
        result.delivered += 1
      } catch {
        // pane 已关闭 / host 掉线：不打断本次输入，顺手把死成员剔出组（异步、不阻塞击键）
        dead.push(member.paneId)
        result.skipped += 1
      }
    }),
  )
  if (dead.length) {
    result.pruned = dead.length
    const remaining = members.filter((member) => !dead.includes(member.paneId))
    void replaceSyncMembers(remaining).catch(() => {})
  }
  return result
}
