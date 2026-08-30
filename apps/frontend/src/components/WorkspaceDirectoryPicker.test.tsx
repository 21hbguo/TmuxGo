import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker'

const { promptMock, createDirectoryMock, refetchCurrent, refetchSelected } = vi.hoisted(() => ({ promptMock: vi.fn(), createDirectoryMock: vi.fn(), refetchCurrent: vi.fn(), refetchSelected: vi.fn() }))

vi.mock('@/hooks/useApi', () => ({
  useFileRoots: () => ({ data: [{ id: 'root-workspace', label: 'workspace', path: '/workspace' }] }),
  useFileList: (_hostId: string, _rootId: string, path: string) => ({
    data: path === 'src' ? { breadcrumbs: [{ name: '/', path: '' }, { name: 'src', path: 'src' }], items: [{ name: 'nested', path: 'src/nested', type: 'directory', size: 0, modifiedAt: '' }] } : { breadcrumbs: [{ name: '/', path: '' }], items: [{ name: 'src', path: 'src', type: 'directory', size: 0, modifiedAt: '' }, { name: 'README.md', path: 'README.md', type: 'file', size: 0, modifiedAt: '' }] },
    isLoading: false,
    isError: false,
    refetch: path ? refetchSelected : refetchCurrent,
  }),
}))
vi.mock('@/lib/api', () => ({
  api: { files: { createDirectory: createDirectoryMock } },
}))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: () => ({ prompt: promptMock, PromptElement: null }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('WorkspaceDirectoryPicker', () => {
  it('opens the selected directory as a workspace target', async () => {
    const onPick = vi.fn()
    render(<WorkspaceDirectoryPicker hostId="local" onPick={onPick} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('src'))
    fireEvent.click(await screen.findByText('nested'))
    fireEvent.click(screen.getByText('workspace.openDirectory'))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ rootId: 'root-workspace', rootPath: '/workspace', rootLabel: 'workspace', relativePath: 'src/nested', absolutePath: '/workspace/src/nested' }))
  })
  it('creates a directory in the selected root', async () => {
    promptMock.mockResolvedValueOnce('new-project')
    createDirectoryMock.mockResolvedValueOnce({ item: { name: 'new-project', path: 'new-project', type: 'directory' } })
    render(<WorkspaceDirectoryPicker hostId="local" onPick={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('file.newFolder'))
    await waitFor(() => expect(createDirectoryMock).toHaveBeenCalledWith('local', 'root-workspace', '', 'new-project'))
  })
})
