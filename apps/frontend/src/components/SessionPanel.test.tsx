import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPanel } from './SessionPanel'
import { useConsoleStore } from '@/stores/useConsoleStore'

const mutateCreateSession = vi.fn()
const mutateRenameSession = vi.fn()
const mutateDeleteSession = vi.fn()
const mutateBatchDeleteSessions = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  useSessions: () => ({ data: [{ id: 'session-dev', name: 'dev', windowCount: 2 }] }),
  useCreateSession: () => ({ mutateAsync: mutateCreateSession }),
  useRenameSession: () => ({ mutateAsync: mutateRenameSession }),
  useDeleteSession: () => ({ mutateAsync: mutateDeleteSession }),
  useBatchDeleteSessions: () => ({ mutateAsync: mutateBatchDeleteSessions }),
}))
vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { showQuickActions: false } }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: [{ id: 'session-dev', name: 'dev', windowCount: 2 }], moveSession: vi.fn() }),
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
    if (key === 'drawer.sessionName') return 'Session name:'
    if (key === 'drawer.renamePrompt') return 'Rename session:'
    if (key === 'common.cancel') return 'Cancel'
    return key
  } }),
}))
vi.mock('./SessionTemplates', () => ({
  SessionTemplates: ({ onSelect }: { onSelect: (template: { id: string; name: string; layout: { windows: { name: string; panes: {}[] }[] } }) => void }) => React.createElement('button', { onClick: () => onSelect({ id: 'default', name: 'default', layout: { windows: [{ name: 'main', panes: [{}] }] } }) }, 'select-template'),
}))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null,
}))
vi.mock('./QuickActions', () => ({
  QuickActions: () => React.createElement('div'),
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
    mutateRenameSession.mockResolvedValue({ id: 'session-dev-renamed' })
    useConsoleStore.setState({
      activeHostId: 'local',
      activeSessionId: 'session-dev',
      toasts: [],
    } as any)
  })

  it('renames the active session from the desktop rename button', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('dev-renamed')
    render(<SessionPanel />)
    fireEvent.click(screen.getByLabelText('Rename session'))
    expect(mutateRenameSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev', name: 'dev-renamed' })
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-renamed'))
    promptSpy.mockRestore()
  })

  it('renames the session on double click', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('dev-double')
    mutateRenameSession.mockResolvedValueOnce({ id: 'session-dev-double' })
    render(<SessionPanel />)
    fireEvent.doubleClick(screen.getByText('dev'))
    expect(mutateRenameSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev', name: 'dev-double' })
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-double'))
    promptSpy.mockRestore()
  })

  it('activates the newly created session', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('default')
    mutateCreateSession.mockResolvedValueOnce({ id: 'session-default', name: 'default', windowCount: 1 })
    render(<SessionPanel />)
    fireEvent.click(screen.getByText('New'))
    fireEvent.click(screen.getByText('select-template'))
    expect(mutateCreateSession).toHaveBeenCalledWith({ hostId: 'local', name: 'default', layout: expect.any(Object) })
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-default'))
    promptSpy.mockRestore()
  })
})
