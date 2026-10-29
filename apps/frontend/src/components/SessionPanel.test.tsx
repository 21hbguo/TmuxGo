import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React, { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPanel } from './SessionPanel'
import { useConsoleStore } from '@/stores/useConsoleStore'
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
// 有状态 preferences：新开关（隐藏工作区分组/排序）都靠 updatePreferences 落盘再回读，
// 只返回常量的 mock 会把开关点击变成空操作，测不出行为
const preferencesState = vi.hoisted(() => ({
  initial: { showQuickActions: false } as Record<string, unknown>,
  updatePreferences: vi.fn(),
}))
vi.mock('@/hooks/usePreferences', async () => {
  const React = await import('react')
  return {
    usePreferences: () => {
      const [preferences, setPreferences] = React.useState(preferencesState.initial)
      const updatePreferences = (patch: Record<string, unknown>) => {
        preferencesState.updatePreferences(patch)
        setPreferences((prev) => ({ ...prev, ...patch }))
      }
      return { preferences, updatePreferences }
    },
  }
})
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
      if (key === 'sidebar.sort') return 'Sort'
      if (key === 'sidebar.toggleWorkspaceGroups') return 'Grouping'
      if (key === 'sidebar.sortManual') return 'Manual'
      if (key === 'sidebar.sortCreatedAt') return 'Created'
      if (key === 'sidebar.sortLastActiveAt') return 'Last active'
      if (key === 'sidebar.sortName') return 'Name'
      if (key === 'sidebar.sortAttention') return 'Work state'
      if (key === 'sidebar.sortDragHint') return 'Dragging disabled'
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
// 拖拽链路：真实 DndContext 只能靠指针手势激活，jsdom 里点不出来。换成捕获回调的壳，
// 测试直接按 active/over 调 onDragStart → onDragOver → onDragEnd，断言落盘入参
type DragEventLike = { active?: { id?: string } | null; over?: { id?: string } | null }
const dndHandlers = vi.hoisted(() => ({
  current: {} as {
    onDragStart?: (event: DragEventLike) => void
    onDragOver?: (event: DragEventLike) => void
    onDragEnd?: (event: DragEventLike) => void
    onDragCancel?: () => void
    sensors?: unknown[]
  },
}))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: { children?: React.ReactNode } & Record<string, unknown>) => {
      dndHandlers.current = {
        onDragStart: props.onDragStart as (event: DragEventLike) => void,
        onDragOver: props.onDragOver as (event: DragEventLike) => void,
        onDragEnd: props.onDragEnd as (event: DragEventLike) => void,
        onDragCancel: props.onDragCancel as (() => void) | undefined,
        sensors: props.sensors as unknown[],
      }
      return React.createElement(React.Fragment, null, props.children)
    },
    // 覆盖层只在真拖拽时渲染，测试里不需要
    DragOverlay: () => null,
  }
})
vi.mock('./SessionSortableList', async (importOriginal) => {
  // 预览序助手（findPreviewGroup/movePreviewBetweenGroups/orderByIds）用真实现，
  // 只把两个列表组件换成同步渲染的壳——拖拽回调才是本组用例的被测面
  const actual = await importOriginal<typeof import('./SessionSortableList')>()
  return {
    ...actual,
    // flat（隐藏工作区分组）模式走单列表：无组头，只按传入序渲染行
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
            React.createElement(
              'div',
              { key: session.id },
              renderItem({ session, isDragging: false, isOverlay: false }),
            ),
          ),
        ]),
      ),
    SessionGroupDropZone: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  }
})
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
      within(screen.getByTestId('session-panel-header') as HTMLElement).getByRole('button', { name: 'New' }),
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
      within(screen.getByTestId('session-panel-header') as HTMLElement).getByRole('button', { name: 'New' }),
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

// —— Task D：快照入口移除 / 隐藏工作区分组 / 排序 chip ——
// 断言全为行为级：不认组件内部状态字段，只认「点哪个 chip、列表变成什么顺序」
describe('SessionPanel grouping and sorting controls', () => {
  beforeEach(() => {
    preferencesState.initial = { showQuickActions: false }
    preferencesState.updatePreferences.mockReset()
    workspacesState.data = []
    sessionWorkspacesState.data = []
    orderedSessionQueryState.data = []
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: null, toasts: [] })
  })

  const mkWs = (id: string, name: string): WorkspaceEntry => ({
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
  const bind = (sessionId: string, ws: WorkspaceEntry): SessionWorkspaceEntry => ({
    sessionId,
    hostId: 'local',
    workspaceId: ws.id,
    workspacePath: ws.path,
    rootId: ws.rootId,
    rootPath: ws.rootPath,
    rootLabel: ws.rootLabel,
    relativePath: ws.relativePath,
    updatedAt: '',
  })
  type SortSession = PanelSession & { createdAt?: string; lastActiveAt?: string }
  const mkSess = (
    id: string,
    name: string,
    extra: { createdAt?: string; lastActiveAt?: string; agentSummary?: AgentSummary } = {},
  ): SortSession => ({ id, name, windowCount: 1, ...extra })
  const domBefore = (a: HTMLElement, b: HTMLElement) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  // 顶栏动作：本轮改版把「新建」提到工作区行，其余四个仍是工具行，
  // 顺序不再同排，改用 data-session-action 标记在顶栏范围内定界（组头里的同名按钮不算）
  const chipRow = () => screen.getByTestId('session-panel-header') as HTMLElement
  const chipLabel = (el: HTMLElement) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()
  const chips = () =>
    within(chipRow())
      .getAllByRole('button')
      .filter((el) => el.hasAttribute('data-session-action'))
  const findChip = (pattern: RegExp) => {
    const all = chips()
    const found = all.find((el) => pattern.test(chipLabel(el)))
    if (!found) throw new Error(`chip ${pattern} not found; chips = [${all.map(chipLabel).join(' | ')}]`)
    return found
  }
  // 菜单项 = 点击后新出现的 button（不依赖菜单 class/文案 key）
  const clickToNewButtons = (chip: HTMLElement) => {
    const before = new Set(within(document.body).getAllByRole('button'))
    fireEvent.click(chip)
    return within(document.body)
      .getAllByRole('button')
      .filter((el) => !before.has(el))
  }
  const sortOptions = () => clickToNewButtons(findChip(/sort/i))
  const pickSort = (label: string) => {
    const options = sortOptions()
    // 菜单顺序即产品规格：手动 / 创建时间 / 最近活跃 / 名称 / 工作状态
    expect(options.map((el) => el.textContent)).toEqual(['Manual', 'Created', 'Last active', 'Name', 'Work state'])
    fireEvent.click(options.find((el) => el.textContent === label) as HTMLElement)
  }
  const expectDomOrder = (names: string[]) => {
    const nodes = names.map((name) => screen.getByText(name))
    for (let i = 0; i + 1 < nodes.length; i++) expect(domBefore(nodes[i], nodes[i + 1])).toBe(true)
  }

  it('drops the snapshots entry chip from the sessions header', () => {
    orderedSessionQueryState.data = [mkSess('s-1', 'only')]
    render(<SessionPanel />)
    expect(screen.queryByLabelText('snapshot.entry')).not.toBeInTheDocument()
    // 顶栏 chip：New / 导入布局 / 隐藏分组 / 排序 / 批量
    expect(chips()).toHaveLength(5)
  })

  it('flattens the list when workspace grouping is hidden and restores it on toggle', () => {
    const ws = mkWs('ws-1', 'alpha-ws')
    workspacesState.data = [ws]
    orderedSessionQueryState.data = [mkSess('s-in', 'in-ws'), mkSess('s-loose', 'loose')]
    sessionWorkspacesState.data = [bind('s-in', ws)]
    render(<SessionPanel />)
    // 分组态：有 workspace 组头与未分类组头
    expect(screen.getAllByText('alpha-ws')).toHaveLength(1)
    expect(screen.getByText('workspace.unclassified')).toBeInTheDocument()

    fireEvent.click(findChip(/hide|group|flat|分组/i))
    // 拍平：两层组头都消失，也没有空占位留下
    expect(screen.queryByText('workspace.unclassified')).not.toBeInTheDocument()
    expect(screen.queryByText('alpha-ws')).not.toBeInTheDocument()
    expect(screen.getByText('in-ws')).toBeInTheDocument()
    expect(screen.getByText('loose')).toBeInTheDocument()

    fireEvent.click(findChip(/hide|group|flat|分组/i))
    expect(screen.getByText('workspace.unclassified')).toBeInTheDocument()
  })

  it('sorts all sessions in flat mode by the chosen rule', () => {
    const ws = mkWs('ws-1', 'alpha-ws')
    workspacesState.data = [ws]
    orderedSessionQueryState.data = [
      mkSess('s-b', 'zzz', {
        createdAt: '2026-05-01T00:00:00Z',
        lastActiveAt: '2026-09-01T00:00:00Z',
        agentSummary: { idle: 1, working: 0, blocked: 0, done: 0, unknown: 0, total: 1 },
      }),
      mkSess('s-a', 'aaa', {
        createdAt: '2026-01-01T00:00:00Z',
        lastActiveAt: '2026-10-20T00:00:00Z',
        agentSummary: { idle: 0, working: 0, blocked: 1, done: 0, unknown: 0, total: 1 },
      }),
      mkSess('s-c', 'mmm', {
        createdAt: '2026-03-01T00:00:00Z',
        lastActiveAt: '2026-08-01T00:00:00Z',
        agentSummary: { idle: 0, working: 1, blocked: 0, done: 0, unknown: 0, total: 1 },
      }),
    ]
    sessionWorkspacesState.data = [bind('s-b', ws), bind('s-a', ws), bind('s-c', ws)]
    render(<SessionPanel />)
    fireEvent.click(findChip(/hide|group|flat|分组/i))

    // 菜单 5 项：手动 / 创建时间 / 最近活跃 / 名称 / 工作状态
    const options = sortOptions()
    expect(options.map((el) => el.textContent)).toEqual(['Manual', 'Created', 'Last active', 'Name', 'Work state'])
    fireEvent.click(findChip(/sort/i)) // 关掉菜单，避免残留项干扰下一轮

    pickSort('Created')
    expectDomOrder(['zzz', 'mmm', 'aaa']) // createdAt 新→旧
    // 非手动排序下拖拽被禁用：菜单里给出提示，chip 进入激活态
    fireEvent.click(findChip(/sort/i))
    expect(screen.getByText('Dragging disabled')).toBeInTheDocument()
    expect(findChip(/sort/i).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByText('Last active'))
    expectDomOrder(['aaa', 'zzz', 'mmm']) // lastActiveAt 新→旧
    pickSort('Name')
    expectDomOrder(['aaa', 'mmm', 'zzz']) // 名称 localeCompare
    pickSort('Work state')
    expectDomOrder(['aaa', 'mmm', 'zzz']) // blocked > working > idle
  })

  it('sorts groups by aggregate and within groups while keeping unclassified last', () => {
    const alpha = mkWs('ws-alpha', 'alpha-ws')
    const beta = mkWs('ws-beta', 'beta-ws')
    workspacesState.data = [alpha, beta]
    orderedSessionQueryState.data = [
      mkSess('s-alpha-old', 'alpha-old', { createdAt: '2026-01-01T00:00:00Z' }),
      mkSess('s-beta-old', 'beta-old', { createdAt: '2026-02-01T00:00:00Z' }),
      mkSess('s-beta-new', 'beta-new', { createdAt: '2026-08-01T00:00:00Z' }),
      mkSess('s-loose', 'loose-newest', { createdAt: '2026-09-01T00:00:00Z' }),
    ]
    sessionWorkspacesState.data = [bind('s-alpha-old', alpha), bind('s-beta-old', beta), bind('s-beta-new', beta)]
    render(<SessionPanel />)

    pickSort('Created')
    // 组间按组内最新 createdAt：beta(08) 先于 alpha(01)；组内 beta-new 在 beta-old 前
    expectDomOrder(['beta-ws', 'beta-new', 'beta-old', 'alpha-ws', 'alpha-old'])
    // 未分类组即便含最新 session 也沉底
    expect(domBefore(screen.getByText('alpha-old'), screen.getByText('workspace.unclassified'))).toBe(true)
    expect(domBefore(screen.getByText('workspace.unclassified'), screen.getByText('loose-newest'))).toBe(true)

    pickSort('Name')
    // 名称排序在组间用 workspace.name：alpha 先于 beta，未分类仍沉底
    expectDomOrder(['alpha-ws', 'alpha-old', 'beta-ws'])
    expect(domBefore(screen.getByText('beta-old'), screen.getByText('workspace.unclassified'))).toBe(true)
  })
})

// —— Task F-13：拖拽落盘链路（flat 全量序 / 原地松手守卫 / 跨组归属）——
describe('SessionPanel drag ordering', () => {
  beforeEach(() => {
    preferencesState.initial = { showQuickActions: false }
    preferencesState.updatePreferences.mockReset()
    workspacesState.data = []
    sessionWorkspacesState.data = []
    orderedSessionQueryState.data = []
    moveSessionMock.mockReset()
    mutateSetSessionWorkspace.mockReset()
    mutateRemoveSessionWorkspaces.mockReset()
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: null, toasts: [] })
  })

  const mkWs = (id: string, name: string): WorkspaceEntry => ({
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
  const bind = (sessionId: string, ws: WorkspaceEntry): SessionWorkspaceEntry => ({
    sessionId,
    hostId: 'local',
    workspaceId: ws.id,
    workspacePath: ws.path,
    rootId: ws.rootId,
    rootPath: ws.rootPath,
    rootLabel: ws.rootLabel,
    relativePath: ws.relativePath,
    updatedAt: '',
  })
  const mkSess = (id: string, name: string): PanelSession => ({ id, name, windowCount: 1 })
  const domBefore = (a: HTMLElement, b: HTMLElement) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const handlers = () => dndHandlers.current
  const dragStart = (activeId: string) => act(() => handlers().onDragStart?.({ active: { id: activeId } }))
  const dragOver = (activeId: string, overId: string) =>
    act(() => handlers().onDragOver?.({ active: { id: activeId }, over: { id: overId } }))
  const dragEnd = (activeId: string, overId: string | null) =>
    act(() => handlers().onDragEnd?.({ active: { id: activeId }, over: overId ? { id: overId } : null }))

  it('moves a session in the flat list and commits the full id order', () => {
    preferencesState.initial = { showQuickActions: false, hideWorkspaceGroups: true }
    // 持久序 alpha,gamma,beta：flat(manual) 按持久序展示（不套 attention 展示序）
    orderedSessionQueryState.data = [mkSess('s-a', 'alpha'), mkSess('s-c', 'gamma'), mkSess('s-b', 'beta')]
    render(<SessionPanel />)
    expect(domBefore(screen.getByText('gamma'), screen.getByText('beta'))).toBe(true)

    dragStart('s-b')
    dragOver('s-b', 's-c')
    // 预览序即时生效：beta 插到 gamma 前
    expect(domBefore(screen.getByText('beta'), screen.getByText('gamma'))).toBe(true)
    dragEnd('s-b', 's-c')

    expect(moveSessionMock).toHaveBeenCalledTimes(1)
    expect(moveSessionMock).toHaveBeenCalledWith(['s-a', 's-b', 's-c'])
    // flat 无跨组语义：不写归属
    expect(mutateSetSessionWorkspace).not.toHaveBeenCalled()
    expect(mutateRemoveSessionWorkspaces).not.toHaveBeenCalled()
  })

  it('skips the write when the flat preview equals the persisted order', () => {
    preferencesState.initial = { showQuickActions: false, hideWorkspaceGroups: true }
    orderedSessionQueryState.data = [mkSess('s-a', 'alpha'), mkSess('s-b', 'beta'), mkSess('s-c', 'gamma')]
    render(<SessionPanel />)

    // 行上按下又原地松手（DragOver 因 activeId===overId 提前返回，预览序 == 持久序）
    dragStart('s-b')
    dragEnd('s-b', 's-b')
    expect(moveSessionMock).not.toHaveBeenCalled()
    expect(mutateSetSessionWorkspace).not.toHaveBeenCalled()
  })

  it('writes workspace ownership and group order when dropping across groups', async () => {
    const ws = mkWs('ws-1', 'alpha-ws')
    workspacesState.data = [ws]
    orderedSessionQueryState.data = [mkSess('s-a', 'alpha'), mkSess('s-b', 'beta'), mkSess('s-c', 'gamma')]
    sessionWorkspacesState.data = [bind('s-a', ws), bind('s-c', ws)]
    mutateSetSessionWorkspace.mockResolvedValue({ ok: true })
    render(<SessionPanel />)

    // 未分类的 beta 拖到 ws-1 的 alpha 之前
    dragStart('s-b')
    dragOver('s-b', 's-a')
    dragEnd('s-b', 's-a')

    await waitFor(() =>
      expect(mutateSetSessionWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's-b',
          hostId: 'local',
          workspaceId: 'ws-1',
          workspacePath: '/workspace/ws-1',
          relativePath: 'ws-1',
        }),
      ),
    )
    // 全局序 = 各组预览序按显示顺序拼接（ws-1 在前，未分类沉底）
    expect(moveSessionMock).toHaveBeenCalledWith(['s-b', 's-a', 's-c'])
  })

  it('detaches workspace ownership when dropping into the unclassified group', async () => {
    const ws = mkWs('ws-1', 'alpha-ws')
    workspacesState.data = [ws]
    orderedSessionQueryState.data = [mkSess('s-a', 'alpha'), mkSess('s-c', 'gamma')]
    sessionWorkspacesState.data = [bind('s-a', ws), bind('s-c', ws)]
    mutateRemoveSessionWorkspaces.mockResolvedValue({ ok: true })
    render(<SessionPanel />)

    // 组容器 dropzone 的 id 形如 group:<key>，未分类组 key 为空串
    dragStart('s-a')
    dragOver('s-a', 'group:')
    dragEnd('s-a', 'group:')

    await waitFor(() => expect(mutateRemoveSessionWorkspaces).toHaveBeenCalledWith(['s-a']))
    expect(mutateSetSessionWorkspace).not.toHaveBeenCalled()
    expect(moveSessionMock).toHaveBeenCalledWith(['s-c', 's-a'])
  })

  it('passes no drag sensors when sorting is not manual', () => {
    preferencesState.initial = { showQuickActions: false, hideWorkspaceGroups: true, sessionSortMode: 'createdAt' }
    orderedSessionQueryState.data = [mkSess('s-a', 'alpha'), mkSess('s-c', 'gamma')]
    render(<SessionPanel />)
    // 非手动排序下拖拽禁用：sensors 传空数组，dnd 不会激活任何手势
    expect(handlers().sensors).toEqual([])
  })
})
