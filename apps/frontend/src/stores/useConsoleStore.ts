import { create } from 'zustand'
import type { Host, Session, Window, Pane, ConnectionState } from '@/types'

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
  showCommandPalette: boolean
  filePanelOpen: boolean
  mobileFileSheetOpen: boolean
  filePanelWidth: number
  uploadRequest: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean } | null
  toasts: { id: string; type: 'success' | 'error' | 'info'; message: string; durationMs?: number }[]

  setActiveHost: (id: string) => void
  setActiveSession: (id: string) => void
  setActivePane: (id: string) => void
  toggleSidebar: () => void
  setCommandPalette: (open: boolean) => void
  setFilePanelOpen: (open: boolean) => void
  toggleFilePanel: () => void
  setMobileFileSheetOpen: (open: boolean) => void
  setFilePanelWidth: (width: number) => void
  openUploadDialog: (request: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean }) => void
  closeUploadDialog: () => void
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
  showCommandPalette: false,
  filePanelOpen: false,
  mobileFileSheetOpen: false,
  filePanelWidth: 360,
  uploadRequest: null,
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
  setCommandPalette: (open) => set({ showCommandPalette: open }),
  setFilePanelOpen: (open) => set({ filePanelOpen: open }),
  toggleFilePanel: () => set((state) => ({ filePanelOpen: !state.filePanelOpen })),
  setMobileFileSheetOpen: (open) => set({ mobileFileSheetOpen: open }),
  setFilePanelWidth: (width) => set({ filePanelWidth: Math.max(320, Math.min(420, width)) }),
  openUploadDialog: (request) => set({ uploadRequest: request }),
  closeUploadDialog: () => set({ uploadRequest: null }),
  pushToast: (toast) => set((state) => ({ toasts: [...state.toasts, { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ...toast }] })),
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  updateConnection: (newState) =>
    set((state) => ({
      connection: { ...state.connection, ...newState },
    })),
}))
