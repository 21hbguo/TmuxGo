import { getApiBase } from './runtime-endpoints'
import type { CustomShortcut, FavoriteDirectory, FileContentMatch, FileContentResponse, FileItem, FileListResponse, FilePreviewResponse, FileRoot, FileUploadTarget, RemotePreferences, UploadJobResult, UploadedFile } from '@/types'

export interface StreamSystemInfo {
  outputBytes: number
  outputChunks: number
  outputFlushes: number
  sanitizeCalls: number
  sanitizeChars: number
  attachRequests: number
  resizeRequests: number
  inputMessages: number
  backpressureSignals: number
  profileUpdates: number
  activeClients: number
  activeProfile: 'foreground' | 'background' | 'mobile'
  activeFlushInterval: number
  activeMaxChars: number
}
export interface SystemInfoResponse {
  gpu: { used: number; total: number } | null
  cpu: number
  mem: { used: number; total: number }
  disks: { mount: string; used: number; total: number }[]
  stream: StreamSystemInfo
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData
  const headers = isFormData ? { ...options?.headers } : {
    'Content-Type': 'application/json',
    ...options?.headers,
  }
  const response = await fetch(url, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed', code: 'REQUEST_FAILED' }))
    const e = new Error(error.message || `HTTP ${response.status}`) as Error & { status?: number; code?: string }
    e.status = response.status
    e.code = error.code || 'REQUEST_FAILED'
    throw e
  }

  const data = await response.json()
  if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
    const e = new Error((data as { error?: string }).error || 'Request failed') as Error & { code?: string }
    e.code = 'REQUEST_FAILED'
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
function uploadWithProgress(body: FormData, onProgress?: (loadedBytes: number, totalBytes: number) => void): Promise<UploadJobResult> {
  const url = `${getApiBase()}/api/files/upload`
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
  snapshot: {
    get: (hostId: string, sessionId: string) => fetchApi<{ sessionId: string; sessionName: string; windows: any[]; panes: any[]; activeWindowId: string | null; activePaneId: string | null }>(`/api/hosts/${hostId}/sessions/${sessionId}/snapshot`),
  },
  hosts: {
    list: () => fetchApi<any[]>('/api/hosts'),
    get: (id: string) => fetchApi<any>(`/api/hosts/${id}`),
  },
  sessions: {
    list: (hostId: string) => fetchApi<any[]>(`/api/hosts/${hostId}/sessions`),
    create: (hostId: string, name: string, layout?: { windows: { name: string; panes: { command?: string }[] }[] }) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ name, layout }),
      }),
    rename: (hostId: string, sessionId: string, name: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/rename`, {
        method: 'POST',
        body: JSON.stringify({ sessionId, name }),
      }),
    delete: (hostId: string, sessionId: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions/${sessionId}`, {
        method: 'DELETE',
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
    kill: (paneId?: string) =>
      fetchApi<any>('/api/panes/kill', {
        method: 'POST',
        body: JSON.stringify({ paneId }),
      }),
  },
  system: {
    info: () => fetchApi<SystemInfoResponse>('/api/system'),
  },
  files: {
    roots: () => fetchApi<FileRoot[]>('/api/files/roots'),
    list: (root: string, path = '') => fetchApi<FileListResponse>(`/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    preview: (root: string, path: string, line = 1) => fetchApi<FilePreviewResponse>(`/api/files/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&line=${line}`),
    content: (root: string, path: string) => fetchApi<FileContentResponse>(`/api/files/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    saveContent: (root: string, path: string, content: string, modifiedAt?: string) => fetchApi<{ ok: true; content: string; modifiedAt: string; size: number }>(`/api/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ root, path, content, modifiedAt }),
    }),
    searchName: (root: string, q: string, basePath = '') => fetchApi<FileItem[]>(`/api/files/search-name?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&basePath=${encodeURIComponent(basePath)}`),
    searchContent: (root: string, q: string, basePath = '') => fetchApi<FileContentMatch[]>(`/api/files/search-content?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&basePath=${encodeURIComponent(basePath)}`),
    defaultUploadTarget: (paneId?: string) => fetchApi<FileUploadTarget>(`/api/files/default-upload-target${paneId ? `?paneId=${encodeURIComponent(paneId)}` : ''}`),
    upload: (body: FormData, onProgress?: (loadedBytes: number, totalBytes: number) => void) => uploadWithProgress(body, onProgress),
  },
  preferences: {
    get: (profile = 'default') => fetchApi<RemotePreferences>(`/api/preferences?profile=${encodeURIComponent(profile)}`),
    update: (payload: { customShortcuts?: CustomShortcut[]; customShortcutsUpdatedAt?: string; favoriteDirectories?: FavoriteDirectory[]; favoriteDirectoriesUpdatedAt?: string }, profile = 'default') =>
      fetchApi<RemotePreferences>(`/api/preferences?profile=${encodeURIComponent(profile)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
  },
}
