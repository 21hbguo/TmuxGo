import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { WorkspaceEntry } from '@/types'

const QUERY_KEY = ['workspaces']

export function useWorkspaces(hostId?: string) {
  return useQuery({
    queryKey: [...QUERY_KEY, hostId || 'all'],
    queryFn: async () => (await api.workspaces.list(hostId)).workspaces,
    staleTime: 15000,
  })
}
export function useCreateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: Parameters<typeof api.workspaces.create>[0]) => api.workspaces.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
export function useUpdateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof api.workspaces.update>[1] }) => api.workspaces.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
export function useRemoveWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.workspaces.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
export function findWorkspaceById(workspaces: WorkspaceEntry[], id?: string) {
  return id ? workspaces.find((item) => item.id === id) || null : null
}
export function findWorkspaceByPath(workspaces: WorkspaceEntry[], hostId: string, workspacePath: string) {
  return workspaces.find((item) => item.hostId === hostId && item.path === workspacePath) || null
}
