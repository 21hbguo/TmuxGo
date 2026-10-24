import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const useGitWorktreesMock = vi.fn()
const gitDetectMock = vi.fn()
const gitCommitMutateMock = vi.fn()
const gitMergeMutateMock = vi.fn()
const gitPullMutateMock = vi.fn()
const gitCreateWorktreeMutateMock = vi.fn()
const gitRemoveWorktreeMutateMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { git: { detect: (...args: unknown[]) => gitDetectMock(...args) } },
}))

vi.mock('@/hooks/useApi', () => ({
  useGitStatus: (...args: unknown[]) => useGitStatusMock(...args),
  useGitDiff: (...args: unknown[]) => useGitDiffMock(...args),
  useGitStage: () => ({ mutate: vi.fn() }),
  useGitUnstage: () => ({ mutate: vi.fn() }),
  useGitCommit: () => ({ mutate: (...args: unknown[]) => gitCommitMutateMock(...args) }),
  useGitDiscard: () => ({ mutate: vi.fn() }),
  useGitResolve: () => ({ mutate: vi.fn() }),
  useGitOperation: () => ({ mutate: vi.fn() }),
  useGitRemotes: () => ({ data: { remotes: [] } }),
  useGitLog: (...args: unknown[]) => useGitLogMock(...args),
  useGitPaneDetect: (...args: unknown[]) => useGitPaneDetectMock(...args),
  useGitRepositories: (...args: unknown[]) => useGitRepositoriesMock(...args),
  useGitBranches: (...args: unknown[]) => useGitBranchesMock(...args),
  useGitCheckout: () => ({ mutate: vi.fn() }),
  useGitCreateBranch: () => ({ mutate: vi.fn() }),
  useGitDeleteBranch: () => ({ mutate: vi.fn() }),
  useGitMerge: () => ({ mutate: (...args: unknown[]) => gitMergeMutateMock(...args) }),
  useGitFetch: () => ({ mutate: vi.fn() }),
  useGitPull: () => ({ mutate: (...args: unknown[]) => gitPullMutateMock(...args), isPending: false }),
  useGitPush: () => ({ mutate: vi.fn() }),
  useGitWorktrees: (...args: unknown[]) => useGitWorktreesMock(...args),
  useGitCreateWorktree: () => ({ mutate: (...args: unknown[]) => gitCreateWorktreeMutateMock(...args) }),
  useGitRemoveWorktree: () => ({ mutate: (...args: unknown[]) => gitRemoveWorktreeMutateMock(...args) }),
}))

describe('GitPanel', () => {
  beforeEach(() => {
    class MockIntersectionObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    useGitLogMock.mockReturnValue({
      data: {
        commits: [
          {
            hash: 'a1',
            shortHash: 'a1',
            subject: 'first',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: '2024-01-01T00:00:00Z',
            date: '2024-01-01T00:00:00Z',
            parents: [],
          },
          {
            hash: 'b2',
            shortHash: 'b2',
            subject: 'second',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: '2024-01-02T00:00:00Z',
            date: '2024-01-02T00:00:00Z',
            parents: ['a1'],
          },
        ],
        hasMore: false,
      },
      isLoading: false,
    })
    useGitBranchesMock.mockReturnValue({
      data: {
        current: 'main',
        branches: [{ name: 'main', current: true, commitHash: 'b2', lastCommitSubject: 'second' }],
      },
    })
    useGitPaneDetectMock.mockReturnValue({ data: undefined })
    useGitRepositoriesMock.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() })
    gitDetectMock.mockImplementation(async (_hostId: string, path: string) => ({
      isGitRepo: true,
      rootPath: path,
      branch: 'main',
      path,
    }))
    useGitStatusMock.mockReturnValue({
      data: { branch: 'main', ahead: 1, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] },
    })
    useGitDiffMock.mockReturnValue({
      data: {
        raw: 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new',
      },
      isLoading: false,
    })
    useGitWorktreesMock.mockReturnValue({
      data: {
        worktrees: [
          {
            path: '/workspace/app',
            head: 'b2aaaa',
            branch: 'main',
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
          },
          {
            path: '/workspace/app-wt',
            head: 'c3bbbb',
            branch: 'feature',
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    gitCreateWorktreeMutateMock.mockReset()
    gitRemoveWorktreeMutateMock.mockReset()
    gitCommitMutateMock.mockReset()
    gitMergeMutateMock.mockReset()
    gitPullMutateMock.mockReset()
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
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders git history rows and opens commit diff from click', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByText('历史'))
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
    await user.click(screen.getByText('second'))
    expect(useConsoleStore.getState().openEditors.at(-1)).toMatchObject({
      id: expect.stringContaining('git-diff?'),
      language: 'diff',
      rootPath: '/workspace/app',
      name: 'b2 second',
    })
  })

  it('shows queued feedback for background commit and merge tasks', async () => {
    useGitStatusMock.mockReturnValue({
      data: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        staged: [{ path: 'src/index.ts', status: 'modified', staged: true }],
        unstaged: [],
        untracked: [],
        conflicted: [],
      },
    })
    useGitBranchesMock.mockReturnValue({
      data: {
        current: 'main',
        branches: [
          { name: 'main', current: true, commitHash: 'b2', lastCommitSubject: 'second' },
          { name: 'feature', current: false, commitHash: 'a1', lastCommitSubject: 'first' },
        ],
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByText('状态 1'))
    await user.type(screen.getByPlaceholderText('提交信息...'), 'background commit')
    await user.click(screen.getByText('提交'))
    ;(gitCommitMutateMock.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }).onSuccess({
      task: { id: 'commit-1' },
    })
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('任务已开始')
    await user.click(screen.getByText('分支'))
    await user.click(screen.getByText('合并'))
    ;(gitMergeMutateMock.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }).onSuccess({
      task: { id: 'merge-1' },
    })
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('任务已开始')
  })

  it('offers rebase and merge when pull reports a diverged branch', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByRole('button', { name: '拉取' }))
    const firstCall = gitPullMutateMock.mock.calls[0] as [Record<string, unknown>, { onSuccess: (r: unknown) => void }]
    // 常规拉取不带 strategy：选项只在分叉被拒后才出现
    expect(firstCall[0]).toMatchObject({ path: '/workspace/app' })
    expect(firstCall[0].strategy).toBeUndefined()
    // onSuccess 里会 setState + 发 toast，必须包 act
    await act(async () => {
      firstCall[1].onSuccess({ ok: false, conflicts: false, diverged: true, ahead: 2, behind: 3, message: 'hint' })
    })

    const dialog = await screen.findByRole('dialog', { name: '分支已分叉' })
    expect(dialog).toHaveTextContent('领先 2 个提交、落后 3 个提交')

    await user.click(screen.getByRole('button', { name: '变基拉取' }))
    const secondCall = gitPullMutateMock.mock.calls[1] as [Record<string, unknown>, { onSuccess: (r: unknown) => void }]
    expect(secondCall[0]).toMatchObject({ path: '/workspace/app', strategy: 'rebase' })
    await act(async () => {
      secondCall[1].onSuccess({ ok: true, conflicts: false, message: 'ok' })
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '分支已分叉' })).not.toBeInTheDocument())
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('拉取成功')
  })

  it('maps pull 409 codes to actionable hints and keeps the raw message without a code', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByRole('button', { name: '拉取' }))
    const onError = gitPullMutateMock.mock.calls[0][1].onError as (err: Error & { code?: string }) => void

    const cases: [string, string][] = [
      ['GIT_DIRTY_TREE', '工作区有未提交改动，请先提交或暂存后再拉取'],
      ['GIT_DETACHED_HEAD', '当前处于游离 HEAD，请先切回分支再拉取'],
      ['GIT_NO_UPSTREAM', '当前分支未设置上游分支，请先设置后再拉取'],
      ['GIT_REBASE_IN_PROGRESS', '有未完成的变基操作，请先完成或中止后再拉取'],
      ['GIT_MERGE_IN_PROGRESS', '有未完成的合并操作，请先完成或中止后再拉取'],
    ]
    for (const [code, expected] of cases) {
      await act(async () => onError(Object.assign(new Error('git 原文不可读'), { code })))
      expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe(expected)
    }

    // 老后端/网络错误没有 code：保持透传原文，不吞信息
    await act(async () => onError(new Error('network down')))
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('network down')
    // 未知 code 同样回退原文（后端将来加了新 code 也不会显示空白提示）
    await act(async () => onError(Object.assign(new Error('some git stderr'), { code: 'GIT_SOMETHING_NEW' })))
    expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('some git stderr')
  })

  it('opens commit diff inside the mobile Git panel and returns one level', async () => {
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel, { mode: 'mobile' })),
      ),
    )
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
    useGitBranchesMock.mockReturnValue({
      data: {
        current: 'main',
        branches: [{ name: 'main', current: true, commitHash: 'b2', lastCommitSubject: 'second' }],
        refs: [
          { name: 'origin/main', kind: 'remote', commitHash: 'b2' },
          { name: 'v1.0.0', kind: 'tag', commitHash: 'a1' },
        ],
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    expect(screen.getByText('origin/main')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('查找提交、作者、分支或标签'), 'second')
    expect(screen.getByText('second').closest('button')).toHaveAttribute('data-git-search-match', '1')
    expect(container.querySelectorAll('[data-git-search-match="1"]')).toHaveLength(1)
  })

  it('shows working tree changes as a graph node and opens its diff', async () => {
    useGitStatusMock.mockReturnValue({
      data: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        staged: [],
        unstaged: [{ path: 'src/changed.ts', status: 'modified', staged: false }],
        untracked: [],
        conflicted: [],
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    const { container } = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    expect(screen.getByText('WIP')).toBeInTheDocument()
    expect(screen.getByText('工作区更改 (1)')).toBeInTheDocument()
    expect(container.querySelector('path[stroke-dasharray="3 4"]')).toBeInTheDocument()
    await user.click(screen.getByText('工作区更改 (1)'))
    await waitFor(() =>
      expect(useConsoleStore.getState().openEditors.at(-1)).toMatchObject({
        rootPath: '/workspace/app',
        path: '',
        name: '工作区更改 (1)',
        language: 'diff',
      }),
    )
  })

  it('opens the working tree diff inside the mobile Git panel and returns to history', async () => {
    useGitStatusMock.mockReturnValue({
      data: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        staged: [{ path: 'src/staged.ts', status: 'modified', staged: true }],
        unstaged: [],
        untracked: [],
        conflicted: [],
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel, { mode: 'mobile' })),
      ),
    )
    await user.click(screen.getByText('工作区更改 (1)'))
    expect(screen.getByText('差异: 工作区更改 (1)')).toBeInTheDocument()
    expect(useGitDiffMock).toHaveBeenLastCalledWith(
      'local',
      '/workspace/app',
      expect.objectContaining({ workingTree: true }),
    )
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    expect(await screen.findByText('工作区更改 (1)')).toBeInTheDocument()
  })

  it('opens tracked and untracked status files inside the mobile Git panel one level at a time', async () => {
    useGitStatusMock.mockReturnValue({
      data: {
        branch: 'main',
        ahead: 1,
        behind: 0,
        staged: [],
        unstaged: [{ path: 'src/changed.ts', status: 'modified', staged: false }],
        untracked: ['src/new.ts'],
        conflicted: [],
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel, { mode: 'mobile' })),
      ),
    )
    await user.click(screen.getByText('状态 2'))
    await user.click(screen.getByText('src/changed.ts'))
    expect(screen.getByText('差异: src/changed.ts')).toBeInTheDocument()
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    await user.click(await screen.findByText('src/new.ts'))
    expect(screen.getByText('差异: src/new.ts')).toBeInTheDocument()
    expect(useGitDiffMock).toHaveBeenLastCalledWith(
      'local',
      '/workspace/app',
      expect.objectContaining({ filePath: 'src/new.ts', untracked: true }),
    )
    fireEvent(window, new CustomEvent('tmuxgo-mobile-git-back', { detail: { handled: false } }))
    expect(await screen.findByText('src/changed.ts')).toBeInTheDocument()
  })

  it('filters recent repositories and switches the selected repository', async () => {
    useConsoleStore.setState({
      gitByHost: {
        local: {
          mode: 'follow-editor',
          currentRepoPath: '/workspace/repo-a',
          currentFilePath: null,
          source: 'pane',
          lockedRepoPath: null,
          recentRepos: [
            { repoPath: '/workspace/repo-a', label: 'repo-a', lastUsedAt: 2, pinned: false },
            { repoPath: '/workspace/repo-b', label: 'repo-b', lastUsedAt: 1, pinned: false },
          ],
        },
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    const input = screen.getByPlaceholderText('搜索仓库或输入仓库路径')
    await user.type(input, 'repo-b')
    expect(screen.queryByText('repo-a')).toBeNull()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(useConsoleStore.getState().gitByHost.local).toMatchObject({
        mode: 'locked',
        currentRepoPath: '/workspace/repo-b',
        lockedRepoPath: '/workspace/repo-b',
      }),
    )
    expect(gitDetectMock).toHaveBeenCalledWith('local', '/workspace/repo-b')
  })

  it('finds a discovered repository by name and switches to its detected root', async () => {
    useGitRepositoriesMock.mockReturnValue({
      data: [{ path: '/workspace/projects/alpha-service', label: 'alpha-service' }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    await user.type(screen.getByPlaceholderText('搜索仓库或输入仓库路径'), 'alpha')
    expect(screen.getByText('alpha-service')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(useConsoleStore.getState().gitByHost.local).toMatchObject({
        currentRepoPath: '/workspace/projects/alpha-service',
        lockedRepoPath: '/workspace/projects/alpha-service',
      }),
    )
  })

  it('keeps the current repository when a recent repository is invalid', async () => {
    useConsoleStore.setState({
      gitByHost: {
        local: {
          mode: 'follow-editor',
          currentRepoPath: '/workspace/repo-a',
          currentFilePath: null,
          source: 'pane',
          lockedRepoPath: null,
          recentRepos: [{ repoPath: '/workspace/missing', label: 'missing', lastUsedAt: 1, pinned: false }],
        },
      },
    })
    gitDetectMock.mockResolvedValue({ isGitRepo: false, rootPath: null })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    await user.click(screen.getByText('missing'))
    await waitFor(() => expect(useConsoleStore.getState().toasts.at(-1)?.message).toBe('未检测到 Git 仓库'))
    expect(useConsoleStore.getState().gitByHost.local.currentRepoPath).toBe('/workspace/repo-a')
  })

  it('removes the previous repository history immediately after switching', async () => {
    useGitLogMock.mockImplementation((_hostId: string, path: string) => ({
      data: {
        commits: path.endsWith('repo-a')
          ? [
              {
                hash: 'old1',
                shortHash: 'old1',
                subject: 'old repository commit',
                body: '',
                author: 'dev',
                authorEmail: 'dev@test',
                authorDate: '2024-01-01T00:00:00Z',
                date: '2024-01-01T00:00:00Z',
                parents: [],
              },
            ]
          : [
              {
                hash: 'new1',
                shortHash: 'new1',
                subject: 'new repository commit',
                body: '',
                author: 'dev',
                authorEmail: 'dev@test',
                authorDate: '2024-01-02T00:00:00Z',
                date: '2024-01-02T00:00:00Z',
                parents: [],
              },
            ],
        hasMore: false,
      },
      isLoading: false,
    }))
    useConsoleStore.setState({
      gitByHost: {
        local: {
          mode: 'follow-editor',
          currentRepoPath: '/workspace/repo-a',
          currentFilePath: null,
          source: 'pane',
          lockedRepoPath: null,
          recentRepos: [{ repoPath: '/workspace/repo-b', label: 'repo-b', lastUsedAt: 1, pinned: false }],
        },
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    expect(screen.getByText('old repository commit')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '切换仓库' }))
    await user.click(screen.getByText('repo-b'))
    await waitFor(() => expect(screen.getByText('new repository commit')).toBeInTheDocument())
    expect(screen.queryByText('old repository commit')).toBeNull()
  })

  it('follows the active terminal repository when no editor is open', async () => {
    useGitPaneDetectMock.mockReturnValue({
      data: {
        isGitRepo: true,
        rootPath: '/workspace/terminal-repo',
        branch: 'main',
        path: '/workspace/terminal-repo/apps',
      },
    })
    useConsoleStore.setState({
      activePaneId: 'local:%1',
      gitByHost: {
        local: {
          mode: 'follow-editor',
          currentRepoPath: null,
          currentFilePath: null,
          source: null,
          lockedRepoPath: null,
          recentRepos: [],
        },
      },
    })
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await waitFor(() =>
      expect(useConsoleStore.getState().gitByHost.local).toMatchObject({
        currentRepoPath: '/workspace/terminal-repo',
        currentFilePath: '/workspace/terminal-repo/apps',
        source: 'pane',
      }),
    )
    expect(useGitPaneDetectMock).toHaveBeenCalledWith('local', 'local:%1', true)
  })

  it('ignores invalid commit entries in history data', async () => {
    useGitLogMock.mockReturnValue({
      data: {
        commits: [
          null,
          {
            shortHash: 'x1',
            subject: 'broken',
            body: '',
            author: '',
            authorEmail: 'dev@test',
            authorDate: '',
            date: '',
            parents: [],
          },
          {
            hash: 'a1',
            shortHash: 'a1',
            subject: 'first',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: '2024-01-01T00:00:00Z',
            date: '2024-01-01T00:00:00Z',
            parents: [],
          },
          undefined,
          {
            hash: 'b2',
            shortHash: 'b2',
            subject: 'second',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: '2024-01-02T00:00:00Z',
            date: '2024-01-02T00:00:00Z',
            parents: ['a1'],
          },
        ],
        hasMore: false,
      },
      isLoading: false,
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByText('历史'))
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.queryByText('broken')).toBeNull()
  })

  it('filters invalid dates and unreachable branch heads from history graph data', async () => {
    useGitLogMock.mockReturnValue({
      data: {
        commits: [
          {
            hash: 'a1',
            shortHash: 'a1',
            subject: 'first',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: 'invalid-date',
            date: 'invalid-date',
            parents: [],
          },
          {
            hash: 'b2',
            shortHash: 'b2',
            subject: 'second',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: '2024-01-01T23:59:59Z',
            date: '2024-01-02T00:00:00Z',
            parents: ['a1', 'a1', 'missing'],
          },
          {
            hash: 'c3',
            shortHash: 'c3',
            subject: '',
            body: '',
            author: 'dev',
            authorEmail: 'dev@test',
            authorDate: '2024-01-02T23:59:59Z',
            date: '2024-01-03T00:00:00Z',
            parents: ['b2'],
          },
        ],
        hasMore: false,
      },
      isLoading: false,
    })
    useGitBranchesMock.mockReturnValue({
      data: {
        current: 'ghost',
        branches: [
          { name: 'ghost', current: true, commitHash: 'missing', lastCommitSubject: 'ghost' },
          { name: 'main', current: false, commitHash: 'c3', lastCommitSubject: 'third' },
          { name: 'main', current: false, commitHash: 'c3', lastCommitSubject: 'duplicate' },
        ],
      },
    })
    const user = userEvent.setup()
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByText('历史'))
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(screen.getAllByText('c3').length).toBeGreaterThan(0)
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
    expect(screen.queryByText('ghost')).toBeNull()
    expect(screen.getByText('second').closest('button')?.getAttribute('title')).toContain('Author')
  })

  it('keeps loaded history lanes stable when an older branch page is appended', () => {
    const commits: GitGraphCommit[] = [
      {
        sha: 'a',
        shortSha: 'a',
        subject: 'merge',
        author: { name: 'dev' },
        authoredAt: '2024-01-05',
        committedAt: '2024-01-05',
        parents: [{ sha: 'b' }, { sha: 'x' }],
      },
      {
        sha: 'b',
        shortSha: 'b',
        subject: 'main',
        author: { name: 'dev' },
        authoredAt: '2024-01-04',
        committedAt: '2024-01-04',
        parents: [{ sha: 'c' }],
      },
      {
        sha: 'x',
        shortSha: 'x',
        subject: 'side',
        author: { name: 'dev' },
        authoredAt: '2024-01-03',
        committedAt: '2024-01-03',
        parents: [{ sha: 'c' }],
      },
      {
        sha: 'c',
        shortSha: 'c',
        subject: 'base',
        author: { name: 'dev' },
        authoredAt: '2024-01-02',
        committedAt: '2024-01-02',
        parents: [],
      },
    ]
    const branchHeads: GitGraphBranchHead[] = [
      { name: 'main', commit: { sha: 'a' } },
      { name: 'old', commit: { sha: 'q' } },
    ]
    const before = buildGitGraphLayout(commits, branchHeads, 'main')
    const after = buildGitGraphLayout(
      [
        ...commits,
        {
          sha: 'q',
          shortSha: 'q',
          subject: 'old',
          author: { name: 'dev' },
          authoredAt: '2024-01-01',
          committedAt: '2024-01-01',
          parents: [],
        },
      ],
      branchHeads,
      'main',
    )
    expect(after.rows.slice(0, commits.length).map((row) => [row.commit.sha, row.lane])).toEqual(
      before.rows.map((row) => [row.commit.sha, row.lane]),
    )
  })

  it('lists worktrees, creates one and opens the session flow at its cwd', async () => {
    const user = userEvent.setup()
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener('tmuxgo-open-create-session', listener)
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByText('Worktree'))
    expect(screen.getByText('/workspace/app-wt')).toBeInTheDocument()
    expect(screen.getByText(/feature · c3bbbb/)).toBeInTheDocument()
    await user.click(screen.getByText('+ 新建 worktree'))
    await user.type(screen.getByPlaceholderText('worktree 路径'), '/workspace/app-hotfix')
    await user.type(screen.getByPlaceholderText(/分支/), 'hotfix')
    await user.click(screen.getByText('确认'))
    expect(gitCreateWorktreeMutateMock).toHaveBeenCalledWith(
      { hostId: 'local', path: '/workspace/app', worktreePath: '/workspace/app-hotfix', newBranch: 'hotfix' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
    ;(gitCreateWorktreeMutateMock.mock.calls[0]?.[1] as { onSuccess: (r: unknown) => void }).onSuccess({
      ok: true,
      worktree: {},
    })
    expect(events.at(-1)?.detail).toMatchObject({
      cwd: '/workspace/app-hotfix',
      worktreeLink: { repoPath: '/workspace/app', worktreePath: '/workspace/app-hotfix' },
    })
    window.removeEventListener('tmuxgo-open-create-session', listener)
  })

  it('opens an existing worktree and escalates a dirty remove to a force confirm', async () => {
    const user = userEvent.setup()
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener('tmuxgo-open-create-session', listener)
    const queryClient = new QueryClient()
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, null, React.createElement(GitPanel)),
      ),
    )
    await user.click(screen.getByText('Worktree'))
    await user.click(screen.getByText('打开'))
    expect(events.at(-1)?.detail.cwd).toBe('/workspace/app-wt')
    await user.click(screen.getByText('✕'))
    await user.click(screen.getByRole('button', { name: '移除' }))
    expect(gitRemoveWorktreeMutateMock).toHaveBeenCalledWith(
      { hostId: 'local', path: '/workspace/app', worktreePath: '/workspace/app-wt', force: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
    ;(gitRemoveWorktreeMutateMock.mock.calls[0]?.[1] as { onSuccess: (r: unknown) => void }).onSuccess({
      ok: false,
      code: 'dirty',
      message: 'dirty',
    })
    const forceConfirm = await screen.findByRole('button', { name: '移除' })
    await user.click(forceConfirm)
    expect(gitRemoveWorktreeMutateMock).toHaveBeenLastCalledWith(
      { hostId: 'local', path: '/workspace/app', worktreePath: '/workspace/app-wt', force: true },
      expect.anything(),
    )
    window.removeEventListener('tmuxgo-open-create-session', listener)
  })
})
