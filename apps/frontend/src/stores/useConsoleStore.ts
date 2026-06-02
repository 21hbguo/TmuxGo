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
  return {
    ...file,
    content: '',
    savedContent: '',
    modifiedAt: '',
    size: 0,
    dirty: false,
    loading: true,
    saving: false,
    binary: false,
    truncated: false,
  }
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
  editorPrimaryId: string | null
  editorSecondaryId: string | null
  editorSplitDirection: 'horizontal' | 'vertical' | null
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
  return {
    mode: 'follow-editor',
    currentRepoPath: null,
    currentFilePath: null,
    source: null,
    lockedRepoPath: null,
    recentRepos: [],
  }
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

export const useConsoleStore = create<ConsoleState>((set) => ({
  activeHostId: null,
  activeSessionId: null,
  activePaneId: null,
  connection: {
    status: 'disconnected',
    latency: 0,
    lastPing: new Date().toISOString(),
  },
  terminalPerf: {
    attachLatency: 0,
    outputBytes: 0,
    outputEvents: 0,
    outputBacklog: 0,
    layoutFitCount: 0,
    lastOutputAt: '',
  },
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
  editorPrimaryId: null,
  editorSecondaryId: null,
  editorSplitDirection: null,
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
  setGitFollowEditorRepo: (hostId, repoPath, filePath) => set((state) => ({
    gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => {
      if (current.mode === 'locked') return { ...current, currentFilePath: filePath }
      return {
        ...current,
        currentRepoPath: repoPath,
        currentFilePath: filePath,
        source: repoPath ? 'editor' as GitSource : current.source,
        recentRepos: repoPath ? touchGitRepo(current, repoPath) : current.recentRepos,
      }
    }),
  })),
  setGitLockedRepo: (hostId, repoPath) => set((state) => ({
    gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({
      ...current,
      mode: 'locked' as GitMode,
      currentRepoPath: repoPath,
      lockedRepoPath: repoPath,
      source: 'manual',
      recentRepos: touchGitRepo(current, repoPath),
    })),
  })),
  resumeGitFollowEditor: (hostId) => set((state) => ({
    gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({
      ...current,
      mode: 'follow-editor',
      lockedRepoPath: null,
      source: current.currentRepoPath ? 'editor' : null,
    })),
  })),
  pinGitRepo: (hostId, repoPath, pinned) => set((state) => ({
    gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({
      ...current,
      recentRepos: current.recentRepos.map((item) => item.repoPath === repoPath ? { ...item, pinned } : item),
    })),
  })),
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
    return { openEditors: nextEditors, activeEditorId: nextActiveEditorId, editorPrimaryId: nextActiveEditorId, editorSecondaryId: null, editorSplitDirection: null, activeEditorSlot: 'primary', editorsHydrated: true }
  }),
  openEditor: (file) => set((state) => {
    const existing = state.openEditors.find((item) => item.id === file.id)
    if (existing) {
      writePersistedEditors(state.openEditors, existing.id)
      return { activeEditorId: existing.id, editorPrimaryId: state.editorPrimaryId || existing.id }
    }
    const nextState = {
      openEditors: [...state.openEditors, {
        ...file,
        content: '',
        savedContent: '',
        modifiedAt: '',
        size: 0,
        dirty: false,
        loading: true,
        saving: false,
        binary: false,
        truncated: false,
      }],
      activeEditorId: file.id,
      editorPrimaryId: state.editorPrimaryId || file.id,
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
        return { activeEditorId: existing.id }
      }
      const nextState = {
        openEditors: [...state.openEditors, {
          id: compareId,
          hostId: left.hostId,
          rootId: left.rootId,
          rootLabel: left.rootLabel,
          rootPath: left.rootPath,
          path: left.path,
          name: `${left.name} <> ${right.name}`,
          absolutePath: '',
          language: left.language === right.language ? left.language : 'plaintext',
          content: '',
          savedContent: '',
          modifiedAt: '',
          size: 0,
          dirty: false,
          loading: false,
          saving: false,
          binary: false,
          truncated: false,
          kind: 'compare' as const,
          compareLeftId: leftId,
          compareRightId: rightId,
        }],
        activeEditorId: compareId,
        editorPrimaryId: state.editorPrimaryId || compareId,
      }
      writePersistedEditors(nextState.openEditors, nextState.activeEditorId)
      return nextState
    })
    return compareId
  },
  placeEditorInSplit: (id, placement) => set((state) => {
    if (!state.openEditors.some((item) => item.id === id)) return state
    if (placement === 'center') {
      writePersistedEditors(state.openEditors, id)
      return { activeEditorId: id, editorPrimaryId: id, editorSecondaryId: null, editorSplitDirection: null, activeEditorSlot: 'primary' }
    }
    const anchorId = state.activeEditorId && state.openEditors.some((item) => item.id === state.activeEditorId) ? state.activeEditorId : state.editorPrimaryId || id
    const nextDirection = placement === 'left' || placement === 'right' ? 'horizontal' : 'vertical'
    if (placement === 'left' || placement === 'top') {
      writePersistedEditors(state.openEditors, id)
      return { activeEditorId: id, editorPrimaryId: id, editorSecondaryId: anchorId === id ? state.editorSecondaryId : anchorId, editorSplitDirection: nextDirection, activeEditorSlot: 'primary' }
    }
    writePersistedEditors(state.openEditors, id)
    return { activeEditorId: id, editorPrimaryId: anchorId, editorSecondaryId: id === anchorId ? state.editorSecondaryId : id, editorSplitDirection: nextDirection, activeEditorSlot: 'secondary' }
  }),
  closeEditor: (id) => set((state) => {
    const nextEditors = state.openEditors.filter((item) => item.id !== id)
    const nextActiveEditorId = state.activeEditorId === id ? nextEditors[nextEditors.length - 1]?.id || null : state.activeEditorId
    writePersistedEditors(nextEditors, nextActiveEditorId)
    if (state.editorPrimaryId === id && state.editorSecondaryId === id) return { openEditors: nextEditors, activeEditorId: nextActiveEditorId, editorPrimaryId: nextActiveEditorId, editorSecondaryId: null, editorSplitDirection: null, activeEditorSlot: 'primary' }
    if (state.editorPrimaryId === id) return { openEditors: nextEditors, activeEditorId: nextActiveEditorId, editorPrimaryId: state.editorSecondaryId && state.editorSecondaryId !== id ? state.editorSecondaryId : nextActiveEditorId, editorSecondaryId: null, editorSplitDirection: null, activeEditorSlot: 'primary' }
    if (state.editorSecondaryId === id) return { openEditors: nextEditors, activeEditorId: nextActiveEditorId, editorPrimaryId: state.editorPrimaryId, editorSecondaryId: null, editorSplitDirection: null, activeEditorSlot: 'primary' }
    return { openEditors: nextEditors, activeEditorId: nextActiveEditorId }
  }),
  setActiveEditor: (id) => set((state) => {
    writePersistedEditors(state.openEditors, id)
    if (!id) return { activeEditorId: id }
    if (state.editorSecondaryId === id) return { activeEditorId: id, activeEditorSlot: 'secondary' }
    if (state.editorPrimaryId === id) return { activeEditorId: id, activeEditorSlot: 'primary' }
    if (state.editorSecondaryId) {
      if (state.activeEditorSlot === 'secondary') return { activeEditorId: id, editorSecondaryId: id }
      return { activeEditorId: id, editorPrimaryId: id, activeEditorSlot: 'primary' }
    }
    return { activeEditorId: id, editorPrimaryId: state.editorPrimaryId || id, activeEditorSlot: 'primary' }
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
  updateConnection: (newState) =>
    set((state) => ({
      connection: { ...state.connection, ...newState },
    })),
  updateTerminalPerf: (newState) =>
    set((state) => ({
      terminalPerf: { ...state.terminalPerf, ...newState },
    })),
}))
