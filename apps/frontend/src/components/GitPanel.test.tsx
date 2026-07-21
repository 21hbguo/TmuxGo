import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GitPanel } from './GitPanel'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { buildGitGraphLayout, type GitGraphBranchHead, type GitGraphCommit } from '@/lib/gitGraph'

const useGitLogMock = vi.fn()
const useGitBranchesMock = vi.fn()
const useGitPaneDetectMock = vi.fn()
const useGitStatusMock = vi.fn()
const useGitDiffMock = vi.fn()
const useGitRepositoriesMock = vi.fn()
const gitDetectMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { git: { detect: (...args: any[]) => gitDetectMock(...args) } },
}))

vi.mock('@/hooks/useApi', () => ({
  useGitStatus: (...args: any[]) => useGitStatusMock(...args),
  useGitDiff: (...args: any[]) => useGitDiffMock(...args),
  useGitStage: () => ({ mutate: vi.fn() }),
  useGitUnstage: () => ({ mutate: vi.fn() }),
  useGitCommit: () => ({ mutate: vi.fn() }),
  useGitDiscard: () => ({ mutate: vi.fn() }),
  useGitLog: (...args: any[]) => useGitLogMock(...args),
  useGitPaneDetect: (...args: any[]) => useGitPaneDetectMock(...args),
  useGitRepositories: (...args: any[]) => useGitRepositoriesMock(...args),
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
    useGitPaneDetectMock.mockReturnValue({ data: undefined })
    useGitRepositoriesMock.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() })
    gitDetectMock.mockImplementation(async (_hostId: string, path: string) => ({ isGitRepo: true, rootPath: path, branch: 'main', path }))
    useGitStatusMock.mockReturnValue({ data: { branch: 'main', ahead: 1, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] } })
    useGitDiffMock.mockReturnValue({ data: { raw: 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new' }, isLoading: false })
    useConsoleStore.setState({
      activeHostId: 'local',
      activePaneId: null,
      activeEditorId: null,
      openEditors: [],
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
    vi.restoreAllMocks()
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

  it('opens commit diff inside the mobile Git panel and returns one level', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel, { mode: 'mobile' }))))
    await user.click(screen.getByText('历史'))
    await user.click(screen.getByText('second'))
    expect(useConsoleStore.getState().openEditors).toHaveLength(0)
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument()
    expect(screen.getByText('差异: b2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '返回' }))
    expect(backSpy).toHaveBeenCalledTimes(1)
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    expect(await screen.findByText('second')).toBeInTheDocument()
  })

  it('shows remote and tag refs and highlights history search matches', async () => {
    useGitBranchesMock.mockReturnValue({ data: { current: 'main', branches: [{ name: 'main', current: true, commitHash: 'b2', lastCommitSubject: 'second' }], refs: [{ name: 'origin/main', kind: 'remote', commitHash: 'b2' }, { name: 'v1.0.0', kind: 'tag', commitHash: 'a1' }] } })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    const { container } = render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    expect(screen.getByText('origin/main')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('查找提交、作者、分支或标签'), 'second')
    expect(screen.getByText('second').closest('button')).toHaveAttribute('data-git-search-match', '1')
    expect(container.querySelectorAll('[data-git-search-match="1"]')).toHaveLength(1)
  })

  it('shows working tree changes as a graph node and opens the status tab', async () => {
    useGitStatusMock.mockReturnValue({ data: { branch: 'main', ahead: 1, behind: 0, staged: [], unstaged: [{ path: 'src/changed.ts', status: 'modified', staged: false }], untracked: [], conflicted: [] } })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    const { container } = render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    expect(screen.getByText('WIP')).toBeInTheDocument()
    expect(screen.getByText('工作区更改 (1)')).toBeInTheDocument()
    expect(container.querySelector('path[stroke-dasharray="3 4"]')).toBeInTheDocument()
    await user.click(screen.getByText('工作区更改 (1)'))
    expect(screen.getByText('未暂存')).toBeInTheDocument()
    expect(screen.getByText('src/changed.ts')).toBeInTheDocument()
  })

  it('opens the working tree diff inside the mobile Git panel and returns to history', async () => {
    useGitStatusMock.mockReturnValue({ data: { branch: 'main', ahead: 1, behind: 0, staged: [{ path: 'src/staged.ts', status: 'modified', staged: true }], unstaged: [], untracked: [], conflicted: [] } })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel, { mode: 'mobile' }))))
    await user.click(screen.getByText('工作区更改 (1)'))
    expect(screen.getByText('差异: 工作区更改 (1)')).toBeInTheDocument()
    expect(useGitDiffMock).toHaveBeenLastCalledWith('local', '/workspace/app', expect.objectContaining({ workingTree: true }))
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    expect(await screen.findByText('工作区更改 (1)')).toBeInTheDocument()
  })

  it('opens tracked and untracked status files inside the mobile Git panel one level at a time', async () => {
    useGitStatusMock.mockReturnValue({ data: { branch: 'main', ahead: 1, behind: 0, staged: [], unstaged: [{ path: 'src/changed.ts', status: 'modified', staged: false }], untracked: ['src/new.ts'], conflicted: [] } })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel, { mode: 'mobile' }))))
    await user.click(screen.getByText('状态 2'))
    await user.click(screen.getByText('src/changed.ts'))
    expect(screen.getByText('差异: src/changed.ts')).toBeInTheDocument()
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    await user.click(await screen.findByText('src/new.ts'))
    expect(screen.getByText('差异: src/new.ts')).toBeInTheDocument()
    expect(useGitDiffMock).toHaveBeenLastCalledWith('local', '/workspace/app', expect.objectContaining({ filePath: 'src/new.ts', untracked: true }))
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    expect(await screen.findByText('src/changed.ts')).toBeInTheDocument()
  })

  it('filters recent repositories and switches the selected repository', async () => {
    useConsoleStore.setState({ gitByHost: { local: { mode: 'follow-editor', currentRepoPath: '/workspace/repo-a', currentFilePath: null, source: 'pane', lockedRepoPath: null, recentRepos: [{ repoPath: '/workspace/repo-a', label: 'repo-a', lastUsedAt: 2, pinned: false }, { repoPath: '/workspace/repo-b', label: 'repo-b', lastUsedAt: 1, pinned: false }] } } } as any)
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    const input = screen.getByPlaceholderText('搜索仓库或输入仓库路径')
    await user.type(input, 'repo-b')
    expect(screen.queryByText('repo-a')).toBeNull()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(useConsoleStore.getState().gitByHost.local).toMatchObject({ mode: 'locked', currentRepoPath: '/workspace/repo-b', lockedRepoPath: '/workspace/repo-b' }))
    expect(gitDetectMock).toHaveBeenCalledWith('local', '/workspace/repo-b')
  })

  it('finds a discovered repository by name and switches to its detected root', async () => {
    useGitRepositoriesMock.mockReturnValue({ data: [{ path: '/workspace/projects/alpha-service', label: 'alpha-service' }], isLoading: false, isError: false, refetch: vi.fn() })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    await user.type(screen.getByPlaceholderText('搜索仓库或输入仓库路径'), 'alpha')
    expect(screen.getByText('alpha-service')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(useConsoleStore.getState().gitByHost.local).toMatchObject({ currentRepoPath: '/workspace/projects/alpha-service', lockedRepoPath: '/workspace/projects/alpha-service' }))
  })

  it('keeps the current repository when a recent repository is invalid', async () => {
    useConsoleStore.setState({ gitByHost: { local: { mode: 'follow-editor', currentRepoPath: '/workspace/repo-a', currentFilePath: null, source: 'pane', lockedRepoPath: null, recentRepos: [{ repoPath: '/workspace/missing', label: 'missing', lastUsedAt: 1, pinned: false }] } } } as any)
    gitDetectMock.mockResolvedValue({ isGitRepo: false, rootPath: null })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    await user.click(screen.getByText('missing'))
    await waitFor(() => expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('未检测到 Git 仓库'))
    expect(useConsoleStore.getState().gitByHost.local.currentRepoPath).toBe('/workspace/repo-a')
  })

  it('removes the previous repository history immediately after switching', async () => {
    useGitLogMock.mockImplementation((_hostId: string, path: string) => ({ data: { commits: path.endsWith('repo-a') ? [{ hash: 'old1', shortHash: 'old1', subject: 'old repository commit', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-01T00:00:00Z', date: '2024-01-01T00:00:00Z', parents: [] }] : [{ hash: 'new1', shortHash: 'new1', subject: 'new repository commit', body: '', author: 'dev', authorEmail: 'dev@test', authorDate: '2024-01-02T00:00:00Z', date: '2024-01-02T00:00:00Z', parents: [] }], hasMore: false }, isLoading: false }))
    useConsoleStore.setState({ gitByHost: { local: { mode: 'follow-editor', currentRepoPath: '/workspace/repo-a', currentFilePath: null, source: 'pane', lockedRepoPath: null, recentRepos: [{ repoPath: '/workspace/repo-b', label: 'repo-b', lastUsedAt: 1, pinned: false }] } } } as any)
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    expect(screen.getByText('old repository commit')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    await user.click(screen.getByText('repo-b'))
    await waitFor(() => expect(screen.getByText('new repository commit')).toBeInTheDocument())
    expect(screen.queryByText('old repository commit')).toBeNull()
  })

  it('follows the active terminal repository when no editor is open', async () => {
    useGitPaneDetectMock.mockReturnValue({ data: { isGitRepo: true, rootPath: '/workspace/terminal-repo', branch: 'main', path: '/workspace/terminal-repo/apps' } })
    useConsoleStore.setState({ activePaneId: 'local:%1', gitByHost: { local: { mode: 'follow-editor', currentRepoPath: null, currentFilePath: null, source: null, lockedRepoPath: null, recentRepos: [] } } } as any)
    const queryClient = new QueryClient()
    render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(I18nProvider, null, React.createElement(GitPanel))))
    await waitFor(() => expect(useConsoleStore.getState().gitByHost.local).toMatchObject({ currentRepoPath: '/workspace/terminal-repo', currentFilePath: '/workspace/terminal-repo/apps', source: 'pane' }))
    expect(useGitPaneDetectMock).toHaveBeenCalledWith('local', 'local:%1', true)
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

  it('keeps loaded history lanes stable when an older branch page is appended', () => {
    const commits: GitGraphCommit[] = [
      { sha: 'a', shortSha: 'a', subject: 'merge', author: { name: 'dev' }, authoredAt: '2024-01-05', committedAt: '2024-01-05', parents: [{ sha: 'b' }, { sha: 'x' }] },
      { sha: 'b', shortSha: 'b', subject: 'main', author: { name: 'dev' }, authoredAt: '2024-01-04', committedAt: '2024-01-04', parents: [{ sha: 'c' }] },
      { sha: 'x', shortSha: 'x', subject: 'side', author: { name: 'dev' }, authoredAt: '2024-01-03', committedAt: '2024-01-03', parents: [{ sha: 'c' }] },
      { sha: 'c', shortSha: 'c', subject: 'base', author: { name: 'dev' }, authoredAt: '2024-01-02', committedAt: '2024-01-02', parents: [] },
    ]
    const branchHeads: GitGraphBranchHead[] = [{ name: 'main', commit: { sha: 'a' } }, { name: 'old', commit: { sha: 'q' } }]
    const before = buildGitGraphLayout(commits, branchHeads, 'main')
    const after = buildGitGraphLayout([...commits, { sha: 'q', shortSha: 'q', subject: 'old', author: { name: 'dev' }, authoredAt: '2024-01-01', committedAt: '2024-01-01', parents: [] }], branchHeads, 'main')
    expect(after.rows.slice(0, commits.length).map((row) => [row.commit.sha, row.lane])).toEqual(before.rows.map((row) => [row.commit.sha, row.lane]))
  })
})
