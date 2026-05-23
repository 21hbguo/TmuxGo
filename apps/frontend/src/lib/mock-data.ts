import type { Host, Session, Window, Pane } from '@/types'

export const mockHosts: Host[] = [
  {
    id: 'host-1',
    name: 'dev-server',
    address: '192.168.1.100',
    status: 'online',
    tags: ['dev', 'main'],
  },
  {
    id: 'host-2',
    name: 'gpu-server',
    address: '192.168.1.101',
    status: 'online',
    tags: ['gpu', 'training'],
  },
  {
    id: 'host-3',
    name: 'staging',
    address: '192.168.1.102',
    status: 'offline',
    tags: ['staging'],
  },
]

export const mockSessions: Session[] = [
  {
    id: 'session-1',
    hostId: 'host-1',
    name: 'main',
    createdAt: '2026-05-23T10:00:00Z',
    lastActiveAt: '2026-05-23T15:30:00Z',
    windowCount: 3,
  },
  {
    id: 'session-2',
    hostId: 'host-1',
    name: 'backend',
    createdAt: '2026-05-23T11:00:00Z',
    lastActiveAt: '2026-05-23T14:00:00Z',
    windowCount: 2,
  },
  {
    id: 'session-3',
    hostId: 'host-2',
    name: 'training',
    createdAt: '2026-05-23T09:00:00Z',
    lastActiveAt: '2026-05-23T15:00:00Z',
    windowCount: 4,
  },
]

export const mockWindows: Window[] = [
  { id: 'window-1', sessionId: 'session-1', index: 0, name: 'zsh', active: true },
  { id: 'window-2', sessionId: 'session-1', index: 1, name: 'vim', active: false },
  { id: 'window-3', sessionId: 'session-1', index: 2, name: 'server', active: false },
]

export const mockPanes: Pane[] = [
  {
    id: 'pane-1',
    windowId: 'window-1',
    index: 0,
    title: 'zsh',
    active: true,
    size: { cols: 80, rows: 24 },
  },
  {
    id: 'pane-2',
    windowId: 'window-1',
    index: 1,
    title: 'htop',
    active: false,
    size: { cols: 80, rows: 24 },
  },
]
