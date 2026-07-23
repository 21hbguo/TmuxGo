import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { SessionWorkspaceEntry } from '@/types'

const PROFILE = 'default'
const QUERY_KEY = ['preferences', 'session-workspaces']

export function useSessionWorkspaces() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const remote = await api.preferences.get(PROFILE)
      return Array.isArray(remote.sessionWorkspaces) ? remote.sessionWorkspaces : []
    },
    staleTime: 15000,
  })
}
function applySessionWorkspacesMutation(queryClient: ReturnType<typeof useQueryClient>, next: SessionWorkspaceEntry[], updatedAt: string) {
  queryClient.setQueryData<SessionWorkspaceEntry[]>(QUERY_KEY, next)
  queryClient.setQueryData<RemotePreferencesLite>(['preferences', 'default'], (prev) => prev ? { ...prev, sessionWorkspaces: next, sessionWorkspacesUpdatedAt: updatedAt } : prev)
}
type RemotePreferencesLite = { sessionWorkspaces?: SessionWorkspaceEntry[]; sessionWorkspacesUpdatedAt?: string }

export function useSetSessionWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (entry: SessionWorkspaceEntry) => {
      const remote = await api.preferences.get(PROFILE)
      const current = Array.isArray(remote.sessionWorkspaces) ? remote.sessionWorkspaces : []
      const next = [...current.filter((item) => item.sessionId !== entry.sessionId), entry]
      const updatedAt = entry.updatedAt || new Date().toISOString()
      await api.preferences.update({ sessionWorkspaces: next, sessionWorkspacesUpdatedAt: updatedAt }, PROFILE)
      return { next, updatedAt }
    },
    onSuccess: ({ next, updatedAt }) => applySessionWorkspacesMutation(queryClient, next, updatedAt),
  })
}
export function useRemoveSessionWorkspaces() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (sessionIds: string[]) => {
      const removeSet = new Set(sessionIds)
      const remote = await api.preferences.get(PROFILE)
      const current = Array.isArray(remote.sessionWorkspaces) ? remote.sessionWorkspaces : []
      const next = current.filter((item) => !removeSet.has(item.sessionId))
      if (next.length === current.length) return { next, updatedAt: remote.sessionWorkspacesUpdatedAt || new Date().toISOString() }
      const updatedAt = new Date().toISOString()
      await api.preferences.update({ sessionWorkspaces: next, sessionWorkspacesUpdatedAt: updatedAt }, PROFILE)
      return { next, updatedAt }
    },
    onSuccess: ({ next, updatedAt }) => applySessionWorkspacesMutation(queryClient, next, updatedAt),
  })
}
export function useMigrateSessionWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ fromId, toId }: { fromId: string; toId: string }) => {
      if (!fromId || !toId || fromId === toId) return { next: [] as SessionWorkspaceEntry[], updatedAt: new Date().toISOString() }
      const remote = await api.preferences.get(PROFILE)
      const current = Array.isArray(remote.sessionWorkspaces) ? remote.sessionWorkspaces : []
      const target = current.find((item) => item.sessionId === fromId)
      if (!target) return { next: current, updatedAt: remote.sessionWorkspacesUpdatedAt || new Date().toISOString() }
      const next = [...current.filter((item) => item.sessionId !== fromId && item.sessionId !== toId), { ...target, sessionId: toId, updatedAt: new Date().toISOString() }]
      const updatedAt = new Date().toISOString()
      await api.preferences.update({ sessionWorkspaces: next, sessionWorkspacesUpdatedAt: updatedAt }, PROFILE)
      return { next, updatedAt }
    },
    onSuccess: ({ next, updatedAt }) => applySessionWorkspacesMutation(queryClient, next, updatedAt),
  })
}
