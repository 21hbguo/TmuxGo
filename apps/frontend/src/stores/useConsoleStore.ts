import { create } from 'zustand'
import type { ConnectionState, FileDocumentHandle, FileEditorDocument, GitHostState, GitMode, GitSource, UploadJob, TerminalPerfState } from '@/types'
type PersistedEditor = Pick<FileEditorDocument, 'id' | 'hostId' | 'rootId' | 'rootLabel' | 'rootPath' | 'path' | 'name' | 'absolutePath' | 'language'>
const OPEN_EDITORS_STORAGE_KEY = 'tmuxgo-open-editors'
const ACTIVE_EDITOR_STORAGE_KEY = 'tmuxgo-active-editor'
const ACTIVE_SESSION_STORAGE_KEY = 'tmuxgo-active-session'
function getActiveSessionStorageKey(hostId: string) {
  return `${ACTIVE_SESSION_STORAGE_KEY}:${hostId}`
}
function readPersistedEditors() {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_EDITORS_STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter((item): item is PersistedEditor => !!item && typeof item.id === 'string' && typeof item.hostId === 'string' && typeof item.rootId === 'string' && typeof item.rootLabel === 'string' && typeof item.rootPath === 'string' && typeof item.path === 'string' && typeof item.name === 'string' && typeof item.absolutePath === 'string' && typeof item.language === 'string')
  } catch {
    return []
  }
}
function readPersistedActiveEditorId() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ACTIVE_EDITOR_STORAGE_KEY) || null
}
function toEditorDocument(file: PersistedEditor): FileEditorDocument {
  return { ...file, content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: true, saving: false, binary: false, truncated: false }
}
function writePersistedEditors(openEditors: FileEditorDocument[], activeEditorId: string | null) {
  if (typeof window === 'undefined') return
  const nextEditors = openEditors.filter((item) => !item.kind || item.kind === 'file').map(({ id, hostId, rootId, rootLabel, rootPath, path, name, absolutePath, language }) => ({ id, hostId, rootId, rootLabel, rootPath, path, name, absolutePath, language }))
  localStorage.setItem(OPEN_EDITORS_STORAGE_KEY, JSON.stringify(nextEditors))
  if (activeEditorId) localStorage.setItem(ACTIVE_EDITOR_STORAGE_KEY, activeEditorId)
  else localStorage.removeItem(ACTIVE_EDITOR_STORAGE_KEY)
}
interface ConsoleState {
  activeHostId: string | null
  activeSessionId: string | null
  activePaneId: string | null
  connection: ConnectionState
  terminalPerf: TerminalPerfState
  showCommandPalette: boolean
  sessionPanelExpanded: boolean
  filePanelOpen: boolean
  gitPanelOpen: boolean
  gitPanelWidth: number
  gitByHost: Record<string, GitHostState>
  mobileFileSheetOpen: boolean
  sessionPanelWidth: number
  filePanelWidth: number
  terminalPanelHeight: number
  openEditors: FileEditorDocument[]
  activeEditorId: string | null
  editorPrimaryGroupIds: string[]
  editorSecondaryGroupIds: string[]
  editorPrimaryId: string | null
  editorSecondaryId: string | null
  editorSplitDirection: 'horizontal' | 'vertical' | null
  editorSplitRatio: number
  activeEditorSlot: 'primary' | 'secondary'
  editorsHydrated: boolean
  uploadRequest: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean } | null
  uploadJobs: UploadJob[]
  toasts: { id: string; type: 'success' | 'error' | 'info'; message: string; durationMs?: number }[]
  setActiveHost: (id: string) => void
  setActiveSession: (id: string) => void
  setActivePane: (id: string | null) => void
  setCommandPalette: (open: boolean) => void
  setSessionPanelExpanded: (expanded: boolean) => void
  toggleSessionPanel: () => void
  setFilePanelOpen: (open: boolean) => void
  toggleFilePanel: () => void
  setGitPanelOpen: (open: boolean) => void
  toggleGitPanel: () => void
  setGitPanelWidth: (width: number) => void
  ensureGitHostState: (hostId: string) => void
  replaceGitByHost: (gitByHost: Record<string, GitHostState>) => void
  setGitFollowEditorRepo: (hostId: string, repoPath: string | null, filePath: string | null) => void
  setGitLockedRepo: (hostId: string, repoPath: string) => void
  resumeGitFollowEditor: (hostId: string) => void
  pinGitRepo: (hostId: string, repoPath: string, pinned: boolean) => void
  setMobileFileSheetOpen: (open: boolean) => void
  setSessionPanelWidth: (width: number) => void
  setFilePanelWidth: (width: number) => void
  setTerminalPanelHeight: (height: number) => void
  hydrateEditorsFromStorage: () => void
  openEditor: (file: FileDocumentHandle & { language: string }) => void
  openCompareEditor: (leftId: string, rightId: string) => string | null
  placeEditorInSplit: (id: string, placement: 'center' | 'left' | 'right' | 'top' | 'bottom') => void
  moveEditorToGroup: (id: string, targetGroup: 'primary' | 'secondary', targetId?: string | null) => void
  setEditorSplitRatio: (ratio: number) => void
  closeEditor: (id: string) => void
  setActiveEditor: (id: string | null) => void
  setEditorLoaded: (id: string, patch: Partial<FileEditorDocument>) => void
  setEditorContent: (id: string, content: string) => void
  setEditorSaving: (id: string, saving: boolean) => void
  markEditorSaved: (id: string, content: string, modifiedAt: string, size: number) => void
  openUploadDialog: (request: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean }) => void
  closeUploadDialog: () => void
  addUploadJob: (job: UploadJob) => void
  updateUploadJob: (id: string, patch: Partial<UploadJob>) => void
  removeUploadJob: (id: string) => void
  clearFinishedUploadJobs: () => void
  pushToast: (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void
  removeToast: (id: string) => void
  updateConnection: (state: Partial<ConnectionState>) => void
  updateTerminalPerf: (state: Partial<TerminalPerfState>) => void
}
function createDefaultGitHostState(): GitHostState {
  return { mode: 'follow-editor', currentRepoPath: null, currentFilePath: null, source: null, lockedRepoPath: null, recentRepos: [] }
}
function touchGitRepo(state: GitHostState, repoPath: string) {
  const label = repoPath.split('/').filter(Boolean).pop() || repoPath
  const existing = state.recentRepos.find((item) => item.repoPath === repoPath)
  const next = { repoPath, label, lastUsedAt: Date.now(), pinned: existing?.pinned || false }
  return [next, ...state.recentRepos.filter((item) => item.repoPath !== repoPath)].slice(0, 12)
}
function updateGitHostState(gitByHost: Record<string, GitHostState>, hostId: string, updater: (current: GitHostState) => GitHostState) {
  const current = gitByHost[hostId] || createDefaultGitHostState()
  return { ...gitByHost, [hostId]: updater(current) }
}
function insertEditorId(items: string[], id: string, targetId?: string | null) {
  const next = items.filter((item) => item !== id)
  if (!targetId) return [...next, id]
  const index = next.indexOf(targetId)
  if (index < 0) return [...next, id]
  next.splice(index, 0, id)
  return next
}
export const useConsoleStore = create<ConsoleState>((set) => ({
  activeHostId: null,
  activeSessionId: null,
  activePaneId: null,
  connection: { status: 'disconnected', latency: 0, lastPing: new Date().toISOString() },
  terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' },
  showCommandPalette: false,
  sessionPanelExpanded: true,
  filePanelOpen: false,
  gitPanelOpen: false,
  gitPanelWidth: 320,
  gitByHost: {},
  mobileFileSheetOpen: false,
  sessionPanelWidth: 248,
  filePanelWidth: 240,
  terminalPanelHeight: 300,
  openEditors: [],
  activeEditorId: null,
  editorPrimaryGroupIds: [],
  editorSecondaryGroupIds: [],
  editorPrimaryId: null,
  editorSecondaryId: null,
  editorSplitDirection: null,
  editorSplitRatio: 0.5,
  activeEditorSlot: 'primary',
  editorsHydrated: false,
  uploadRequest: null,
  uploadJobs: [],
  toasts: [],
  setActiveHost: (id) => {
    let activeSessionId = ''
    if (typeof window !== 'undefined') {
      localStorage.setItem('tmuxgo-active-host', id)
      activeSessionId = localStorage.getItem(getActiveSessionStorageKey(id)) || ''
    }
    set({ activeHostId: id, activeSessionId, activePaneId: null })
  },
  setActiveSession: (id) => set((state) => {
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id)
      else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
      if (state.activeHostId) {
        if (id) localStorage.setItem(getActiveSessionStorageKey(state.activeHostId), id)
        else localStorage.removeItem(getActiveSessionStorageKey(state.activeHostId))
      }
    }
    return { activeSessionId: id, activePaneId: null }
  }),
  setActivePane: (id) => set({ activePaneId: id }),
  setCommandPalette: (open) => set({ showCommandPalette: open }),
  setSessionPanelExpanded: (expanded) => set({ sessionPanelExpanded: expanded }),
  toggleSessionPanel: () => set((state) => ({ sessionPanelExpanded: !state.sessionPanelExpanded, gitPanelOpen: state.sessionPanelExpanded ? state.gitPanelOpen : false })),
  setFilePanelOpen: (open) => set((state) => open ? { filePanelOpen: true, sessionPanelExpanded: false, gitPanelOpen: false } : { filePanelOpen: false }),
  toggleFilePanel: () => set((state) => state.filePanelOpen ? { filePanelOpen: false } : { filePanelOpen: true, sessionPanelExpanded: false, gitPanelOpen: false }),
  setGitPanelOpen: (open) => set((state) => open ? { gitPanelOpen: true, sessionPanelExpanded: false, filePanelOpen: false } : { gitPanelOpen: false }),
  toggleGitPanel: () => set((state) => state.gitPanelOpen ? { gitPanelOpen: false } : { gitPanelOpen: true, sessionPanelExpanded: false, filePanelOpen: false }),
  setGitPanelWidth: (width) => set({ gitPanelWidth: Math.max(260, Math.min(400, width)) }),
  ensureGitHostState: (hostId) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => current) })),
  replaceGitByHost: (gitByHost) => set({ gitByHost }),
  setGitFollowEditorRepo: (hostId, repoPath, filePath) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => {
    if (current.mode === 'locked') return { ...current, currentFilePath: filePath }
    return { ...current, currentRepoPath: repoPath, currentFilePath: filePath, source: repoPath ? 'editor' as GitSource : current.source, recentRepos: repoPath ? touchGitRepo(current, repoPath) : current.recentRepos }
  }) })),
  setGitLockedRepo: (hostId, repoPath) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({ ...current, mode: 'locked' as GitMode, currentRepoPath: repoPath, lockedRepoPath: repoPath, source: 'manual', recentRepos: touchGitRepo(current, repoPath) })) })),
  resumeGitFollowEditor: (hostId) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({ ...current, mode: 'follow-editor', lockedRepoPath: null, source: current.currentRepoPath ? 'editor' : null })) })),
  pinGitRepo: (hostId, repoPath, pinned) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({ ...current, recentRepos: current.recentRepos.map((item) => item.repoPath === repoPath ? { ...item, pinned } : item) })) })),
  setMobileFileSheetOpen: (open) => set({ mobileFileSheetOpen: open }),
  setSessionPanelWidth: (width) => set({ sessionPanelWidth: Math.max(208, Math.min(320, width)) }),
  setFilePanelWidth: (width) => set({ filePanelWidth: Math.max(200, Math.min(520, width)) }),
  setTerminalPanelHeight: (height) => set({ terminalPanelHeight: Math.max(180, Math.min(2000, height)) }),
  hydrateEditorsFromStorage: () => set((state) => {
    if (state.editorsHydrated) return state
    const nextEditors = readPersistedEditors().map(toEditorDocument)
    const nextActiveEditorId = (() => {
      const id = readPersistedActiveEditorId()
      return id && nextEditors.some((item) => item.id === id) ? id : nextEditors[nextEditors.length - 1]?.id || null
    })()
    return { openEditors: nextEditors, activeEditorId: nextActiveEditorId, editorPrimaryGroupIds: nextEditors.map((item) => item.id), editorSecondaryGroupIds: [], editorPrimaryId: nextActiveEditorId, editorSecondaryId: null, editorSplitDirection: null, editorSplitRatio: 0.5, activeEditorSlot: 'primary' as const, editorsHydrated: true }
  }),
  openEditor: (file) => set((state) => {
    const existing = state.openEditors.find((item) => item.id === file.id)
    if (existing) {
      writePersistedEditors(state.openEditors, existing.id)
      if (state.editorSecondaryGroupIds.includes(existing.id)) return { activeEditorId: existing.id, editorSecondaryId: existing.id, activeEditorSlot: 'secondary' as const }
      const nextPrimaryGroupIds = state.editorPrimaryGroupIds.includes(existing.id) ? state.editorPrimaryGroupIds : [...state.editorPrimaryGroupIds, existing.id]
      return { activeEditorId: existing.id, editorPrimaryGroupIds: nextPrimaryGroupIds, editorPrimaryId: existing.id, activeEditorSlot: 'primary' as const }
    }
    const targetSlot:'primary'|'secondary' = state.editorSplitDirection && state.activeEditorSlot === 'secondary' ? 'secondary' : 'primary'
    const nextState = {
      openEditors: [...state.openEditors, { ...file, content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: true, saving: false, binary: false, truncated: false }],
      activeEditorId: file.id,
      editorPrimaryGroupIds: targetSlot === 'primary' ? [...state.editorPrimaryGroupIds, file.id] : state.editorPrimaryGroupIds,
      editorSecondaryGroupIds: targetSlot === 'secondary' ? [...state.editorSecondaryGroupIds, file.id] : state.editorSecondaryGroupIds,
      editorPrimaryId: targetSlot === 'primary' ? file.id : state.editorPrimaryId || state.editorPrimaryGroupIds.at(-1) || file.id,
      editorSecondaryId: targetSlot === 'secondary' ? file.id : state.editorSecondaryId,
      activeEditorSlot: targetSlot,
    }
    writePersistedEditors(nextState.openEditors, nextState.activeEditorId)
    return nextState
  }),
  openCompareEditor: (leftId, rightId) => {
    const left = useConsoleStore.getState().openEditors.find((item) => item.id === leftId)
    const right = useConsoleStore.getState().openEditors.find((item) => item.id === rightId)
    if (!left || !right) return null
    const compareId = `compare:${[leftId, rightId].sort().join('::')}`
    set((state) => {
      const existing = state.openEditors.find((item) => item.id === compareId)
      if (existing) {
        writePersistedEditors(state.openEditors, existing.id)
        if (state.editorSecondaryGroupIds.includes(existing.id)) return { activeEditorId: existing.id, editorSecondaryId: existing.id, activeEditorSlot: 'secondary' as const }
        return { activeEditorId: existing.id, editorPrimaryId: existing.id, activeEditorSlot: 'primary' as const }
      }
      const targetSlot:'primary'|'secondary' = state.editorSplitDirection && state.activeEditorSlot === 'secondary' ? 'secondary' : 'primary'
      const nextState = {
        openEditors: [...state.openEditors, { id: compareId, hostId: left.hostId, rootId: left.rootId, rootLabel: left.rootLabel, rootPath: left.rootPath, path: left.path, name: `${left.name} <> ${right.name}`, absolutePath: '', language: left.language === right.language ? left.language : 'plaintext', content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: false, saving: false, binary: false, truncated: false, kind: 'compare' as const, compareLeftId: leftId, compareRightId: rightId }],
        activeEditorId: compareId,
        editorPrimaryGroupIds: targetSlot === 'primary' ? [...state.editorPrimaryGroupIds, compareId] : state.editorPrimaryGroupIds,
        editorSecondaryGroupIds: targetSlot === 'secondary' ? [...state.editorSecondaryGroupIds, compareId] : state.editorSecondaryGroupIds,
        editorPrimaryId: targetSlot === 'primary' ? compareId : state.editorPrimaryId || state.editorPrimaryGroupIds.at(-1) || compareId,
        editorSecondaryId: targetSlot === 'secondary' ? compareId : state.editorSecondaryId,
        activeEditorSlot: targetSlot,
      }
      writePersistedEditors(nextState.openEditors, nextState.activeEditorId)
      return nextState
    })
    return compareId
  },
  placeEditorInSplit: (id, placement) => set((state) => {
    if (!state.openEditors.some((item) => item.id === id)) return state
    const nextPrimaryGroupIds = state.editorPrimaryGroupIds.filter((item) => item !== id)
    const nextSecondaryGroupIds = state.editorSecondaryGroupIds.filter((item) => item !== id)
    if (placement === 'center') {
      writePersistedEditors(state.openEditors, id)
      if (state.editorSplitDirection && state.activeEditorSlot === 'secondary') return { activeEditorId: id, editorPrimaryGroupIds: nextPrimaryGroupIds, editorSecondaryGroupIds: [...nextSecondaryGroupIds, id], editorPrimaryId: state.editorPrimaryId, editorSecondaryId: id, activeEditorSlot: 'secondary' as const }
      return { activeEditorId: id, editorPrimaryGroupIds: [...nextPrimaryGroupIds, id], editorSecondaryGroupIds: nextSecondaryGroupIds, editorPrimaryId: id, editorSecondaryId: state.editorSecondaryId, activeEditorSlot: 'primary' as const }
    }
    const nextDirection = placement === 'left' || placement === 'right' ? 'horizontal' : 'vertical'
    const basePrimaryGroupIds = nextPrimaryGroupIds.length ? nextPrimaryGroupIds : nextSecondaryGroupIds
    if (!state.editorSplitDirection) {
      if (placement === 'left' || placement === 'top') {
        writePersistedEditors(state.openEditors, id)
        return { activeEditorId: id, editorPrimaryGroupIds: [id], editorSecondaryGroupIds: basePrimaryGroupIds, editorPrimaryId: id, editorSecondaryId: basePrimaryGroupIds.at(-1) || null, editorSplitDirection: nextDirection, editorSplitRatio: 0.5, activeEditorSlot: 'primary' as const }
      }
      writePersistedEditors(state.openEditors, id)
      return { activeEditorId: id, editorPrimaryGroupIds: basePrimaryGroupIds, editorSecondaryGroupIds: [id], editorPrimaryId: basePrimaryGroupIds.at(-1) || null, editorSecondaryId: id, editorSplitDirection: nextDirection, editorSplitRatio: 0.5, activeEditorSlot: 'secondary' as const }
    }
    if (placement === 'left' || placement === 'top') {
      writePersistedEditors(state.openEditors, id)
      return { activeEditorId: id, editorPrimaryGroupIds: [...nextPrimaryGroupIds, id], editorSecondaryGroupIds: nextSecondaryGroupIds, editorPrimaryId: id, editorSecondaryId: nextSecondaryGroupIds.at(-1) || null, editorSplitDirection: nextDirection, editorSplitRatio: state.editorSplitRatio, activeEditorSlot: 'primary' as const }
    }
    writePersistedEditors(state.openEditors, id)
    return { activeEditorId: id, editorPrimaryGroupIds: nextPrimaryGroupIds, editorSecondaryGroupIds: [...nextSecondaryGroupIds, id], editorPrimaryId: nextPrimaryGroupIds.at(-1) || null, editorSecondaryId: id, editorSplitDirection: nextDirection, editorSplitRatio: state.editorSplitRatio, activeEditorSlot: 'secondary' as const }
  }),
  moveEditorToGroup: (id, targetGroup, targetId) => set((state) => {
    if (!state.openEditors.some((item) => item.id === id)) return state
    let nextPrimaryGroupIds = targetGroup === 'primary' ? insertEditorId(state.editorPrimaryGroupIds, id, targetId) : state.editorPrimaryGroupIds.filter((item) => item !== id)
    let nextSecondaryGroupIds = targetGroup === 'secondary' ? insertEditorId(state.editorSecondaryGroupIds, id, targetId) : state.editorSecondaryGroupIds.filter((item) => item !== id)
    let nextSplitDirection = state.editorSplitDirection
    let nextActiveEditorSlot:'primary'|'secondary' = targetGroup
    if (!nextPrimaryGroupIds.length && nextSecondaryGroupIds.length) {
      nextPrimaryGroupIds = nextSecondaryGroupIds
      nextSecondaryGroupIds = []
      nextSplitDirection = null
      nextActiveEditorSlot = 'primary'
    }
    if (!nextSecondaryGroupIds.length) nextSplitDirection = null
    else if (!nextSplitDirection) nextSplitDirection = 'horizontal'
    writePersistedEditors(state.openEditors, id)
    return { activeEditorId: id, editorPrimaryGroupIds: nextPrimaryGroupIds, editorSecondaryGroupIds: nextSecondaryGroupIds, editorPrimaryId: nextActiveEditorSlot === 'primary' ? id : nextPrimaryGroupIds.at(-1) || null, editorSecondaryId: nextActiveEditorSlot === 'secondary' ? id : nextSecondaryGroupIds.at(-1) || null, editorSplitDirection: nextSplitDirection, editorSplitRatio: state.editorSplitRatio, activeEditorSlot: nextActiveEditorSlot }
  }),
  setEditorSplitRatio: (ratio) => set({ editorSplitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),
  closeEditor: (id) => set((state) => {
    const nextEditors = state.openEditors.filter((item) => item.id !== id)
    let nextPrimaryGroupIds = state.editorPrimaryGroupIds.filter((item) => item !== id)
    let nextSecondaryGroupIds = state.editorSecondaryGroupIds.filter((item) => item !== id)
    let nextSplitDirection = state.editorSplitDirection
    let nextActiveEditorSlot:'primary'|'secondary' = state.activeEditorSlot
    if (!nextPrimaryGroupIds.length && nextSecondaryGroupIds.length) {
      nextPrimaryGroupIds = nextSecondaryGroupIds
      nextSecondaryGroupIds = []
      nextSplitDirection = null
      nextActiveEditorSlot = 'primary'
    }
    if (!nextSecondaryGroupIds.length) {
      nextSplitDirection = null
      nextActiveEditorSlot = 'primary'
    }
    const nextPrimaryId = state.editorPrimaryId && nextPrimaryGroupIds.includes(state.editorPrimaryId) ? state.editorPrimaryId : nextPrimaryGroupIds.at(-1) || null
    const nextSecondaryId = state.editorSecondaryId && nextSecondaryGroupIds.includes(state.editorSecondaryId) ? state.editorSecondaryId : nextSecondaryGroupIds.at(-1) || null
    let nextActiveEditorId = state.activeEditorId === id ? null : state.activeEditorId
    if (!nextActiveEditorId || !nextEditors.some((item) => item.id === nextActiveEditorId)) nextActiveEditorId = nextActiveEditorSlot === 'secondary' && nextSecondaryId ? nextSecondaryId : nextPrimaryId
    writePersistedEditors(nextEditors, nextActiveEditorId)
    return { openEditors: nextEditors, activeEditorId: nextActiveEditorId, editorPrimaryGroupIds: nextPrimaryGroupIds, editorSecondaryGroupIds: nextSecondaryGroupIds, editorPrimaryId: nextPrimaryId, editorSecondaryId: nextSecondaryId, editorSplitDirection: nextSplitDirection, editorSplitRatio: nextSplitDirection ? state.editorSplitRatio : 0.5, activeEditorSlot: nextActiveEditorSlot }
  }),
  setActiveEditor: (id) => set((state) => {
    writePersistedEditors(state.openEditors, id)
    if (!id) return { activeEditorId: id }
    if (state.editorSecondaryGroupIds.includes(id)) return { activeEditorId: id, editorSecondaryId: id, activeEditorSlot: 'secondary' as const }
    const nextPrimaryGroupIds = state.editorPrimaryGroupIds.includes(id) ? state.editorPrimaryGroupIds : [...state.editorPrimaryGroupIds, id]
    return { activeEditorId: id, editorPrimaryGroupIds: nextPrimaryGroupIds, editorPrimaryId: id, activeEditorSlot: 'primary' as const }
  }),
  setEditorLoaded: (id, patch) => set((state) => ({ openEditors: state.openEditors.map((item) => item.id === id ? { ...item, ...patch } : item) })),
  setEditorContent: (id, content) => set((state) => ({ openEditors: state.openEditors.map((item) => item.id === id ? { ...item, content, dirty: content !== item.savedContent } : item) })),
  setEditorSaving: (id, saving) => set((state) => ({ openEditors: state.openEditors.map((item) => item.id === id ? { ...item, saving } : item) })),
  markEditorSaved: (id, content, modifiedAt, size) => set((state) => ({ openEditors: state.openEditors.map((item) => item.id === id ? { ...item, content, savedContent: content, modifiedAt, size, dirty: false, saving: false, loading: false, problem: undefined } : item) })),
  openUploadDialog: (request) => set({ uploadRequest: request }),
  closeUploadDialog: () => set({ uploadRequest: null }),
  addUploadJob: (job) => set((state) => ({ uploadJobs: [job, ...state.uploadJobs].slice(0, 12) })),
  updateUploadJob: (id, patch) => set((state) => ({ uploadJobs: state.uploadJobs.map((job) => job.id === id ? { ...job, ...patch } : job) })),
  removeUploadJob: (id) => set((state) => ({ uploadJobs: state.uploadJobs.filter((job) => job.id !== id) })),
  clearFinishedUploadJobs: () => set((state) => ({ uploadJobs: state.uploadJobs.filter((job) => job.status === 'queued' || job.status === 'uploading') })),
  pushToast: (toast) => set((state) => ({ toasts: [...state.toasts, { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ...toast }] })),
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  updateConnection: (newState) => set((state) => ({ connection: { ...state.connection, ...newState } })),
  updateTerminalPerf: (newState) => set((state) => ({ terminalPerf: { ...state.terminalPerf, ...newState } })),
}))
