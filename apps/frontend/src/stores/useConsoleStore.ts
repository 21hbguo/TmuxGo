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
  toasts: { id: string; type: 'success' | 'error' | 'info'; message: string }[]

  setActiveHost: (id: string) => void
  setActiveSession: (id: string) => void
  setActivePane: (id: string) => void
  toggleSidebar: () => void
  setCommandPalette: (open: boolean) => void
  pushToast: (toast: { type: 'success' | 'error' | 'info'; message: string }) => void
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
  pushToast: (toast) => set((state) => ({ toasts: [...state.toasts, { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ...toast }] })),
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  updateConnection: (newState) =>
    set((state) => ({
      connection: { ...state.connection, ...newState },
    })),
}))
