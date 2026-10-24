import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React, { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPanel } from './SessionPanel'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'
import type { AgentSummary, Session, SessionWorkspaceEntry, WorkspaceEntry } from '@/types'
import type { CreateSessionDialogResult } from './CreateSessionDialog'

// 面板只消费这几个字段：夹具不造完整 Session（hostId/createdAt 等与断言无关）
type PanelSession = Pick<Session, 'id' | 'name' | 'windowCount'> & { agentSummary?: AgentSummary }

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
const orderedSessions: PanelSession[] = [
  {
    id: 'session-dev',
    name: 'dev',
    windowCount: 2,
    agentSummary: { idle: 2, working: 1, blocked: 0, done: 0, unknown: 0, total: 3 },
  },
  { id: 'session-next', name: 'next', windowCount: 1 },
]
const moveSessionMock = vi.fn()
const refetchSessionsMock = vi.fn()
const orderedSessionQueryState: {
  data: PanelSession[]
  moveSession: ReturnType<typeof vi.fn>
  isError: boolean
  error: unknown
  refetch: ReturnType<typeof vi.fn>
} = {
  data: orderedSessions,
  moveSession: moveSessionMock,
  isError: false,
  error: null,
  refetch: refetchSessionsMock,
}
const workspacesState: { data: WorkspaceEntry[] } = { data: [] }
const sessionWorkspacesState: { data: SessionWorkspaceEntry[] } = { data: [] }

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
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
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
      if (key === 'agent.status.done') return 'Done'
      if (key === 'drawer.sessionName') return 'Session name:'
      if (key === 'drawer.renamePrompt') return 'Rename session:'
      if (key === 'common.cancel') return 'Cancel'
      if (key === 'workspace.current') return 'Current workspace'
      if (key === 'workspace.choose') return 'Choose workspace'
      if (key === 'workspace.add') return 'Add workspace'
      return key
    },
  }),
}))
vi.mock('./SessionTemplates', () => ({
  SessionTemplates: ({
    onSelect,
  }: {
    onSelect: (template: {
      id: string
      name: string
      layout: { windows: { name: string; panes: Record<string, never>[] }[] }
    }) => void
  }) =>
    React.createElement(
      'button',
      {
        onClick: () =>
          onSelect({ id: 'default', name: 'default', layout: { windows: [{ name: 'main', panes: [{}] }] } }),
      },
      'select-template',
    ),
  templates: [
    { id: 'default', name: 'default', description: '', layout: { windows: [{ name: 'main', panes: [{}] }] } },
  ],
}))
vi.mock('./CreateSessionDialog', () => ({
  CreateSessionDialog: ({
    open,
    defaultName,
    initialWorkspace,
    onCreate,
  }: {
    open: boolean
    defaultName: string
    initialWorkspace?: WorkspaceEntry
    onCreate: (result: CreateSessionDialogResult) => void
  }) =>
    open
      ? React.createElement(
          'button',
          {
            onClick: () =>
              onCreate({
                name: defaultName,
                cwd: initialWorkspace?.path,
                workspace: initialWorkspace
                  ? {
                      rootId: initialWorkspace.rootId,
                      rootPath: initialWorkspace.rootPath,
                      rootLabel: initialWorkspace.rootLabel,
                      relativePath: initialWorkspace.relativePath,
                      absolutePath: initialWorkspace.path,
                      workspaceId: initialWorkspace.id,
                      workspaceName: initialWorkspace.name,
                    }
                  : undefined,
              }),
          },
          'create-session',
        )
      : null,
}))
const confirmHandlers = new Map<string, () => unknown>()
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, onConfirm }: { open: boolean; title: string; onConfirm: () => unknown }) => {
    if (open) confirmHandlers.set(title, onConfirm)
    return open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null
  },
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
  SessionSortableList: ({
    sessions,
    renderItem,
  }: {
    sessions: Session[]
    renderItem: (args: { session: Session; isDragging: boolean; isOverlay: boolean }) => React.ReactNode
  }) =>
    React.createElement(
      'div',
      null,
      sessions.map((session) =>
        React.createElement('div', { key: session.id }, renderItem({ session, isDragging: false, isOverlay: false })),
      ),
    ),
  SessionGroupedSortableList: ({
    groups,
    renderItem,
  }: {
    groups: { key: string; header: React.ReactNode; sessions: Session[] }[]
    renderItem: (args: { session: Session; isDragging: boolean; isOverlay: boolean }) => React.ReactNode
  }) =>
    React.createElement(
      'div',
      null,
      groups.flatMap((group) => [
        React.createElement('div', { key: `group-drop:${group.key || 'unclassified'}` }, group.header),
        ...group.sessions.map((session) =>
          React.createElement('div', { key: session.id }, renderItem({ session, isDragging: false, isOverlay: false })),
        ),
      ]),
    ),
  SessionGroupDropZone: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  orderByIds: (sessions: Session[], ids: string[]) => {
    const map = new Map(sessions.map((session) => [session.id, session]))
    return ids.map((id) => map.get(id)).filter(Boolean)
  },
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
    })
  })
  it('renders base panel', () => {
    render(<SessionPanel />)
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('2 windows')).toHaveClass('whitespace-nowrap')
    // 徽标只渲染颜色点+数字，状态名移到 title/aria-label
    expect(screen.getByTitle('空闲')).toHaveTextContent('2')
    expect(screen.getAllByTitle('工作中').some((el) => el.textContent === '1')).toBe(true)
    expect(screen.queryByText('0 等待处理')).not.toBeInTheDocument()
  })
  it('badges sessions with pending agent-recovery candidates and resumes through the badge', async () => {
    const candidates = [
      {
        id: 'c1',
        hostId: 'local',
        sessionName: 'dev',
        paneId: '%1',
        tmuxPaneId: '%1',
        agent: 'claude',
        lastSeenAt: '2026-10-24T00:00:00Z',
        reason: 'pane_exited',
        status: 'pending',
        createdAt: '2026-10-24T00:00:00Z',
        resumable: true,
        occupant: '',
      },
      {
        id: 'c2',
        hostId: 'local',
        sessionName: 'dev',
        paneId: '%2',
        tmuxPaneId: '%2',
        agent: 'codex',
        lastSeenAt: '2026-10-24T00:00:00Z',
        reason: 'pane_exited',
        status: 'pending',
        createdAt: '2026-10-24T00:00:00Z',
        resumable: true,
        occupant: '',
      },
      {
        // 已恢复的候选不再计数：徽标只代表「还能恢复」的那批
        id: 'c3',
        hostId: 'local',
        sessionName: 'dev',
        paneId: '%3',
        tmuxPaneId: '%3',
        agent: 'grok',
        lastSeenAt: '2026-10-24T00:00:00Z',
        reason: 'pane_exited',
        status: 'resumed',
        createdAt: '2026-10-24T00:00:00Z',
        resumable: true,
        occupant: '',
      },
    ]
    const listSpy = vi.spyOn(api.agentRecovery, 'list').mockResolvedValue({ candidates } as never)
    const resumeSpy = vi.spyOn(api.agentRecovery, 'resume').mockResolvedValue({ ok: true } as never)

    render(<SessionPanel />)

    // dev 有 2 条 pending → 一个徽标、数字 2；next 无候选 → 不出徽标（全局只有这一个）
    const badge = await screen.findByRole('button', { name: 'agent.recovery.badgeTitle' })
    expect(badge).toHaveTextContent('2')
    expect(screen.getAllByRole('button', { name: 'agent.recovery.badgeTitle' })).toHaveLength(1)
    expect(listSpy).toHaveBeenCalledWith('local')

    // 点开弹窗：列候选，恢复走确认
    fireEvent.click(badge)
    const dialog = await screen.findByRole('dialog', { name: 'agent.recovery.title' })
    expect(within(dialog).getByText('claude · %1')).toBeInTheDocument()
    expect(within(dialog).getByText('codex · %2')).toBeInTheDocument()
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'agent.recovery.resume' })[0])
    await act(async () => {
      await confirmHandlers.get('agent.recovery.confirmTitle')?.()
    })
    expect(resumeSpy).toHaveBeenCalledWith('local', 'c1', {
      paneId: '%1',
      agentSessionId: '',
      targetMode: undefined,
    })
    // resume 成功后 session 列表与候选列表都会重取
    expect(refetchSessionsMock).toHaveBeenCalled()
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(1))
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
    await waitFor(() =>
      expect(mutateRenameSession).toHaveBeenCalledWith({
        hostId: 'local',
        sessionId: 'session-dev',
        name: 'dev-renamed',
      }),
    )
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-renamed'))
  })

  it('renames the session on double click', async () => {
    promptMock.mockResolvedValueOnce('dev-double')
    mutateRenameSession.mockResolvedValueOnce({ id: 'session-dev-double' })
    render(<SessionPanel />)
    fireEvent.doubleClick(screen.getByText('dev'))
    await waitFor(() =>
      expect(mutateRenameSession).toHaveBeenCalledWith({
        hostId: 'local',
        sessionId: 'session-dev',
        name: 'dev-double',
      }),
    )
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-double'))
  })

  it('activates the newly created session', async () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    mutateCreateSession.mockResolvedValueOnce({ id: 'session-new-1', name: 'tmuxgo-1', windowCount: 1 })
    render(<SessionPanel />)
    // 顶栏 New 已图标化（aria-label），与未分类组头的同名按钮区分需按 Sessions 行定界
    fireEvent.click(
      within(screen.getByText('Sessions').parentElement as HTMLElement).getByRole('button', { name: 'New' }),
    )
    fireEvent.click(screen.getByText('select-template'))
    fireEvent.click(screen.getByText('create-session'))
    await waitFor(() =>
      expect(mutateCreateSession).toHaveBeenCalledWith({
        hostId: 'local',
        name: 'tmuxgo-1',
        layout: expect.any(Object),
        cwd: '/workspace/tmuxgo',
      }),
    )
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-new-1'))
  })
  it('uses the configured workspace template', () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: 'default',
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    render(<SessionPanel />)
    fireEvent.click(
      within(screen.getByText('Sessions').parentElement as HTMLElement).getByRole('button', { name: 'New' }),
    )
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
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.batchDeleteAction' }))
    fireEvent.click(screen.getAllByText('☐')[0])
    fireEvent.click(screen.getByText('sidebar.batchDeleteSelected'))
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() =>
      expect(mutateBatchDeleteSessions).toHaveBeenNthCalledWith(1, {
        hostId: 'local',
        payload: { mode: 'preview', sessionIds: ['session-dev'], filters: { includeAttached: true } },
      }),
    )
    await waitFor(() =>
      expect(mutateBatchDeleteSessions).toHaveBeenNthCalledWith(2, {
        hostId: 'local',
        payload: { mode: 'execute', sessionIds: ['session-dev'], filters: { includeAttached: true }, force: false },
      }),
    )
  })
  it('groups sessions by workspace and shows unclassified group', () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    render(<SessionPanel />)
    expect(screen.getAllByText('tmuxgo')).toHaveLength(2)
    expect(screen.getByText('workspace.unclassified')).toBeInTheDocument()
  })
  it('creates a session from the unclassified group header without a workspace', async () => {
    render(<SessionPanel />)
    const header = screen.getByText('workspace.unclassified').parentElement as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: 'New' }))
    fireEvent.click(await screen.findByText('create-session'))
    await waitFor(() =>
      expect(mutateCreateSession).toHaveBeenCalledWith({
        hostId: 'local',
        name: 'session-1',
        layout: expect.any(Object),
        cwd: undefined,
      }),
    )
    expect(mutateSetSessionWorkspace).not.toHaveBeenCalled()
  })
  it('keeps empty workspaces visible', () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'ws-2',
        name: 'empty',
        hostId: 'local',
        path: '/workspace/empty',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'empty',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    render(<SessionPanel />)
    expect(screen.getByText('empty')).toBeInTheDocument()
  })
  it('rolls session agent summaries up to workspace groups by attention', () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'ws-2',
        name: 'other',
        hostId: 'local',
        path: '/workspace/other',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'other',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
      {
        sessionId: 'session-next',
        hostId: 'local',
        workspaceId: 'ws-2',
        workspacePath: '/workspace/other',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'other',
        updatedAt: '',
      },
    ]
    orderedSessionQueryState.data = [
      {
        id: 'session-dev',
        name: 'dev',
        windowCount: 1,
        agentSummary: { idle: 1, working: 1, blocked: 0, done: 0, unknown: 0, total: 2 },
      },
      {
        id: 'session-next',
        name: 'next',
        windowCount: 1,
        agentSummary: { idle: 0, working: 0, blocked: 1, done: 0, unknown: 0, total: 1 },
      },
      {
        id: 'session-loose',
        name: 'loose',
        windowCount: 1,
        agentSummary: { idle: 0, working: 0, blocked: 0, done: 1, unknown: 0, total: 1 },
      },
    ]
    render(<SessionPanel />)
    // ws-2(blocked) 注意力排序先于 ws-1(working)
    expect(
      screen.getByText('next').compareDocumentPosition(screen.getByText('dev')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // 组头不再聚合徽标/计数（只留名称+操作项）；rollup 仍驱动组排序，徽标落在各 session 行
    const otherHeader = screen.getByText('other').parentElement as HTMLElement
    expect(within(otherHeader).queryByTitle('等待处理')).not.toBeInTheDocument()
    const nextRow = screen.getByText('next').closest('button') as HTMLElement
    expect(within(nextRow).getByTitle('等待处理')).toBeInTheDocument()
    const unclassifiedHeader = screen.getByText('workspace.unclassified').parentElement as HTMLElement
    expect(within(unclassifiedHeader).queryByTitle('Done')).not.toBeInTheDocument()
    const looseRow = screen.getByText('loose').closest('button') as HTMLElement
    expect(within(looseRow).getByTitle('Done')).toBeInTheDocument()
  })
  it('switches to the selected workspace session', () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'ws-2',
        name: 'other',
        hostId: 'local',
        path: '/workspace/other',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'other',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
      {
        sessionId: 'session-next',
        hostId: 'local',
        workspaceId: 'ws-2',
        workspacePath: '/workspace/other',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'other',
        updatedAt: '',
      },
    ]
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('Current workspace: tmuxgo'))
    fireEvent.click(screen.getByLabelText('other'))
    expect(useConsoleStore.getState().activeSessionId).toBe('session-next')
  })
  it('creates a session from a workspace with bound cwd and workspace binding', async () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    mutateCreateSession.mockResolvedValueOnce({ id: 'session-new', name: 'tmuxgo-1', windowCount: 1 })
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('workspace.newSession'))
    fireEvent.click(screen.getByText('select-template'))
    fireEvent.click(screen.getByText('create-session'))
    await waitFor(() =>
      expect(mutateCreateSession).toHaveBeenCalledWith({
        hostId: 'local',
        name: 'tmuxgo-1',
        layout: expect.any(Object),
        cwd: '/workspace/tmuxgo',
      }),
    )
    await waitFor(() =>
      expect(mutateSetSessionWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-new', workspaceId: 'ws-1', workspacePath: '/workspace/tmuxgo' }),
      ),
    )
  })
  it('deletes a workspace and keeps sessions', async () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    mutateRemoveWorkspace.mockResolvedValueOnce({ success: true })
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('workspace.delete'))
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateRemoveWorkspace).toHaveBeenCalledWith('ws-1'))
  })
  // —— Task21：workspace 组内 session attention 排序 ——
  const mkSummary = (counts: Partial<Record<'idle' | 'working' | 'blocked' | 'done' | 'unknown', number>>) => {
    const summary = { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0, ...counts }
    return { ...summary, total: summary.idle + summary.working + summary.blocked + summary.done + summary.unknown }
  }
  const mkWorkspace = (id: string, name: string): WorkspaceEntry => ({
    id,
    name,
    hostId: 'local',
    path: `/workspace/${id}`,
    rootId: 'root-workspace',
    rootPath: '/workspace',
    rootLabel: 'workspace',
    relativePath: id,
    templateId: null,
    createdAt: '',
    updatedAt: '',
  })
  const bindSession = (sessionId: string, ws: { id: string; path: string }): SessionWorkspaceEntry => ({
    sessionId,
    hostId: 'local',
    workspaceId: ws.id,
    workspacePath: ws.path,
    rootId: 'root-workspace',
    rootPath: '/workspace',
    rootLabel: 'workspace',
    relativePath: ws.id,
    updatedAt: '',
  })
  const mkSession = (id: string, name: string, agentSummary?: AgentSummary): PanelSession => ({
    id,
    name,
    windowCount: 1,
    agentSummary,
  })
  const domBefore = (a: HTMLElement, b: HTMLElement) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  it('sorts sessions inside a workspace group by attention rank', () => {
    const ws = mkWorkspace('ws-1', 'tmuxgo')
    workspacesState.data = [ws]
    orderedSessionQueryState.data = [
      mkSession('s-idle', 'a-idle', mkSummary({ idle: 1 })),
      mkSession('s-blocked', 'b-blocked', mkSummary({ blocked: 1 })),
      mkSession('s-done', 'c-done', mkSummary({ done: 1 })),
      mkSession('s-working', 'd-working', mkSummary({ working: 1 })),
      mkSession('s-unknown', 'e-unknown', mkSummary({ unknown: 1 })),
    ]
    sessionWorkspacesState.data = orderedSessionQueryState.data.map((s) => bindSession(s.id, ws))
    render(<SessionPanel />)
    // blocked > done > working > idle > unknown（agentAttentionPriority 同一模型）
    const ordered = ['b-blocked', 'c-done', 'd-working', 'a-idle', 'e-unknown'].map((name) => screen.getByText(name))
    for (let i = 0; i + 1 < ordered.length; i++) expect(domBefore(ordered[i], ordered[i + 1])).toBeTruthy()
  })

  it('keeps manual order within the same attention rank', () => {
    const ws = mkWorkspace('ws-1', 'tmuxgo')
    workspacesState.data = [ws]
    const first = mkSession('s-a', 'idle-a', mkSummary({ idle: 1 }))
    const second = mkSession('s-b', 'idle-b', mkSummary({ idle: 1 }))
    const hot = mkSession('s-c', 'blk-c', mkSummary({ blocked: 1 }))
    orderedSessionQueryState.data = [first, second, hot]
    sessionWorkspacesState.data = [first, second, hot].map((s) => bindSession(s.id, ws))
    const { rerender } = render(<SessionPanel />)
    expect(domBefore(screen.getByText('blk-c'), screen.getByText('idle-a'))).toBeTruthy()
    expect(domBefore(screen.getByText('idle-a'), screen.getByText('idle-b'))).toBeTruthy()
    // 手动序翻转（等价拖拽后 moveSession 写回的新存储序）→ 同档跟随，排序偏好不丢
    orderedSessionQueryState.data = [second, first, hot]
    rerender(<SessionPanel />)
    expect(domBefore(screen.getByText('idle-b'), screen.getByText('idle-a'))).toBeTruthy()
    expect(domBefore(screen.getByText('blk-c'), screen.getByText('idle-b'))).toBeTruthy()
  })

  it('keeps the unclassified group last while sorting its own sessions by attention', () => {
    const ws = mkWorkspace('ws-1', 'tmuxgo')
    workspacesState.data = [ws]
    const inWs = mkSession('s-in', 'in-ws', mkSummary({ idle: 1 }))
    const uDone = mkSession('s-u1', 'u-done', mkSummary({ done: 1 }))
    const uBlocked = mkSession('s-u2', 'u-blocked', mkSummary({ blocked: 1 }))
    orderedSessionQueryState.data = [inWs, uDone, uBlocked]
    sessionWorkspacesState.data = [bindSession(inWs.id, ws)]
    render(<SessionPanel />)
    // 未分类组固定沉底：即便内含最高注意力 session，也排在 workspace 组后
    expect(domBefore(screen.getByText('in-ws'), screen.getByText('workspace.unclassified'))).toBeTruthy()
    // 未分类组内同样按 rank 排：blocked 反超存储序在前的 done
    expect(domBefore(screen.getByText('u-blocked'), screen.getByText('u-done'))).toBeTruthy()
  })

  it('orders workspace dropdown items by attention like the group list', () => {
    const calm = mkWorkspace('ws-1', 'calm')
    const urgent = mkWorkspace('ws-2', 'urgent')
    workspacesState.data = [calm, urgent]
    orderedSessionQueryState.data = [
      mkSession('s-calm', 'calm-s', mkSummary({ idle: 1 })),
      mkSession('s-hot', 'hot-s', mkSummary({ blocked: 1 })),
    ]
    sessionWorkspacesState.data = [bindSession('s-calm', calm), bindSession('s-hot', urgent)]
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText(/^Current workspace:/))
    // 下拉项与列表分组同序：urgent(blocked) 在 calm(idle) 前
    expect(domBefore(screen.getByLabelText('urgent'), screen.getByLabelText('calm'))).toBeTruthy()
  })

  it('hands the pending removal promise to the workspace delete dialog', async () => {
    workspacesState.data = [
      {
        id: 'ws-1',
        name: 'tmuxgo',
        hostId: 'local',
        path: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        templateId: null,
        createdAt: '',
        updatedAt: '',
      },
    ]
    sessionWorkspacesState.data = [
      {
        sessionId: 'session-dev',
        hostId: 'local',
        workspaceId: 'ws-1',
        workspacePath: '/workspace/tmuxgo',
        rootId: 'root-workspace',
        rootPath: '/workspace',
        rootLabel: 'workspace',
        relativePath: 'tmuxgo',
        updatedAt: '',
      },
    ]
    let resolveRemove: (value: { success: boolean }) => void = () => {}
    mutateRemoveWorkspace.mockImplementation(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveRemove = resolve
        }),
    )
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('workspace.delete'))
    let result: unknown
    await act(async () => {
      result = confirmHandlers.get('workspace.deleteTitle')?.()
    })
    // Promise 真正传给弹窗 → 弹窗据此 busy 防重复提交（旧写法 void 丢弃时拿不到）
    expect(typeof (result as PromiseLike<unknown>)?.then).toBe('function')
    await act(async () => resolveRemove({ success: true }))
  })
})
