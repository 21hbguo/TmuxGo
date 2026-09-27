import { createHash, randomUUID } from 'crypto'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { createReadStream, rmSync } from 'fs'
import os from 'os'
import path from 'path'

// pane 内 agent → TmuxGo UI 的推送收件箱。metadata 存 JSON（原子 rename 落盘，
// 同 agent-notifications 约定），二进制按 sha256 分层存 inbox-assets/。
// WS 只广播 metadata 事件，内容一律走 REST 拉取——大文件不进 ws/JSON。

export type InboxMessageType = 'text' | 'image' | 'video' | 'file' | 'link'
export interface InboxMessageRoute {
  hostId?: string
  sessionName?: string
  paneId?: string
  tmuxPaneId?: string
}
export interface InboxMessageSource {
  provider?: string
  agent?: string
  agentSessionId?: string
}
export interface AgentInboxMessage {
  id: string
  type: InboxMessageType
  title?: string
  text?: string
  assetId?: string
  mime?: string
  size?: number
  sha256?: string
  name?: string
  source: InboxMessageSource
  route: InboxMessageRoute
  createdAt: string
  readBy: string[]
  // 全局已读：任一设备读过即对所有端已读（readBy 仍记录各设备明细做兼容）
  readAt?: string
  // 归档（"关闭已打开"）：fuera de la vista activa sin borrar nada；历史 sigue
  // 可查 por el filtro archived=1。Solo mensajes ya leídos pueden archivarse.
  archivedAt?: string
  // 回收站（软删）：deletedAt 标记=进回收站可恢复；只有 purge/TTL 才真正
  // 移除并回收 asset。归档≠删除≠回收站，三态互不影响
  deletedAt?: string
  updatedAt?: string
  // 本条状态对应的 store revision；客户端据此丢弃乱序/重复事件
  rev?: number
  expiresAt?: string
  dedupeKey?: string
  open?: boolean
  metadata?: Record<string, unknown>
}
export interface InboxAsset {
  id: string
  sha256: string
  mime: string
  size: number
  name: string
  path: string
  createdAt: string
}

export type InboxEvent =
  | { type: 'inbox_message_created'; message: AgentInboxMessage; rev: number }
  | { type: 'inbox_message_updated'; messages: AgentInboxMessage[]; rev: number }
  | { type: 'inbox_message_deleted'; ids: string[]; rev: number }
  | { type: 'inbox_open_target'; route: InboxMessageRoute; messageId?: string }

const STORE_VERSION = 1
const MAX_MESSAGES = 1000
const MAX_TEXT_BYTES = 256 * 1024
const MAX_BASE64_BYTES = 32 * 1024 * 1024
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MESSAGE_TTL_MS = 30 * 24 * 3600 * 1000
// 回收站容量时限：软删后可恢复窗口，超期随 sweep 物理清除并回收 asset
const TRASH_TTL_MS = 7 * 24 * 3600 * 1000
const TITLE_MAX = 160
const NAME_MAX = 256

interface InboxStore {
  version: 1
  messages: AgentInboxMessage[]
  assets: InboxAsset[]
  dedupe: Record<string, string>
  // 全局单调递增版本号：每次状态迁移 +1 并随 store 持久化，多端靠它对账
  revision: number
}

let store: InboxStore | null = null
let storePromise: Promise<InboxStore> | null = null
let loadedStorePath: string | null = null
let savePromise: Promise<void> = Promise.resolve()
let saveSequence = 0
const listeners = new Set<(event: InboxEvent) => void>()

function configDir() {
  return process.env.TMUXGO_CONFIG_DIR?.trim() || path.join(os.homedir(), '.tmuxgo')
}
function storePath() {
  return path.join(configDir(), 'agent-inbox.json')
}
function assetsRoot() {
  return process.env.TMUXGO_DATA_DIR?.trim() || path.join(configDir(), 'inbox-assets')
}
function assetDirFor(sha256: string) {
  return path.join(assetsRoot(), sha256.slice(0, 2))
}
function assetPathFor(sha256: string) {
  return path.join(assetDirFor(sha256), sha256)
}

async function writeStore(value: InboxStore, targetPath: string) {
  const directory = path.dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${targetPath}.${process.pid}.${++saveSequence}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temporary, targetPath)
  await chmod(targetPath, 0o600)
}
async function backupCorruptStore() {
  await copyFile(storePath(), `${storePath()}.corrupt-${Date.now()}`).catch(() => {})
}
async function saveStore(value: InboxStore) {
  const targetPath = storePath()
  const pending = savePromise.then(
    () => writeStore(value, targetPath),
    () => writeStore(value, targetPath),
  )
  savePromise = pending.then(
    () => undefined,
    () => undefined,
  )
  await pending
}
function normalizeMessage(value: unknown): AgentInboxMessage | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<AgentInboxMessage>
  if (typeof item.id !== 'string' || !item.id) return null
  if (!['text', 'image', 'video', 'file', 'link'].includes(String(item.type))) return null
  if (typeof item.createdAt !== 'string' || !item.createdAt) return null
  if (!item.source || typeof item.source !== 'object') return null
  if (!item.route || typeof item.route !== 'object') return null
  const readBy = Array.isArray(item.readBy) ? item.readBy.filter((v): v is string => typeof v === 'string') : []
  return {
    ...item,
    readBy,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : item.createdAt,
    // 迁移兼容：旧数据只有 readBy 没有 readAt——任一设备读过即按全局已读回填
    readAt: typeof item.readAt === 'string' ? item.readAt : readBy.length ? item.createdAt : undefined,
    archivedAt: typeof item.archivedAt === 'string' ? item.archivedAt : undefined,
    deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : undefined,
    rev: typeof item.rev === 'number' ? item.rev : undefined,
  } as AgentInboxMessage
}
async function loadStore() {
  const currentPath = storePath()
  if (store && loadedStorePath === currentPath) return store
  if (loadedStorePath !== currentPath) store = null
  if (storePromise) return storePromise
  storePromise = (async () => {
    let loaded: InboxStore | null = null
    try {
      const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<InboxStore>
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.messages) && Array.isArray(parsed.assets))
        loaded = {
          version: STORE_VERSION,
          messages: parsed.messages.map(normalizeMessage).filter((v): v is AgentInboxMessage => !!v),
          assets: parsed.assets as InboxAsset[],
          dedupe: parsed.dedupe && typeof parsed.dedupe === 'object' ? parsed.dedupe : {},
          revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
        }
      else await backupCorruptStore()
    } catch (err: any) {
      // JSON 损坏：留 .corrupt 副本供人工恢复再重建，别静默覆盖索引
      if (err?.code !== 'ENOENT') await backupCorruptStore()
    }
    store = loaded || { version: STORE_VERSION, messages: [], assets: [], dedupe: {}, revision: 0 }
    loadedStorePath = currentPath
    const evicted = await sweepExpired(store)
    if (evicted.length) {
      // 冷启动淘汰也算状态迁移：bump rev 并广播，在线的其他端同步剔除
      const rev = bumpRevision(store)
      await saveStore(store)
      emitInbox({ type: 'inbox_message_deleted', ids: evicted, rev })
    } else {
      await saveStore(store)
    }
    return store
  })().finally(() => {
    storePromise = null
  })
  return storePromise
}

// 过期/超限清理：message TTL + 总数上限 + asset 孤儿回收与总量配额。
// 返回被移除的 messageId（TTL/FIFO/配额都算删除事件，多端要同步消失）
async function sweepExpired(value: InboxStore): Promise<string[]> {
  const removed = new Set<string>()
  const now = Date.now()
  value.messages = value.messages.filter((m) => {
    const dead =
      (m.expiresAt && Date.parse(m.expiresAt) < now) ||
      now - Date.parse(m.createdAt) >= MESSAGE_TTL_MS ||
      // 回收站超期自动清空：恢复窗口只有 TRASH_TTL
      (!!m.deletedAt && now - Date.parse(m.deletedAt) >= TRASH_TTL_MS)
    if (dead) removed.add(m.id)
    return !dead
  })
  if (value.messages.length > MAX_MESSAGES) {
    // FIFO：保留最新 MAX_MESSAGES 条
    const evicted = value.messages.slice(0, value.messages.length - MAX_MESSAGES)
    for (const m of evicted) removed.add(m.id)
    value.messages = value.messages.slice(value.messages.length - MAX_MESSAGES)
  }
  const liveAssetIds = new Set(value.messages.map((m) => m.assetId).filter(Boolean) as string[])
  const liveSha = new Set<string>()
  value.assets = value.assets.filter((asset) => liveAssetIds.has(asset.id))
  let total = 0
  for (const asset of value.assets) total += asset.size || 0
  // 超配额按 createdAt 淘汰 asset（仅未被引用时不存在——被引用的淘汰旧消息释放）
  if (total > MAX_ASSET_BYTES) {
    const sorted = [...value.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const message of sorted) {
      if (total <= MAX_ASSET_BYTES) break
      const asset = message.assetId ? value.assets.find((v) => v.id === message.assetId) : null
      if (asset) {
        value.messages = value.messages.filter((v) => v.id !== message.id)
        removed.add(message.id)
        // 同 sha 资产可能被多条消息共享——还有引用时只删消息，别留下悬空 assetId
        const stillReferenced = value.messages.some((v) => v.assetId === asset.id)
        if (!stillReferenced) {
          total -= asset.size || 0
          value.assets = value.assets.filter((v) => v.id !== asset.id)
        }
      }
    }
  }
  for (const asset of value.assets) liveSha.add(asset.sha256)
  // dedupe 只进不出会随时间无界增长：清掉已不在消息集里的映射
  const liveIds = new Set(value.messages.map((m) => m.id))
  for (const key of Object.keys(value.dedupe)) {
    if (!liveIds.has(value.dedupe[key])) delete value.dedupe[key]
  }
  // 孤儿 asset 文件回收（异步失败不影响主流程）
  void (async () => {
    try {
      const root = assetsRoot()
      // 只收 sha256 布局产物：2-hex 目录 + 64-hex 文件名。assetsRoot 指向
      // 用户自选目录（TMUXGO_DATA_DIR）时绝不能误删其他文件
      for (const dir of await readdir(root).catch(() => [] as string[])) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue
        const dirPath = path.join(root, dir)
        for (const file of await readdir(dirPath).catch(() => [] as string[])) {
          if (/^[0-9a-f]{64}$/.test(file) && !liveSha.has(file))
            await rm(path.join(dirPath, file), { force: true }).catch(() => {})
        }
      }
    } catch {}
  })()
  return [...removed]
}

// 每次状态迁移 +1：客户端按 rev 丢旧/乱序事件，跳号则回源快照对账
function bumpRevision(value: InboxStore) {
  value.revision = (value.revision || 0) + 1
  return value.revision
}

export function subscribeInbox(listener: (event: InboxEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function emitInbox(event: InboxEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {}
  }
}

const SAFE_NAME = /[^\w.()\- +#[\]]+/g
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.azure(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker(\/|$)/,
  /(^|\/)\.env([./]|$)/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/,
  /(^|\/)\.tmuxgo\/(agent-inbox\.json|agent-event-token)$/,
  /(^|\/)\.claude(\.json|\/|$)/,
  /(^|\/)\.codex\/(auth|config)/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)config\.gcloud(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.config\/gh(\/|$)/,
  /(^|\/)\.hermes\//,
  /(^|\/)proc\/[^/]+\/environ$/,
  /\.(pem|key|p12|pfx)$/i,
]
export function isSensitivePath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
}
export function sanitizeFileName(name: string) {
  // basename 语义：路径分隔符一律截到最后一段，再剥危险字符与隐藏点前缀
  const base = name.split(/[\\/]/).filter(Boolean).pop() || 'file'
  const cleaned = base.replace(SAFE_NAME, '_').replace(/^\.+/, '').slice(0, NAME_MAX)
  return cleaned || 'file'
}
export function normalizeRoute(value: unknown): InboxMessageRoute {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const route: InboxMessageRoute = {}
  if (typeof raw.hostId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw.hostId)) route.hostId = raw.hostId
  if (typeof raw.sessionName === 'string' && raw.sessionName.length <= 64) route.sessionName = raw.sessionName
  if (typeof raw.tmuxPaneId === 'string' && /^%[0-9]+$/.test(raw.tmuxPaneId)) route.tmuxPaneId = raw.tmuxPaneId
  if (typeof raw.paneId === 'string' && raw.paneId.length <= 256) route.paneId = raw.paneId
  return route
}
function normalizeSource(value: unknown): InboxMessageSource {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const source: InboxMessageSource = {}
  if (typeof raw.provider === 'string') source.provider = raw.provider.slice(0, 64)
  if (typeof raw.agent === 'string') source.agent = raw.agent.slice(0, 64)
  if (typeof raw.agentSessionId === 'string') source.agentSessionId = raw.agentSessionId.slice(0, 128)
  return source
}

export interface PushInput {
  type: InboxMessageType
  title?: unknown
  text?: unknown
  name?: unknown
  mime?: unknown
  linkUrl?: unknown
  route?: unknown
  source?: unknown
  open?: unknown
  dedupeKey?: unknown
  expiresInMs?: unknown
  metadata?: unknown
  // 三选一的内容载体：本地路径引用 / base64 / 已上传 buffer（multipart）
  path?: unknown
  base64?: unknown
  buffer?: Buffer
  declaredSha256?: unknown
}

function guessMime(fileName: string, declared?: string) {
  if (declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared) && declared.length <= 128) return declared
  const ext = path.extname(fileName).toLowerCase()
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.log': 'text/plain',
  }
  return table[ext] || 'application/octet-stream'
}
function typeFromMime(mime: string, fallback: InboxMessageType) {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return fallback === 'image' || fallback === 'video' ? fallback : 'file'
}

export async function createPush(input: PushInput) {
  const value = await loadStore()
  const dedupeKey =
    typeof input.dedupeKey === 'string' && input.dedupeKey.trim() ? input.dedupeKey.trim().slice(0, 128) : undefined
  if (dedupeKey && value.dedupe[dedupeKey]) {
    const existing = value.messages.find((m) => m.id === value.dedupe[dedupeKey])
    if (existing) return { message: existing, deduplicated: true }
  }
  const type: InboxMessageType = ['text', 'image', 'video', 'file', 'link'].includes(String(input.type))
    ? input.type
    : 'text'
  const title =
    typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, TITLE_MAX) : undefined
  const route = normalizeRoute(input.route)
  const source = normalizeSource(input.source)
  const open = input.open === true

  const message: AgentInboxMessage = {
    id: randomUUID(),
    type,
    title,
    source,
    route,
    createdAt: new Date().toISOString(),
    readBy: [],
    dedupeKey,
    open,
  }
  if (typeof input.metadata === 'object' && input.metadata) {
    try {
      message.metadata = JSON.parse(JSON.stringify(input.metadata).slice(0, 8192))
    } catch {}
  }
  if (typeof input.expiresInMs === 'number' && input.expiresInMs > 0)
    message.expiresAt = new Date(Date.now() + Math.min(input.expiresInMs, MESSAGE_TTL_MS)).toISOString()

  if (type === 'text' || type === 'link') {
    const text = typeof input.text === 'string' ? input.text : typeof input.linkUrl === 'string' ? input.linkUrl : ''
    if (!text.trim()) throw new Error('Push requires text or linkUrl')
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('Text exceeds 256KiB limit')
    message.text = text
    if (type === 'link' && !/^https?:\/\//i.test(text)) throw new Error('link type requires http(s) URL')
  } else {
    // 二进制：path 引用 / base64 / multipart buffer 三选一
    let content: Buffer
    let name = typeof input.name === 'string' && input.name.trim() ? sanitizeFileName(input.name.trim()) : 'file'
    if (Buffer.isBuffer(input.buffer)) {
      content = input.buffer
    } else if (typeof input.path === 'string' && input.path.trim()) {
      const resolved = path.resolve(input.path.trim().replace(/^~(?=\/|$)/, os.homedir()))
      // realpath 解符号链接再查 denylist——`ln -s ~/.ssh/id_rsa x.png`
      // 这类链接名检查会漏判目标
      const real = await realpath(resolved).catch(() => resolved)
      if (isSensitivePath(resolved) || isSensitivePath(real)) throw new Error('Refusing to read sensitive path')
      // agent 侧最常见错误就是路径不存在/无权限——给出可定位文案而不是裸 errno
      const info = await stat(real).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error(`File not found: ${resolved}`)
        if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new Error(`Permission denied: ${resolved}`)
        throw error
      })
      if (!info.isFile()) throw new Error('Path is not a regular file')
      if (info.size > MAX_ASSET_BYTES) throw new Error('File exceeds asset size limit')
      content = await readFile(real).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new Error(`Permission denied: ${resolved}`)
        throw error
      })
      if (name === 'file') name = sanitizeFileName(path.basename(real))
    } else if (typeof input.base64 === 'string' && input.base64) {
      content = Buffer.from(input.base64, 'base64')
      if (content.length > MAX_BASE64_BYTES) throw new Error('base64 payload exceeds 32MiB limit')
    } else {
      throw new Error('Push requires path, base64, or multipart file')
    }
    if (content.length === 0) throw new Error('Empty content')
    if (content.length > MAX_ASSET_BYTES) throw new Error('Content exceeds asset size limit')
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (typeof input.declaredSha256 === 'string' && input.declaredSha256 && input.declaredSha256 !== sha256)
      throw new Error('sha256 mismatch')
    const mime = guessMime(name, typeof input.mime === 'string' ? input.mime : undefined)
    const assetPath = assetPathFor(sha256)
    const already = value.assets.find((a) => a.sha256 === sha256)
    let asset: InboxAsset
    if (already) {
      asset = already
    } else {
      await mkdir(assetDirFor(sha256), { recursive: true, mode: 0o700 })
      // 同 sha256 已存在的文件直接复用（内容寻址天然幂等）
      if (!(await stat(assetPath).catch(() => null))) {
        const tmp = `${assetPath}.${process.pid}.${++saveSequence}.tmp`
        await writeFile(tmp, content, { mode: 0o600 })
        await rename(tmp, assetPath)
      }
      asset = {
        id: randomUUID(),
        sha256,
        mime,
        size: content.length,
        name,
        path: path.relative(assetsRoot(), assetPath),
        createdAt: new Date().toISOString(),
      }
      value.assets.push(asset)
    }
    message.type = typeFromMime(mime, type)
    message.assetId = asset.id
    message.mime = mime
    message.size = content.length
    message.sha256 = sha256
    message.name = name
  }

  value.messages.push(message)
  if (dedupeKey) value.dedupe[dedupeKey] = message.id
  const evicted = await sweepExpired(value)
  // 淘汰与新增是两个迁移：各取一个 rev，客户端才能按序应用不丢事件
  const evictedRev = evicted.length ? bumpRevision(value) : 0
  const rev = bumpRevision(value)
  message.rev = rev
  message.updatedAt = message.createdAt
  await saveStore(value)
  if (evicted.length) emitInbox({ type: 'inbox_message_deleted', ids: evicted, rev: evictedRev })
  emitInbox({ type: 'inbox_message_created', message, rev })
  if (open) emitInbox({ type: 'inbox_open_target', route, messageId: message.id })
  return { message, deduplicated: false }
}

// vista del listado：active 默认（活动+未读+已读）| archived 归档 | trash 回收站
// | all 镜像全量（前端镜像需要看到所有状态，视图过滤在客户端做）
export type InboxListView = 'active' | 'archived' | 'trash' | 'all'
export async function listInboxMessages(
  options: {
    cursor?: string
    limit?: number
    // unreadForDevice 只决定是否返回 unreadCount（兼容旧语义）；过滤列表用 unreadOnly
    unreadForDevice?: string
    unreadOnly?: boolean
    view?: InboxListView
    sessionName?: string
    paneId?: string
  } = {},
) {
  const value = await loadStore()
  let items = [...value.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const view = options.view || 'active'
  if (view === 'trash') items = items.filter((m) => !!m.deletedAt)
  else if (view === 'archived') items = items.filter((m) => !!m.archivedAt && !m.deletedAt)
  else if (view === 'active') items = items.filter((m) => !m.archivedAt && !m.deletedAt)
  if (options.sessionName) items = items.filter((m) => m.route.sessionName === options.sessionName)
  if (options.paneId)
    items = items.filter((m) => m.route.paneId === options.paneId || m.route.tmuxPaneId === options.paneId)
  if (options.unreadOnly) items = items.filter((m) => !m.readAt)
  // cursor = 上一页最后一条的 createdAt+id，翻更旧的消息
  if (options.cursor) {
    const index = items.findIndex((m) => `${m.createdAt}#${m.id}` === options.cursor)
    if (index >= 0) items = items.slice(0, index)
  }
  const limit = Math.min(Math.max(options.limit || 50, 1), 200)
  const page = items.slice(Math.max(0, items.length - limit))
  const nextCursor =
    items.length > page.length
      ? `${items[items.length - page.length - 1].createdAt}#${items[items.length - page.length - 1].id}`
      : null
  // deviceId 触发返回未读数；语义是全局已读（readAt），多端角标一致.
  // 角标只 cuenta la vista activa: archivados/reciclados no suman badge
  const unreadCount = options.unreadForDevice
    ? value.messages.filter((m) => !m.readAt && !m.archivedAt && !m.deletedAt).length
    : undefined
  // 容量提示用的权威口径：消息数按非回收站计，asset 字节是全量占用（回收站
  // 里的消息仍引用 asset，purge/超期才释放）
  const stats = {
    messages: value.messages.filter((m) => !m.deletedAt).length,
    maxMessages: MAX_MESSAGES,
    assetBytes: value.assets.reduce((sum, asset) => sum + (asset.size || 0), 0),
    maxAssetBytes: MAX_ASSET_BYTES,
  }
  return { messages: page, nextCursor, unreadCount, total: items.length, stats, revision: value.revision }
}

export async function getInboxMessage(id: string) {
  const value = await loadStore()
  return value.messages.find((m) => m.id === id) || null
}
export async function getInboxRevision() {
  return (await loadStore()).revision
}
export async function getInboxAsset(assetId: string) {
  const value = await loadStore()
  return value.assets.find((a) => a.id === assetId) || null
}
// asset.path 相对 assetsRoot 存储；解析后必须落在 assetsRoot 内，防 store
// 被篡改后越界读盘。旧记录锚在 configDir（带 inbox-assets/ 前缀）——剥掉兼容
export function resolveAssetPath(asset: InboxAsset) {
  const rel = asset.path.replace(/^inbox-assets[\\/]/, '')
  const resolved = path.resolve(assetsRoot(), rel)
  if (!resolved.startsWith(path.resolve(assetsRoot()) + path.sep)) throw new Error('Invalid asset path')
  return resolved
}
export async function getAssetStream(asset: InboxAsset, range?: { start: number; end: number }) {
  return createReadStream(resolveAssetPath(asset), range)
}
const MAX_READ_BY = 64
// read=false 标未读：全局语义——清 readAt 并清空 readBy（否则其他端仍按已读看）
export async function markInboxRead(ids: string[], deviceId: string, read = true) {
  const value = await loadStore()
  const idSet = new Set(ids.slice(0, 500))
  const changed: AgentInboxMessage[] = []
  const now = new Date().toISOString()
  for (const message of value.messages) {
    if (!idSet.has(message.id)) continue
    if (!read) {
      if (!message.readAt && !message.readBy.length) continue
      message.readAt = undefined
      message.readBy = []
      message.updatedAt = now
      changed.push(message)
      continue
    }
    const known = message.readBy.includes(deviceId)
    if (known && message.readAt) continue
    if (!known) {
      // readBy 无界增长会被灌水——超上限丢最老设备标记
      if (message.readBy.length >= MAX_READ_BY) message.readBy.shift()
      message.readBy.push(deviceId)
    }
    if (!message.readAt) message.readAt = now
    message.updatedAt = now
    changed.push(message)
  }
  // 先落盘再广播：崩溃窗口内前端状态不得领先盘上状态
  if (changed.length) {
    const rev = bumpRevision(value)
    for (const message of changed) message.rev = rev
    await saveStore(value)
    // 批量已读一条事件全量带齐，避免多端对每条消息各收一次
    emitInbox({ type: 'inbox_message_updated', messages: changed, rev })
  }
  return { changed: changed.length, revision: value.revision }
}
// "关闭已打开" = archivar: fuera de la vista activa, historial intacto.
// Guard de servidor: solo se archivan mensajes leídos (readAt) — un id sin
// leer jamás se cierra, aunque el cliente lo pida. Idempotente: archivar lo
// ya archivado no cuenta ni re-emite.
export async function archiveInboxMessages(ids: string[], archived = true) {
  const value = await loadStore()
  const idSet = new Set(ids.slice(0, 500))
  const changed: AgentInboxMessage[] = []
  const now = new Date().toISOString()
  let skippedUnread = 0
  for (const message of value.messages) {
    if (!idSet.has(message.id) || message.deletedAt) continue
    if (archived) {
      if (!message.readAt) {
        skippedUnread += 1
        continue
      }
      if (message.archivedAt) continue
      message.archivedAt = now
    } else {
      if (!message.archivedAt) continue
      message.archivedAt = undefined
    }
    message.updatedAt = now
    changed.push(message)
  }
  if (changed.length) {
    const rev = bumpRevision(value)
    for (const message of changed) message.rev = rev
    await saveStore(value)
    // El pipeline de updated ya trae rev+墓碑: el resto de clientes ven el
    // cambio de vista sin evento nuevo ni riesgo de resurrección
    emitInbox({ type: 'inbox_message_updated', messages: changed, rev })
  }
  return { changed: changed.length, skippedUnread, revision: value.revision }
}
// 回收站：删除=软删（deletedAt），可从回收站恢复；purge/TTL 才物理移除。
// 进回收站即摘掉 dedupe——同 key 重新 push 生成新消息，旧的在回收站互不影响
async function setInboxDeleted(ids: string[], deleted: boolean) {
  const value = await loadStore()
  const idSet = new Set(ids.slice(0, 500))
  const changed: AgentInboxMessage[] = []
  const now = new Date().toISOString()
  for (const message of value.messages) {
    if (!idSet.has(message.id) || !!message.deletedAt === deleted) continue
    if (deleted) message.deletedAt = now
    else message.deletedAt = undefined
    message.updatedAt = now
    changed.push(message)
  }
  if (deleted) {
    const trashed = new Set(changed.map((m) => m.id))
    for (const key of Object.keys(value.dedupe)) {
      if (trashed.has(value.dedupe[key])) delete value.dedupe[key]
    }
  }
  if (changed.length) {
    const rev = bumpRevision(value)
    for (const message of changed) message.rev = rev
    await saveStore(value)
    emitInbox({ type: 'inbox_message_updated', messages: changed, rev })
  }
  return { changed: changed.length, revision: value.revision }
}
export async function deleteInboxMessages(ids: string[]) {
  const { changed, revision } = await setInboxDeleted(ids, true)
  // 兼容旧响应字段：removed = 进回收站的条数（不再物理删除）
  return { removed: changed, revision }
}
export async function restoreInboxMessages(ids: string[]) {
  const { changed, revision } = await setInboxDeleted(ids, false)
  return { restored: changed, revision }
}
// 只有已在回收站的才能物理清除——防止 purge 误删活动/归档消息
export async function purgeInboxMessages(ids: string[]) {
  const value = await loadStore()
  const idSet = new Set(ids.slice(0, 500))
  const purged = value.messages.filter((m) => idSet.has(m.id) && m.deletedAt)
  const purgedIds = new Set(purged.map((m) => m.id))
  value.messages = value.messages.filter((m) => !purgedIds.has(m.id))
  const evicted = await sweepExpired(value)
  const removedIds = [...purged.map((m) => m.id), ...evicted]
  if (removedIds.length) {
    const rev = bumpRevision(value)
    await saveStore(value)
    emitInbox({ type: 'inbox_message_deleted', ids: removedIds, rev })
  }
  return { purged: purged.length, revision: value.revision }
}
export async function requestOpenTarget(route: InboxMessageRoute, messageId?: string) {
  emitInbox({ type: 'inbox_open_target', route, messageId })
  return { ok: true }
}

// 测试挂钩：重置内存态并让 loadStore 落到干净 store（test-env 的 config dir
// 在进程内共享，不同步清文件会读到上个用例的持久化消息）
export function _resetInboxForTest(options: { keepStore?: boolean } = {}) {
  store = null
  storePromise = null
  loadedStorePath = null
  listeners.clear()
  if (!options.keepStore) {
    try {
      rmSync(storePath(), { force: true })
    } catch {}
  }
}
export { assetsRoot as _assetsRootForTest }
