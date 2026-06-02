import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDrawer } from './MobileDrawer'
import { useConsoleStore } from '@/stores/useConsoleStore'

const mutateCreateSession = vi.fn()
const mutateRenameSession = vi.fn()
const mutateDeleteSession = vi.fn()
const mutateBatchDeleteSessions = vi.fn()
const promptMock = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  useSessions: () => ({ data: [{ id: 'session-dev', name: 'dev', windowCount: 2 }, { id: 'session-next', name: 'next', windowCount: 1 }] }),
  useCreateSession: () => ({ mutateAsync: mutateCreateSession }),
  useRenameSession: () => ({ mutateAsync: mutateRenameSession }),
  useDeleteSession: () => ({ mutateAsync: mutateDeleteSession }),
  useBatchDeleteSessions: () => ({ mutateAsync: mutateBatchDeleteSessions }),
  useWindows: () => ({ data: [] }),
}))
vi.mock('@/hooks/useWindowQueryState', () => ({
  useWindowQueryState: () => ({ getWindows: () => [], setWindows: vi.fn() }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: [{ id: 'session-dev', name: 'dev', windowCount: 2 }, { id: 'session-next', name: 'next', windowCount: 1 }], moveSession: vi.fn() }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, string | number>) => {
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
    return key
  } }),
}))
vi.mock('./SessionTemplates', () => ({
  SessionTemplates: () => React.createElement('div'),
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
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null,
}))
vi.mock('./SessionSortableList', () => ({
  SessionSortableList: ({ sessions, renderItem }: { sessions: any[]; renderItem: (args: { session: any; isDragging: boolean; isOverlay: boolean }) => React.ReactNode }) => React.createElement('div', null, sessions.map((session) => React.createElement('div', { key: session.id }, renderItem({ session, isDragging: false, isOverlay: false })))),
}))

describe('MobileDrawer session actions', () => {
  beforeEach(() => {
    mutateCreateSession.mockReset()
    mutateRenameSession.mockReset()
    mutateDeleteSession.mockReset()
    mutateBatchDeleteSessions.mockReset()
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
    expect(screen.getByLabelText('Rename session')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete session')).toBeInTheDocument()
  })

  it('renames the active session from the mobile action button', async () => {
    promptMock.mockResolvedValueOnce('dev-renamed')
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    fireEvent.click(screen.getByLabelText('Rename session'))
    await waitFor(() => expect(mutateRenameSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev', name: 'dev-renamed' }))
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-renamed'))
  })

  it('deletes the active session from the mobile action button', async () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    fireEvent.click(screen.getByLabelText('Delete session'))
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
