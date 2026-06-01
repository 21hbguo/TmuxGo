import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'

type CustomShortcut = { id: string; label: string; keys: string }
type FavoriteDirectory = { rootId: string; rootPath: string; name: string; path: string }
type SessionOrder = { hostId: string; orderedSessionIds: string[] }
type Snippet = { id: string; name: string; command: string; description?: string; category?: string }
type FavoriteItem = { id: string; type: 'host' | 'session' | 'pane'; name: string; target: string; addedAt: string }
type UiPreferences = {
  theme?: string
  fontSize?: number
  fontFamily?: string
  cursorBlink?: boolean
  sidebarPosition?: string
  showStatusBar?: boolean
  showQuickActions?: boolean
  autoReconnect?: boolean
  reconnectInterval?: number
  terminalPadding?: number
  language?: string
  attachExclusive?: boolean
}
type PreferencesStore = {
  version: 1
  updatedAt: string
  customShortcuts: CustomShortcut[]
  customShortcutsUpdatedAt: string
  favoriteDirectories: FavoriteDirectory[]
  favoriteDirectoriesUpdatedAt: string
  sessionOrders: SessionOrder[]
  sessionOrdersUpdatedAt: string
  snippets: Snippet[]
  snippetsUpdatedAt: string
  favorites: FavoriteItem[]
  favoritesUpdatedAt: string
  uiPreferences: UiPreferences
  uiPreferencesUpdatedAt: string
  uploadRateLimitKBps: number
  downloadRateLimitKBps: number
}

const MAX_SHORTCUTS = 100
const MAX_FAVORITES = 100
const MAX_SESSION_ORDERS = 200
const MAX_SESSION_ORDER_IDS = 500
const MAX_SNIPPETS = 200
const MAX_BOOKMARK_FAVORITES = 200
const MAX_BODY_BYTES = 256 * 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_PROFILE_LEN = 64
const MAX_SHORTCUT_LABEL_LEN = 64
const MAX_SHORTCUT_KEYS_LEN = 64
const MAX_ID_LEN = 64
const MAX_ROOT_ID_LEN = 64
const MAX_ROOT_PATH_LEN = 1024
const MAX_FAVORITE_NAME_LEN = 128
const MAX_FAVORITE_PATH_LEN = 1024
const MAX_SESSION_ID_LEN = 128
const MAX_SNIPPET_NAME_LEN = 128
const MAX_SNIPPET_COMMAND_LEN = 4096
const MAX_SNIPPET_DESC_LEN = 512
const MAX_SNIPPET_CATEGORY_LEN = 64
const MAX_FAVORITE_TARGET_LEN = 1024
const VALID_THEMES = ['dark', 'light', 'high-contrast', 'dracula', 'nord', 'catppuccin']
const VALID_SIDEBAR = ['left', 'right']
const VALID_LANGUAGE = ['zh', 'en']
const DEFAULT_UPLOAD_RATE_LIMIT_KBPS = 200
const MAX_UPLOAD_RATE_LIMIT_KBPS = 10 * 1024
const PROFILE_RE = /^[a-zA-Z0-9_-]+$/
const STORAGE_DIR = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')

function nowIso() {
  return new Date().toISOString()
}
function getDefaultStore(): PreferencesStore {
  const now = nowIso()
  return {
    version: 1,
    updatedAt: now,
    customShortcuts: [],
    customShortcutsUpdatedAt: now,
    favoriteDirectories: [],
    favoriteDirectoriesUpdatedAt: now,
    sessionOrders: [],
    sessionOrdersUpdatedAt: now,
    snippets: [],
    snippetsUpdatedAt: now,
    favorites: [],
    favoritesUpdatedAt: now,
    uiPreferences: {},
    uiPreferencesUpdatedAt: now,
    uploadRateLimitKBps: DEFAULT_UPLOAD_RATE_LIMIT_KBPS,
    downloadRateLimitKBps: DEFAULT_UPLOAD_RATE_LIMIT_KBPS,
  }
}
function safeString(input: unknown, maxLen: number) {
  if (typeof input !== 'string') return ''
  return input.trim().slice(0, maxLen)
}
function normalizeIso(input: unknown, fallback: string) {
  if (typeof input !== 'string') return fallback
  const t = Date.parse(input)
  if (Number.isNaN(t)) return fallback
  return new Date(t).toISOString()
}
function parseIsoMs(input: string) {
  const t = Date.parse(input)
  return Number.isNaN(t) ? 0 : t
}
function normalizeShortcuts(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: CustomShortcut[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const id = safeString((entry as Record<string, unknown>).id, MAX_ID_LEN)
    const label = safeString((entry as Record<string, unknown>).label, MAX_SHORTCUT_LABEL_LEN)
    const keys = safeString((entry as Record<string, unknown>).keys, MAX_SHORTCUT_KEYS_LEN)
    if (!id || !label || !keys) continue
    next.push({ id, label, keys })
    if (next.length >= MAX_SHORTCUTS) break
  }
  return next
}
function normalizeFavorites(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: FavoriteDirectory[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const rootId = safeString((entry as Record<string, unknown>).rootId, MAX_ROOT_ID_LEN)
    const rootPath = safeString((entry as Record<string, unknown>).rootPath, MAX_ROOT_PATH_LEN)
    const name = safeString((entry as Record<string, unknown>).name, MAX_FAVORITE_NAME_LEN)
    const pathValue = safeString((entry as Record<string, unknown>).path, MAX_FAVORITE_PATH_LEN)
    if (!rootId || !rootPath || !name) continue
    next.push({ rootId, rootPath, name, path: pathValue })
    if (next.length >= MAX_FAVORITES) break
  }
  return next
}
function normalizeSessionOrders(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: SessionOrder[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const hostId = safeString((entry as Record<string, unknown>).hostId, MAX_ID_LEN)
    const orderedSessionIdsRaw = Array.isArray((entry as Record<string, unknown>).orderedSessionIds) ? (entry as Record<string, unknown>).orderedSessionIds as unknown[] : []
    if (!hostId) continue
    const orderedSessionIds: string[] = []
    for (const item of orderedSessionIdsRaw) {
      const sessionId = safeString(item, MAX_SESSION_ID_LEN)
      if (!sessionId || orderedSessionIds.includes(sessionId)) continue
      orderedSessionIds.push(sessionId)
      if (orderedSessionIds.length >= MAX_SESSION_ORDER_IDS) break
    }
    next.push({ hostId, orderedSessionIds })
    if (next.length >= MAX_SESSION_ORDERS) break
  }
  return next
}
function normalizeSnippets(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: Snippet[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const id = safeString((entry as Record<string, unknown>).id, MAX_ID_LEN)
    const name = safeString((entry as Record<string, unknown>).name, MAX_SNIPPET_NAME_LEN)
    const command = safeString((entry as Record<string, unknown>).command, MAX_SNIPPET_COMMAND_LEN)
    if (!id || !name || !command) continue
    const description = safeString((entry as Record<string, unknown>).description, MAX_SNIPPET_DESC_LEN)
    const category = safeString((entry as Record<string, unknown>).category, MAX_SNIPPET_CATEGORY_LEN)
    const snippet: Snippet = { id, name, command }
    if (description) snippet.description = description
    if (category) snippet.category = category
    next.push(snippet)
    if (next.length >= MAX_SNIPPETS) break
  }
  return next
}
function normalizeBookmarkFavorites(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: FavoriteItem[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const id = safeString((entry as Record<string, unknown>).id, MAX_ID_LEN)
    const type = (entry as Record<string, unknown>).type
    if (!id || !['host', 'session', 'pane'].includes(type as string)) continue
    const name = safeString((entry as Record<string, unknown>).name, MAX_FAVORITE_NAME_LEN)
    const target = safeString((entry as Record<string, unknown>).target, MAX_FAVORITE_TARGET_LEN)
    const addedAt = normalizeIso((entry as Record<string, unknown>).addedAt, nowIso())
    if (!name) continue
    next.push({ id, type: type as 'host' | 'session' | 'pane', name, target, addedAt })
    if (next.length >= MAX_BOOKMARK_FAVORITES) break
  }
  return next
}
function normalizeUiPreferences(input: unknown): UiPreferences {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const result: UiPreferences = {}
  if (typeof raw.theme === 'string' && VALID_THEMES.includes(raw.theme)) result.theme = raw.theme
  if (typeof raw.fontSize === 'number' && raw.fontSize >= 8 && raw.fontSize <= 32) result.fontSize = raw.fontSize
  if (typeof raw.fontFamily === 'string' && raw.fontFamily.length <= 256) result.fontFamily = raw.fontFamily
  if (typeof raw.cursorBlink === 'boolean') result.cursorBlink = raw.cursorBlink
  if (typeof raw.sidebarPosition === 'string' && VALID_SIDEBAR.includes(raw.sidebarPosition)) result.sidebarPosition = raw.sidebarPosition
  if (typeof raw.showStatusBar === 'boolean') result.showStatusBar = raw.showStatusBar
  if (typeof raw.showQuickActions === 'boolean') result.showQuickActions = raw.showQuickActions
  if (typeof raw.autoReconnect === 'boolean') result.autoReconnect = raw.autoReconnect
  if (typeof raw.reconnectInterval === 'number' && raw.reconnectInterval >= 1000 && raw.reconnectInterval <= 60000) result.reconnectInterval = raw.reconnectInterval
  if (typeof raw.terminalPadding === 'number' && raw.terminalPadding >= 0 && raw.terminalPadding <= 32) result.terminalPadding = raw.terminalPadding
  if (typeof raw.language === 'string' && VALID_LANGUAGE.includes(raw.language)) result.language = raw.language
  if (typeof raw.attachExclusive === 'boolean') result.attachExclusive = raw.attachExclusive
  return result
}
function normalizeUploadRateLimitKBps(input: unknown) {
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_RATE_LIMIT_KBPS
  return Math.max(1, Math.min(MAX_UPLOAD_RATE_LIMIT_KBPS, Math.round(value)))
}
function normalizeStore(input: unknown): PreferencesStore {
  const fallback = getDefaultStore()
  if (!input || typeof input !== 'object') return fallback
  const raw = input as Record<string, unknown>
  const customShortcutsUpdatedAt = normalizeIso(raw.customShortcutsUpdatedAt, fallback.customShortcutsUpdatedAt)
  const favoriteDirectoriesUpdatedAt = normalizeIso(raw.favoriteDirectoriesUpdatedAt, fallback.favoriteDirectoriesUpdatedAt)
  const sessionOrdersUpdatedAt = normalizeIso(raw.sessionOrdersUpdatedAt, fallback.sessionOrdersUpdatedAt)
  const snippetsUpdatedAt = normalizeIso(raw.snippetsUpdatedAt, fallback.snippetsUpdatedAt)
  const favoritesUpdatedAt = normalizeIso(raw.favoritesUpdatedAt, fallback.favoritesUpdatedAt)
  const uiPreferencesUpdatedAt = normalizeIso(raw.uiPreferencesUpdatedAt, fallback.uiPreferencesUpdatedAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt, fallback.updatedAt)
  const updatedAt = new Date(Math.max(
    parseIsoMs(updatedAtRaw), parseIsoMs(customShortcutsUpdatedAt), parseIsoMs(favoriteDirectoriesUpdatedAt),
    parseIsoMs(sessionOrdersUpdatedAt), parseIsoMs(snippetsUpdatedAt), parseIsoMs(favoritesUpdatedAt), parseIsoMs(uiPreferencesUpdatedAt),
  )).toISOString()
  return {
    version: 1,
    updatedAt,
    customShortcuts: normalizeShortcuts(raw.customShortcuts),
    customShortcutsUpdatedAt,
    favoriteDirectories: normalizeFavorites(raw.favoriteDirectories),
    favoriteDirectoriesUpdatedAt,
    sessionOrders: normalizeSessionOrders(raw.sessionOrders),
    sessionOrdersUpdatedAt,
    snippets: normalizeSnippets(raw.snippets),
    snippetsUpdatedAt,
    favorites: normalizeBookmarkFavorites(raw.favorites),
    favoritesUpdatedAt,
    uiPreferences: normalizeUiPreferences(raw.uiPreferences),
    uiPreferencesUpdatedAt,
    uploadRateLimitKBps: normalizeUploadRateLimitKBps(raw.uploadRateLimitKBps),
    downloadRateLimitKBps: normalizeUploadRateLimitKBps(raw.downloadRateLimitKBps),
  }
}
function getProfileName(input: unknown) {
  const profile = safeString(input, MAX_PROFILE_LEN) || 'default'
  if (!PROFILE_RE.test(profile)) return 'default'
  return profile
}
function getProfilePath(profile: string) {
  return path.join(STORAGE_DIR, `${profile}.json`)
}
async function ensureStorageDir() {
  await mkdir(STORAGE_DIR, { recursive: true })
}
async function readStore(profile: string) {
  const file = getProfilePath(profile)
  try {
    const content = await readFile(file, 'utf8')
    return normalizeStore(JSON.parse(content))
  } catch {
    return getDefaultStore()
  }
}
async function writeStore(profile: string, store: PreferencesStore) {
  await ensureStorageDir()
  const file = getProfilePath(profile)
  const data = JSON.stringify(store)
  if (Buffer.byteLength(data, 'utf8') > MAX_FILE_BYTES) throw new Error('Preferences too large')
  const tmp = `${file}.tmp-${Date.now().toString(36)}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, file)
  try {
    const info = await stat(file)
    if (info.size > MAX_FILE_BYTES) throw new Error('Preferences too large')
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error('Failed to verify preferences file')
  }
}

export async function preferencesRoutes(fastify: FastifyInstance) {
  fastify.get('/preferences', async (request) => {
    const query = request.query as { profile?: string }
    const profile = getProfileName(query.profile)
    return readStore(profile)
  })
  fastify.put('/preferences', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    const query = request.query as { profile?: string }
    const profile = getProfileName(query.profile)
    const body = (request.body && typeof request.body === 'object') ? request.body as Record<string, unknown> : {}
    const current = await readStore(profile)
    const next = { ...current }
    if ('customShortcuts' in body) {
      const incoming = normalizeShortcuts(body.customShortcuts)
      const incomingAt = normalizeIso(body.customShortcutsUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.customShortcutsUpdatedAt)) {
        next.customShortcuts = incoming
        next.customShortcutsUpdatedAt = incomingAt
      }
    }
    if ('favoriteDirectories' in body) {
      const incoming = normalizeFavorites(body.favoriteDirectories)
      const incomingAt = normalizeIso(body.favoriteDirectoriesUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.favoriteDirectoriesUpdatedAt)) {
        next.favoriteDirectories = incoming
        next.favoriteDirectoriesUpdatedAt = incomingAt
      }
    }
    if ('sessionOrders' in body) {
      const incoming = normalizeSessionOrders(body.sessionOrders)
      const incomingAt = normalizeIso(body.sessionOrdersUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.sessionOrdersUpdatedAt)) {
        next.sessionOrders = incoming
        next.sessionOrdersUpdatedAt = incomingAt
      }
    }
    if ('snippets' in body) {
      const incoming = normalizeSnippets(body.snippets)
      const incomingAt = normalizeIso(body.snippetsUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.snippetsUpdatedAt)) {
        next.snippets = incoming
        next.snippetsUpdatedAt = incomingAt
      }
    }
    if ('favorites' in body) {
      const incoming = normalizeBookmarkFavorites(body.favorites)
      const incomingAt = normalizeIso(body.favoritesUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.favoritesUpdatedAt)) {
        next.favorites = incoming
        next.favoritesUpdatedAt = incomingAt
      }
    }
    if ('uiPreferences' in body) {
      const incoming = normalizeUiPreferences(body.uiPreferences)
      const incomingAt = normalizeIso(body.uiPreferencesUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.uiPreferencesUpdatedAt)) {
        next.uiPreferences = { ...next.uiPreferences, ...incoming }
        next.uiPreferencesUpdatedAt = incomingAt
      }
    }
    if ('uploadRateLimitKBps' in body) next.uploadRateLimitKBps = normalizeUploadRateLimitKBps(body.uploadRateLimitKBps)
    if ('downloadRateLimitKBps' in body) next.downloadRateLimitKBps = normalizeUploadRateLimitKBps(body.downloadRateLimitKBps)
    next.updatedAt = new Date(Math.max(
      parseIsoMs(next.customShortcutsUpdatedAt), parseIsoMs(next.favoriteDirectoriesUpdatedAt),
      parseIsoMs(next.sessionOrdersUpdatedAt), parseIsoMs(next.snippetsUpdatedAt),
      parseIsoMs(next.favoritesUpdatedAt), parseIsoMs(next.uiPreferencesUpdatedAt),
    )).toISOString()
    try {
      await writeStore(profile, next)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save preferences'
      return reply.code(413).send({ message, code: 'PREFERENCES_TOO_LARGE' })
    }
    return next
  })
}
