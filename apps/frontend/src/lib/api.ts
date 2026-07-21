import { getApiBase } from './runtime-endpoints'
import { buildSessionId } from './session-id'
import type { AuditEvent, CustomShortcut, FavoriteDirectory, FavoriteItem, FileContentMatch, FileContentResponse, FileItem, FileListResponse, FilePreviewResponse, FileRoot, FileUploadTarget, GitBranchesResponse, GitCommitResponse, GitDetectResponse, GitDiffResponse, GitDiffStatsResponse, GitHostState, GitLogResponse, GitMergeResponse, GitRepositoryInfo, GitStatusResponse, RemotePreferences, SessionArchive, SessionArchivePolicy, SessionArchiveSummary, SessionContinuityConfig, SessionLayout, SessionOrderPreference, SessionTemplate, SessionThumbnail, Snippet, TrashEntry, UiPreferences, UploadJobResult, UploadedFile } from '@/types'

export interface StreamSystemInfo {
  outputBytes: number
  outputChunks: number
  outputFlushes: number
  outputResyncRequests: number
  outputResyncCompleted: number
  droppedOutputChars: number
  sanitizeCalls: number
  sanitizeChars: number
  attachRequests: number
  snapshotRequests: number
  resizeRequests: number
  inputMessages: number
  backpressureSignals: number
  profileUpdates: number
  deferredFlushes: number
  socketBufferedBytes: number
  activeClients: number
  activeProfile: 'foreground' | 'background' | 'mobile'
  activeFlushInterval: number
  activeMaxChars: number
}
export interface SystemInfoResponse {
  hostId: string
  gpu: { used: number; total: number } | null
  cpu: number
  mem: { used: number; total: number }
  disks: { mount: string; used: number; total: number }[]
  dependencies: { tmux: boolean; git: boolean; python: boolean; rg: boolean; sshpass: boolean }
  stream: StreamSystemInfo
}
export interface RestartRebuildTaskResponse {
  status: 'idle' | 'running' | 'success' | 'error'
  startedAt: string | null
  finishedAt: string | null
  summaryLines: string[]
  exitCode: number | null
  errorMessage: string | null
}
export interface BatchDeleteSessionFilters {
  createdBefore?: string
  inactiveBefore?: string
  nameIncludes?: string
  includeAttached?: boolean
}
export interface BatchDeleteSessionsRequest {
  mode?: 'preview' | 'execute'
  sessionIds?: string[]
  filters?: BatchDeleteSessionFilters
  limit?: number
  force?: boolean
}
export interface BatchDeleteSessionItem {
  sessionId: string
  name: string
  createdAt?: string
  lastActiveAt?: string
  windowCount?: number
  attached?: boolean
  reason?: string
}
export interface BatchDeleteSessionsResponse {
  mode: 'preview' | 'execute'
  limit: number
  forceRequired?: boolean
  forceUsed?: boolean
  matchedCount?: number
  deletableCount?: number
  deleteCount?: number
  attemptedCount?: number
  deletedCount?: number
  failedCount?: number
  skipped?: BatchDeleteSessionItem[]
  sessions?: BatchDeleteSessionItem[]
  deleted?: BatchDeleteSessionItem[]
  failed?: BatchDeleteSessionItem[]
}
export interface HostPayload {
  id: string
  name?: string
  address: string
  user: string
  port?: number
  password?: string
  passwordEnv?: string
}
async function readResponseBody(response: Response) {
  if (typeof response.text === 'function') {
    const raw = await response.text()
    if (!raw.trim()) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (typeof response.json === 'function') return response.json().catch(() => undefined)
  return undefined
}
async function listHostSessions(hostId: string) {
  const sessions = await fetchApi<any[]>(`/api/hosts/${hostId}/sessions`)
  return Array.isArray(sessions) ? sessions : []
}
async function findHostSessionByName(hostId: string, name: string) {
  const sessions = await listHostSessions(hostId)
  return sessions.find((item) => item?.name === name) || null
}
function buildSessionFallback(hostId: string, name: string, session?: any) {
  return {
    id: buildSessionId(hostId, name),
    hostId,
    name,
    createdAt: session?.createdAt || new Date().toISOString(),
    lastActiveAt: session?.lastActiveAt || new Date().toISOString(),
    windowCount: typeof session?.windowCount === 'number' ? session.windowCount : 1,
    attached: !!session?.attached,
    ...session,
  }
}
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData
  const hasBody = options?.body !== undefined && options?.body !== null
  const headers = new Headers(options?.headers)
  if (!isFormData && hasBody && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, {
    ...options,
    headers,
  })
  const data = await readResponseBody(response)
  if (!response.ok) {
    if (typeof data === 'string') throw parseApiError(response.status, data)
    const error = data && typeof data === 'object' ? data as { message?: string; code?: string } : { message: 'Request failed', code: 'REQUEST_FAILED' }
    const e = new Error(error.message || `HTTP ${response.status}`) as Error & { status?: number; code?: string }
    e.status = response.status
    e.code = error.code || 'REQUEST_FAILED'
    throw e
  }
  if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
    const body = data as { error?: string; message?: string; code?: string }
    const e = new Error(body.error || body.message || 'Request failed') as Error & { code?: string }
    e.code = body.code || 'REQUEST_FAILED'
    throw e
  }
  return data
}
function parseApiError(status: number, raw: string) {
  let message = `HTTP ${status}`
  let code = 'REQUEST_FAILED'
  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') {
      if ('message' in data && typeof data.message === 'string' && data.message) message = data.message
      if ('code' in data && typeof data.code === 'string' && data.code) code = data.code
      if ('ok' in data && data.ok === false && 'error' in data && typeof data.error === 'string' && data.error) message = data.error
    }
  } catch {
    if (raw.trim()) message = raw.trim()
  }
  const error = new Error(message) as Error & { status?: number; code?: string }
  error.status = status
  error.code = code
  return error
}
function uploadWithProgress(hostId: string, body: FormData, onProgress?: (loadedBytes: number, totalBytes: number) => void): Promise<UploadJobResult> {
  const url = `${getApiBase()}/api/hosts/${encodeURIComponent(hostId)}/files/upload`
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url, true)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onProgress?.(event.loaded, event.total)
    }
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(parseApiError(xhr.status, xhr.responseText || ''))
        return
      }
      try {
        const data = JSON.parse(xhr.responseText || '{}')
        if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
          reject(parseApiError(xhr.status, xhr.responseText || ''))
          return
        }
        resolve(data as UploadJobResult)
      } catch {
        reject(new Error('Invalid server response'))
      }
    }
    xhr.send(body)
  })
}

export const api = {
  sessionArchives: {
    list: (hostId: string, sessionId?: string) => fetchApi<{ archives: SessionArchiveSummary[] }>(`/api/hosts/${encodeURIComponent(hostId)}/session-archives${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
    get: (hostId: string, archiveId: string) => fetchApi<SessionArchive>(`/api/hosts/${encodeURIComponent(hostId)}/session-archives/${encodeURIComponent(archiveId)}`),
    capture: (hostId: string, sessionId: string, policy: SessionArchivePolicy) => fetchApi<SessionArchiveSummary>(`/api/hosts/${encodeURIComponent(hostId)}/session-archives`, { method: 'POST', body: JSON.stringify({ sessionId, captureMode: policy.captureMode, maxBytesPerSession: policy.maxBytesPerSession, retentionDays: policy.retentionDays }) }),
    remove: (hostId: string, archiveId: string) => fetchApi<{ ok: true }>(`/api/hosts/${encodeURIComponent(hostId)}/session-archives/${encodeURIComponent(archiveId)}`, { method: 'DELETE' }),
  },
  sessionTemplates: {
    list: () => fetchApi<{ templates: SessionTemplate[] }>('/api/session-templates'),
    update: (templates: SessionTemplate[]) => fetchApi<{ templates: SessionTemplate[] }>('/api/session-templates', { method: 'PUT', body: JSON.stringify({ templates }) }),
  },
  audit: {
    list: (options: { limit?: number; action?: string; result?: 'success' | 'failure'; hostId?: string } = {}) => {
      const params = new URLSearchParams()
      if (options.limit) params.set('limit', String(options.limit))
      if (options.action) params.set('action', options.action)
      if (options.result) params.set('result', options.result)
      if (options.hostId) params.set('hostId', options.hostId)
      return fetchApi<{ events: AuditEvent[] }>(`/api/audit-log${params.size ? `?${params}` : ''}`)
    },
  },
  snapshot: {
    get: (hostId: string, sessionId: string) => fetchApi<{ sessionId: string; sessionName: string; windows: any[]; panes: any[]; activeWindowId: string | null; activePaneId: string | null }>(`/api/hosts/${hostId}/sessions/${sessionId}/snapshot`),
  },
  hosts: {
    list: () => fetchApi<any[]>('/api/hosts'),
    get: (id: string) => fetchApi<any>(`/api/hosts/${id}`),
    create: (payload: HostPayload) =>
      fetchApi<any>('/api/hosts', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    remove: (id: string) =>
      fetchApi<{ success: boolean }>(`/api/hosts/${id}`, {
        method: 'DELETE',
      }),
    test: (id: string) =>
      fetchApi<{ ok: boolean; message: string; mode: 'local' | 'key' | 'password' }>(`/api/hosts/${id}/test`, {
        method: 'POST',
      }),
    githubAuthStatus: (id: string) =>
      fetchApi<{ ok: boolean; available: boolean; loggedIn: boolean | null }>(`/api/hosts/${encodeURIComponent(id)}/github/auth-status`),
  },
  sessions: {
    list: (hostId: string) => fetchApi<any[]>(`/api/hosts/${hostId}/sessions`),
    thumbnails: (hostId: string) => fetchApi<{ sessions: SessionThumbnail[] }>(`/api/hosts/${hostId}/session-thumbnails`),
    create: async (hostId: string, name: string, layout?: SessionLayout) => {
      try {
        const created = await fetchApi<any>(`/api/hosts/${hostId}/sessions`, {
          method: 'POST',
          body: JSON.stringify({ name, layout }),
        })
        if (created?.id) return created
        const existing = await findHostSessionByName(hostId, name).catch(() => null)
        return existing || buildSessionFallback(hostId, name, created)
      } catch (error) {
        const existing = await findHostSessionByName(hostId, name).catch(() => null)
        if (existing) return existing
        throw error
      }
    },
    rename: async (hostId: string, sessionId: string, name: string) => {
      try {
        const renamed = await fetchApi<any>(`/api/hosts/${hostId}/sessions/rename`, {
          method: 'POST',
          body: JSON.stringify({ sessionId, name }),
        })
        if (renamed?.id) return renamed
        const existing = await findHostSessionByName(hostId, name).catch(() => null)
        return existing || buildSessionFallback(hostId, name, renamed)
      } catch (error) {
        const existing = await findHostSessionByName(hostId, name).catch(() => null)
        if (existing) return existing
        throw error
      }
    },
    delete: async (hostId: string, sessionId: string) => {
      try {
        const removed = await fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}`, {
          method: 'DELETE',
        })
        return removed && typeof removed === 'object' ? removed : { success: true, sessionId }
      } catch (error) {
        const sessions = await listHostSessions(hostId).catch(() => null)
        if (sessions && !sessions.some((item) => item?.id === sessionId)) return { success: true, sessionId }
        throw error
      }
    },
    batchDelete: (hostId: string, payload: BatchDeleteSessionsRequest) =>
      fetchApi<BatchDeleteSessionsResponse>(`/api/hosts/${hostId}/sessions/batch-delete`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },
  windows: {
    list: (hostId: string, sessionId: string) =>
      fetchApi<any[]>(`/api/hosts/${hostId}/sessions/${sessionId}/windows`),
    create: (hostId: string, sessionId: string, name: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}/windows`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    select: (hostId: string, sessionId: string, windowId: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}/windows/select`, {
        method: 'POST',
        body: JSON.stringify({ windowId }),
      }),
    rename: (hostId: string, sessionId: string, windowId: string, name: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}/windows/rename`, {
        method: 'POST',
        body: JSON.stringify({ windowId, name }),
      }),
    move: (hostId: string, sessionId: string, orderedWindowIds: string[]) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}/windows/move`, {
        method: 'POST',
        body: JSON.stringify({ orderedWindowIds }),
      }),
    kill: (hostId: string, sessionId: string, windowId: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}/windows/kill`, {
        method: 'POST',
        body: JSON.stringify({ windowId }),
      }),
  },
  panes: {
    list: (windowId: string) => fetchApi<any[]>(`/api/windows/${windowId}/panes`),
    listBySession: (hostId: string, sessionId: string) =>
      fetchApi<any[]>(`/api/hosts/${hostId}/sessions/${sessionId}/panes`),
    output: (paneId: string) => fetchApi<{ paneId: string; tmuxPaneId?: string; data: string }>(`/api/panes/${encodeURIComponent(paneId)}/output`),
    create: (windowId: string, direction: 'horizontal' | 'vertical') =>
      fetchApi<any>(`/api/windows/${windowId}/panes`, {
        method: 'POST',
        body: JSON.stringify({ direction }),
      }),
    zoom: (session?: string) =>
      fetchApi<any>('/api/panes/zoom', {
        method: 'POST',
        body: JSON.stringify({ paneId: session }),
      }),
    select: (paneId: string) =>
      fetchApi<any>('/api/panes/select', {
        method: 'POST',
        body: JSON.stringify({ paneId }),
      }),
    split: (paneId: string, direction: 'horizontal' | 'vertical') =>
      fetchApi<any>('/api/panes/split', {
        method: 'POST',
        body: JSON.stringify({ paneId, direction }),
      }),
    zoomByPane: (paneId: string) =>
      fetchApi<any>('/api/panes/zoom', {
        method: 'POST',
        body: JSON.stringify({ paneId }),
      }),
    resize: (paneId: string, size: { cols?: number; rows?: number }) =>
      fetchApi<any>('/api/panes/resize', {
        method: 'POST',
        body: JSON.stringify({ paneId, ...size }),
      }),
    kill: (paneId?: string) =>
      fetchApi<any>('/api/panes/kill', {
        method: 'POST',
        body: JSON.stringify({ paneId }),
      }),
  },
  system: {
    info: (hostId = 'local') => fetchApi<SystemInfoResponse>(`/api/hosts/${encodeURIComponent(hostId)}/system`),
    restartRebuildStatus: () => fetchApi<RestartRebuildTaskResponse>('/api/system/restart-rebuild'),
    restartRebuild: () => fetchApi<RestartRebuildTaskResponse>('/api/system/restart-rebuild', { method: 'POST' }),
  },
  files: {
    roots: (hostId: string) => fetchApi<FileRoot[]>(`/api/hosts/${encodeURIComponent(hostId)}/files/roots`),
    list: (hostId: string, root: string, path = '') => fetchApi<FileListResponse>(`/api/hosts/${encodeURIComponent(hostId)}/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    preview: (hostId: string, root: string, path: string, line = 1) => fetchApi<FilePreviewResponse>(`/api/hosts/${encodeURIComponent(hostId)}/files/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&line=${line}`),
    content: (hostId: string, root: string, path: string) => fetchApi<FileContentResponse>(`/api/hosts/${encodeURIComponent(hostId)}/files/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    saveContent: (hostId: string, root: string, path: string, content: string, modifiedAt?: string) => fetchApi<{ ok: true; content: string; modifiedAt: string; size: number }>(`/api/hosts/${encodeURIComponent(hostId)}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ root, path, content, modifiedAt }),
    }),
    createFile: (hostId: string, root: string, path: string, name: string) => fetchApi<{ ok: true; item: FileItem; parentPath: string }>(`/api/hosts/${encodeURIComponent(hostId)}/files/create-file`, {
      method: 'POST',
      body: JSON.stringify({ root, path, name }),
    }),
    createDirectory: (hostId: string, root: string, path: string, name: string) => fetchApi<{ ok: true; item: FileItem; parentPath: string }>(`/api/hosts/${encodeURIComponent(hostId)}/files/create-directory`, {
      method: 'POST',
      body: JSON.stringify({ root, path, name }),
    }),
    rename: (hostId: string, root: string, path: string, name: string) => fetchApi<{ ok: true; item: FileItem; previousPath: string }>(`/api/hosts/${encodeURIComponent(hostId)}/files/rename`, {
      method: 'POST',
      body: JSON.stringify({ root, path, name }),
    }),
    copy: (hostId: string, root: string, path: string, targetRoot: string, targetPath: string) => fetchApi<{ ok: true; item: FileItem; previousPath: string }>(`/api/hosts/${encodeURIComponent(hostId)}/files/copy`, { method: 'POST', body: JSON.stringify({ root, path, targetRoot, targetPath }) }),
    move: (hostId: string, root: string, path: string, targetRoot: string, targetPath: string) => fetchApi<{ ok: true; item: FileItem; previousPath: string }>(`/api/hosts/${encodeURIComponent(hostId)}/files/move`, { method: 'POST', body: JSON.stringify({ root, path, targetRoot, targetPath }) }),
    trash: (hostId: string, root: string, path: string) => fetchApi<{ ok: true; entry: TrashEntry }>(`/api/hosts/${encodeURIComponent(hostId)}/files/trash`, { method: 'POST', body: JSON.stringify({ root, path }) }),
    trashEntries: (hostId: string) => fetchApi<{ entries: TrashEntry[] }>(`/api/hosts/${encodeURIComponent(hostId)}/files/trash`),
    restore: (hostId: string, trashId: string) => fetchApi<{ ok: true; item: FileItem }>(`/api/hosts/${encodeURIComponent(hostId)}/files/restore`, { method: 'POST', body: JSON.stringify({ trashId }) }),
    remove: (hostId: string, root: string, path: string) => fetchApi<{ ok: true; path: string; type: 'file' | 'directory' }>(`/api/hosts/${encodeURIComponent(hostId)}/files/remove?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
    searchName: (hostId: string, root: string, q: string, basePath = '', includeDotFiles = true) => fetchApi<FileItem[]>(`/api/hosts/${encodeURIComponent(hostId)}/files/search-name?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&basePath=${encodeURIComponent(basePath)}&includeDotFiles=${includeDotFiles ? 'true' : 'false'}`),
    searchContent: (hostId: string, root: string, q: string, basePath = '', includeDotFiles = true) => fetchApi<FileContentMatch[]>(`/api/hosts/${encodeURIComponent(hostId)}/files/search-content?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&basePath=${encodeURIComponent(basePath)}&includeDotFiles=${includeDotFiles ? 'true' : 'false'}`),
    defaultUploadTarget: (hostId: string, paneId?: string) => fetchApi<FileUploadTarget>(`/api/hosts/${encodeURIComponent(hostId)}/files/default-upload-target${paneId ? `?paneId=${encodeURIComponent(paneId)}` : ''}`),
    temporaryUploadTarget: (hostId: string) => fetchApi<FileUploadTarget>(`/api/hosts/${encodeURIComponent(hostId)}/files/temporary-upload-target`),
    upload: (hostId: string, body: FormData, onProgress?: (loadedBytes: number, totalBytes: number) => void) => uploadWithProgress(hostId, body, onProgress),
    downloadUrl: (hostId: string, root: string, path: string, rateLimitKBps?: number, profile = 'default') => `${getApiBase()}/api/hosts/${encodeURIComponent(hostId)}/files/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&profile=${encodeURIComponent(profile)}${typeof rateLimitKBps === 'number' ? `&rateLimitKBps=${encodeURIComponent(String(rateLimitKBps))}` : ''}`,
    imageUrl: (hostId: string, root: string, path: string, modifiedAt?: string) => `${getApiBase()}/api/hosts/${encodeURIComponent(hostId)}/files/image?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${modifiedAt ? `&modifiedAt=${encodeURIComponent(modifiedAt)}` : ''}`,
  },
  preferences: {
    get: (profile = 'default') => fetchApi<RemotePreferences>(`/api/preferences?profile=${encodeURIComponent(profile)}`),
    update: (payload: { customShortcuts?: CustomShortcut[]; customShortcutsUpdatedAt?: string; favoriteDirectories?: FavoriteDirectory[]; favoriteDirectoriesUpdatedAt?: string; sessionOrders?: SessionOrderPreference[]; sessionOrdersUpdatedAt?: string; snippets?: Snippet[]; snippetsUpdatedAt?: string; favorites?: FavoriteItem[]; favoritesUpdatedAt?: string; sessionContinuity?: SessionContinuityConfig; sessionContinuityUpdatedAt?: string; gitByHost?: Record<string, GitHostState>; gitByHostUpdatedAt?: string; uiPreferences?: UiPreferences; uiPreferencesUpdatedAt?: string; uploadRateLimitKBps?: number; downloadRateLimitKBps?: number }, profile = 'default') =>
      fetchApi<RemotePreferences>(`/api/preferences?profile=${encodeURIComponent(profile)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
  },
  git: {
    repositories: (hostId: string) =>
      fetchApi<GitRepositoryInfo[]>(`/api/hosts/${hostId}/git/repositories`),
    detect: (hostId: string, path: string) =>
      fetchApi<GitDetectResponse>(`/api/hosts/${hostId}/git/detect?path=${encodeURIComponent(path)}`),
    detectFromPane: (hostId: string, paneId: string) =>
      fetchApi<GitDetectResponse>(`/api/hosts/${hostId}/git/detect?paneId=${encodeURIComponent(paneId)}`),
    status: (hostId: string, path: string) =>
      fetchApi<GitStatusResponse>(`/api/hosts/${hostId}/git/status?path=${encodeURIComponent(path)}`),
    diff: (hostId: string, path: string, options?: { filePath?: string; staged?: boolean; commit?: string; workingTree?: boolean; untracked?: boolean }) => {
      const params = new URLSearchParams({ path })
      if (options?.filePath) params.set('filePath', options.filePath)
      if (options?.staged) params.set('staged', 'true')
      if (options?.commit) params.set('commit', options.commit)
      if (options?.workingTree) params.set('workingTree', 'true')
      if (options?.untracked) params.set('untracked', 'true')
      return fetchApi<GitDiffResponse>(`/api/hosts/${hostId}/git/diff?${params}`)
    },
    diffStats: (hostId: string, path: string, base: string, head: string) =>
      fetchApi<GitDiffStatsResponse>(`/api/hosts/${hostId}/git/diff-stats?path=${encodeURIComponent(path)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`),
    stage: (hostId: string, path: string, filePaths: string[]) =>
      fetchApi<{ ok: true }>(`/api/hosts/${hostId}/git/stage`, { method: 'POST', body: JSON.stringify({ path, filePaths }) }),
    unstage: (hostId: string, path: string, filePaths: string[]) =>
      fetchApi<{ ok: true }>(`/api/hosts/${hostId}/git/unstage`, { method: 'POST', body: JSON.stringify({ path, filePaths }) }),
    commit: (hostId: string, path: string, message: string, amend?: boolean) =>
      fetchApi<GitCommitResponse>(`/api/hosts/${hostId}/git/commit`, { method: 'POST', body: JSON.stringify({ path, message, amend }) }),
    discard: (hostId: string, path: string, filePaths: string[]) =>
      fetchApi<{ ok: true }>(`/api/hosts/${hostId}/git/discard`, { method: 'POST', body: JSON.stringify({ path, filePaths }) }),
    resolve: (hostId: string, path: string, filePath: string, resolution: 'ours' | 'theirs' | 'mark') =>
      fetchApi<{ ok: true; filePath: string; resolution: string }>(`/api/hosts/${hostId}/git/resolve`, { method: 'POST', body: JSON.stringify({ path, filePath, resolution }) }),
    operation: (hostId: string, path: string, operation: 'merge' | 'rebase', action: 'continue' | 'abort') =>
      fetchApi<{ ok: true; operation: string; action: string; message: string }>(`/api/hosts/${hostId}/git/operation`, { method: 'POST', body: JSON.stringify({ path, operation, action }) }),
    log: (hostId: string, path: string, options?: { limit?: number; skip?: number }) => {
      const params = new URLSearchParams({ path })
      if (options?.limit) params.set('limit', String(options.limit))
      if (options?.skip) params.set('skip', String(options.skip))
      return fetchApi<GitLogResponse>(`/api/hosts/${hostId}/git/log?${params}`)
    },
    branches: (hostId: string, path: string) =>
      fetchApi<GitBranchesResponse>(`/api/hosts/${hostId}/git/branches?path=${encodeURIComponent(path)}`),
    checkout: (hostId: string, path: string, branch: string) =>
      fetchApi<{ ok: true; branch: string }>(`/api/hosts/${hostId}/git/checkout`, { method: 'POST', body: JSON.stringify({ path, branch }) }),
    createBranch: (hostId: string, path: string, name: string, startPoint?: string) =>
      fetchApi<{ ok: true; branch: string }>(`/api/hosts/${hostId}/git/create-branch`, { method: 'POST', body: JSON.stringify({ path, name, startPoint }) }),
    deleteBranch: (hostId: string, path: string, name: string, force?: boolean) =>
      fetchApi<{ ok: true }>(`/api/hosts/${hostId}/git/delete-branch`, { method: 'POST', body: JSON.stringify({ path, name, force }) }),
    merge: (hostId: string, path: string, branch: string, noFF?: boolean) =>
      fetchApi<GitMergeResponse>(`/api/hosts/${hostId}/git/merge`, { method: 'POST', body: JSON.stringify({ path, branch, noFF }) }),
    fetch: (hostId: string, path: string, options?: { remote?: string; prune?: boolean }) =>
      fetchApi<{ ok: true; message: string }>(`/api/hosts/${hostId}/git/fetch`, { method: 'POST', body: JSON.stringify({ path, ...options }) }),
    pull: (hostId: string, path: string, options?: { remote?: string; branch?: string; rebase?: boolean }) =>
      fetchApi<{ ok: boolean; conflicts: boolean; message: string }>(`/api/hosts/${hostId}/git/pull`, { method: 'POST', body: JSON.stringify({ path, ...options }) }),
    push: (hostId: string, path: string, options?: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }) =>
      fetchApi<{ ok: boolean; rejected: boolean; message: string }>(`/api/hosts/${hostId}/git/push`, { method: 'POST', body: JSON.stringify({ path, ...options }) }),
    remotes: (hostId: string, path: string) =>
      fetchApi<{ remotes: { name: string; fetchUrl: string; pushUrl: string }[] }>(`/api/hosts/${hostId}/git/remotes?path=${encodeURIComponent(path)}`),
  },
}
