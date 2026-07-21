export interface Host {
  id: string
  name: string
  address: string
  status: 'online' | 'offline' | 'unknown' | 'unreachable'
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
  agents?: AgentPaneState[]
  agentSummary?: AgentSummary
}
export interface SessionThumbnailPane {
  id: string
  title: string
  active: boolean
  left: number
  top: number
  size: {
    cols: number
    rows: number
  }
  data: string
}
export interface SessionThumbnail {
  id: string
  name: string
  window: {
    id: string
    index: number
    name: string
    zoomed: boolean
  } | null
  panes: SessionThumbnailPane[]
}
export type SessionWindowSplitDirection = 'horizontal' | 'vertical'
export type SessionWindowLayoutPreset = 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical'
export interface SessionLayoutWindow {
  name: string
  panes: { command?: string; cwd?: string; env?: Record<string, string> }[]
  splitDirection?: SessionWindowSplitDirection
  layoutPreset?: SessionWindowLayoutPreset
}
export interface SessionLayout {
  windows: SessionLayoutWindow[]
}
export interface SessionTemplate {
  id: string
  name: string
  description: string
  layout: SessionLayout
  createdAt?: string
  updatedAt?: string
}

export interface Window {
  id: string
  sessionId: string
  index: number
  name: string
  active: boolean
  zoomed?: boolean
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
  agent?: string
  agentStatus?: AgentStatus
  revision?: number
}
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export interface AgentPaneState {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  agent: string
  agentStatus: AgentStatus
  revision: number
}
export interface AgentSummary {
  idle: number
  working: number
  blocked: number
  done: number
  unknown: number
  total: number
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
export interface TrashEntry {
  id: string
  rootId: string
  path: string
  name: string
  type: 'file' | 'directory'
  deletedAt: string
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
  hostId: string
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
  kind?: 'file' | 'compare'
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
  previewUrl?: string
  compareLeftId?: string
  compareRightId?: string
}
export interface FileUploadTarget {
  rootId: string
  rootLabel: string
  rootPath: string
  path: string
  absolutePath: string
  source: 'pane' | 'fallback' | 'preferred' | 'temporary'
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
  agentNotificationsEnabled?: boolean
  agentNotificationDurationMs?: number
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
export interface SessionArchiveSummary {
  id: string
  hostId: string
  sessionId: string
  sessionName: string
  captureMode: 'visible' | 'history'
  createdAt: string
  expiresAt: string
  size: number
  paneCount: number
}
export interface SessionArchive extends SessionArchiveSummary {
  panes: { paneId: string; title: string; windowName: string; active: boolean; data: string }[]
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
  gitByHost: Record<string, GitHostState>
  gitByHostUpdatedAt: string
  uiPreferences: UiPreferences
  uiPreferencesUpdatedAt: string
  uploadRateLimitKBps: number
  downloadRateLimitKBps: number
}
export interface AuditEvent {
  id: string
  timestamp: string
  user: string
  action: string
  target: string
  result: 'success' | 'failure'
  method: string
  statusCode: number
  hostId?: string
  message?: string
}
export type PluginPlatform = 'linux' | 'macos' | 'windows'
export type PluginContextType = 'global' | 'host' | 'session' | 'pane' | 'file' | 'git'
export interface PluginCommandContribution {
  id: string
  title: string
  description?: string
  contexts?: PluginContextType[]
  command: string[]
  platforms?: PluginPlatform[]
  timeoutMs?: number
}
export interface PluginEventContribution {
  on: string
  command: string[]
  platforms?: PluginPlatform[]
  timeoutMs?: number
}
export interface PluginViewContribution {
  id: string
  title: string
  description?: string
  icon?: string
  entry: string
  placement: 'activity'
  width?: number
}
export interface PluginManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  minTmuxGoVersion: string
  description?: string
  icon?: string
  platforms: PluginPlatform[]
  permissions?: string[]
  build?: { command: string[]; platforms?: PluginPlatform[] }[]
  contributes?: {
    actions?: PluginCommandContribution[]
    events?: PluginEventContribution[]
    views?: PluginViewContribution[]
  }
}
export interface PluginSource {
  kind: 'local' | 'github'
  owner?: string
  repo?: string
  subdir?: string
  requestedRef?: string
  resolvedCommit?: string
  installedAt: string
}
export interface PluginInfo {
  pluginId: string
  root: string
  enabled: boolean
  manifest: PluginManifest
  source: PluginSource
  state: 'active' | 'disabled' | 'error'
  error?: string
}
export interface PluginCommandLog {
  id: string
  pluginId: string
  actionId?: string
  event?: string
  command: string[]
  status: 'running' | 'success' | 'error' | 'timeout'
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  stdout: string
  stderr: string
  error?: string
}
export interface GitHubPluginPreview {
  source: string
  resolvedCommit: string
  manifest: PluginManifest
  replacing: boolean
}

// Git types
export interface GitFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged'
  oldPath?: string
  staged: boolean
}
export interface GitStatusResponse {
  branch: string
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
  conflicted: GitFileChange[]
  operation?: 'merge' | 'rebase' | null
}
export interface GitDiffResponse {
  raw: string
}
export interface GitRepositoryInfo {
  path: string
  label: string
}
export interface GitDiffStatItem {
  filename: string
  status: string
  additions: number
  deletions: number
}
export interface GitDiffStatsResponse {
  files: GitDiffStatItem[]
}
export interface GitDetectResponse {
  isGitRepo: boolean
  rootPath?: string
  branch?: string
  path?: string
}
export interface GitCommitResponse {
  ok: true
  hash: string
  message: string
}
export interface GitCommitInfo {
  hash: string
  shortHash: string
  subject: string
  body: string
  author: string
  authorEmail: string
  authorDate: string
  date: string
  parents: string[]
}
export interface GitBranch {
  name: string
  current: boolean
  remote?: string
  commitHash: string
  lastCommitSubject: string
}
export interface GitReference {
  name: string
  kind: 'remote' | 'tag'
  commitHash: string
}
export interface GitLogResponse {
  commits: GitCommitInfo[]
  hasMore: boolean
}
export interface GitBranchesResponse {
  branches: GitBranch[]
  refs?: GitReference[]
  current: string
}
export interface GitMergeResponse {
  ok: boolean
  fastForward: boolean
  conflicts: boolean
  message: string
}
export type GitMode='follow-editor'|'locked'
export type GitSource='editor'|'pane'|'manual'|null
export interface GitRepoEntry {
  repoPath: string
  label: string
  lastUsedAt: number
  pinned: boolean
}
export interface GitHostState {
  mode: GitMode
  currentRepoPath: string | null
  currentFilePath: string | null
  source: GitSource
  lockedRepoPath: string | null
  recentRepos: GitRepoEntry[]
}
