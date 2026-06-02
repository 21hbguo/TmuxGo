import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GitPanel } from './GitPanel'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '@/lib/api'

const graphSpy = vi.fn()

vi.mock('commit-graph', () => ({
  CommitGraph: {
    WithInfiniteScroll: (props: any) => {
      graphSpy(props)
      return React.createElement('div', { 'data-testid': 'commit-graph' })
    },
  },
}))
vi.mock('@/lib/api', () => ({
  api: {
    git: {
      diffStats: vi.fn(async () => ({ files: [{ filename: 'src/index.ts', status: 'modified', additions: 3, deletions: 1 }] })),
    },
  },
}))

vi.mock('@/hooks/useApi', () => ({
  useGitStatus: () => ({ data: { branch: 'main', ahead: 1, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] } }),
  useGitStage: () => ({ mutate: vi.fn() }),
  useGitUnstage: () => ({ mutate: vi.fn() }),
  useGitCommit: () => ({ mutate: vi.fn() }),
  useGitDiscard: () => ({ mutate: vi.fn() }),
  useGitLog: () => ({ data: { commits: [{ hash: 'a1', shortHash: 'a1', subject: 'first', body: '', author: 'dev', authorEmail: 'dev@test', date: '2024-01-01T00:00:00Z', parents: [] }, { hash: 'b2', shortHash: 'b2', subject: 'second', body: '', author: 'dev', authorEmail: 'dev@test', date: '2024-01-02T00:00:00Z', parents: ['a1'] }], hasMore: false }, isLoading: false }),
  useGitBranches: () => ({ data: { current: 'main', branches: [{ name: 'main', current: true, commitHash: 'b2', lastCommitSubject: 'second' }] } }),
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
    graphSpy.mockClear()
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

  it('passes commit and branch data into commit-graph', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByText('历史'))
    expect(screen.getByTestId('commit-graph')).toBeInTheDocument()
    expect(graphSpy).toHaveBeenCalled()
    const props = graphSpy.mock.calls[0][0]
    expect(props.commits).toHaveLength(2)
    expect(props.commits[1]).toMatchObject({ sha: 'b2', parents: [{ sha: 'a1' }] })
    expect(props.branchHeads).toEqual([{ name: 'main', commit: { sha: 'b2' } }])
    expect(props.currentBranch).toBe('main')
    await expect(props.getDiff('a1', 'b2')).resolves.toEqual({ files: [{ filename: 'src/index.ts', status: 'modified', additions: 3, deletions: 1 }] })
    expect(api.git.diffStats).toHaveBeenCalledWith('local', '/workspace/app', 'a1', 'b2')
    props.onCommitClick({ sha: 'b2', message: 'second' })
    expect(useConsoleStore.getState().openEditors.at(-1)).toMatchObject({ id: expect.stringContaining('git-diff?'), language: 'diff', rootPath: '/workspace/app' })
  })
})
