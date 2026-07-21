import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'

type CustomShortcut = { id: string; label: string; keys: string }
type FavoriteDirectory = { rootId: string; rootPath: string; name: string; path: string }
type SessionOrder = { hostId: string; orderedSessionIds: string[] }
type Snippet = { id: string; name: string; command: string; description?: string; category?: string }
type FavoriteItem = { id: string; type: 'host' | 'session' | 'pane'; name: string; target: string; addedAt: string }
type GitMode = 'follow-editor' | 'locked'
type GitSource = 'editor' | 'pane' | 'manual' | null
type GitRepoEntry = { repoPath: string; label: string; lastUsedAt: number; pinned: boolean }
type GitHostState = { mode: GitMode; currentRepoPath: string | null; currentFilePath: string | null; source: GitSource; lockedRepoPath: string | null; recentRepos: GitRepoEntry[] }
type SessionResumePoint = {
  hostId: string
  sessionId: string
  sessionName: string
  windowId: string | null
  paneId: string | null
  cols: number
  rows: number
  exclusive: boolean
  lastSeenAt: string
  lastOutputAt: string
}
type SessionArchivePolicy = {
  enabled: boolean
  captureMode: 'none' | 'visible' | 'history'
  maxBytesPerSession: number
  retentionDays: number
}
type SessionContinuity = {
  enabled: boolean
  syncToServer: boolean
  resumeOnReconnect: boolean
  resumeOnNewDevice: boolean
  maxResumePoints: number
  archive: SessionArchivePolicy
  resumePoints: SessionResumePoint[]
  updatedAt: string
}
type UiPreferences = {
  theme?: string
  fontSize?: number
  fontFamily?: string
  cursorBlink?: boolean
  sidebarPosition?: string
  showStatusBar?: boolean
  showQuickActions?: boolean
  agentNotificationsEnabled?: boolean
  agentNotificationDurationMs?: number
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
  sessionContinuity: SessionContinuity
  sessionContinuityUpdatedAt: string
  gitByHost: Record<string, GitHostState>
  gitByHostUpdatedAt: string
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
const MAX_RESUME_POINTS = 200
const MAX_GIT_HOSTS = 64
const MAX_GIT_RECENT_REPOS = 12
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
const MAX_SESSION_NAME_LEN = 128
const MAX_WINDOW_ID_LEN = 128
const MAX_PANE_ID_LEN = 128
const MAX_SNIPPET_NAME_LEN = 128
const MAX_SNIPPET_COMMAND_LEN = 4096
const MAX_SNIPPET_DESC_LEN = 512
const MAX_SNIPPET_CATEGORY_LEN = 64
const MAX_FAVORITE_TARGET_LEN = 1024
const VALID_THEMES = ['dark', 'light', 'high-contrast', 'dracula', 'nord', 'catppuccin']
const VALID_SIDEBAR = ['left', 'right']
const VALID_LANGUAGE = ['zh', 'en']
const VALID_CAPTURE_MODES = ['none', 'visible', 'history']
const DEFAULT_UPLOAD_RATE_LIMIT_KBPS = 200
const MAX_UPLOAD_RATE_LIMIT_KBPS = 10 * 1024
const PROFILE_RE = /^[a-zA-Z0-9_-]+$/
const STORAGE_DIR = process.env.TMUXGO_PREFERENCES_DIR || path.join(os.homedir(), '.tmuxgo', 'preferences')

function nowIso() {
  return new Date().toISOString()
}
function getDefaultSessionArchivePolicy(): SessionArchivePolicy {
  return {
    enabled: false,
    captureMode: 'none',
    maxBytesPerSession: 256 * 1024,
    retentionDays: 7,
  }
}
function getDefaultSessionContinuity(): SessionContinuity {
  const now = nowIso()
  return {
    enabled: true,
    syncToServer: true,
    resumeOnReconnect: true,
    resumeOnNewDevice: true,
    maxResumePoints: 20,
    archive: getDefaultSessionArchivePolicy(),
    resumePoints: [],
    updatedAt: now,
  }
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
    sessionContinuity: getDefaultSessionContinuity(),
    sessionContinuityUpdatedAt: now,
    gitByHost: {},
    gitByHostUpdatedAt: now,
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
function normalizeInt(input: unknown, fallback: number, min: number, max: number) {
  const value = typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : NaN
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
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
function normalizeSessionArchivePolicy(input: unknown): SessionArchivePolicy {
  const fallback = getDefaultSessionArchivePolicy()
  if (!input || typeof input !== 'object') return fallback
  const raw = input as Record<string, unknown>
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled
  const captureMode = typeof raw.captureMode === 'string' && VALID_CAPTURE_MODES.includes(raw.captureMode) ? raw.captureMode as 'none' | 'visible' | 'history' : fallback.captureMode
  const maxBytesPerSession = normalizeInt(raw.maxBytesPerSession, fallback.maxBytesPerSession, 0, 32 * 1024 * 1024)
  const retentionDays = normalizeInt(raw.retentionDays, fallback.retentionDays, 1, 3650)
  return { enabled, captureMode, maxBytesPerSession, retentionDays }
}
function normalizeSessionResumePoints(input: unknown, maxResumePoints: number) {
  if (!Array.isArray(input)) return []
  const dedup = new Map<string, SessionResumePoint>()
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const hostId = safeString(raw.hostId, MAX_ID_LEN)
    const sessionId = safeString(raw.sessionId, MAX_SESSION_ID_LEN)
    const sessionName = safeString(raw.sessionName, MAX_SESSION_NAME_LEN)
    if (!hostId || !sessionId || !sessionName) continue
    const windowIdRaw = safeString(raw.windowId, MAX_WINDOW_ID_LEN)
    const paneIdRaw = safeString(raw.paneId, MAX_PANE_ID_LEN)
    const cols = normalizeInt(raw.cols, 120, 2, 1000)
    const rows = normalizeInt(raw.rows, 36, 2, 1000)
    const exclusive = typeof raw.exclusive === 'boolean' ? raw.exclusive : true
    const lastSeenAt = normalizeIso(raw.lastSeenAt, nowIso())
    const lastOutputAt = normalizeIso(raw.lastOutputAt, lastSeenAt)
    dedup.set(`${hostId}:${sessionId}`, {
      hostId,
      sessionId,
      sessionName,
      windowId: windowIdRaw || null,
      paneId: paneIdRaw || null,
      cols,
      rows,
      exclusive,
      lastSeenAt,
      lastOutputAt,
    })
  }
  return [...dedup.values()]
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, Math.max(1, Math.min(MAX_RESUME_POINTS, maxResumePoints)))
}
function normalizeSessionContinuity(input: unknown): SessionContinuity {
  const fallback = getDefaultSessionContinuity()
  if (!input || typeof input !== 'object') return fallback
  const raw = input as Record<string, unknown>
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled
  const syncToServer = typeof raw.syncToServer === 'boolean' ? raw.syncToServer : fallback.syncToServer
  const resumeOnReconnect = typeof raw.resumeOnReconnect === 'boolean' ? raw.resumeOnReconnect : fallback.resumeOnReconnect
  const resumeOnNewDevice = typeof raw.resumeOnNewDevice === 'boolean' ? raw.resumeOnNewDevice : fallback.resumeOnNewDevice
  const maxResumePoints = normalizeInt(raw.maxResumePoints, fallback.maxResumePoints, 1, MAX_RESUME_POINTS)
  const archive = normalizeSessionArchivePolicy(raw.archive)
  const resumePoints = normalizeSessionResumePoints(raw.resumePoints, maxResumePoints)
  const updatedAt = normalizeIso(raw.updatedAt, fallback.updatedAt)
  return { enabled, syncToServer, resumeOnReconnect, resumeOnNewDevice, maxResumePoints, archive, resumePoints, updatedAt }
}
function normalizeGitRepoEntries(input: unknown) {
  if (!Array.isArray(input)) return []
  const next: GitRepoEntry[] = []
  const seen = new Set<string>()
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const repoPath = safeString(raw.repoPath, MAX_ROOT_PATH_LEN)
    if (!repoPath || seen.has(repoPath)) continue
    seen.add(repoPath)
    next.push({
      repoPath,
      label: safeString(raw.label, MAX_FAVORITE_NAME_LEN) || repoPath.split('/').filter(Boolean).pop() || repoPath,
      lastUsedAt: normalizeInt(raw.lastUsedAt, 0, 0, 8640000000000000),
      pinned: raw.pinned === true,
    })
    if (next.length >= MAX_GIT_RECENT_REPOS) break
  }
  return next
}
function normalizeGitHostState(input: unknown): GitHostState {
  if (!input || typeof input !== 'object') return { mode: 'follow-editor', currentRepoPath: null, currentFilePath: null, source: null, lockedRepoPath: null, recentRepos: [] }
  const raw = input as Record<string, unknown>
  const mode = raw.mode === 'locked' ? 'locked' : 'follow-editor'
  const currentRepoPath = safeString(raw.currentRepoPath, MAX_ROOT_PATH_LEN) || null
  const currentFilePath = safeString(raw.currentFilePath, MAX_ROOT_PATH_LEN) || null
  const source = raw.source === 'editor' || raw.source === 'pane' || raw.source === 'manual' ? raw.source : null
  const lockedRepoPath = safeString(raw.lockedRepoPath, MAX_ROOT_PATH_LEN) || null
  const recentRepos = normalizeGitRepoEntries(raw.recentRepos)
  return { mode, currentRepoPath, currentFilePath, source, lockedRepoPath, recentRepos }
}
function normalizeGitByHost(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const next: Record<string, GitHostState> = {}
  for (const [hostId, rawState] of Object.entries(input)) {
    const safeHostId = safeString(hostId, MAX_ID_LEN)
    if (!safeHostId) continue
    next[safeHostId] = normalizeGitHostState(rawState)
    if (Object.keys(next).length >= MAX_GIT_HOSTS) break
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
  if (typeof raw.agentNotificationsEnabled === 'boolean') result.agentNotificationsEnabled = raw.agentNotificationsEnabled
  if (typeof raw.agentNotificationDurationMs === 'number' && raw.agentNotificationDurationMs >= 1000 && raw.agentNotificationDurationMs <= 300000) result.agentNotificationDurationMs = raw.agentNotificationDurationMs
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
  const sessionContinuityUpdatedAt = normalizeIso(raw.sessionContinuityUpdatedAt, fallback.sessionContinuityUpdatedAt)
  const gitByHostUpdatedAt = normalizeIso(raw.gitByHostUpdatedAt, fallback.gitByHostUpdatedAt)
  const uiPreferencesUpdatedAt = normalizeIso(raw.uiPreferencesUpdatedAt, fallback.uiPreferencesUpdatedAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt, fallback.updatedAt)
  const updatedAt = new Date(Math.max(
    parseIsoMs(updatedAtRaw), parseIsoMs(customShortcutsUpdatedAt), parseIsoMs(favoriteDirectoriesUpdatedAt),
    parseIsoMs(sessionOrdersUpdatedAt), parseIsoMs(snippetsUpdatedAt), parseIsoMs(favoritesUpdatedAt),
    parseIsoMs(sessionContinuityUpdatedAt), parseIsoMs(gitByHostUpdatedAt), parseIsoMs(uiPreferencesUpdatedAt),
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
    sessionContinuity: normalizeSessionContinuity(raw.sessionContinuity),
    sessionContinuityUpdatedAt,
    gitByHost: normalizeGitByHost(raw.gitByHost),
    gitByHostUpdatedAt,
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
    if ('sessionContinuity' in body) {
      const incoming = normalizeSessionContinuity(body.sessionContinuity)
      const incomingAt = normalizeIso(body.sessionContinuityUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.sessionContinuityUpdatedAt)) {
        next.sessionContinuity = incoming
        next.sessionContinuityUpdatedAt = incomingAt
      }
    }
    if ('gitByHost' in body) {
      const incoming = normalizeGitByHost(body.gitByHost)
      const incomingAt = normalizeIso(body.gitByHostUpdatedAt, nowIso())
      if (parseIsoMs(incomingAt) >= parseIsoMs(current.gitByHostUpdatedAt)) {
        next.gitByHost = incoming
        next.gitByHostUpdatedAt = incomingAt
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
      parseIsoMs(next.favoritesUpdatedAt), parseIsoMs(next.sessionContinuityUpdatedAt), parseIsoMs(next.gitByHostUpdatedAt), parseIsoMs(next.uiPreferencesUpdatedAt),
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
