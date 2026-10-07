export interface Host {
  id: string
  name: string
  address: string
  status: 'online' | 'offline' | 'unknown' | 'unreachable'
  tags: string[]
  userTags?: string[]
  user?: string
  port?: number
  auth?: 'auto'
  groups?: string[]
  favorite?: boolean
  hasPassword?: boolean
  hasPrivateKey?: boolean
  usesAgent?: boolean
  jumpHost?: string
  knownHostsPolicy?: 'strict' | 'accept-new' | 'off'
  connectionMode?: 'local' | 'ssh' | 'agent'
  latencyMs?: number
  lastCheckedAt?: string
  lastConnectionError?: string
  dependencies?: Record<string, boolean>
  agent?: {
    version: string
    online: boolean
    lastSeenAt: string
    lastDisconnectedAt?: string | null
    disconnectReason: string | null
    reconnectCount: number
  }
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
export type SessionWindowSplitDirection = 'horizontal' | 'vertical'
export type SessionWindowLayoutPreset =
  'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical'
export interface SessionLayoutWindow {
  name: string
  panes: { command?: string; cwd?: string; env?: Record<string, string> }[]
  splitDirection?: SessionWindowSplitDirection
  layoutPreset?: SessionWindowLayoutPreset
}
export interface SessionLayout {
  windows: SessionLayoutWindow[]
}
export interface SessionLayoutDocument {
  kind: 'tmuxgo.session-layout'
  version: 1
  name: string
  exportedAt?: string
  sourceHostId?: string
  windows: SessionLayoutWindow[]
}
export type SessionLayoutApplyMode = 'create' | 'append'
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
  agentSessionId?: string
  agentStatus?: AgentStatus
  phase?: AgentPhase
  lastEvent?: AgentEvent
  source?: AgentSource
  confidence?: AgentConfidence
  since?: string
  updatedAt?: string
  eventId?: string
  message?: string
  revision?: number
  display?: AgentDisplayMetadata
}
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type AgentPhase =
  | 'idle'
  | 'working'
  | 'needs_input'
  | 'permission_required'
  | 'retrying'
  | 'failed'
  | 'ended'
  | 'disconnected'
  | 'unknown'
export type AgentEvent =
  | 'started'
  | 'permission_required'
  | 'question_required'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'ended'
  | 'disconnected'
  | 'reconnected'
export type AgentSource = 'protocol' | 'hook' | 'tmux' | 'osc133' | 'process' | 'pane_output'
export type AgentConfidence = 'high' | 'medium' | 'low'
export interface AgentDisplayMetadata {
  title?: string
  stateLabel?: string
  tokens?: number
  seq?: number
  ttlMs?: number
  updatedAt?: string
}
export interface AgentPaneState {
  paneId: string
  tmuxPaneId: string
  sessionName: string
  agent: string
  agentSessionId?: string
  nativeAgentSessionId?: string
  cwd?: string
  agentStatus: AgentStatus
  revision: number
  phase?: AgentPhase
  lastEvent?: AgentEvent
  source?: AgentSource
  confidence?: AgentConfidence
  since?: string
  updatedAt?: string
  eventId?: string
  message?: string
  display?: AgentDisplayMetadata
}
export interface AgentRecoveryCandidate {
  id: string
  hostId: string
  sessionName: string
  paneId: string
  tmuxPaneId: string
  agent: string
  agentSessionId?: string
  cwd?: string
  lastSeenAt: string
  reason: string
  status: 'pending' | 'resumed'
  createdAt: string
  resumedAt?: string
  resumable: boolean
  blockReason?: string
  occupant: string
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
  // xterm.write 在途字节与 backlog 最老排队年龄：背压水位上报用
  outputInFlight?: number
  outputOldestAgeMs?: number
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
  mode?: number
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
  truncated?: boolean
  totalCount?: number
  etag?: string
  modifiedAt?: string
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
  type: 'file' | 'directory'
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
  // 预览 tab（VSCode 语义）：未修改时被下一次打开原位替换；编辑后钉住
  preview?: boolean
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
  saveError?: string
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
  hostId: string
  files: { name: string; size: number }[]
  // 重试快照：File 仅存活于内存——store persist 的 partialize 是白名单制不会带出；
  // 成功/移除/清理时必须释放引用，错误态保留供重试
  sourceFiles?: File[]
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
export type ShortcutStepType = 'keys' | 'text' | 'wait'
export interface ShortcutStep {
  type: ShortcutStepType
  keys?: string
  text?: string
  appendEnter?: boolean
  ms?: number
}
export interface CustomShortcut {
  id: string
  label: string
  mode?: 'keys' | 'text'
  keys?: string
  text?: string
  appendEnter?: boolean
  steps?: ShortcutStep[]
  repeat?: boolean
}
export interface FavoriteDirectory {
  rootId: string
  rootPath: string
  name: string
  path: string
}
export interface WorkspaceEntry {
  id: string
  name: string
  hostId: string
  path: string
  rootId: string
  rootPath: string
  rootLabel: string
  relativePath: string
  templateId: string | null
  createdAt: string
  updatedAt: string
}
export interface SessionWorkspaceEntry {
  sessionId: string
  hostId: string
  workspaceId?: string
  workspacePath: string
  rootId: string
  rootPath: string
  rootLabel: string
  relativePath: string
  updatedAt: string
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
  showShortcutBar?: boolean
  agentNotificationsEnabled?: boolean
  agentNotificationDurationMs?: number
  autoReconnect?: boolean
  reconnectInterval?: number
  terminalPadding?: number
  editorWheelScrollLines?: number
  language?: string
  attachExclusive?: boolean
  activityBarOrder?: string[]
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
  sessionWorkspaces: SessionWorkspaceEntry[]
  sessionWorkspacesUpdatedAt: string
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
  actor?: string
  source?: 'http' | 'agent-token' | 'ws' | 'ssh' | 'share' | 'anonymous'
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
  permissions?: PluginPermission[]
  build?: { command: string[]; platforms?: PluginPlatform[] }[]
  contributes?: {
    actions?: PluginCommandContribution[]
    events?: PluginEventContribution[]
    views?: PluginViewContribution[]
  }
}
export type PluginPermission = 'actions.execute' | 'host.context' | 'files.read' | 'files.write'
export interface PluginSource {
  kind: 'local' | 'github'
  owner?: string
  repo?: string
  subdir?: string
  requestedRef?: string
  resolvedCommit?: string
  installedAt: string
  previousSource?: PluginSource
}
export interface PluginInfo {
  pluginId: string
  root: string
  enabled: boolean
  manifest: PluginManifest
  source: PluginSource
  state: 'active' | 'disabled' | 'error'
  grantedPermissions: PluginPermission[]
  error?: string
}
export interface PluginCommandLog {
  id: string
  pluginId: string
  actionId?: string
  event?: string
  command: string[]
  status: 'running' | 'success' | 'error' | 'timeout' | 'permission_denied'
  permission?: PluginPermission
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
export interface GitWorktreeProvenance {
  id: string
  hostId: string
  repoPath: string
  worktreePath: string
  branch?: string
  commit?: string
  workspaceId?: string
  sessionId?: string
  createdAt: string
  updatedAt: string
}
export interface GitWorktreeEntry {
  path: string
  head: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
  provenance?: GitWorktreeProvenance
}
export interface GitWorktreesResponse {
  worktrees: GitWorktreeEntry[]
}
export interface GitWorktreeMutationResponse {
  ok: boolean
  code?: 'dirty' | 'missing'
  message?: string
  worktree?: GitWorktreeProvenance
}
// Agent inbox：与 skills/tmuxgo-control/agent-inbox-protocol.md 的 wire schema 对齐（metadata-only）
export type InboxMessageType = 'text' | 'image' | 'video' | 'file' | 'link'
export interface InboxMessageRoute {
  hostId?: string
  sessionName?: string
  paneId?: string
  tmuxPaneId?: string
}
export interface InboxMessageSource {
  provider?: string
  agent?: string
  agentSessionId?: string
}
export interface AgentInboxMessage {
  id: string
  type: InboxMessageType
  title?: string
  text?: string
  assetId?: string
  mime?: string
  size?: number
  sha256?: string
  name?: string
  source: InboxMessageSource
  route: InboxMessageRoute
  createdAt: string
  readBy: string[]
  // 全局已读：任一设备读过即所有端消除未读；readBy 仍按设备记录明细
  readAt?: string
  // "关闭已打开"=归档：离开活动列表但历史保留（archived=1 可查/恢复），≠删除
  archivedAt?: string
  // 回收站：删除=软删可恢复，purge/TTL 才真正回收
  deletedAt?: string
  updatedAt?: string
  // 服务端 store revision；按它丢乱序/重复事件
  rev?: number
  expiresAt?: string
  dedupeKey?: string
  open?: boolean
  metadata?: Record<string, unknown>
}
// 附件外链：token 只在创建响应里下发，列表/详情永远只见元数据
export interface InboxShare {
  id: string
  messageId: string
  name: string
  mime: string
  size: number
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}
export type InboxViewFilter = 'active' | 'archived' | 'trash'
export type InboxStatusFilter = 'all' | 'unread' | 'read'
export type InboxRangeFilter = 'all' | '1d' | '7d' | '30d'
export interface InboxFilter {
  query: string
  type: InboxMessageType | 'all'
  // 已读状态筛选（全部/未读/已读）
  status: InboxStatusFilter
  // 活动/归档/回收站三个互斥视图；回收站是软删历史（可恢复）
  view: InboxViewFilter
  // 来源筛选：agent 名或路由标签，'' 不过滤
  source: string
  // 时间范围（按 createdAt）
  range: InboxRangeFilter
}
export interface InboxListStats {
  messages: number
  maxMessages: number
  assetBytes: number
  maxAssetBytes: number
}
// 预览 tab 只持久化元数据；内容经 REST 重新拉取，过期消息 hydrate 时剔除
export interface InboxTab {
  id: string
  messageId: string
  hostId?: string
  sessionName?: string
  paneId?: string
  title: string
  type: InboxMessageType
  pinned?: boolean
  lastOpenedAt: string
}
export type GitMode = 'follow-editor' | 'locked'
export type GitSource = 'editor' | 'pane' | 'manual' | null
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
