'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { useGitStatus, useGitStage, useGitUnstage, useGitCommit, useGitDiscard, useGitLog, useGitBranches, useGitCheckout, useGitCreateBranch, useGitDeleteBranch, useGitMerge, useGitFetch, useGitPull, useGitPush } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from './ConfirmDialog'
import type { GitFileChange, GitCommitInfo } from '@/types'
import { GitHistoryGraph } from './GitHistoryGraph'
import type { GitGraphBranchHead, GitGraphCommit } from '@/lib/gitGraph'

type GitTab = 'status' | 'history' | 'branches'
function isValidGitCommitInfo(commit: GitCommitInfo | null | undefined): commit is GitCommitInfo {
  return !!commit?.hash && !!commit.author && !!commit.date
}
function isValidCommitDate(date: string) {
  return Number.isFinite(new Date(date).getTime())
}
function normalizeGitGraphCommits(commits: GitCommitInfo[]) {
  const seen = new Set<string>()
  const validCommits = commits.filter((commit) => isValidGitCommitInfo(commit) && isValidCommitDate(commit.date) && !seen.has(commit.hash) && !!seen.add(commit.hash))
  const commitSet = new Set(validCommits.map((commit) => commit.hash))
  return validCommits.map((commit) => ({
    sha: commit.hash,
    shortSha: commit.shortHash || commit.hash.slice(0, 7),
    subject: commit.subject || commit.hash.slice(0, 7),
    author: {
      name: commit.author,
      date: commit.date,
      email: commit.authorEmail,
    },
    parents: (commit.parents || []).filter((sha, index, arr) => !!sha && commitSet.has(sha) && arr.indexOf(sha) === index).map((sha) => ({ sha })),
  }))
}
function normalizeBranchHeads(branches: Array<{ name?: string; commitHash?: string }>, commitSet: Set<string>): GitGraphBranchHead[] {
  const seen = new Set<string>()
  return branches.filter((branch): branch is { name: string; commitHash: string } => !!branch?.name && !!branch?.commitHash && commitSet.has(branch.commitHash) && !seen.has(branch.name) && !!seen.add(branch.name)).map((branch) => ({
    name: branch.name,
    commit: { sha: branch.commitHash },
  }))
}
function normalizeCurrentBranch(currentBranch: string | undefined, branchHeads: GitGraphBranchHead[]) {
  if (!currentBranch) return undefined
  return branchHeads.some((branch) => branch.name === currentBranch) ? currentBranch : undefined
}

function statusIcon(status: GitFileChange['status']) {
  switch (status) {
    case 'added': return { icon: 'A', color: 'text-green-400' }
    case 'modified': return { icon: 'M', color: 'text-yellow-400' }
    case 'deleted': return { icon: 'D', color: 'text-red-400' }
    case 'renamed': return { icon: 'R', color: 'text-blue-400' }
    case 'copied': return { icon: 'C', color: 'text-blue-400' }
    case 'unmerged': return { icon: 'U', color: 'text-red-400' }
    default: return { icon: '?', color: 'text-text-3' }
  }
}

type TFunc = (key: string, params?: Record<string, string | number>) => string

function FileRow({ file, staged, onStage, onUnstage, onDiscard, onViewDiff, t }: { file: GitFileChange; staged: boolean; onStage: () => void; onUnstage: () => void; onDiscard: () => void; onViewDiff: () => void; t: TFunc }) {
  const { icon, color } = statusIcon(file.status)
  return (
    <div className="group flex items-center gap-2 px-3 py-1 hover:bg-bg-2" onClick={onViewDiff}>
      <span className={`w-4 text-center text-[11px] font-bold ${color}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-2" title={file.path}>{file.path}</span>
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        {staged ? (
          <button onClick={(e) => { e.stopPropagation(); onUnstage() }} className="rounded px-1.5 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.unstage')}</button>
        ) : (
          <>
            <button onClick={(e) => { e.stopPropagation(); onStage() }} className="rounded px-1.5 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.stage')}</button>
            <button onClick={(e) => { e.stopPropagation(); onDiscard() }} className="rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-bg-2">{t('git.discard')}</button>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, count, children, defaultOpen = true }: { title: string; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (count === 0) return null
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-text-3 hover:bg-bg-2">
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
        <span>{title}</span>
        <span className="ml-auto rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px]">{count}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function StatusTab({ hostId, repoPath, t }: { hostId: string; repoPath: string; t: TFunc }) {
  const { data: status } = useGitStatus(hostId, repoPath)
  const stage = useGitStage()
  const unstage = useGitUnstage()
  const discard = useGitDiscard()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null)

  const openDiff = useCallback((file: GitFileChange, isStaged: boolean) => {
    const params = new URLSearchParams({ hostId, repoPath, filePath: file.path })
    if (isStaged) params.set('staged', '1')
    useConsoleStore.getState().openEditor({
      id: `git-diff?${params.toString()}`,
      hostId,
      rootId: 'git',
      rootLabel: 'Git',
      rootPath: repoPath,
      path: file.path,
      name: `${file.path} (diff)`,
      absolutePath: `${repoPath}/${file.path}`,
      language: 'diff',
    })
  }, [hostId, repoPath])

  if (!status) return <div className="p-3 text-[11px] text-text-3">{t('git.detecting')}</div>
  const hasChanges = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length === 0

  return (
    <>
      {hasChanges && <div className="p-3 text-[11px] text-text-3">{t('git.noChanges')}</div>}
      <Section title={t('git.staged')} count={status.staged.length}>
        {status.staged.map((f) => <FileRow key={`s-${f.path}`} file={f} staged onStage={() => {}} onUnstage={() => unstage.mutate({ hostId, path: repoPath, filePaths: [f.path] })} onDiscard={() => {}} onViewDiff={() => openDiff(f, true)} t={t} />)}
      </Section>
      <Section title={t('git.unstaged')} count={status.unstaged.length}>
        {status.unstaged.map((f) => <FileRow key={`u-${f.path}`} file={f} staged={false} onStage={() => stage.mutate({ hostId, path: repoPath, filePaths: [f.path] })} onUnstage={() => {}} onDiscard={() => setPendingDiscard(f.path)} onViewDiff={() => openDiff(f, false)} t={t} />)}
      </Section>
      <Section title={t('git.untracked')} count={status.untracked.length}>
        {status.untracked.map((f) => (
          <div key={`un-${f}`} className="group flex items-center gap-2 px-3 py-1 hover:bg-bg-2">
            <span className="w-4 text-center text-[11px] font-bold text-text-3">?</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-2">{f}</span>
            <button onClick={() => stage.mutate({ hostId, path: repoPath, filePaths: [f] })} className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-3 opacity-0 group-hover:opacity-100 hover:bg-bg-2 hover:text-text-1">{t('git.stage')}</button>
          </div>
        ))}
      </Section>
      <Section title={t('git.conflicted')} count={status.conflicted.length}>
        {status.conflicted.map((f) => <FileRow key={`c-${f.path}`} file={f} staged={false} onStage={() => stage.mutate({ hostId, path: repoPath, filePaths: [f.path] })} onUnstage={() => {}} onDiscard={() => setPendingDiscard(f.path)} onViewDiff={() => openDiff(f, false)} t={t} />)}
      </Section>
      <ConfirmDialog open={!!pendingDiscard} title={t('git.discardTitle')} message={t('git.discardConfirm', { file: pendingDiscard || '' })} confirmLabel={t('git.discard')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDiscard(null)} onConfirm={() => { if (pendingDiscard) { discard.mutate({ hostId, path: repoPath, filePaths: [pendingDiscard] }); setPendingDiscard(null) } }} />
    </>
  )
}

function HistoryTab({ hostId, repoPath, t }: { hostId: string; repoPath: string; t: TFunc }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useGitLogPaged(hostId, repoPath)
  const { data: branchesData } = useGitBranches(hostId, repoPath)
  if (!data) return <div className="p-3 text-[11px] text-text-3">{t('git.detecting')}</div>
  const commits = normalizeGitGraphCommits(data)
  const commitSet = new Set(commits.map((commit) => commit.sha))
  const branchHeads = normalizeBranchHeads(branchesData?.branches || [], commitSet)
  const currentBranch = normalizeCurrentBranch(branchesData?.current, branchHeads)
  const openCommitDiff = (commit: GitGraphCommit) => {
    if (!commit.sha) return
    const params = new URLSearchParams({ hostId, repoPath, commit: `${commit.sha}^!` })
    useConsoleStore.getState().openEditor({
      id: `git-diff?${params.toString()}`,
      hostId,
      rootId: 'git',
      rootLabel: 'Git',
      rootPath: repoPath,
      path: '',
      name: `${commit.shortSha} ${commit.subject || 'commit diff'}`,
      absolutePath: `${repoPath}@${commit.shortSha}`,
      language: 'diff',
    })
  }
  return (
    <div className="tmuxgo-scrollbar h-full overflow-y-auto" data-git-history-scroll="1">
      {commits.length === 0 ? <div className="p-3 text-[11px] text-text-3">{t('git.noChanges')}</div> : (
      <GitHistoryGraph
        commits={commits}
        branchHeads={branchHeads}
        onLoadMore={fetchNextPage}
        hasMore={hasNextPage}
        isFetchingMore={isFetchingNextPage}
        currentBranch={currentBranch}
        onCommitClick={openCommitDiff}
        formatDate={formatDate}
      />
      )}
    </div>
  )
}

function useGitLogPaged(hostId: string, repoPath: string) {
  const [page, setPage] = useState(0)
  const pagesRef = useRef<GitCommitInfo[][]>([])
  const pageSize = 200
  const { data, isLoading } = useGitLog(hostId, repoPath, { limit: pageSize, skip: page * pageSize }, true)

  if (data && data.commits.length > 0) {
    const existing = pagesRef.current[page]
    if (!existing || existing.length !== data.commits.length || existing[0]?.hash !== data.commits[0]?.hash) {
      pagesRef.current = [...pagesRef.current]
      pagesRef.current[page] = data.commits
    }
  }

  const allCommits = pagesRef.current.flat()
  const seen = new Set<string>()
  const uniqueCommits = allCommits.filter((c) => {
    if (!isValidGitCommitInfo(c) || !isValidCommitDate(c.date)) return false
    if (seen.has(c.hash)) return false
    seen.add(c.hash)
    return true
  })

  return {
    data: uniqueCommits,
    fetchNextPage: () => setPage((p) => p + 1),
    hasNextPage: data?.hasMore ?? false,
    isFetchingNextPage: isLoading,
  }
}

function formatDate(dateValue: string | number | Date) {
  try {
    const d = new Date(dateValue)
    if (!Number.isFinite(d.getTime())) return String(dateValue)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString()
  } catch {
    return String(dateValue)
  }
}

function BranchesTab({ hostId, repoPath, t }: { hostId: string; repoPath: string; t: TFunc }) {
  const { data } = useGitBranches(hostId, repoPath)
  const checkout = useGitCheckout()
  const deleteBranch = useGitDeleteBranch()
  const merge = useGitMerge()
  const createBranch = useGitCreateBranch()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [showCreate, setShowCreate] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  if (!data) return <div className="p-3 text-[11px] text-text-3">{t('git.detecting')}</div>

  const handleCreate = () => {
    if (!newBranchName.trim()) return
    createBranch.mutate({ hostId, path: repoPath, name: newBranchName.trim() }, {
      onSuccess: () => { pushToast({ type: 'success', message: t('git.createBranchSuccess') }); setShowCreate(false); setNewBranchName('') },
      onError: (err) => pushToast({ type: 'error', message: err.message }),
    })
  }

  return (
    <div>
      <div className="border-b border-[var(--line)] px-3 py-2">
        {showCreate ? (
          <div className="flex gap-1">
            <input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} placeholder={t('git.branchName')} className="flex-1 rounded border border-[var(--line)] bg-bg-0 px-2 py-1 text-[12px] text-text-1 outline-none focus:border-accent" autoFocus />
            <button onClick={handleCreate} className="rounded bg-accent/20 px-2 py-1 text-[11px] text-accent">{t('common.confirm')}</button>
            <button onClick={() => setShowCreate(false)} className="rounded px-2 py-1 text-[11px] text-text-3">{t('common.cancel')}</button>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)} className="text-[11px] text-accent hover:text-text-1">+ {t('git.newBranch')}</button>
        )}
      </div>
      {data.branches.map((b) => (
        <div key={b.name} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-bg-2">
          <span className={`w-3 text-center text-[11px] ${b.current ? 'text-accent' : 'text-text-3'}`}>{b.current ? '●' : ''}</span>
          <div className="min-w-0 flex-1">
            <div className={`truncate text-[12px] ${b.current ? 'font-semibold text-accent' : 'text-text-1'}`}>{b.name}</div>
            {b.lastCommitSubject && <div className="truncate text-[10px] text-text-3">{b.lastCommitSubject}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
            {!b.current && (
              <>
                <button onClick={() => checkout.mutate({ hostId, path: repoPath, branch: b.name }, { onSuccess: () => pushToast({ type: 'success', message: t('git.checkoutSuccess', { branch: b.name }) }), onError: (err) => pushToast({ type: 'error', message: err.message }) })} className="rounded px-1.5 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.checkout')}</button>
                <button onClick={() => merge.mutate({ hostId, path: repoPath, branch: b.name }, { onSuccess: () => pushToast({ type: 'success', message: t('git.mergeSuccess') }), onError: (err) => pushToast({ type: 'error', message: t('git.mergeFailed') + ': ' + err.message }) })} className="rounded px-1.5 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.merge')}</button>
                <button onClick={() => setPendingDelete(b.name)} className="rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-bg-2">✕</button>
              </>
            )}
          </div>
        </div>
      ))}
      <ConfirmDialog open={!!pendingDelete} title={t('git.deleteBranch')} message={t('git.deleteBranchConfirm', { name: pendingDelete || '' })} confirmLabel={t('git.deleteBranch')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) { deleteBranch.mutate({ hostId, path: repoPath, name: pendingDelete }, { onSuccess: () => pushToast({ type: 'success', message: t('git.deleteBranch') }), onError: (err) => pushToast({ type: 'error', message: err.message }) }); setPendingDelete(null) } }} />
    </div>
  )
}

export function GitPanel() {
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const gitByHost = useConsoleStore((state) => state.gitByHost)
  const setGitLockedRepo = useConsoleStore((state) => state.setGitLockedRepo)
  const resumeGitFollowEditor = useConsoleStore((state) => state.resumeGitFollowEditor)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [activeTab, setActiveTab] = useState<GitTab>('status')
  const [commitMessage, setCommitMessage] = useState('')
  const gitState = activeHostId ? gitByHost[activeHostId] : undefined
  const repoPath = gitState?.currentRepoPath || null
  const { data: status } = useGitStatus(activeHostId || '', repoPath || '', !!repoPath)
  const commit = useGitCommit()
  const stageAll = useGitStage()
  const unstageAll = useGitUnstage()
  const fetch = useGitFetch()
  const pull = useGitPull()
  const push = useGitPush()
  const queryClient = useQueryClient()
  const pinnedRepos = useMemo(() => (gitState?.recentRepos || []).filter((item) => item.pinned), [gitState?.recentRepos])
  const otherRepos = useMemo(() => (gitState?.recentRepos || []).filter((item) => !item.pinned), [gitState?.recentRepos])

  const handleCommit = () => {
    if (!activeHostId || !repoPath || !commitMessage.trim()) return
    commit.mutate({ hostId: activeHostId, path: repoPath, message: commitMessage.trim() }, {
      onSuccess: () => { setCommitMessage(''); pushToast({ type: 'success', message: t('git.commitSuccess') }) },
      onError: (err) => pushToast({ type: 'error', message: t('git.commitFailed') + ': ' + err.message }),
    })
  }

  if (!activeHostId) return <div className="flex h-full items-center justify-center p-3 text-[11px] text-text-3">{t('git.noRepo')}</div>

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1">
      <div className="border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text-1">
              {status?.branch || (repoPath ? t('git.detecting') : t('git.noRepo'))}
            </div>
            <div className="mt-0.5 text-[10px] text-text-3">
              {gitState?.mode === 'locked' ? t('git.modeLocked') : t('git.modeFollowingFile')}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status && status.ahead > 0 && <span className="text-[11px] text-green-400">↑{status.ahead}</span>}
            {status && status.behind > 0 && <span className="text-[11px] text-yellow-400">↓{status.behind}</span>}
          </div>
        </div>
        {repoPath && (
          <div className="mt-1 truncate text-[11px] text-text-3" title={repoPath}>{repoPath}</div>
        )}
        {repoPath && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {gitState?.mode === 'locked' && (
              <button onClick={() => activeHostId && resumeGitFollowEditor(activeHostId)} className="rounded px-2 py-0.5 text-[10px] text-accent hover:bg-bg-2 hover:text-text-1">{t('git.followCurrentFile')}</button>
            )}
            <button onClick={() => activeHostId && fetch.mutate({ hostId: activeHostId, path: repoPath }, { onSuccess: () => { pushToast({ type: 'success', message: t('git.fetchSuccess') }); queryClient.invalidateQueries({ queryKey: ['git-status'] }) }, onError: (err) => pushToast({ type: 'error', message: err.message }) })} className="rounded px-2 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.fetch')}</button>
            <button onClick={() => activeHostId && pull.mutate({ hostId: activeHostId, path: repoPath }, { onSuccess: () => { pushToast({ type: 'success', message: t('git.pullSuccess') }); queryClient.invalidateQueries({ queryKey: ['git-status'] }) }, onError: (err) => pushToast({ type: 'error', message: err.message }) })} className="rounded px-2 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.pull')}</button>
            <button onClick={() => activeHostId && push.mutate({ hostId: activeHostId, path: repoPath }, { onSuccess: () => { pushToast({ type: 'success', message: t('git.pushSuccess') }); queryClient.invalidateQueries({ queryKey: ['git-status'] }) }, onError: (err) => pushToast({ type: 'error', message: err.message.includes('rejected') ? t('git.pushRejected') : err.message }) })} className="rounded px-2 py-0.5 text-[10px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.push')}</button>
          </div>
        )}
        {!!pinnedRepos.length && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] text-text-3">{t('git.pinnedRepos')}</div>
            <div className="flex flex-wrap gap-1">
              {pinnedRepos.map((item) => (
                <button key={item.repoPath} onClick={() => activeHostId && setGitLockedRepo(activeHostId, item.repoPath)} className={`rounded px-2 py-0.5 text-[10px] ${repoPath === item.repoPath ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3 hover:text-text-1'}`}>{item.label}</button>
              ))}
            </div>
          </div>
        )}
        {!!otherRepos.length && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] text-text-3">{t('git.recentRepos')}</div>
            <div className="flex flex-wrap gap-1">
              {otherRepos.map((item) => (
                <button key={item.repoPath} onClick={() => activeHostId && setGitLockedRepo(activeHostId, item.repoPath)} className={`rounded px-2 py-0.5 text-[10px] ${repoPath === item.repoPath ? 'bg-accent/20 text-accent' : 'bg-bg-2 text-text-3 hover:text-text-1'}`}>{item.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      {repoPath && (
        <>
          <div className="flex border-b border-[var(--line)]">
            {(['status', 'history', 'branches'] as const).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${activeTab === tab ? 'border-b-2 border-accent text-accent' : 'text-text-3 hover:text-text-1'}`}>
                {t(`git.${tab}`)}
              </button>
            ))}
          </div>
          <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto">
            {activeTab === 'status' && <StatusTab hostId={activeHostId} repoPath={repoPath} t={t as TFunc} />}
            {activeTab === 'history' && <HistoryTab hostId={activeHostId} repoPath={repoPath} t={t as TFunc} />}
            {activeTab === 'branches' && <BranchesTab hostId={activeHostId} repoPath={repoPath} t={t as TFunc} />}
          </div>
          {activeTab === 'status' && (
            <div className="border-t border-[var(--line)] p-3">
              <textarea
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit() }}
                placeholder={t('git.commitMessage')}
                rows={2}
                className="w-full resize-none rounded border border-[var(--line)] bg-bg-0 px-2 py-1.5 text-[12px] text-text-1 outline-none focus:border-accent"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={handleCommit}
                  disabled={!commitMessage.trim() || !status?.staged.length}
                  className={`flex-1 rounded py-1.5 text-[12px] font-medium ${commitMessage.trim() && status?.staged.length ? 'bg-accent text-bg-0 hover:opacity-90' : 'bg-bg-2 text-text-3'}`}
                >
                  {t('git.commit')}
                </button>
                {status && status.unstaged.length > 0 && (
                  <button onClick={() => activeHostId && repoPath && stageAll.mutate({ hostId: activeHostId, path: repoPath, filePaths: status.unstaged.map((f) => f.path) })} className="rounded px-2 py-1.5 text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.stageAll')}</button>
                )}
                {status && status.staged.length > 0 && (
                  <button onClick={() => activeHostId && repoPath && unstageAll.mutate({ hostId: activeHostId, path: repoPath, filePaths: status.staged.map((f) => f.path) })} className="rounded px-2 py-1.5 text-[11px] text-text-3 hover:bg-bg-2 hover:text-text-1">{t('git.unstageAll')}</button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {!repoPath && (
        <div className="flex h-full items-center justify-center p-3 text-[11px] text-text-3">{gitState?.currentFilePath ? t('git.fileNotInRepo') : t('git.noActiveEditor')}</div>
      )}
    </div>
  )
}
