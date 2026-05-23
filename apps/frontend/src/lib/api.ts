function getApiBase() {
  const envBase = process.env.NEXT_PUBLIC_API_URL
  if (envBase) {
    return envBase
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`
  }
  return 'http://localhost:3001'
}

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
    const error = await response.json().catch(() => ({ message: 'Request failed' }))
    throw new Error(error.message || `HTTP ${response.status}`)
  }

  return response.json()
}

export const api = {
  hosts: {
    list: () => fetchApi<any[]>('/api/hosts'),
    get: (id: string) => fetchApi<any>(`/api/hosts/${id}`),
  },
  sessions: {
    list: (hostId: string) => fetchApi<any[]>(`/api/hosts/${hostId}/sessions`),
    create: (hostId: string, name: string) =>
      fetchApi<any>(`/api/hosts/${hostId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ name }),
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
  },
}
