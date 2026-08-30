import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CreateSessionDialog } from './CreateSessionDialog'
import { I18nProvider } from '@/i18n'

vi.mock('@/hooks/useWorkspaces', () => ({ useCreateWorkspace: () => ({ mutateAsync: vi.fn() }) }))
vi.mock('@/hooks/usePrompt', () => ({ usePrompt: () => ({ prompt: vi.fn(), PromptElement: null }) }))
vi.mock('./FilePanel', () => ({ FilePanel: () => null }))
const { pushToastMock } = vi.hoisted(() => ({ pushToastMock: vi.fn() }))
vi.mock('@/stores/useConsoleStore', () => ({ useConsoleStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ pushToast: pushToastMock }) }))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
})

const template = { id: 'default', name: 'Default', description: '', layout: { windows: [{ name: 'main', panes: [{}] }] } }
const workspace = { id: 'ws-1', name: 'tmuxgo', hostId: 'local', path: '/home/guo/project/other/TmuxGo', rootId: 'root-1', rootPath: '/home/guo', rootLabel: 'TmuxGo', relativePath: 'project/other/TmuxGo', templateId: null, createdAt: '', updatedAt: '' }
const renderDialog = (props: Record<string, unknown>) => render(React.createElement(I18nProvider, null, React.createElement(CreateSessionDialog, props as any)))

afterEach(cleanup)

describe('CreateSessionDialog workspace cwd', () => {
  it('submits the workspace path as cwd when opened from a workspace', async () => {
    const onCreate = vi.fn(async () => {})
    renderDialog({ open: true, template, defaultName: 'tmuxgo-default', hostId: 'local', workspaces: [workspace], initialWorkspace: workspace, onCreate, onClose: vi.fn() })
    await act(async () => {})
    fireEvent.change(screen.getByPlaceholderText(/会话名称/), { target: { value: 'new-session' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await act(async () => {})
    expect(onCreate).toHaveBeenCalledWith({ name: 'new-session', cwd: '/home/guo/project/other/TmuxGo', workspace: expect.objectContaining({ absolutePath: '/home/guo/project/other/TmuxGo', workspaceId: 'ws-1' }) })
  })
  it('keeps the selected workspace fixed', async () => {
    renderDialog({ open: true, template, defaultName: 'tmuxgo-default', hostId: 'local', workspaces: [workspace], initialWorkspace: workspace, workspaceLocked: true, onCreate: vi.fn(), onClose: vi.fn() })
    await act(async () => {})
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
  it('submits without cwd when no workspace is selected', async () => {
    const onCreate = vi.fn(async () => {})
    renderDialog({ open: true, template, defaultName: 'plain', hostId: 'local', workspaces: [workspace], onCreate, onClose: vi.fn() })
    await act(async () => {})
    fireEvent.change(screen.getByPlaceholderText(/会话名称/), { target: { value: 'plain-session' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await act(async () => {})
    expect(onCreate).toHaveBeenCalledWith({ name: 'plain-session', cwd: undefined, workspace: undefined })
  })
  it('blocks submit and toasts when the selected workspace has no path', async () => {
    pushToastMock.mockClear()
    const onCreate = vi.fn(async () => {})
    const brokenWorkspace = { ...workspace, path: '' }
    renderDialog({ open: true, template, defaultName: 'broken', hostId: 'local', workspaces: [brokenWorkspace], initialWorkspace: brokenWorkspace, onCreate, onClose: vi.fn() })
    await act(async () => {})
    fireEvent.change(screen.getByPlaceholderText(/会话名称/), { target: { value: 'broken-session' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await act(async () => {})
    expect(onCreate).not.toHaveBeenCalled()
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })
})
