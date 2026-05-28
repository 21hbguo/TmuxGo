import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleLayout } from './ConsoleLayout'
import { useConsoleStore } from '@/stores/useConsoleStore'

vi.mock('./TopBar', () => ({ TopBar: () => React.createElement('div') }))
vi.mock('./PaneGrid', () => ({ PaneGrid: () => React.createElement('div') }))
vi.mock('./StatusBar', () => ({ StatusBar: () => React.createElement('div') }))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => React.createElement('div') }))
vi.mock('./ClipboardController', () => ({ ClipboardController: () => React.createElement('div') }))
vi.mock('./MobileNav', () => ({ MobileNav: ({ onOpenFiles }: { onOpenFiles: () => void }) => React.createElement('button', { onClick: onOpenFiles }, 'open-files') }))
vi.mock('./MobileDrawer', () => ({ MobileDrawer: () => React.createElement('div') }))
vi.mock('./Settings', () => ({ Settings: () => React.createElement('div') }))
vi.mock('./InstallAppBanner', () => ({ InstallAppBanner: () => React.createElement('div') }))
vi.mock('./ShortcutBar', () => ({ ShortcutBar: () => React.createElement('div') }))
vi.mock('./ToastViewport', () => ({ ToastViewport: () => React.createElement('div') }))
vi.mock('./UploadConfirmDialog', () => ({ UploadConfirmDialog: () => React.createElement('div') }))
vi.mock('./UploadQueue', () => ({ UploadQueue: () => React.createElement('div') }))
vi.mock('./AppVersionGuard', () => ({ AppVersionGuard: () => React.createElement('div') }))
vi.mock('./DesktopWorkbench', () => ({ DesktopWorkbench: () => React.createElement('div') }))
vi.mock('@/hooks/usePreferences', () => ({ usePreferences: () => ({ preferences: { showStatusBar: false } }) }))
vi.mock('@/hooks/useApi', () => ({
  useHosts: () => ({ data: [{ id: 'local', name: 'Local', address: '127.0.0.1', status: 'online', tags: [] }] }),
  useSessions: () => ({ data: [] }),
  useSessionSnapshot: () => ({ data: { windows: [], panes: [], activePaneId: null } }),
}))
vi.mock('./FilePanel', () => ({
  FilePanel: () => React.createElement('div', null,
    React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-push-level')) }, 'push-level'),
    React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('tmuxgo-mobile-files-back', { detail: { handled: true } })) }, 'consume-back'),
  ),
}))

describe('ConsoleLayout mobile files overlay stack', () => {
  beforeEach(() => {
    useConsoleStore.setState({
      activeHostId: null,
      activeSessionId: null,
      activePaneId: null,
      showCommandPalette: false,
      sessionPanelExpanded: false,
      filePanelOpen: false,
      mobileFileSheetOpen: false,
      panes: [],
      windows: [],
      sessions: [],
      hosts: [],
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
})
