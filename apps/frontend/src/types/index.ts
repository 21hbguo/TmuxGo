export interface Host {
  id: string
  name: string
  address: string
  status: 'online' | 'offline' | 'unreachable'
  tags: string[]
  user?: string
  port?: number
  auth?: 'auto'
  hasPassword?: boolean
  passwordEnv?: string
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
  left?: number
  top?: number
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
export interface TerminalPerfState {
  attachLatency: number
  outputBytes: number
  outputEvents: number
  outputBacklog: number
  layoutFitCount: number
  lastOutputAt: string
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
export interface FileDocumentHandle {
  id: string
  rootId: string
  rootLabel: string
  rootPath: string
  path: string
  name: string
  absolutePath: string
}
export interface FileContentResponse {
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
  binary: boolean
  truncated: boolean
  reason?: string
  encoding: string
  content: string
}
export interface FileEditorDocument extends FileDocumentHandle {
  language: string
  content: string
  savedContent: string
  modifiedAt: string
  size: number
  dirty: boolean
  loading: boolean
  saving: boolean
  binary: boolean
  truncated: boolean
  problem?: string
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
export interface UploadJobResult {
  ok: true
  target: FileUploadTarget
  files: UploadedFile[]
}
export interface UploadJob {
  id: string
  files: { name: string; size: number }[]
  targetRootId: string
  targetPath: string
  insertPaths: boolean
  loadedBytes: number
  totalBytes: number
  status: 'queued' | 'uploading' | 'success' | 'error'
  createdAt: string
  finishedAt?: string
  errorMessage?: string
  result?: UploadJobResult
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
export interface SessionOrderPreference {
  hostId: string
  orderedSessionIds: string[]
}
export interface Snippet {
  id: string
  name: string
  command: string
  description?: string
  category?: string
}
export interface FavoriteItem {
  id: string
  type: 'host' | 'session' | 'pane'
  name: string
  target: string
  addedAt: string
}
export interface UiPreferences {
  theme?: string
  fontSize?: number
  fontFamily?: string
  cursorBlink?: boolean
  sidebarPosition?: string
  showStatusBar?: boolean
  showQuickActions?: boolean
  autoReconnect?: boolean
  reconnectInterval?: number
  terminalPadding?: number
  language?: string
  attachExclusive?: boolean
}
export type SessionCaptureMode = 'none' | 'visible' | 'history'
export interface SessionResumePoint {
  hostId: string
  sessionId: string
  sessionName: string
  windowId: string | null
  paneId: string | null
  cols: number
  rows: number
  exclusive: boolean
  lastSeenAt: string
  lastOutputAt: string
}
export interface SessionArchivePolicy {
  enabled: boolean
  captureMode: SessionCaptureMode
  maxBytesPerSession: number
  retentionDays: number
}
export interface SessionContinuityConfig {
  enabled: boolean
  syncToServer: boolean
  resumeOnReconnect: boolean
  resumeOnNewDevice: boolean
  maxResumePoints: number
  archive: SessionArchivePolicy
  resumePoints: SessionResumePoint[]
  updatedAt: string
}
export interface RemotePreferences {
  version: 1
  updatedAt: string
  customShortcuts: CustomShortcut[]
  customShortcutsUpdatedAt: string
  favoriteDirectories: FavoriteDirectory[]
  favoriteDirectoriesUpdatedAt: string
  sessionOrders: SessionOrderPreference[]
  sessionOrdersUpdatedAt: string
  snippets: Snippet[]
  snippetsUpdatedAt: string
  favorites: FavoriteItem[]
  favoritesUpdatedAt: string
  sessionContinuity: SessionContinuityConfig
  sessionContinuityUpdatedAt: string
  uiPreferences: UiPreferences
  uiPreferencesUpdatedAt: string
  uploadRateLimitKBps: number
  downloadRateLimitKBps: number
}
