import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDrawer } from './MobileDrawer'
import { useConsoleStore } from '@/stores/useConsoleStore'

const mutateCreateSession = vi.fn()
const mutateRenameSession = vi.fn()
const mutateDeleteSession = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useSessions: () => ({ data: [{ id: 'session-dev', name: 'dev', windowCount: 2 }] }),
  useCreateSession: () => ({ mutateAsync: mutateCreateSession }),
  useRenameSession: () => ({ mutateAsync: mutateRenameSession }),
  useDeleteSession: () => ({ mutateAsync: mutateDeleteSession }),
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
vi.mock('./QuickActions', () => ({
  QuickActions: () => React.createElement('div'),
}))
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? React.createElement('button', { onClick: onConfirm }, 'confirm-delete') : null,
}))

describe('MobileDrawer session actions', () => {
  beforeEach(() => {
    mutateCreateSession.mockReset()
    mutateRenameSession.mockReset()
    mutateDeleteSession.mockReset()
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
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('dev-renamed')
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    fireEvent.click(screen.getByLabelText('Rename session'))
    expect(mutateRenameSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev', name: 'dev-renamed' })
    await waitFor(() => expect(useConsoleStore.getState().activeSessionId).toBe('session-dev-renamed'))
    promptSpy.mockRestore()
  })

  it('deletes the active session from the mobile action button', async () => {
    render(<MobileDrawer isOpen onClose={vi.fn()} type="sessions" />)
    fireEvent.click(screen.getByLabelText('Delete session'))
    fireEvent.click(screen.getByText('confirm-delete'))
    await waitFor(() => expect(mutateDeleteSession).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'session-dev' }))
  })
})
