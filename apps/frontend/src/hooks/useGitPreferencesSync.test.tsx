import { act, render, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitPreferencesSync } from './useGitPreferencesSync'
import { useConsoleStore } from '@/stores/useConsoleStore'

const getMock = vi.fn()
const updateMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    preferences: {
      get: (...args: unknown[]) => getMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}))

function TestComponent() {
  useGitPreferencesSync()
  return React.createElement('div')
}

describe('useGitPreferencesSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    updateMock.mockResolvedValue({})
    useConsoleStore.setState({ gitByHost: {} } as any)
  })

  it('hydrates remote git state without immediately pushing it back', async () => {
    getMock.mockResolvedValue({
      gitByHost: {
        local: {
          mode: 'follow-editor',
          currentRepoPath: '/workspace/app',
          currentFilePath: null,
          source: 'pane',
          lockedRepoPath: null,
          recentRepos: [{ repoPath: '/workspace/app', label: 'app', lastUsedAt: 1, pinned: false }],
        },
      },
      gitByHostUpdatedAt: '2026-06-02T00:00:00.000Z',
    })
    render(React.createElement(TestComponent))
    await act(async () => {
      await Promise.resolve()
    })
    expect(useConsoleStore.getState().gitByHost.local?.currentRepoPath).toBe('/workspace/app')
    expect(useConsoleStore.getState().gitByHost.local?.source).toBe('pane')
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('debounces git state writes and only pushes the latest snapshot', async () => {
    vi.useRealTimers()
    getMock.mockResolvedValue({ gitByHost: {}, gitByHostUpdatedAt: '2026-06-02T00:00:00.000Z' })
    render(React.createElement(TestComponent))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getMock).toHaveBeenCalled()
    await act(async () => {
      useConsoleStore.getState().setGitLockedRepo('local', '/workspace/app')
      useConsoleStore.getState().setGitLockedRepo('local', '/workspace/other')
    })
    expect(updateMock).not.toHaveBeenCalled()
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1), { timeout: 1200 })
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      gitByHost: {
        local: {
          currentRepoPath: '/workspace/other',
          lockedRepoPath: '/workspace/other',
          mode: 'locked',
        },
      },
    })
  })
})
