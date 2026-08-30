import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPanel } from './SessionPanel'
import { useConsoleStore } from '@/stores/useConsoleStore'

const mutateCreateSession = vi.fn()
const mutateRenameSession = vi.fn()
const mutateDeleteSession = vi.fn()
const mutateBatchDeleteSessions = vi.fn()
const mutateSetSessionWorkspace = vi.fn()
const mutateRemoveSessionWorkspaces = vi.fn()
const mutateMigrateSessionWorkspace = vi.fn()
const mutateUpdateWorkspace = vi.fn()
const mutateRemoveWorkspace = vi.fn()
const mutateCreateWorkspace = vi.fn()
const promptMock = vi.fn()
const orderedSessions = [{ id: 'session-dev', name: 'dev', windowCount: 2, agentSummary: { idle: 2, working: 1, blocked: 0, done: 0, unknown: 0, total: 3 } }, { id: 'session-next', name: 'next', windowCount: 1 }]
const moveSessionMock = vi.fn()
const refetchSessionsMock = vi.fn()
const orderedSessionQueryState: any = { data: orderedSessions, moveSession: moveSessionMock, isError: false, error: null, refetch: refetchSessionsMock }
const workspacesState: any = { data: [] }
const sessionWorkspacesState: any = { data: [] }

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  useSessions: () => ({ data: orderedSessions }),
  useCreateSession: () => ({ mutateAsync: mutateCreateSession }),
  useRenameSession: () => ({ mutateAsync: mutateRenameSession }),
  useDeleteSession: () => ({ mutateAsync: mutateDeleteSession }),
  useBatchDeleteSessions: () => ({ mutateAsync: mutateBatchDeleteSessions }),
  useSessionTemplates: () => ({ data: { templates: [] } }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { showQuickActions: false } }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => orderedSessionQueryState,
}))
vi.mock('@/hooks/useSessionWorkspaces', () => ({
  useSessionWorkspaces: () => sessionWorkspacesState,
  useSetSessionWorkspace: () => ({ mutateAsync: mutateSetSessionWorkspace }),
  useRemoveSessionWorkspaces: () => ({ mutateAsync: mutateRemoveSessionWorkspaces }),
  useMigrateSessionWorkspace: () => ({ mutateAsync: mutateMigrateSessionWorkspace }),
}))
vi.mock('@/hooks/useWorkspaces', () => ({
  useWorkspaces: () => workspacesState,
  useCreateWorkspace: () => ({ mutateAsync: mutateCreateWorkspace }),
  useUpdateWorkspace: () => ({ mutateAsync: mutateUpdateWorkspace }),
  useRemoveWorkspace: () => ({ mutateAsync: mutateRemoveWorkspace }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, string | number>) => {
    if (key === 'sidebar.sessions') return 'Sessions'
    if (key === 'sidebar.newAction') return 'New'
    if (key === 'sidebar.renameSession') return 'Rename session'
    if (key === 'sidebar.deleteSession') return 'Delete session'
    if (key === 'sidebar.reorderSession') return 'Reorder session'
    if (key === 'sidebar.deleteTitle') return 'Delete session'
    if (key === 'sidebar.deleteConfirm') return `Delete ${params?.name || ''}?`
    if (key === 'sidebar.confirmDelete') return 'Delete'
    if (key === 'sidebar.windows') return `${params?.count || 0} windows`
    if (key === 'agent.status.idle') return '空闲'
    if (key === 'agent.status.working') return '工作中'
    if (key === 'agent.status.blocked') return '等待处理'
    if (key === 'drawer.sessionName') return 'Session name:'
    if (key === 'drawer.renamePrompt') return 'Rename session:'
    if (key === 'common.cancel') return 'Cancel'
    if (key === 'workspace.current') return 'Current workspace'
    if (key === 'workspace.choose') return 'Choose workspace'
    if (key === 'workspace.add') return 'Add workspace'
    return key
  } }),
}))
vi.mock('./SessionTemplates', () => ({
  SessionTemplates: ({ onSelect }: { onSelect: (template: { id: string; name: string; layout: { windows: { name: string; panes: {}[] }[] } }) => void }) => React.createElement('button', { onClick: () => onSelect({ id: 'default', name: 'default', layout: { windows: [{ name: 'main', panes: [{}] }] } }) }, 'select-template'),
  templates: [{ id: 'default', name: 'default', description: '', layout: { windows: [{ name: 'main', panes: [{}] }] } }],
}))
vi.mock('./CreateSessionDialog', () => ({
  CreateSessionDialog: ({ open, defaultName, initialWorkspace, onCreate }: { open: boolean; defaultName: string; initialWorkspace?: any; onCreate: (result: { name: string; cwd?: string; workspace?: any }) => void }) => open ? React.createElement('button', { onClick: () => onCreate({ name: defaultName, cwd: initialWorkspace?.path, workspace: initialWorkspace ? { rootId: initialWorkspace.rootId, rootPath: initialWorkspace.rootPath, rootLabel: initialWorkspace.rootLabel, relativePath: initialWorkspace.relativePath, absolutePath: initialWorkspace.path, workspaceId: initialWorkspace.id, workspaceName: initialWorkspace.name } : undefined }) }, 'create-session') : null,
}))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null,
}))
vi.mock('./QuickActions', () => ({
  QuickActions: () => React.createElement('div'),
}))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: () => ({
    prompt: promptMock,
    PromptElement: null,
  }),
}))
vi.mock('./HostSwitcher', () => ({
  HostSwitcher: () => React.createElement('div'),
}))
vi.mock('./SessionSortableList', () => ({
  SessionSortableList: ({ sessions, renderItem }: { sessions: any[]; renderItem: (args: { session: any; isDragging: boolean; isOverlay: boolean }) => React.ReactNode }) => React.createElement('div', null, sessions.map((session) => React.createElement('div', { key: session.id }, renderItem({ session, isDragging: false, isOverlay: false })))),
}))

describe('SessionPanel session actions', () => {
  beforeEach(() => {
    mutateCreateSession.mockReset()
    mutateRenameSession.mockReset()
    mutateDeleteSession.mockReset()
    mutateBatchDeleteSessions.mockReset()
    mutateSetSessionWorkspace.mockReset()
    mutateRemoveSessionWorkspaces.mockReset()
    mutateMigrateSessionWorkspace.mockReset()
    mutateUpdateWorkspace.mockReset()
    mutateRemoveWorkspace.mockReset()
    mutateCreateWorkspace.mockReset()
    workspacesState.data = []
    sessionWorkspacesState.data = []
    promptMock.mockReset()
    moveSessionMock.mockReset()
    refetchSessionsMock.mockReset()
    orderedSessionQueryState.data = orderedSessions
    orderedSessionQueryState.isError = false
    orderedSessionQueryState.error = null
    mutateRenameSession.mockResolvedValue({ id: 'session-dev-renamed' })
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev',
      toasts: [],
    } as any)
  })
  it('renders base panel', () => {
    render(<SessionPanel />)
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('2 windows')).toHaveClass('whitespace-nowrap')
    expect(screen.getByText('2 空闲')).toBeInTheDocument()
    expect(screen.getByText('1 工作中')).toBeInTheDocument()
    expect(screen.queryByText('0 等待处理')).not.toBeInTheDocument()
  })
  it('shows session loading errors and retries', () => {
    orderedSessionQueryState.data = []
    orderedSessionQueryState.isError = true
    orderedSessionQueryState.error = new Error('SSH connection timed out')
    render(<SessionPanel />)
    expect(screen.getByText('SSH connection timed out')).toBeInTheDocument()
    fireEvent.click(screen.getByText('common.retry'))
    expect(refetchSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('renames the active session from the desktop rename button', async () => {
    promptMock.mockResolvedValueOnce('dev-renamed')
    render(<SessionPanel />)
    fireEvent.click(screen.getAllByLabelText('Rename session')[0])
    await waitFor(() => expect(mutateRenameSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev', name: 'dev-renamed' }))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-renamed'))
  })

  it('renames the session on double click', async () => {
    promptMock.mockResolvedValueOnce('dev-double')
    mutateRenameSession.mockResolvedValueOnce({ id: 'session-dev-double' })
    render(<SessionPanel />)
    fireEvent.doubleClick(screen.getByText('dev'))
    await waitFor(() => expect(mutateRenameSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev', name: 'dev-double' }))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-double'))
  })

  it('activates the newly created session', async () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: null, createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }]
    mutateCreateSession.mockResolvedValueOnce({ id: 'session-default', name: 'tmuxgo-default', windowCount: 1 })
    render(<SessionPanel />)
    fireEvent.click(screen.getByText('New'))
    fireEvent.click(screen.getByText('select-template'))
    fireEvent.click(screen.getByText('create-session'))
    await waitFor(() => expect(mutateCreateSession).toHaveBeenCalledWith({ hostId: 'local', name: 'tmuxgo-default', layout: expect.any(Object), cwd: '/workspace/tmuxgo' }))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-default'))
  })
  it('uses the configured workspace template', () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: 'default', createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }]
    render(<SessionPanel />)
    fireEvent.click(screen.getByText('New'))
    expect(screen.getByText('create-session')).toBeInTheDocument()
    expect(screen.queryByText('select-template')).not.toBeInTheDocument()
  })

  it('switches to the next session after deleting the active session', async () => {
    mutateDeleteSession.mockResolvedValueOnce({ success: true, sessionId: 'session-dev' })
    render(<SessionPanel />)
    fireEvent.click(screen.getAllByLabelText('Delete session')[0])
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateDeleteSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev' }))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-next'))
  })
  it('allows batch deletion of attached sessions', async () => {
    mutateBatchDeleteSessions
      .mockResolvedValueOnce({ mode: 'preview', forceRequired: false })
      .mockResolvedValueOnce({ mode: 'execute', deleted: [{ sessionId: 'session-dev' }], deletedCount: 1 })
    render(<SessionPanel />)
    fireEvent.click(screen.getByText('sidebar.batchDeleteAction'))
    fireEvent.click(screen.getAllByText('☐')[0])
    fireEvent.click(screen.getByText('sidebar.batchDeleteSelected'))
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateBatchDeleteSessions).toHaveBeenNthCalledWith(1, { hostId: 'local', payload: { mode: 'preview', sessionIds: ['session-dev'], filters: { includeAttached: true } } }))
    await waitFor(() => expect(mutateBatchDeleteSessions).toHaveBeenNthCalledWith(2, { hostId: 'local', payload: { mode: 'execute', sessionIds: ['session-dev'], filters: { includeAttached: true }, force: false } }))
  })
  it('groups sessions by workspace and shows unclassified group', () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: null, createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }]
    render(<SessionPanel />)
    expect(screen.getAllByText('tmuxgo')).toHaveLength(2)
    expect(screen.getByText('workspace.unclassified')).toBeInTheDocument()
  })
  it('keeps empty workspaces visible', () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: null, createdAt: '', updatedAt: '' }, { id: 'ws-2', name: 'empty', hostId: 'local', path: '/workspace/empty', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'empty', templateId: null, createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }]
    render(<SessionPanel />)
    expect(screen.getByText('empty')).toBeInTheDocument()
  })
  it('switches to the selected workspace session', () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: null, createdAt: '', updatedAt: '' }, { id: 'ws-2', name: 'other', hostId: 'local', path: '/workspace/other', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'other', templateId: null, createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }, { sessionId: 'session-next', hostId: 'local', workspaceId: 'ws-2', workspacePath: '/workspace/other', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'other', updatedAt: '' }]
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('Current workspace: tmuxgo'))
    fireEvent.click(screen.getByLabelText('other'))
    expect(useConsoleStore.getState().activeSessionId).toBe('session-next')
  })
  it('creates a session from a workspace with bound cwd and workspace binding', async () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: null, createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }]
    mutateCreateSession.mockResolvedValueOnce({ id: 'session-new', name: 'tmuxgo-default', windowCount: 1 })
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('workspace.newSession'))
    fireEvent.click(screen.getByText('select-template'))
    fireEvent.click(screen.getByText('create-session'))
    await waitFor(() => expect(mutateCreateSession).toHaveBeenCalledWith({ hostId: 'local', name: 'tmuxgo-default', layout: expect.any(Object), cwd: '/workspace/tmuxgo' }))
    await waitFor(() => expect(mutateSetSessionWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-new', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo' })))
  })
  it('deletes a workspace and keeps sessions', async () => {
    workspacesState.data = [{ id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', templateId: null, createdAt: '', updatedAt: '' }]
    sessionWorkspacesState.data = [{ sessionId: 'session-dev', hostId: 'local', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo', rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'tmuxgo', updatedAt: '' }]
    mutateRemoveWorkspace.mockResolvedValueOnce({ success: true })
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('workspace.delete'))
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateRemoveWorkspace).toHaveBeenCalledWith('ws-1'))
  })
})
