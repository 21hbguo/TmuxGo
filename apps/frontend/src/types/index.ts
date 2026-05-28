export interface Host {
  id: string
  name: string
  address: string
  status: 'online' | 'offline' | 'unreachable'
  tags: string[]
}

export interface Session {
  id: string
  hostId: string
  name: string
  createdAt: string
  lastActiveAt: string
  windowCount: number
}

export interface Window {
  id: string
  sessionId: string
  index: number
  name: string
  active: boolean
}

export interface Pane {
  id: string
  windowId: string
  tmuxPaneId?: string
  index: number
  title: string
  active: boolean
  size: {
    cols: number
    rows: number
  }
}

export interface User {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'operator' | 'viewer'
  lastLoginAt: string
}

export interface ConnectionState {
  status: 'connected' | 'attaching' | 'reconnecting' | 'disconnected'
  latency: number
  lastPing: string
}

export interface FileRoot {
  id: string
  label: string
  path: string
}

export interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
}

export interface FileBreadcrumb {
  name: string
  path: string
}

export interface FileListResponse {
  root: FileRoot
  path: string
  breadcrumbs: FileBreadcrumb[]
  items: FileItem[]
}

export interface FilePreviewLine {
  number: number
  content: string
}

export interface FilePreviewResponse {
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
  binary: boolean
  truncated: boolean
  reason?: string
  lines: FilePreviewLine[]
}

export interface FileContentMatch extends FileItem {
  matches: FilePreviewLine[]
}
export interface FileUploadTarget {
  rootId: string
  rootLabel: string
  rootPath: string
  path: string
  absolutePath: string
  source: 'pane' | 'fallback' | 'preferred'
}
export interface UploadedFile {
  name: string
  path: string
  absolutePath: string
  size: number
}
export interface CustomShortcut {
  id: string
  label: string
  keys: string
}
export interface FavoriteDirectory {
  rootId: string
  rootPath: string
  name: string
  path: string
}
export interface RemotePreferences {
  version: 1
  updatedAt: string
  customShortcuts: CustomShortcut[]
  customShortcutsUpdatedAt: string
  favoriteDirectories: FavoriteDirectory[]
  favoriteDirectoriesUpdatedAt: string
  uploadRateLimitKBps: number
}
