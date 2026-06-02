import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GitPanel } from './GitPanel'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const useGitLogMock = vi.fn()
const useGitBranchesMock = vi.fn()

vi.mock('@/hooks/useApi', () => ({
  useGitStatus: () => ({ data: { branch: 'main', ahead: 1, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] } }),
  useGitStage: () => ({ mutate: vi.fn() }),
  useGitUnstage: () => ({ mutate: vi.fn() }),
  useGitCommit: () => ({ mutate: vi.fn() }),
  useGitDiscard: () => ({ mutate: vi.fn() }),
  useGitLog: (...args: any[]) => useGitLogMock(...args),
  useGitBranches: (...args: any[]) => useGitBranchesMock(...args),
  useGitCheckout: () => ({ mutate: vi.fn() }),
  useGitCreateBranch: () => ({ mutate: vi.fn() }),
  useGitDeleteBranch: () => ({ mutate: vi.fn() }),
  useGitMerge: () => ({ mutate: vi.fn() }),
  useGitFetch: () => ({ mutate: vi.fn() }),
  useGitPull: () => ({ mutate: vi.fn() }),
  useGitPush: () => ({ mutate: vi.fn() }),
}))

describe('GitPanel', () => {
  beforeEach(() => {
    class MockIntersectionObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver as any)
    useGitLogMock.mockReturnValue({ data: { commits: [{ hash: 'a1', shortHash: 'a1', subject: 'first', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-01T00:00:00Z', date: '2024-01-01T00:00:00Z', parents: [] }, { hash: 'b2', shortHash: 'b2', subject: 'second', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-02T00:00:00Z', date: '2024-01-02T00:00:00Z', parents: ['a1'] }], hasMore: false }, isLoading: false })
    useGitBranchesMock.mockReturnValue({ data: { current: 'main', branches: [{ name: 'main', current: true, commitHash: 'b2', lastCommitSubject: 'second' }] } })
    useConsoleStore.setState({
      activeHostId: 'local',
      gitByHost: {
        local: {
          mode: 'follow-editor',
          currentRepoPath: '/workspace/app',
          currentFilePath: '/workspace/app/src/index.ts',
          source: 'editor',
          lockedRepoPath: null,
          recentRepos: [],
        },
      },
      toasts: [],
      connection: { status: 'disconnected', latency: 0, lastPing: new Date().toISOString() },
    } as any)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders git history rows and opens commit diff from click', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByText('历史'))
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
    await user.click(screen.getByText('second'))
    expect(useConsoleStore.getState().openEditors.at(-1)).toMatchObject({ id: expect.stringContaining('git-diff?'), language: 'diff', rootPath: '/workspace/app', name: 'b2 second' })
  })

  it('ignores invalid commit entries in history data', async () => {
    useGitLogMock.mockReturnValue({ data: { commits: [null, { shortHash: 'x1', subject: 'broken', body: '', author: '', authorEmail: 'dev@test', authorDate: '', date: '', parents: [] }, { hash: 'a1', shortHash: 'a1', subject: 'first', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-01T00:00:00Z', date: '2024-01-01T00:00:00Z', parents: [] }, undefined, { hash: 'b2', shortHash: 'b2', subject: 'second', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-02T00:00:00Z', date: '2024-01-02T00:00:00Z', parents: ['a1'] }] as any, hasMore: false }, isLoading: false })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByText('历史'))
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.queryByText('broken')).toBeNull()
  })

  it('filters invalid dates and unreachable branch heads from history graph data', async () => {
    useGitLogMock.mockReturnValue({ data: { commits: [
      { hash: 'a1', shortHash: 'a1', subject: 'first', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: 'invalid-date', date: 'invalid-date', parents: [] },
      { hash: 'b2', shortHash: 'b2', subject: 'second', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-01T23:59:59Z', date: '2024-01-02T00:00:00Z', parents: ['a1', 'a1', 'missing'] },
      { hash: 'c3', shortHash: 'c3', subject: '', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-02T23:59:59Z', date: '2024-01-03T00:00:00Z', parents: ['b2'] },
    ], hasMore: false }, isLoading: false })
    useGitBranchesMock.mockReturnValue({ data: { current: 'ghost', branches: [{ name: 'ghost', current: true, commitHash: 'missing', lastCommitSubject: 'ghost' }, { name: 'main', current: false, commitHash: 'c3', lastCommitSubject: 'third' }, { name: 'main', current: false, commitHash: 'c3', lastCommitSubject: 'duplicate' }] } })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByText('历史'))
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.getAllByText('c3').length).toBeGreaterThan(0)
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
    expect(screen.queryByText('ghost')).toBeNull()
    expect(screen.getByText('second').closest('button')?.getAttribute('title')).toContain('Author')
  })
})
