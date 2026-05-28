import { create } from 'zustand'
import type { Host, Session, Window, Pane, ConnectionState, FileDocumentHandle, FileEditorDocument, UploadJob } from '@/types'

interface ConsoleState {
  hosts: Host[]
  sessions: Session[]
  windows: Window[]
  panes: Pane[]
  activeHostId: string | null
  activeSessionId: string | null
  activePaneId: string | null
  connection: ConnectionState
  sidebarCollapsed: boolean
  desktopPanel: 'sessions' | 'files'
  showCommandPalette: boolean
  filePanelOpen: boolean
  mobileFileSheetOpen: boolean
  sidebarWidth: number
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
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setDesktopPanel: (panel: 'sessions' | 'files') => void
  setCommandPalette: (open: boolean) => void
  setFilePanelOpen: (open: boolean) => void
  toggleFilePanel: () => void
  setMobileFileSheetOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
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
  sidebarCollapsed: false,
  desktopPanel: 'files',
  showCommandPalette: false,
  filePanelOpen: false,
  mobileFileSheetOpen: false,
  sidebarWidth: 280,
  filePanelWidth: 360,
  terminalPanelHeight: 300,
  openEditors: [],
  activeEditorId: null,
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
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setDesktopPanel: (panel) => set({ desktopPanel: panel, sidebarCollapsed: false, filePanelOpen: panel === 'files' }),
  setCommandPalette: (open) => set({ showCommandPalette: open }),
  setFilePanelOpen: (open) => set({ filePanelOpen: open }),
  toggleFilePanel: () => set((state) => state.desktopPanel === 'files' && !state.sidebarCollapsed ? { filePanelOpen: false, sidebarCollapsed: true } : { filePanelOpen: true, desktopPanel: 'files', sidebarCollapsed: false }),
  setMobileFileSheetOpen: (open) => set({ mobileFileSheetOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(220, Math.min(420, width)) }),
  setFilePanelWidth: (width) => set({ filePanelWidth: Math.max(320, Math.min(420, width)) }),
  setTerminalPanelHeight: (height) => set({ terminalPanelHeight: Math.max(180, Math.min(540, height)) }),
  openEditor: (file) => set((state) => {
    const existing = state.openEditors.find((item) => item.id === file.id)
    if (existing) return { activeEditorId: existing.id }
    return {
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
  }),
  closeEditor: (id) => set((state) => {
    const nextEditors = state.openEditors.filter((item) => item.id !== id)
    const nextActiveEditorId = state.activeEditorId === id ? nextEditors[nextEditors.length - 1]?.id || null : state.activeEditorId
    return { openEditors: nextEditors, activeEditorId: nextActiveEditorId }
  }),
  setActiveEditor: (id) => set({ activeEditorId: id }),
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
