import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDrawer } from './MobileDrawer'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { api } from '@/lib/api'

const mutateCreateSession = vi.fn()
const mutateRenameSession = vi.fn()
const mutateDeleteSession = vi.fn()
const mutateBatchDeleteSessions = vi.fn()
const mutateCreateWindow = vi.fn()
const mutateBatchKillWindows = vi.fn()
const mutateSetSessionWorkspace = vi.fn()
const mutateRemoveSessionWorkspaces = vi.fn()
const mutateMigrateSessionWorkspace = vi.fn()
const promptMock = vi.fn()

let windowsMock: any[] = []
let panesMock: any[] = []

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  useSessions: () => ({
    data: [
      { id: 'session-dev', name: 'dev', windowCount: 2 },
      { id: 'session-next', name: 'next', windowCount: 1 },
    ],
  }),
  useCreateSession: () => ({ mutateAsync: mutateCreateSession }),
  useRenameSession: () => ({ mutateAsync: mutateRenameSession }),
  useDeleteSession: () => ({ mutateAsync: mutateDeleteSession }),
  useBatchDeleteSessions: () => ({ mutateAsync: mutateBatchDeleteSessions }),
  useCreateWindow: () => ({ mutateAsync: mutateCreateWindow, isPending: false }),
  useBatchKillWindows: () => ({ mutateAsync: mutateBatchKillWindows, isPending: false }),
  useWindows: () => ({ data: windowsMock }),
  useSessionPanes: () => ({ data: panesMock }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => windowsMock, setWindows: vi.fn() }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({
    data: [
      { id: 'session-dev', name: 'dev', windowCount: 2 },
      { id: 'session-next', name: 'next', windowCount: 1 },
    ],
    moveSession: vi.fn(),
  }),
}))
vi.mock('@/hooks/useSessionWorkspaces', () => ({
  useSetSessionWorkspace: () => ({ mutateAsync: mutateSetSessionWorkspace }),
  useRemoveSessionWorkspaces: () => ({ mutateAsync: mutateRemoveSessionWorkspaces }),
  useMigrateSessionWorkspace: () => ({ mutateAsync: mutateMigrateSessionWorkspace }),
}))
vi.mock('@/hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ data: [] }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'drawer.sessions') return 'Sessions'
      if (key === 'drawer.panes') return 'Panes'
      if (key === 'drawer.windows') return `${params?.count || 0} windows`
      if (key === 'drawer.renamePrompt') return 'Rename session:'
      if (key === 'drawer.sessionName') return 'Session name:'
      if (key === 'sidebar.newSession') return '+ New Session'
      if (key === 'sidebar.renameSession') return 'Rename session'
      if (key === 'sidebar.deleteSession') return 'Delete session'
      if (key === 'sidebar.reorderSession') return 'Reorder session'
      if (key === 'sidebar.deleteTitle') return 'Delete session'
      if (key === 'sidebar.deleteConfirm') return `Delete ${params?.name || ''}?`
      if (key === 'sidebar.confirmDelete') return 'Delete'
      if (key === 'common.cancel') return 'Cancel'
      if (key === 'drawer.windowsTitle') return 'Windows'
      if (key === 'drawer.expandPanes') return 'Expand panes'
      if (key === 'drawer.collapsePanes') return 'Collapse panes'
      if (key === 'drawer.paneCount') return `${params?.count || 0} panes`
      if (key === 'window.batchMode') return 'Batch'
      if (key === 'window.batchCancel') return 'Exit batch'
      if (key === 'window.batchSelectAll') return 'Select all'
      if (key === 'window.batchClearAll') return 'Clear'
      if (key === 'window.batchDeleteSelected') return `Delete (${params?.count || 0})`
      if (key === 'window.cannotDeleteActive') return 'Active window cannot be deleted'
      if (key === 'window.switchFailed') return 'Switch window failed'
      if (key === 'pane.switchFailed') return 'Failed to switch pane'
      return key
    },
  }),
}))
vi.mock('./SessionTemplates', () => ({
  SessionTemplates: () => React.createElement('div'),
}))
vi.mock('./CreateSessionDialog', () => ({
  CreateSessionDialog: () => null,
}))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: () => ({
    prompt: promptMock,
    PromptElement: null,
  }),
}))
vi.mock('./QuickActions', () => ({
  QuickActions: () => React.createElement('div'),
}))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null,
}))
vi.mock('./SessionSortableList', () => ({
  SessionSortableList: ({
    sessions,
    renderItem,
  }: {
    sessions: any[]
    renderItem: (args: { session: any; isDragging: boolean; isOverlay: boolean }) => React.ReactNode
  }) =>
    React.createElement(
      'div',
      null,
      sessions.map((session) =>
        React.createElement('div', { key: session.id }, renderItem({ session, isDragging: false, isOverlay: false })),
      ),
    ),
  SessionStandaloneSortableList: ({
    sessions,
    renderItem,
  }: {
    sessions: any[]
    renderItem: (args: { session: any; isDragging: boolean; isOverlay: boolean }) => React.ReactNode
  }) =>
    React.createElement(
      'div',
      null,
      sessions.map((session) =>
        React.createElement('div', { key: session.id }, renderItem({ session, isDragging: false, isOverlay: false })),
      ),
    ),
}))

describe('MobileDrawer session actions', () => {
  beforeEach(() => {
    mutateCreateSession.mockReset()
    mutateRenameSession.mockReset()
    mutateDeleteSession.mockReset()
    mutateBatchDeleteSessions.mockReset()
    mutateCreateWindow.mockReset()
    mutateBatchKillWindows.mockReset()
    mutateSetSessionWorkspace.mockReset()
    mutateRemoveSessionWorkspaces.mockReset()
    mutateMigrateSessionWorkspace.mockReset()
    promptMock.mockReset()
    mutateRenameSession.mockResolvedValue({ id: 'session-dev-renamed' })
    mutateDeleteSession.mockResolvedValue({ success: true })
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev',
      toasts: [],
    } as any)
  })

  it('renders visible rename and delete buttons for each mobile session row', () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    expect(screen.getAllByLabelText('Rename session')).toHaveLength(2)
    expect(screen.getAllByLabelText('Delete session')).toHaveLength(2)
  })

  it('renames the active session from the mobile action button', async () => {
    promptMock.mockResolvedValueOnce('dev-renamed')
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
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

  it('deletes the active session from the mobile action button', async () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    fireEvent.click(screen.getAllByLabelText('Delete session')[0])
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateDeleteSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev' }))
  })

  it('switches to the next session after deleting the active session', async () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    fireEvent.click(screen.getAllByLabelText('Delete session')[0])
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateDeleteSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev' }))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-next'))
  })
})

describe('MobileDrawer windows pane list', () => {
  beforeEach(() => {
    windowsMock = [
      { id: 'local:@1', sessionId: 'session-dev', name: 'editor', index: 0, active: true },
      { id: 'local:@2', sessionId: 'session-dev', name: 'logs', index: 1, active: false },
    ]
    panesMock = [
      { id: 'local:%1', windowId: 'local:@1', index: 0, title: 'vim', active: true },
      { id: 'local:%2', windowId: 'local:@2', index: 0, title: 'top', active: false },
      { id: 'local:%3', windowId: 'local:@2', index: 1, title: '', active: false },
    ]
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev',
      activePaneId: 'local:%1',
      toasts: [],
    } as any)
    vi.spyOn(api.windows, 'select').mockResolvedValue({})
    vi.spyOn(api.panes, 'select').mockResolvedValue({})
    vi.spyOn(api.snapshot, 'get').mockResolvedValue({
      sessionId: 'session-dev',
      sessionName: 'dev',
      windows: windowsMock,
      panes: panesMock,
      activeWindowId: 'local:@1',
      activePaneId: 'local:%1',
    })
    return () => vi.restoreAllMocks()
  })

  it('expands the active window by default and collapses others', () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="windows" />)
    expect(screen.getByText('vim')).toBeTruthy()
    expect(screen.queryByText('top')).toBeNull()
    expect(screen.getByLabelText('Collapse panes')).toBeTruthy()
    expect(screen.getByLabelText('Expand panes')).toBeTruthy()
  })

  it('chevron toggles pane rows without selecting the window', () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="windows" />)
    fireEvent.click(screen.getByLabelText('Collapse panes'))
    expect(screen.queryByText('vim')).toBeNull()
    // 收起 @1 后两个窗口均为 Expand，第二个 chevron 属于 @2
    fireEvent.click(screen.getAllByLabelText('Expand panes')[1])
    expect(screen.getByText('top')).toBeTruthy()
    expect(api.windows.select).not.toHaveBeenCalled()
  })

  it('selects window before pane when tapping a pane in another window', async () => {
    const onClose = vi.fn()
    render(<MobileDrawer isOpen onClose={onClose} type="windows" />)
    fireEvent.click(screen.getByLabelText('Expand panes'))
    fireEvent.click(screen.getByText('top'))
    await waitFor(() => expect(api.panes.select).toHaveBeenCalledWith('local:%2'))
    expect(api.windows.select).toHaveBeenCalledWith('local', 'session-dev', 'local:@2')
    expect(vi.mocked(api.windows.select).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.panes.select).mock.invocationCallOrder[0],
    )
    await waitFor(() => expect(useConsoleStore.getState().activePaneId).toBe('local:%2'))
    expect(onClose).toHaveBeenCalled()
  })

  it('skips window select when the pane is already in the active window', async () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="windows" />)
    fireEvent.click(screen.getByText('vim'))
    await waitFor(() => expect(api.panes.select).toHaveBeenCalledWith('local:%1'))
    expect(api.windows.select).not.toHaveBeenCalled()
  })

  it('renders pane count badge and shell fallback title', () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="windows" />)
    expect(screen.getByLabelText('2 panes')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Expand panes'))
    expect(screen.getByText('shell')).toBeTruthy()
  })

  it('does not render pane rows or chevrons in window batch mode', () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="windows" />)
    fireEvent.click(screen.getByText('Batch'))
    expect(screen.queryByText('vim')).toBeNull()
    expect(screen.queryByLabelText('Expand panes')).toBeNull()
    expect(screen.queryByLabelText('Collapse panes')).toBeNull()
    expect(screen.getByText('Select all')).toBeTruthy()
  })
})
