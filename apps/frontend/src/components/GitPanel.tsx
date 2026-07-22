'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { Button } from './Button'
import { Chip } from './Chip'
import { useGitStatus, useGitStage, useGitUnstage, useGitCommit, useGitDiscard, useGitLog, useGitBranches, useGitCheckout, useGitCreateBranch, useGitDeleteBranch, useGitMerge, useGitFetch, useGitPull, useGitPush, useGitPaneDetect, useGitRepositories, useGitOperation, useGitRemotes, useGitResolve } from '@/hooks/useApi'
import { useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from './ConfirmDialog'
import type { GitFileChange, GitCommitInfo, GitStatusResponse } from '@/types'
import { GitHistoryGraph } from './GitHistoryGraph'
import type { GitGraphBranchHead, GitGraphCommit } from '@/lib/gitGraph'
import { FiArrowRight, FiChevronLeft, FiDownload, FiFolder, FiLink, FiRefreshCw, FiSearch, FiSettings, FiUpload, FiX } from 'react-icons/fi'
import { api } from '@/lib/api'
import { DiffViewer } from './DiffViewer'

type GitTab = 'status' | 'history' | 'branches'
type MobileGitDiff = { title: string; subtitle: string; filePath: string; label?: string; staged?: boolean; commit?: string; workingTree?: boolean; untracked?: boolean }
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
      email: commit.authorEmail,
    },
    authoredAt: commit.authorDate || commit.date,
    committedAt: commit.date,
    parents: (commit.parents || []).filter((sha, index, arr) => !!sha && commitSet.has(sha) && arr.indexOf(sha) === index).map((sha) => ({ sha })),
  }))
}
function normalizeBranchHeads(branches: Array<{ name?: string; commitHash?: string; kind?: 'branch' | 'remote' | 'tag' }>, commitSet: Set<string>): GitGraphBranchHead[] {
  const seen = new Set<string>()
  return branches.filter((branch): branch is { name: string; commitHash: string; kind?: 'branch' | 'remote' | 'tag' } => !!branch?.name && !!branch?.commitHash && commitSet.has(branch.commitHash) && !seen.has(`${branch.kind || 'branch'}:${branch.name}`) && !!seen.add(`${branch.kind || 'branch'}:${branch.name}`)).map((branch) => ({
    name: branch.name,
    commit: { sha: branch.commitHash },
    kind: branch.kind || 'branch',
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
function GitLoadError({ onRetry, t }: { onRetry: () => void; t: TFunc }) {
  return <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 p-3 text-[11px] text-text-3"><span>{t('git.loadFailed')}</span><Chip tone="accent" onClick={onRetry}>{t('common.retry')}</Chip></div>
}

function FileRow({ file, staged, onStage, onUnstage, onDiscard, onViewDiff, t }: { file: GitFileChange; staged: boolean; onStage: () => void; onUnstage: () => void; onDiscard: () => void; onViewDiff: () => void; t: TFunc }) {
  const { icon, color } = statusIcon(file.status)
  return (
    <div className="group flex min-h-11 items-center gap-2 px-3 py-1 hover:bg-bg-2 lg:min-h-0" onClick={onViewDiff}>
      <span className={`w-4 text-center text-[11px] font-bold ${color}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-2" title={file.path}>{file.path}</span>
      <div className="flex shrink-0 items-center gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
        {staged ? (
          <Chip onClick={(e) => { e.stopPropagation(); onUnstage() }}>{t('git.unstage')}</Chip>
        ) : (
          <>
            <Chip onClick={(e) => { e.stopPropagation(); onStage() }}>{t('git.stage')}</Chip>
            <Chip tone="danger" onClick={(e) => { e.stopPropagation(); onDiscard() }}>{t('git.discard')}</Chip>
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
      <button onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold text-text-3 hover:bg-bg-2 lg:min-h-0">
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
        <span>{title}</span>
        <span className="ml-auto rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px]">{count}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function StatusTab({ hostId, repoPath, onOpenDiff, t }: { hostId: string; repoPath: string; onOpenDiff?: (diff: MobileGitDiff) => void; t: TFunc }) {
  const { data: status, isError, refetch } = useGitStatus(hostId, repoPath)
  const stage = useGitStage()
  const unstage = useGitUnstage()
  const discard = useGitDiscard()
  const resolve = useGitResolve()
  const operation = useGitOperation()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null)

  const openDiff = useCallback((file: GitFileChange, isStaged: boolean, untracked = false) => {
    if (onOpenDiff) {
      onOpenDiff({ title: file.path, subtitle: isStaged ? t('git.staged') : untracked ? t('git.untracked') : t('git.unstaged'), filePath: file.path, staged: isStaged, untracked })
      return
    }
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
  }, [hostId, onOpenDiff, repoPath, t])

  if (isError) return <GitLoadError onRetry={() => void refetch()} t={t} />
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
          <div key={`un-${f}`} className={`group flex min-h-11 items-center gap-2 px-3 py-1 hover:bg-bg-2 lg:min-h-0 ${onOpenDiff ? 'cursor-pointer' : ''}`} onClick={() => onOpenDiff && openDiff({ path: f, status: 'added', staged: false }, false, true)}>
            <span className="w-4 text-center text-[11px] font-bold text-text-3">?</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-2">{f}</span>
            <button onClick={(event) => { event.stopPropagation(); stage.mutate({ hostId, path: repoPath, filePaths: [f] }) }} className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-3 opacity-100 hover:bg-bg-2 hover:text-text-1 lg:opacity-0 lg:group-hover:opacity-100">{t('git.stage')}</button>
          </div>
        ))}
      </Section>
      <Section title={t('git.conflicted')} count={status.conflicted.length}>
        {status.conflicted.map((f) => <div key={`c-${f.path}`} className="border-b border-[var(--line)] px-3 py-2"><button onClick={() => openDiff(f, false)} className="block w-full truncate text-left text-[12px] text-text-2">{f.path}</button><div className="mt-2 flex flex-wrap gap-1"><Chip tone="accent" onClick={() => resolve.mutate({ hostId, path: repoPath, filePath: f.path, resolution: 'ours' })}>{t('git.useOurs')}</Chip><Chip tone="accent" onClick={() => resolve.mutate({ hostId, path: repoPath, filePath: f.path, resolution: 'theirs' })}>{t('git.useTheirs')}</Chip><Chip tone="accent" onClick={() => resolve.mutate({ hostId, path: repoPath, filePath: f.path, resolution: 'mark' })}>{t('git.markResolved')}</Chip></div></div>)}
      </Section>
      {status.operation && <div className="flex gap-2 border-y border-[var(--line)] p-3"><Button variant="primary" size="sm" disabled={status.conflicted.length > 0} className="flex-1" onClick={() => operation.mutate({ hostId, path: repoPath, operation: status.operation!, action: 'continue' }, { onError: (error) => pushToast({ type: 'error', message: `${t('git.operationFailed')}: ${error.message}` }) })}>{t('git.continueOperation', { operation: status.operation })}</Button><Button variant="danger" size="sm" onClick={() => operation.mutate({ hostId, path: repoPath, operation: status.operation!, action: 'abort' }, { onError: (error) => pushToast({ type: 'error', message: `${t('git.operationFailed')}: ${error.message}` }) })}>{t('git.abortOperation', { operation: status.operation })}</Button></div>}
      <ConfirmDialog open={!!pendingDiscard} title={t('git.discardTitle')} message={t('git.discardConfirm', { file: pendingDiscard || '' })} confirmLabel={t('git.discard')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDiscard(null)} onConfirm={() => { if (pendingDiscard) { discard.mutate({ hostId, path: repoPath, filePaths: [pendingDiscard] }); setPendingDiscard(null) } }} />
    </>
  )
}

function HistoryTab({ hostId, repoPath, status, onOpenWorkingTree, onOpenCommit, t }: { hostId: string; repoPath: string; status?: GitStatusResponse; onOpenWorkingTree: () => void; onOpenCommit?: (commit: GitGraphCommit) => void; t: TFunc }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isError, refetch } = useGitLogPaged(hostId, repoPath)
  const { data: branchesData } = useGitBranches(hostId, repoPath)
  const [searchQuery, setSearchQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const handleFind = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', handleFind)
    return () => window.removeEventListener('keydown', handleFind)
  }, [])
  if (isError) return <GitLoadError onRetry={() => void refetch()} t={t} />
  if (!data) return <div className="p-3 text-[11px] text-text-3">{t('git.detecting')}</div>
  const committedCommits = normalizeGitGraphCommits(data)
  const commitSet = new Set(committedCommits.map((commit) => commit.sha))
  const branchHeads = normalizeBranchHeads([
    ...(branchesData?.branches || []).map((branch) => ({ ...branch, kind: 'branch' as const })),
    ...(branchesData?.refs || []),
  ], commitSet)
  const currentBranch = normalizeCurrentBranch(branchesData?.current, branchHeads)
  const headCommit = branchesData?.branches.find((branch) => branch.current)?.commitHash
  const workingTreePaths = status ? new Set([...status.staged.map((file) => file.path), ...status.unstaged.map((file) => file.path), ...status.untracked, ...status.conflicted.map((file) => file.path)]) : new Set<string>()
  const commits: GitGraphCommit[] = workingTreePaths.size ? [{
    sha: '__WORKING_TREE__',
    shortSha: 'WIP',
    subject: t('git.workingTreeChanges', { count: workingTreePaths.size }),
    author: { name: t('git.workingTreeSummary', { staged: status?.staged.length || 0, unstaged: status?.unstaged.length || 0, untracked: status?.untracked.length || 0, conflicted: status?.conflicted.length || 0 }) },
    authoredAt: committedCommits[0]?.committedAt || new Date().toISOString(),
    committedAt: committedCommits[0]?.committedAt || new Date().toISOString(),
    parents: headCommit && commitSet.has(headCommit) ? [{ sha: headCommit }] : [],
    workingTree: true,
  }, ...committedCommits] : committedCommits
  const openCommitDiff = (commit: GitGraphCommit) => {
    if (commit.workingTree) {
      onOpenWorkingTree()
      return
    }
    if (!commit.sha) return
    if (onOpenCommit) {
      onOpenCommit(commit)
      return
    }
    const params = new URLSearchParams({ hostId, repoPath, commit: commit.sha })
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
        <FiSearch aria-hidden="true" className="shrink-0 text-text-3" size={14} />
        <input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('git.searchCommits')} className="min-w-0 flex-1 bg-transparent text-[12px] text-text-1 outline-none placeholder:text-text-3" />
        {searchQuery && <button type="button" aria-label={t('git.clearSearch')} title={t('git.clearSearch')} onClick={() => setSearchQuery('')} className="tmuxgo-icon-button flex h-6 w-6 items-center justify-center rounded text-text-3 hover:bg-bg-2 hover:text-text-1"><FiX aria-hidden="true" size={13} /></button>}
        <span className="shrink-0 font-mono text-[10px] text-text-3">{commits.length}</span>
      </div>
      <div className="tmuxgo-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain" data-git-history-scroll="1">
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
          formatDateFull={formatDateFull}
          searchQuery={searchQuery}
        />
        )}
      </div>
    </div>
  )
}

function useGitLogPaged(hostId: string, repoPath: string) {
  const key = `${hostId}:${repoPath}`
  const [pagination, setPagination] = useState({ key, page: 0 })
  const pagesRef = useRef<{ key: string; pages: GitCommitInfo[][] }>({ key, pages: [] })
  const page = pagination.key === key ? pagination.page : 0
  const pageSize = 200
  const { data, isLoading, isError, refetch } = useGitLog(hostId, repoPath, { limit: pageSize, skip: page * pageSize }, true)
  if (pagesRef.current.key !== key) pagesRef.current = { key, pages: [] }

  if (data && data.commits.length > 0) {
    const existing = pagesRef.current.pages[page]
    if (!existing || existing.length !== data.commits.length || existing[0]?.hash !== data.commits[0]?.hash) {
      pagesRef.current = { key, pages: [...pagesRef.current.pages] }
      pagesRef.current.pages[page] = data.commits
    }
  }

  const allCommits = pagesRef.current.pages.flat()
  const seen = new Set<string>()
  const uniqueCommits = allCommits.filter((c) => {
    if (!isValidGitCommitInfo(c) || !isValidCommitDate(c.date)) return false
    if (seen.has(c.hash)) return false
    seen.add(c.hash)
    return true
  })

  return {
    data: uniqueCommits,
    fetchNextPage: () => setPagination((current) => ({ key, page: current.key === key ? current.page + 1 : 1 })),
    hasNextPage: data?.hasMore ?? false,
    isFetchingNextPage: isLoading,
    isError,
    refetch,
  }
}

function formatDate(dateValue: string | number | Date) {
  try {
    const d = new Date(dateValue)
    if (!Number.isFinite(d.getTime())) return String(dateValue)
    const now = new Date()
    const sameYear = d.getFullYear() === now.getFullYear()
    return d.toLocaleString([], sameYear ? {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    } : {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return String(dateValue)
  }
}
function formatDateFull(dateValue: string | number | Date) {
  try {
    const d = new Date(dateValue)
    if (!Number.isFinite(d.getTime())) return String(dateValue)
    return d.toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return String(dateValue)
  }
}

function BranchesTab({ hostId, repoPath, t }: { hostId: string; repoPath: string; t: TFunc }) {
  const { data, isError, refetch } = useGitBranches(hostId, repoPath)
  const checkout = useGitCheckout()
  const deleteBranch = useGitDeleteBranch()
  const merge = useGitMerge()
  const createBranch = useGitCreateBranch()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const [showCreate, setShowCreate] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [noFF, setNoFF] = useState(false)

  if (isError) return <GitLoadError onRetry={() => void refetch()} t={t} />
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
            <Chip tone="accent" onClick={handleCreate}>{t('common.confirm')}</Chip>
            <Chip onClick={() => setShowCreate(false)}>{t('common.cancel')}</Chip>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2"><button onClick={() => setShowCreate(true)} className="text-[11px] text-accent hover:text-text-1">+ {t('git.newBranch')}</button><label className="flex items-center gap-1.5 text-[10px] text-text-3"><input type="checkbox" checked={noFF} onChange={(event) => setNoFF(event.target.checked)} className="accent-accent" />{t('git.noFF')}</label></div>
        )}
      </div>
      {data.branches.map((b) => (
        <div key={b.name} className="group flex min-h-11 items-center gap-2 px-3 py-1.5 hover:bg-bg-2 lg:min-h-0">
          <span className={`w-3 text-center text-[11px] ${b.current ? 'text-accent' : 'text-text-3'}`}>{b.current ? '●' : ''}</span>
          <div className="min-w-0 flex-1">
            <div className={`truncate text-[12px] ${b.current ? 'font-semibold text-accent' : 'text-text-1'}`}>{b.name}</div>
            {b.lastCommitSubject && <div className="truncate text-[10px] text-text-3">{b.lastCommitSubject}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
            {!b.current && (
              <>
                <Chip onClick={() => checkout.mutate({ hostId, path: repoPath, branch: b.name }, { onSuccess: () => pushToast({ type: 'success', message: t('git.checkoutSuccess', { branch: b.name }) }), onError: (err) => pushToast({ type: 'error', message: err.message }) })}>{t('git.checkout')}</Chip>
                <Chip onClick={() => merge.mutate({ hostId, path: repoPath, branch: b.name, noFF }, { onSuccess: () => pushToast({ type: 'success', message: t('git.mergeSuccess') }), onError: (err) => pushToast({ type: 'error', message: t('git.mergeFailed') + ': ' + err.message }) })}>{t('git.merge')}</Chip>
                <Chip tone="danger" onClick={() => setPendingDelete(b.name)}>✕</Chip>
              </>
            )}
          </div>
        </div>
      ))}
      <ConfirmDialog open={!!pendingDelete} title={t('git.deleteBranch')} message={t('git.deleteBranchConfirm', { name: pendingDelete || '' })} confirmLabel={t('git.deleteBranch')} cancelLabel={t('common.cancel')} tone="danger" onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) { deleteBranch.mutate({ hostId, path: repoPath, name: pendingDelete }, { onSuccess: () => pushToast({ type: 'success', message: t('git.deleteBranch') }), onError: (err) => pushToast({ type: 'error', message: err.message }) }); setPendingDelete(null) } }} />
    </div>
  )
}

export function GitPanel({ mode = 'desktop' }: { mode?: 'desktop' | 'mobile' }) {
  const { t } = useTranslation()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const activeEditorId = useConsoleStore((state) => state.activeEditorId)
  const openEditors = useConsoleStore((state) => state.openEditors)
  const gitByHost = useConsoleStore((state) => state.gitByHost)
  const ensureGitHostState = useConsoleStore((state) => state.ensureGitHostState)
  const setGitFollowPaneRepo = useConsoleStore((state) => state.setGitFollowPaneRepo)
  const setGitLockedRepo = useConsoleStore((state) => state.setGitLockedRepo)
  const resumeGitFollowEditor = useConsoleStore((state) => state.resumeGitFollowEditor)
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [activeTab, setActiveTab] = useState<GitTab>('history')
  const [commitMessage, setCommitMessage] = useState('')
  const [manualRepoPath, setManualRepoPath] = useState('')
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [repoSwitchingPath, setRepoSwitchingPath] = useState('')
  const [mobileDiff, setMobileDiff] = useState<MobileGitDiff | null>(null)
  const [gitOptionsOpen, setGitOptionsOpen] = useState(false)
  const [selectedRemote, setSelectedRemote] = useState('')
  const [fetchPrune, setFetchPrune] = useState(false)
  const [pullRebase, setPullRebase] = useState(false)
  const [pushForce, setPushForce] = useState(false)
  const [pushSetUpstream, setPushSetUpstream] = useState(false)
  const [amend, setAmend] = useState(false)
  const gitState = activeHostId ? gitByHost[activeHostId] : undefined
  const repoPath = gitState?.currentRepoPath || null
  const activeEditor = activeEditorId ? openEditors.find((editor) => editor.id === activeEditorId && !editor.id.startsWith('git-diff?')) : null
  const followPane = gitState?.mode !== 'locked' && (!activeEditor || !repoPath)
  const { data: paneDetect } = useGitPaneDetect(activeHostId || '', activePaneId || '', followPane)
  const { data: status, isError: statusError } = useGitStatus(activeHostId || '', repoPath || '', !!repoPath)
  const { data: discoveredRepos = [], isLoading: repositoriesLoading, isError: repositoriesError, refetch: refetchRepositories } = useGitRepositories(activeHostId || '', repoPickerOpen)
  const { data: remotesData } = useGitRemotes(activeHostId || '', repoPath || '')
  const commit = useGitCommit()
  const stageAll = useGitStage()
  const unstageAll = useGitUnstage()
  const fetch = useGitFetch()
  const pull = useGitPull()
  const push = useGitPush()
  const queryClient = useQueryClient()
  const pinnedRepos = useMemo(() => (gitState?.recentRepos || []).filter((item) => item.pinned), [gitState?.recentRepos])
  const otherRepos = useMemo(() => (gitState?.recentRepos || []).filter((item) => !item.pinned), [gitState?.recentRepos])
  const remotes = remotesData?.remotes || []
  const repoOptions = useMemo(() => [...pinnedRepos, ...otherRepos, ...discoveredRepos.map((item) => ({ repoPath: item.path, label: item.label, lastUsedAt: 0, pinned: false }))].filter((item, index, items) => items.findIndex((candidate) => candidate.repoPath === item.repoPath) === index), [discoveredRepos, otherRepos, pinnedRepos])
  const filteredRepoOptions = useMemo(() => {
    const query = manualRepoPath.trim().toLocaleLowerCase()
    return (query ? repoOptions.filter((item) => item.label.toLocaleLowerCase().includes(query) || item.repoPath.toLocaleLowerCase().includes(query)) : repoOptions).slice(0, 50)
  }, [manualRepoPath, repoOptions])
  const statusCount = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0
  const stageablePaths = status ? Array.from(new Set([...status.unstaged.map((file) => file.path), ...status.untracked, ...status.conflicted.map((file) => file.path)])) : []

  useEffect(() => {
    if (activeHostId) ensureGitHostState(activeHostId)
  }, [activeHostId, ensureGitHostState])
  useEffect(() => {
    if (!activeHostId || !followPane || !paneDetect) return
    setGitFollowPaneRepo(activeHostId, paneDetect.isGitRepo ? paneDetect.rootPath || paneDetect.path || null : null, paneDetect.path || null)
  }, [activeHostId, followPane, paneDetect, setGitFollowPaneRepo])
  useEffect(() => {
    if (mode !== 'mobile') return
    const handleBack = (event: Event) => {
      if (!mobileDiff) return
      const detail = (event as CustomEvent<{ handled?: boolean }>).detail
      detail.handled = true
      setMobileDiff(null)
    }
    window.addEventListener('tmuxgo-mobile-git-back', handleBack as EventListener)
    return () => window.removeEventListener('tmuxgo-mobile-git-back', handleBack as EventListener)
  }, [mobileDiff, mode])

  const handleCommit = () => {
    if (!activeHostId || !repoPath || !commitMessage.trim()) return
    commit.mutate({ hostId: activeHostId, path: repoPath, message: commitMessage.trim(), amend }, {
      onSuccess: () => { setCommitMessage(''); setAmend(false); pushToast({ type: 'success', message: t('git.commitSuccess') }) },
      onError: (err) => pushToast({ type: 'error', message: t('git.commitFailed') + ': ' + err.message }),
    })
  }
  const handleSelectRepo = async (path: string) => {
    if (!activeHostId || !path || repoSwitchingPath) return
    setRepoSwitchingPath(path)
    try {
      const result = await api.git.detect(activeHostId, path)
      if (!result.isGitRepo || !result.rootPath) throw new Error(t('git.noRepo'))
      setGitLockedRepo(activeHostId, result.rootPath)
      setManualRepoPath('')
      setRepoPickerOpen(false)
    } catch (error) {
      pushToast({ type: 'error', message: error instanceof Error ? error.message : t('git.noRepo') })
    } finally {
      setRepoSwitchingPath('')
    }
  }
  const handleOpenRepo = () => {
    const path = manualRepoPath.trim()
    if (!path.startsWith('/')) {
      pushToast({ type: 'error', message: t('git.noRepoResults') })
      return
    }
    void handleSelectRepo(path)
  }
  const handleRepoSearchSubmit = () => {
    const query = manualRepoPath.trim().toLocaleLowerCase()
    const match = filteredRepoOptions.find((item) => item.label.toLocaleLowerCase() === query || item.repoPath.toLocaleLowerCase() === query) || filteredRepoOptions[0]
    if (match) void handleSelectRepo(match.repoPath)
    else handleOpenRepo()
  }
  const handleOpenMobileDiff = (diff: MobileGitDiff) => {
    setMobileDiff(diff)
    window.dispatchEvent(new CustomEvent('tmuxgo-mobile-git-push-level'))
  }
  const handleOpenMobileCommit = (commit: GitGraphCommit) => handleOpenMobileDiff({ title: commit.subject, subtitle: commit.shortSha, filePath: '', label: commit.shortSha, commit: commit.sha })

  if (!activeHostId) return <div className="flex h-full items-center justify-center p-3 text-[11px] text-text-3">{t('git.noRepo')}</div>
  if (mode === 'mobile' && mobileDiff && repoPath) return <div className="flex h-full min-h-0 flex-col bg-bg-1"><div className="flex h-11 shrink-0 items-center border-b border-[var(--line)]"><button type="button" aria-label={t('common.back')} title={t('common.back')} onClick={() => window.history.back()} className="tmuxgo-icon-button flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-2 active:bg-bg-2 active:text-text-1"><FiChevronLeft aria-hidden="true" size={20} /></button><div className="min-w-0 flex-1 pr-3"><div className="truncate text-[13px] font-medium text-text-1">{mobileDiff.title}</div><div className="truncate font-mono text-[10px] text-text-3">{mobileDiff.subtitle}</div></div></div><div className="min-h-0 flex-1"><DiffViewer hostId={activeHostId} repoPath={repoPath} filePath={mobileDiff.filePath} staged={mobileDiff.staged} commit={mobileDiff.commit} workingTree={mobileDiff.workingTree} untracked={mobileDiff.untracked} label={mobileDiff.label || mobileDiff.title} /></div></div>

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1">
      <div className="border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text-1">
              {status?.branch || (statusError ? t('git.loadFailed') : repoPath ? t('git.detecting') : t('git.noRepo'))}
            </div>
            <div className="mt-0.5 text-[10px] text-text-3">
              {gitState?.mode === 'locked' ? t('git.modeLocked') : t('git.modeFollowingFile')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status && status.ahead > 0 && <span className="text-[11px] text-green-400">↑{status.ahead}</span>}
            {status && status.behind > 0 && <span className="text-[11px] text-yellow-400">↓{status.behind}</span>}
          </div>
        </div>
        {repoPath && (
          <div className="mt-1 truncate text-[11px] text-text-3" title={repoPath}>{repoPath}</div>
        )}
        {repoPath && (
          <div className="mt-2 flex items-center gap-1">
            <button aria-label={t('git.switchRepo')} title={t('git.switchRepo')} onClick={() => setRepoPickerOpen((open) => !open)} className={`tmuxgo-icon-button flex h-11 w-11 items-center justify-center rounded hover:bg-bg-2 hover:text-text-1 lg:h-7 lg:w-7 ${repoPickerOpen ? 'bg-bg-2 text-accent' : 'text-text-3'}`}><FiFolder aria-hidden="true" size={14} /></button>
            {gitState?.mode === 'locked' && (
              <button aria-label={t('git.followCurrentFile')} title={t('git.followCurrentFile')} onClick={() => activeHostId && resumeGitFollowEditor(activeHostId)} className="tmuxgo-icon-button flex h-11 w-11 items-center justify-center rounded text-accent hover:bg-bg-2 hover:text-text-1 lg:h-7 lg:w-7"><FiLink aria-hidden="true" size={14} /></button>
            )}
            <button aria-label={t('git.fetch')} title={t('git.fetch')} disabled={fetch.isPending} onClick={() => activeHostId && fetch.mutate({ hostId: activeHostId, path: repoPath, remote: selectedRemote || undefined, prune: fetchPrune }, { onSuccess: () => { pushToast({ type: 'success', message: t('git.fetchSuccess') }); queryClient.invalidateQueries({ queryKey: ['git-status'] }) }, onError: (err) => pushToast({ type: 'error', message: err.message }) })} className="tmuxgo-icon-button flex h-11 w-11 items-center justify-center rounded text-text-3 hover:bg-bg-2 hover:text-text-1 disabled:opacity-50 lg:h-7 lg:w-7"><FiRefreshCw aria-hidden="true" className={fetch.isPending ? 'animate-spin' : ''} size={14} /></button>
            <button aria-label={t('git.pull')} title={t('git.pull')} disabled={pull.isPending} onClick={() => activeHostId && pull.mutate({ hostId: activeHostId, path: repoPath, remote: selectedRemote || undefined, rebase: pullRebase }, { onSuccess: () => { pushToast({ type: 'success', message: t('git.pullSuccess') }); queryClient.invalidateQueries({ queryKey: ['git-status'] }) }, onError: (err) => pushToast({ type: 'error', message: err.message }) })} className="tmuxgo-icon-button flex h-11 w-11 items-center justify-center rounded text-text-3 hover:bg-bg-2 hover:text-text-1 disabled:opacity-50 lg:h-7 lg:w-7"><FiDownload aria-hidden="true" size={14} /></button>
            <button aria-label={t('git.push')} title={t('git.push')} disabled={push.isPending} onClick={() => activeHostId && push.mutate({ hostId: activeHostId, path: repoPath, remote: selectedRemote || undefined, branch: pushSetUpstream ? status?.branch : undefined, force: pushForce, setUpstream: pushSetUpstream }, { onSuccess: () => { pushToast({ type: 'success', message: t('git.pushSuccess') }); queryClient.invalidateQueries({ queryKey: ['git-status'] }) }, onError: (err) => pushToast({ type: 'error', message: err.message.includes('rejected') ? t('git.pushRejected') : err.message }) })} className="tmuxgo-icon-button flex h-11 w-11 items-center justify-center rounded text-text-3 hover:bg-bg-2 hover:text-text-1 disabled:opacity-50 lg:h-7 lg:w-7"><FiUpload aria-hidden="true" size={14} /></button>
            <button aria-label={t('git.options')} title={t('git.options')} onClick={() => setGitOptionsOpen((open) => !open)} className={`tmuxgo-icon-button flex h-11 w-11 items-center justify-center rounded hover:bg-bg-2 hover:text-text-1 lg:h-7 lg:w-7 ${gitOptionsOpen ? 'bg-bg-2 text-accent' : 'text-text-3'}`}><FiSettings aria-hidden="true" size={14} /></button>
          </div>
        )}
        {gitOptionsOpen && repoPath && <div className="mt-2 grid gap-2 border-t border-[var(--line)] pt-2 text-[11px] text-text-2"><label className="flex items-center justify-between gap-3"><span>{t('git.remote')}</span><select value={selectedRemote} onChange={(event) => setSelectedRemote(event.target.value)} className="tmuxgo-control tmuxgo-select min-w-0 rounded px-2 py-1"><option value="">auto</option>{remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select></label><label className="flex items-center justify-between gap-3"><span>{t('git.prune')}</span><input type="checkbox" checked={fetchPrune} onChange={(event) => setFetchPrune(event.target.checked)} className="accent-accent" /></label><label className="flex items-center justify-between gap-3"><span>{t('git.rebasePull')}</span><input type="checkbox" checked={pullRebase} onChange={(event) => setPullRebase(event.target.checked)} className="accent-accent" /></label><label className="flex items-center justify-between gap-3"><span>{t('git.forceWithLease')}</span><input type="checkbox" checked={pushForce} onChange={(event) => setPushForce(event.target.checked)} className="accent-accent" /></label><label className="flex items-center justify-between gap-3"><span>{t('git.setUpstream')}</span><input type="checkbox" checked={pushSetUpstream} onChange={(event) => setPushSetUpstream(event.target.checked)} className="accent-accent" /></label></div>}
        {repoPickerOpen && (
          <div className="mt-2 border-t border-[var(--line)] pt-2">
            <div className="tmuxgo-control flex items-center gap-2 rounded px-2">
              <FiSearch aria-hidden="true" className="shrink-0 text-text-3" size={13} />
              <input value={manualRepoPath} disabled={!!repoSwitchingPath} onChange={(event) => setManualRepoPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') handleRepoSearchSubmit() }} placeholder={t('git.selectRepo')} className="min-w-0 flex-1 bg-transparent py-1.5 text-[11px] text-text-1 outline-none disabled:opacity-60" autoFocus />
              {(repositoriesLoading || repoSwitchingPath) ? <FiRefreshCw aria-hidden="true" className="shrink-0 animate-spin text-text-3" size={13} /> : manualRepoPath && <button aria-label={t('git.openRepo')} title={t('git.openRepo')} onClick={handleRepoSearchSubmit} className="tmuxgo-icon-button flex h-6 w-6 items-center justify-center rounded text-accent hover:bg-bg-2"><FiArrowRight aria-hidden="true" size={13} /></button>}
            </div>
            {!!filteredRepoOptions.length && <div className="tmuxgo-scrollbar mt-1 max-h-32 overflow-y-auto">
              {filteredRepoOptions.map((item) => <button key={item.repoPath} disabled={!!repoSwitchingPath} onClick={() => void handleSelectRepo(item.repoPath)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-2 disabled:opacity-60 ${repoPath === item.repoPath ? 'text-accent' : 'text-text-2'}`}>
                <span className="shrink-0 text-[11px] font-medium">{item.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-text-3">{item.repoPath}</span>
              </button>)}
            </div>}
            {!filteredRepoOptions.length && repositoriesError && <button type="button" onClick={() => void refetchRepositories()} className="mt-1 w-full rounded px-2 py-2 text-left text-[11px] text-accent hover:bg-bg-2">{t('git.repoSearchFailed')} · {t('common.retry')}</button>}
            {!filteredRepoOptions.length && !repositoriesLoading && !repositoriesError && manualRepoPath && <div className="px-2 py-2 text-[11px] text-text-3">{t('git.noRepoResults')}</div>}
          </div>
        )}
      </div>
      {repoPath && (
        <>
          <div className="flex border-b border-[var(--line)]">
            {(['status', 'history', 'branches'] as const).map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`min-h-11 flex-1 py-1.5 text-[11px] font-medium transition-colors lg:min-h-0 ${activeTab === tab ? 'border-b-2 border-accent text-accent' : 'text-text-3 hover:text-text-1'}`}>
                {t(`git.${tab}`)}{tab === 'status' && statusCount > 0 ? ` ${statusCount}` : ''}
              </button>
            ))}
          </div>
          <div className={`tmuxgo-scrollbar min-h-0 flex-1 ${activeTab === 'history' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
            {activeTab === 'status' && <StatusTab hostId={activeHostId} repoPath={repoPath} onOpenDiff={mode === 'mobile' ? handleOpenMobileDiff : undefined} t={t as TFunc} />}
            {activeTab === 'history' && <HistoryTab hostId={activeHostId} repoPath={repoPath} status={status} onOpenWorkingTree={mode === 'mobile' ? () => handleOpenMobileDiff({ title: t('git.workingTreeChanges', { count: statusCount }), subtitle: 'WIP', filePath: '', workingTree: true }) : () => setActiveTab('status')} onOpenCommit={mode === 'mobile' ? handleOpenMobileCommit : undefined} t={t as TFunc} />}
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
                  disabled={!commitMessage.trim() || !amend && !status?.staged.length}
                  className={`flex-1 rounded py-1.5 text-[12px] font-medium ${commitMessage.trim() && (amend || status?.staged.length) ? 'bg-accent text-bg-0 hover:opacity-90' : 'bg-bg-2 text-text-3'}`}
                >
                  {t('git.commit')}
                </button>
                {stageablePaths.length > 0 && (
                  <button onClick={() => activeHostId && repoPath && stageAll.mutate({ hostId: activeHostId, path: repoPath, filePaths: stageablePaths })} className="tmuxgo-chip">{t('git.stageAll')}</button>
                )}
                {status && status.staged.length > 0 && (
                  <button onClick={() => activeHostId && repoPath && unstageAll.mutate({ hostId: activeHostId, path: repoPath, filePaths: status.staged.map((f) => f.path) })} className="tmuxgo-chip">{t('git.unstageAll')}</button>
                )}
              </div>
              <label className="mt-2 flex items-center gap-2 text-[10px] text-text-3"><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} className="accent-accent" />{t('git.amend')}</label>
            </div>
          )}
        </>
      )}
      {!repoPath && (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-[11px] text-text-3">
          <div>{gitState?.currentFilePath ? t('git.fileNotInRepo') : t('git.noActiveEditor')}</div>
          <div className="flex w-full max-w-md gap-2">
            <input value={manualRepoPath} onChange={(event) => setManualRepoPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleOpenRepo() }} placeholder={t('git.selectRepo')} className="tmuxgo-control tmuxgo-input min-w-0 flex-1 rounded px-2.5 py-1.5 text-[12px]" />
            <button type="button" disabled={!manualRepoPath.trim()} onClick={() => void handleOpenRepo()} className="tmuxgo-button tmuxgo-button--primary tmuxgo-button--sm">{t('git.openRepo')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
