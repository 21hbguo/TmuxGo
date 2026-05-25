import { getApiBase } from './runtime-endpoints'
import type { FileContentMatch, FileItem, FileListResponse, FilePreviewResponse, FileRoot } from '@/types'

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
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
    info: () => fetchApi<{ gpu: { used: number; total: number } | null; cpu: number; mem: { used: number; total: number }; disks: { mount: string; used: number; total: number }[] }>('/api/system'),
  },
  files: {
    roots: () => fetchApi<FileRoot[]>('/api/files/roots'),
    list: (root: string, path = '') => fetchApi<FileListResponse>(`/api/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    preview: (root: string, path: string, line = 1) => fetchApi<FilePreviewResponse>(`/api/files/preview?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&line=${line}`),
    searchName: (root: string, q: string) => fetchApi<FileItem[]>(`/api/files/search-name?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`),
    searchContent: (root: string, q: string) => fetchApi<FileContentMatch[]>(`/api/files/search-content?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`),
  },
}
