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

  setActiveHost: (id: string) => void
  setActiveSession: (id: string) => void
  setActivePane: (id: string) => void
  toggleSidebar: () => void
  toggleCommandPalette: () => void
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

  setActiveHost: (id) => set({ activeHostId: id }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  setActivePane: (id) => set({ activePaneId: id }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleCommandPalette: () => set((state) => ({ showCommandPalette: !state.showCommandPalette })),
  updateConnection: (newState) =>
    set((state) => ({
      connection: { ...state.connection, ...newState },
    })),
}))
