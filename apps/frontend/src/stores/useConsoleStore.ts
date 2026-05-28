import { create } from 'zustand'
import type { Host, Session, Window, Pane, ConnectionState, FileDocumentHandle, FileEditorDocument, UploadJob } from '@/types'

type PersistedEditor = Pick<FileEditorDocument, 'id' | 'rootId' | 'rootLabel' | 'rootPath' | 'path' | 'name' | 'absolutePath' | 'language'>
const OPEN_EDITORS_STORAGE_KEY = 'tmuxgo-open-editors'
const ACTIVE_EDITOR_STORAGE_KEY = 'tmuxgo-active-editor'

function readPersistedEditors() {
  if (typeof window === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_EDITORS_STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter((item): item is PersistedEditor => !!item && typeof item.id === 'string' && typeof item.rootId === 'string' && typeof item.rootLabel === 'string' && typeof item.rootPath === 'string' && typeof item.path === 'string' && typeof item.name === 'string' && typeof item.absolutePath === 'string' && typeof item.language === 'string')
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
  const nextEditors = openEditors.map(({ id, rootId, rootLabel, rootPath, path, name, absolutePath, language }) => ({ id, rootId, rootLabel, rootPath, path, name, absolutePath, language }))
  localStorage.setItem(OPEN_EDITORS_STORAGE_KEY, JSON.stringify(nextEditors))
  if (activeEditorId) localStorage.setItem(ACTIVE_EDITOR_STORAGE_KEY, activeEditorId)
  else localStorage.removeItem(ACTIVE_EDITOR_STORAGE_KEY)
}

const initialOpenEditors = readPersistedEditors().map(toEditorDocument)
const initialActiveEditorId = (() => {
  const id = readPersistedActiveEditorId()
  return id && initialOpenEditors.some((item) => item.id === id) ? id : initialOpenEditors[initialOpenEditors.length - 1]?.id || null
})()

interface ConsoleState {
  hosts: Host[]
  sessions: Session[]
  windows: Window[]
  panes: Pane[]
  activeHostId: string | null
  activeSessionId: string | null
  activePaneId: string | null
  connection: ConnectionState
  showCommandPalette: boolean
  sessionPanelExpanded: boolean
  filePanelOpen: boolean
  mobileFileSheetOpen: boolean
  sessionPanelWidth: number
  filePanelWidth: number
  terminalPanelHeight: number
  openEditors: FileEditorDocument[]
  activeEditorId: string | null
  uploadRequest: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean } | null
  uploadJobs: UploadJob[]
  toasts: { id: string; type: 'success' | 'error' | 'info'; message: string; durationMs?: number }[]

  setActiveHost: (id: string) => void
  setActiveSession: (id: string) => void
  setActivePane: (id: string) => void
  setCommandPalette: (open: boolean) => void
  setSessionPanelExpanded: (expanded: boolean) => void
  toggleSessionPanel: () => void
  setFilePanelOpen: (open: boolean) => void
  toggleFilePanel: () => void
  setMobileFileSheetOpen: (open: boolean) => void
  setSessionPanelWidth: (width: number) => void
  setFilePanelWidth: (width: number) => void
  setTerminalPanelHeight: (height: number) => void
  openEditor: (file: FileDocumentHandle & { language: string }) => void
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
}

export const useConsoleStore = create<ConsoleState>((set) => ({
  hosts: [],
  sessions: [],
  windows: [],
  panes: [],
  activeHostId: null,
  activeSessionId: null,
  activePaneId: null,
  connection: {
    status: 'disconnected',
    latency: 0,
    lastPing: new Date().toISOString(),
  },
  showCommandPalette: false,
  sessionPanelExpanded: true,
  filePanelOpen: false,
  mobileFileSheetOpen: false,
  sessionPanelWidth: 280,
  filePanelWidth: 360,
  terminalPanelHeight: 300,
  openEditors: initialOpenEditors,
  activeEditorId: initialActiveEditorId,
  uploadRequest: null,
  uploadJobs: [],
  toasts: [],

  setActiveHost: (id) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('tmuxgo-active-host', id)
    }
    set({ activeHostId: id })
  },
  setActiveSession: (id) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('tmuxgo-active-session', id)
    }
    set({ activeSessionId: id })
  },
  setActivePane: (id) => set({ activePaneId: id }),
  setCommandPalette: (open) => set({ showCommandPalette: open }),
  setSessionPanelExpanded: (expanded) => set({ sessionPanelExpanded: expanded }),
  toggleSessionPanel: () => set((state) => ({ sessionPanelExpanded: !state.sessionPanelExpanded })),
  setFilePanelOpen: (open) => set((state) => open ? { filePanelOpen: true, sessionPanelExpanded: false } : { filePanelOpen: false }),
  toggleFilePanel: () => set((state) => state.filePanelOpen ? { filePanelOpen: false } : { filePanelOpen: true, sessionPanelExpanded: false }),
  setMobileFileSheetOpen: (open) => set({ mobileFileSheetOpen: open }),
  setSessionPanelWidth: (width) => set({ sessionPanelWidth: Math.max(240, Math.min(360, width)) }),
  setFilePanelWidth: (width) => set({ filePanelWidth: Math.max(320, Math.min(420, width)) }),
  setTerminalPanelHeight: (height) => set({ terminalPanelHeight: Math.max(180, Math.min(540, height)) }),
  openEditor: (file) => set((state) => {
    const existing = state.openEditors.find((item) => item.id === file.id)
    if (existing) {
      writePersistedEditors(state.openEditors, existing.id)
      return { activeEditorId: existing.id }
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
    }
    writePersistedEditors(nextState.openEditors, nextState.activeEditorId)
    return nextState
  }),
  closeEditor: (id) => set((state) => {
    const nextEditors = state.openEditors.filter((item) => item.id !== id)
    const nextActiveEditorId = state.activeEditorId === id ? nextEditors[nextEditors.length - 1]?.id || null : state.activeEditorId
    writePersistedEditors(nextEditors, nextActiveEditorId)
    return { openEditors: nextEditors, activeEditorId: nextActiveEditorId }
  }),
  setActiveEditor: (id) => set((state) => {
    writePersistedEditors(state.openEditors, id)
    return { activeEditorId: id }
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
}))
