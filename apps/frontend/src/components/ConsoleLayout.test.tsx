import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleLayout } from './ConsoleLayout'
import { useConsoleStore } from '@/stores/useConsoleStore'

let snapshotDataMock:any={ windows: [], panes: [], activePaneId: null }
let sessionsDataMock:any[]=[]
const renameSessionMock = vi.fn()
const deleteSessionMock = vi.fn()

vi.mock('./TopBar', () => ({ TopBar: () => React.createElement('div') }))
vi.mock('./PaneGrid', () => ({ PaneGrid: () => React.createElement('div') }))
vi.mock('./StatusBar', () => ({ StatusBar: () => React.createElement('div') }))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => React.createElement('div') }))
vi.mock('./ClipboardController', () => ({ ClipboardController: () => React.createElement('div') }))
vi.mock('./MobileNav', () => ({ MobileNav: ({ onOpenFiles }: { onOpenFiles: () => void }) => React.createElement('button', { onClick: onOpenFiles }, 'open-files') }))
vi.mock('./MobileDrawer', () => ({ MobileDrawer: () => React.createElement('div') }))
vi.mock('./Settings', () => ({ Settings: ({ onClose }: { onClose: () => void }) => React.createElement('button', { onClick: onClose }, 'close-settings') }))
vi.mock('./InstallAppBanner', () => ({ InstallAppBanner: () => React.createElement('div') }))
vi.mock('./ShortcutBar', () => ({ ShortcutBar: () => React.createElement('div', null, 'shortcut-bar') }))
vi.mock('./ToastViewport', () => ({ ToastViewport: () => React.createElement('div') }))
vi.mock('./UploadConfirmDialog', () => ({ UploadConfirmDialog: () => React.createElement('div') }))
vi.mock('./UploadQueue', () => ({ UploadQueue: () => React.createElement('div') }))
vi.mock('./AppVersionGuard', () => ({ AppVersionGuard: () => React.createElement('div') }))
vi.mock('./DesktopWorkbench', () => ({ DesktopWorkbench: () => React.createElement('div') }))
vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => ({ preferences: { showStatusBar: false } }) }))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  useSessions: () => ({ data: [], isFetched: true }),
  useSessionSnapshot: () => ({ data: snapshotDataMock }),
  useRenameSession: () => ({ mutateAsync: renameSessionMock }),
  useDeleteSession: () => ({ mutateAsync: deleteSessionMock }),
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({ data: sessionsDataMock, isFetched: true }),
}))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: () => ({ prompt: vi.fn(), PromptElement: null }),
}))
vi.mock('./FilePanel', () => ({
  FilePanel: () => React.createElement('div', null,
    React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-push-level')) }, 'push-level'),
    React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: { handled: true } })) }, 'consume-back'),
  ),
}))

describe('ConsoleLayout mobile files overlay stack', () => {
  beforeEach(() => {
    snapshotDataMock={ windows: [], panes: [], activePaneId: null }
    sessionsDataMock=[]
    renameSessionMock.mockReset()
    deleteSessionMock.mockReset()
    window.localStorage.clear()
    useConsoleStore.setState({
      activeHostId: null,
      activeSessionId: null,
      activePaneId: null,
      showCommandPalette: false,
      sessionPanelExpanded: false,
      filePanelOpen: false,
      mobileFileSheetOpen: false,
      toasts: [],
      connection: { status: 'disconnected', latency: 0, lastPing: new Date().toISOString() },
    } as any)
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    Object.defineProperty(window, 'visualViewport', {
      writable: true,
      value: { height: 800, width: 390, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })
  })
  it('restores active pane from snapshot after switching session', async () => {
    sessionsDataMock=[{ id:'session-a',name:'A' },{ id:'session-b',name:'B' }]
    snapshotDataMock={ windows: [], panes: [{ id: 'pane-a', active: true }], activePaneId: 'pane-a' }
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-a', activePaneId: 'pane-a' } as any)
    const view=render(React.createElement(ConsoleLayout, { initialIsMobile: false }))
    await waitFor(() => expect(useConsoleStore.getState().activePaneId).toBe('pane-a'))
    snapshotDataMock={ windows: [], panes: [{ id: 'pane-b', active: true }], activePaneId: 'pane-b' }
    useConsoleStore.getState().setActiveSession('session-b')
    expect(useConsoleStore.getState().activePaneId).toBeNull()
    view.rerender(React.createElement(ConsoleLayout, { initialIsMobile: false }))
    await waitFor(() => expect(useConsoleStore.getState().activePaneId).toBe('pane-b'))
  })
  it('allows repeated mobile file levels and pops them one by one', async () => {
    const backSpy = vi.spyOn(window.history, 'back')
    render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    fireEvent.click(screen.getByText('open-files'))
    expect(useConsoleStore.getState().mobileFileSheetOpen).toBe(true)
    fireEvent.click(await screen.findByText('push-level'))
    fireEvent.click(screen.getByText('push-level'))
    expect(backSpy).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(useConsoleStore.getState().mobileFileSheetOpen).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(useConsoleStore.getState().mobileFileSheetOpen).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await waitFor(() => expect(useConsoleStore.getState().mobileFileSheetOpen).toBe(false))
  })
  it('closes settings from backdrop handler after opening from global event', async () => {
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    render(React.createElement(ConsoleLayout, { initialIsMobile: false }))
    window.dispatchEvent(new CustomEvent('tmuxgo-open-settings'))
    fireEvent.click(await screen.findByText('close-settings'))
    await waitFor(() => expect(screen.queryByText('close-settings')).toBeNull())
    expect(backSpy).toHaveBeenCalledTimes(1)
  })
  it('restores mobile nav after keyboard closes', async () => {
    render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    expect(screen.getByText('open-files')).toBeTruthy()
    document.body.classList.add('keyboard-open')
    window.dispatchEvent(new CustomEvent('mobile-keyboard-change', { detail: { open: true, inset: 280 } }))
    await waitFor(() => expect(screen.getByText('shortcut-bar')).toBeTruthy())
    expect(screen.getByText('open-files').parentElement?.className).toContain('hidden')
    document.body.classList.remove('keyboard-open')
    window.dispatchEvent(new CustomEvent('mobile-keyboard-change', { detail: { open: false, inset: 0 } }))
    await waitFor(() => expect(screen.getByText('open-files')).toBeTruthy())
    expect(screen.getByText('open-files').parentElement?.className).not.toContain('hidden')
  })
  it('does not render quick session bar when there are no sessions', () => {
    render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull()
  })
  it('renders up to available sessions when fewer than five exist', async () => {
    sessionsDataMock=[{ id:'session-a',name:'alpha' },{ id:'session-b',name:'beta' }]
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-a' } as any)
    render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'beta' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'gamma' })).toBeNull()
  })
  it('limits quick session bar to five most recent sessions and keeps it visible above shortcut bar', async () => {
    sessionsDataMock=[
      { id:'session-a',name:'alpha' },
      { id:'session-b',name:'beta' },
      { id:'session-c',name:'gamma' },
      { id:'session-d',name:'delta' },
      { id:'session-e',name:'epsilon' },
      { id:'session-f',name:'zeta' },
    ]
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-a' } as any)
    const view=render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'epsilon' }))
    view.rerender(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'epsilon' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'epsilon' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'beta' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'gamma' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'delta' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'zeta' })).toBeNull()
    document.body.classList.add('keyboard-open')
    window.dispatchEvent(new CustomEvent('mobile-keyboard-change', { detail: { open: true, inset: 280 } }))
    await waitFor(() => expect(screen.getByText('shortcut-bar')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'epsilon' })).toBeTruthy()
  })
  it('opens quick session menu from context menu and can jump to sessions drawer', async () => {
    sessionsDataMock=[{ id:'session-a',name:'alpha' }]
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-a' } as any)
    render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    const sessionButton = await screen.findByRole('button', { name: 'alpha' })
    fireEvent.contextMenu(sessionButton)
    expect(screen.getByText('nav.sessions')).toBeTruthy()
    fireEvent.click(screen.getByText('nav.sessions'))
  })
  it('keeps pinned quick sessions ahead of recent sessions', async () => {
    sessionsDataMock=[
      { id:'session-a',name:'alpha' },
      { id:'session-b',name:'beta' },
      { id:'session-c',name:'gamma' },
      { id:'session-d',name:'delta' },
      { id:'session-e',name:'epsilon' },
      { id:'session-f',name:'zeta' },
    ]
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-a' } as any)
    const view=render(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    const betaButton = await screen.findByRole('button', { name: 'beta' })
    fireEvent.contextMenu(betaButton)
    fireEvent.click(screen.getByText('mobile.quickSessionPin'))
    view.rerender(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    expect(screen.getByRole('button', { name: '★ beta' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'epsilon' }))
    view.rerender(React.createElement(ConsoleLayout, { initialIsMobile: true }))
    const buttons = screen.getAllByRole('button').map((item) => item.textContent)
    expect(buttons.indexOf('★ beta')).toBeLessThan(buttons.indexOf('epsilon'))
  })
})
