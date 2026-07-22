import { create } from 'zustand'
import type { ConnectionState, FileDocumentHandle, FileEditorDocument, GitHostState, GitMode, GitSource, UploadJob, TerminalPerfState } from '@/types'
import { readPersistedActiveEditorId, readPersistedEditors, writeActiveHostId, writeActiveSessionId, writePersistedEditors } from '@/lib/console-device-state'
export interface EditorGroupState {
  id: string
  editorIds: string[]
  activeEditorId: string | null
}
export interface EditorLayoutLeaf {
  id: string
  type: 'group'
  groupId: string
}
export interface EditorLayoutSplit {
  id: string
  type: 'split'
  direction: 'horizontal' | 'vertical'
  ratio: number
  first: EditorLayoutNode
  second: EditorLayoutNode
}
export type EditorLayoutNode = EditorLayoutLeaf | EditorLayoutSplit
interface EditorWorkspaceState {
  openEditors: FileEditorDocument[]
  activeEditorId: string | null
  editorGroups: EditorGroupState[]
  editorLayout: EditorLayoutNode | null
  activeEditorGroupId: string | null
}
let editorGroupCounter = 0
let editorLayoutCounter = 0
function toEditorDocument(file: ReturnType<typeof readPersistedEditors>[number]): FileEditorDocument {
  return { ...file, content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: true, saving: false, binary: false, truncated: false }
}
function createEditorGroup(editorIds: string[] = [], activeEditorId: string | null = editorIds.at(-1) || null): EditorGroupState {
  const nextEditorIds = editorIds.filter((item, index, items) => items.indexOf(item) === index)
  return { id: `editor-group-${++editorGroupCounter}`, editorIds: nextEditorIds, activeEditorId: activeEditorId && nextEditorIds.includes(activeEditorId) ? activeEditorId : nextEditorIds.at(-1) || null }
}
function createEditorLayoutLeaf(groupId: string): EditorLayoutLeaf {
  return { id: `editor-layout-${++editorLayoutCounter}`, type: 'group', groupId }
}
function createEditorLayoutSplit(direction: 'horizontal' | 'vertical', first: EditorLayoutNode, second: EditorLayoutNode, ratio = 0.5): EditorLayoutSplit {
  return { id: `editor-layout-${++editorLayoutCounter}`, type: 'split', direction, ratio, first, second }
}
function isEditorLayoutSplit(node: EditorLayoutNode | null | undefined): node is EditorLayoutSplit {
  return !!node && node.type === 'split'
}
function collectEditorLayoutGroupIds(node: EditorLayoutNode | null): string[] {
  if (!node) return []
  if (!isEditorLayoutSplit(node)) return [node.groupId]
  return [...collectEditorLayoutGroupIds(node.first), ...collectEditorLayoutGroupIds(node.second)]
}
function normalizeEditorGroup(group: EditorGroupState): EditorGroupState {
  const editorIds = group.editorIds.filter((item, index, items) => items.indexOf(item) === index)
  return { ...group, editorIds, activeEditorId: group.activeEditorId && editorIds.includes(group.activeEditorId) ? group.activeEditorId : editorIds.at(-1) || null }
}
function getEditorGroupById(groups: EditorGroupState[], groupId: string | null | undefined) {
  if (!groupId) return null
  return groups.find((group) => group.id === groupId) || null
}
function findEditorGroupIdByEditor(groups: EditorGroupState[], editorId: string) {
  return groups.find((group) => group.editorIds.includes(editorId))?.id || null
}
function getExistingEditorGroupId(groups: EditorGroupState[], groupId: string | null | undefined) {
  return getEditorGroupById(groups, groupId)?.id || null
}
function removeEditorGroupFromLayout(node: EditorLayoutNode | null, groupId: string): EditorLayoutNode | null {
  if (!node) return null
  if (!isEditorLayoutSplit(node)) return node.groupId === groupId ? null : node
  const nextFirst = removeEditorGroupFromLayout(node.first, groupId)
  const nextSecond = removeEditorGroupFromLayout(node.second, groupId)
  if (!nextFirst && !nextSecond) return null
  if (!nextFirst) return nextSecond
  if (!nextSecond) return nextFirst
  if (nextFirst === node.first && nextSecond === node.second) return node
  return { ...node, first: nextFirst, second: nextSecond }
}
function splitEditorLayout(node: EditorLayoutNode, targetGroupId: string, direction: 'horizontal' | 'vertical', newGroupId: string, side: 'before' | 'after'): { node: EditorLayoutNode; inserted: boolean } {
  if (!isEditorLayoutSplit(node)) {
    if (node.groupId !== targetGroupId) return { node, inserted: false }
    const currentLeaf = node
    const newLeaf = createEditorLayoutLeaf(newGroupId)
    return { node: side === 'before' ? createEditorLayoutSplit(direction, newLeaf, currentLeaf) : createEditorLayoutSplit(direction, currentLeaf, newLeaf), inserted: true }
  }
  const first = splitEditorLayout(node.first, targetGroupId, direction, newGroupId, side)
  if (first.inserted) return { node: { ...node, first: first.node }, inserted: true }
  const second = splitEditorLayout(node.second, targetGroupId, direction, newGroupId, side)
  if (second.inserted) return { node: { ...node, second: second.node }, inserted: true }
  return { node, inserted: false }
}
function updateEditorLayoutSplitRatio(node: EditorLayoutNode, splitId: string, ratio: number): { node: EditorLayoutNode; updated: boolean } {
  if (!isEditorLayoutSplit(node)) return { node, updated: false }
  if (node.id === splitId) return { node: { ...node, ratio: Math.max(0.2, Math.min(0.8, ratio)) }, updated: true }
  const first = updateEditorLayoutSplitRatio(node.first, splitId, ratio)
  if (first.updated) return { node: { ...node, first: first.node }, updated: true }
  const second = updateEditorLayoutSplitRatio(node.second, splitId, ratio)
  if (second.updated) return { node: { ...node, second: second.node }, updated: true }
  return { node, updated: false }
}
function pruneEmptyEditorGroups(groups: EditorGroupState[], layout: EditorLayoutNode | null) {
  let nextGroups = groups.map(normalizeEditorGroup)
  let nextLayout = layout
  for (const group of [...nextGroups]) {
    if (group.editorIds.length || nextGroups.length <= 1) continue
    nextGroups = nextGroups.filter((item) => item.id !== group.id)
    nextLayout = removeEditorGroupFromLayout(nextLayout, group.id)
  }
  if (!nextGroups.length) {
    const group = createEditorGroup()
    return { editorGroups: [group], editorLayout: createEditorLayoutLeaf(group.id) }
  }
  if (!nextLayout) nextLayout = createEditorLayoutLeaf(nextGroups[0].id)
  return { editorGroups: nextGroups.map(normalizeEditorGroup), editorLayout: nextLayout }
}
function finalizeEditorWorkspace(state: EditorWorkspaceState): Pick<EditorWorkspaceState, 'activeEditorId' | 'editorGroups' | 'editorLayout' | 'activeEditorGroupId'> {
  const openEditorIds = new Set(state.openEditors.map((item) => item.id))
  let editorGroups = state.editorGroups.map((group) => normalizeEditorGroup({ ...group, editorIds: group.editorIds.filter((id) => openEditorIds.has(id)) }))
  let editorLayout = state.editorLayout
  const pruned = pruneEmptyEditorGroups(editorGroups, editorLayout)
  editorGroups = pruned.editorGroups
  editorLayout = pruned.editorLayout
  let activeEditorId = state.activeEditorId && openEditorIds.has(state.activeEditorId) ? state.activeEditorId : null
  let activeEditorGroupId = getExistingEditorGroupId(editorGroups, state.activeEditorGroupId) || editorGroups[0]?.id || null
  if (activeEditorId) {
    const groupId = findEditorGroupIdByEditor(editorGroups, activeEditorId)
    if (groupId) {
      activeEditorGroupId = groupId
      editorGroups = editorGroups.map((group) => group.id === groupId ? { ...group, activeEditorId } : group)
    } else activeEditorId = null
  }
  if (!activeEditorId && activeEditorGroupId) activeEditorId = getEditorGroupById(editorGroups, activeEditorGroupId)?.activeEditorId || null
  if (!activeEditorId) {
    const fallbackGroup = editorGroups.find((group) => group.editorIds.length)
    if (fallbackGroup) {
      activeEditorGroupId = fallbackGroup.id
      activeEditorId = fallbackGroup.activeEditorId || fallbackGroup.editorIds.at(-1) || null
      editorGroups = editorGroups.map((group) => group.id === fallbackGroup.id ? { ...group, activeEditorId } : group)
    }
  }
  if (!activeEditorGroupId && editorGroups[0]) activeEditorGroupId = editorGroups[0].id
  return { activeEditorId, editorGroups: editorGroups.map(normalizeEditorGroup), editorLayout, activeEditorGroupId }
}
function createLegacyEditorState(editorGroups: EditorGroupState[], editorLayout: EditorLayoutNode | null, activeEditorGroupId: string | null) {
  const orderedGroupIds = collectEditorLayoutGroupIds(editorLayout)
  const primaryGroup = getEditorGroupById(editorGroups, orderedGroupIds[0]) || editorGroups[0] || null
  const secondaryGroup = getEditorGroupById(editorGroups, orderedGroupIds[1]) || null
  const rootSplit = isEditorLayoutSplit(editorLayout) ? editorLayout : null
  return {
    editorPrimaryGroupIds: primaryGroup?.editorIds || [],
    editorSecondaryGroupIds: secondaryGroup?.editorIds || [],
    editorPrimaryId: primaryGroup?.activeEditorId || null,
    editorSecondaryId: secondaryGroup?.activeEditorId || null,
    editorSplitDirection: secondaryGroup ? rootSplit?.direction || 'horizontal' : null,
    editorSplitRatio: secondaryGroup ? rootSplit?.ratio || 0.5 : 0.5,
    activeEditorSlot: secondaryGroup && activeEditorGroupId === secondaryGroup.id ? 'secondary' as const : 'primary' as const,
  }
}
function withLegacyEditorState<T extends Pick<EditorWorkspaceState, 'editorGroups' | 'editorLayout' | 'activeEditorGroupId'>>(state: T) {
  return { ...state, ...createLegacyEditorState(state.editorGroups, state.editorLayout, state.activeEditorGroupId) }
}
function createEmptyEditorWorkspace() {
  const group = createEditorGroup()
  return withLegacyEditorState({ editorGroups: [group], editorLayout: createEditorLayoutLeaf(group.id), activeEditorGroupId: group.id, activeEditorId: null as string | null })
}
function createEditorWorkspaceFromEditors(openEditors: FileEditorDocument[], activeEditorId: string | null) {
  const group = createEditorGroup(openEditors.map((item) => item.id), activeEditorId)
  return withLegacyEditorState(finalizeEditorWorkspace({ openEditors, activeEditorId, editorGroups: [group], editorLayout: createEditorLayoutLeaf(group.id), activeEditorGroupId: group.id }))
}
function moveEditorBetweenGroups(state: EditorWorkspaceState, id: string, targetGroupId: string, targetId?: string | null) {
  const sourceGroupId = findEditorGroupIdByEditor(state.editorGroups, id)
  const resolvedTargetGroupId = getExistingEditorGroupId(state.editorGroups, targetGroupId) || sourceGroupId || state.activeEditorGroupId || state.editorGroups[0]?.id || null
  if (!sourceGroupId || !resolvedTargetGroupId) return null
  let editorGroups = state.editorGroups.map(normalizeEditorGroup)
  if (sourceGroupId === resolvedTargetGroupId) {
    editorGroups = editorGroups.map((group) => group.id === resolvedTargetGroupId ? { ...group, editorIds: insertEditorId(group.editorIds, id, targetId), activeEditorId: id } : group)
    return finalizeEditorWorkspace({ ...state, editorGroups, activeEditorId: id, activeEditorGroupId: resolvedTargetGroupId })
  }
  editorGroups = editorGroups.map((group) => {
    if (group.id === sourceGroupId) return { ...group, editorIds: group.editorIds.filter((item) => item !== id), activeEditorId: group.activeEditorId === id ? null : group.activeEditorId }
    if (group.id === resolvedTargetGroupId) return { ...group, editorIds: insertEditorId(group.editorIds, id, targetId), activeEditorId: id }
    return group
  })
  return finalizeEditorWorkspace({ ...state, editorGroups, activeEditorId: id, activeEditorGroupId: resolvedTargetGroupId })
}
interface ConsoleState {
  activeHostId: string | null
  activeSessionId: string | null
  activePaneId: string | null
  connection: ConnectionState
  terminalPerf: TerminalPerfState
  showCommandPalette: boolean
  sessionPanelExpanded: boolean
  filePanelOpen: boolean
  thumbnailPanelOpen: boolean
  gitPanelOpen: boolean
  activePluginView: { pluginId: string; viewId: string } | null
  gitPanelWidth: number
  gitByHost: Record<string, GitHostState>
  mobileFileSheetOpen: boolean
  sessionPanelWidth: number
  filePanelWidth: number
  terminalPanelHeight: number
  openEditors: FileEditorDocument[]
  activeEditorId: string | null
  editorGroups: EditorGroupState[]
  editorLayout: EditorLayoutNode | null
  activeEditorGroupId: string | null
  editorPrimaryGroupIds: string[]
  editorSecondaryGroupIds: string[]
  editorPrimaryId: string | null
  editorSecondaryId: string | null
  editorSplitDirection: 'horizontal' | 'vertical' | null
  editorSplitRatio: number
  activeEditorSlot: 'primary' | 'secondary'
  editorsHydrated: boolean
  uploadRequest: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean; temporary?: boolean } | null
  uploadJobs: UploadJob[]
  toasts: { id: string; type: 'success' | 'error' | 'info'; message: string; durationMs?: number }[]
  setActiveHost: (id: string) => void
  setActiveSession: (id: string) => void
  setActivePane: (id: string | null) => void
  setCommandPalette: (open: boolean) => void
  setSessionPanelExpanded: (expanded: boolean) => void
  toggleSessionPanel: () => void
  setFilePanelOpen: (open: boolean) => void
  toggleFilePanel: () => void
  setThumbnailPanelOpen: (open: boolean) => void
  toggleThumbnailPanel: () => void
  setGitPanelOpen: (open: boolean) => void
  toggleGitPanel: () => void
  setActivePluginView: (view: { pluginId: string; viewId: string } | null) => void
  setGitPanelWidth: (width: number) => void
  ensureGitHostState: (hostId: string) => void
  replaceGitByHost: (gitByHost: Record<string, GitHostState>) => void
  setGitFollowEditorRepo: (hostId: string, repoPath: string | null, filePath: string | null) => void
  setGitFollowPaneRepo: (hostId: string, repoPath: string | null, panePath: string | null) => void
  setGitLockedRepo: (hostId: string, repoPath: string) => void
  resumeGitFollowEditor: (hostId: string) => void
  pinGitRepo: (hostId: string, repoPath: string, pinned: boolean) => void
  setMobileFileSheetOpen: (open: boolean) => void
  setSessionPanelWidth: (width: number) => void
  setFilePanelWidth: (width: number) => void
  setTerminalPanelHeight: (height: number) => void
  hydrateEditorsFromStorage: () => void
  openEditor: (file: FileDocumentHandle & { language: string }) => void
  openCompareEditor: (leftId: string, rightId: string) => string | null
  placeEditorInSplit: (id: string, placement: 'center' | 'left' | 'right' | 'top' | 'bottom', targetGroupId?: string | null) => void
  moveEditorToGroup: (id: string, targetGroupId: string, targetId?: string | null) => void
  setEditorSplitRatio: (splitId: string, ratio: number) => void
  closeEditor: (id: string) => void
  setActiveEditor: (id: string | null) => void
  setEditorLoaded: (id: string, patch: Partial<FileEditorDocument>) => void
  setEditorContent: (id: string, content: string) => void
  setEditorSaving: (id: string, saving: boolean) => void
  markEditorSaved: (id: string, content: string, modifiedAt: string, size: number) => void
  openUploadDialog: (request: { files: File[]; preferredRootId?: string; preferredPath?: string; insertPaths?: boolean; temporary?: boolean }) => void
  closeUploadDialog: () => void
  addUploadJob: (job: UploadJob) => void
  updateUploadJob: (id: string, patch: Partial<UploadJob>) => void
  removeUploadJob: (id: string) => void
  clearFinishedUploadJobs: () => void
  pushToast: (toast: { type: 'success' | 'error' | 'info'; message: string; durationMs?: number }) => void
  removeToast: (id: string) => void
  updateConnection: (state: Partial<ConnectionState>) => void
  updateTerminalPerf: (state: Partial<TerminalPerfState>) => void
}
function createDefaultGitHostState(): GitHostState {
  return { mode: 'follow-editor', currentRepoPath: null, currentFilePath: null, source: null, lockedRepoPath: null, recentRepos: [] }
}
function touchGitRepo(state: GitHostState, repoPath: string) {
  const label = repoPath.split('/').filter(Boolean).pop() || repoPath
  const existing = state.recentRepos.find((item) => item.repoPath === repoPath)
  const next = { repoPath, label, lastUsedAt: Date.now(), pinned: existing?.pinned || false }
  return [next, ...state.recentRepos.filter((item) => item.repoPath !== repoPath)].slice(0, 12)
}
function updateGitHostState(gitByHost: Record<string, GitHostState>, hostId: string, updater: (current: GitHostState) => GitHostState) {
  const current = gitByHost[hostId] || createDefaultGitHostState()
  return { ...gitByHost, [hostId]: updater(current) }
}
function insertEditorId(items: string[], id: string, targetId?: string | null) {
  const next = items.filter((item) => item !== id)
  if (!targetId) return [...next, id]
  const index = next.indexOf(targetId)
  if (index < 0) return [...next, id]
  next.splice(index, 0, id)
  return next
}
export const useConsoleStore = create<ConsoleState>((set) => ({
  activeHostId: null,
  activeSessionId: null,
  activePaneId: null,
  connection: { status: 'disconnected', latency: 0, lastPing: new Date().toISOString() },
  terminalPerf: { attachLatency: 0, outputBytes: 0, outputEvents: 0, outputBacklog: 0, layoutFitCount: 0, lastOutputAt: '' },
  showCommandPalette: false,
  sessionPanelExpanded: true,
  filePanelOpen: false,
  thumbnailPanelOpen: false,
  gitPanelOpen: false,
  activePluginView: null,
  gitPanelWidth: 560,
  gitByHost: {},
  mobileFileSheetOpen: false,
  sessionPanelWidth: 248,
  filePanelWidth: 240,
  terminalPanelHeight: 300,
  openEditors: [],
  ...createEmptyEditorWorkspace(),
  editorsHydrated: false,
  uploadRequest: null,
  uploadJobs: [],
  toasts: [],
  setActiveHost: (id) => {
    writeActiveHostId(id)
    set({ activeHostId: id, activeSessionId: null, activePaneId: null })
  },
  setActiveSession: (id) => set((state) => {
    if (state.activeSessionId === id) return state
    writeActiveSessionId(state.activeHostId, id)
    return { activeSessionId: id, activePaneId: null }
  }),
  setActivePane: (id) => set({ activePaneId: id }),
  setCommandPalette: (open) => set({ showCommandPalette: open }),
  setSessionPanelExpanded: (expanded) => set(expanded ? { sessionPanelExpanded: true, thumbnailPanelOpen: false, activePluginView: null } : { sessionPanelExpanded: false }),
  toggleSessionPanel: () => set((state) => state.sessionPanelExpanded ? { sessionPanelExpanded: false } : { sessionPanelExpanded: true, thumbnailPanelOpen: false, gitPanelOpen: false, activePluginView: null }),
  setFilePanelOpen: (open) => set((state) => open ? { filePanelOpen: true, thumbnailPanelOpen: false, sessionPanelExpanded: false, gitPanelOpen: false, activePluginView: null } : { filePanelOpen: false }),
  toggleFilePanel: () => set((state) => state.filePanelOpen ? { filePanelOpen: false } : { filePanelOpen: true, thumbnailPanelOpen: false, sessionPanelExpanded: false, gitPanelOpen: false, activePluginView: null }),
  setThumbnailPanelOpen: (open) => set((state) => open ? { thumbnailPanelOpen: true, filePanelOpen: false, sessionPanelExpanded: false, gitPanelOpen: false, activePluginView: null } : { thumbnailPanelOpen: false }),
  toggleThumbnailPanel: () => set((state) => state.thumbnailPanelOpen ? { thumbnailPanelOpen: false } : { thumbnailPanelOpen: true, filePanelOpen: false, sessionPanelExpanded: false, gitPanelOpen: false, activePluginView: null }),
  setGitPanelOpen: (open) => set((state) => open ? { gitPanelOpen: true, thumbnailPanelOpen: false, sessionPanelExpanded: false, filePanelOpen: false, activePluginView: null } : { gitPanelOpen: false }),
  toggleGitPanel: () => set((state) => state.gitPanelOpen ? { gitPanelOpen: false } : { gitPanelOpen: true, thumbnailPanelOpen: false, sessionPanelExpanded: false, filePanelOpen: false, activePluginView: null }),
  setActivePluginView: (view) => set((state) => view && state.activePluginView?.pluginId === view.pluginId && state.activePluginView.viewId === view.viewId ? { activePluginView: null } : view ? { activePluginView: view, filePanelOpen: false, thumbnailPanelOpen: false, sessionPanelExpanded: false, gitPanelOpen: false } : { activePluginView: null }),
  setGitPanelWidth: (width) => set({ gitPanelWidth: Math.max(380, Math.min(920, width)) }),
  ensureGitHostState: (hostId) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => current) })),
  replaceGitByHost: (gitByHost) => set({ gitByHost }),
  setGitFollowEditorRepo: (hostId, repoPath, filePath) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => {
    if (current.mode === 'locked') return { ...current, currentFilePath: filePath }
    return { ...current, currentRepoPath: repoPath, currentFilePath: filePath, source: repoPath ? 'editor' as GitSource : current.source, recentRepos: repoPath ? touchGitRepo(current, repoPath) : current.recentRepos }
  }) })),
  setGitFollowPaneRepo: (hostId, repoPath, panePath) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => {
    if (current.mode === 'locked') return current
    return { ...current, currentRepoPath: repoPath, currentFilePath: panePath, source: 'pane' as GitSource, recentRepos: repoPath ? touchGitRepo(current, repoPath) : current.recentRepos }
  }) })),
  setGitLockedRepo: (hostId, repoPath) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({ ...current, mode: 'locked' as GitMode, currentRepoPath: repoPath, lockedRepoPath: repoPath, source: 'manual', recentRepos: touchGitRepo(current, repoPath) })) })),
  resumeGitFollowEditor: (hostId) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({ ...current, mode: 'follow-editor', lockedRepoPath: null, source: current.currentRepoPath ? 'editor' : null })) })),
  pinGitRepo: (hostId, repoPath, pinned) => set((state) => ({ gitByHost: updateGitHostState(state.gitByHost, hostId, (current) => ({ ...current, recentRepos: current.recentRepos.map((item) => item.repoPath === repoPath ? { ...item, pinned } : item) })) })),
  setMobileFileSheetOpen: (open) => set({ mobileFileSheetOpen: open }),
  setSessionPanelWidth: (width) => set({ sessionPanelWidth: Math.max(208, Math.min(320, width)) }),
  setFilePanelWidth: (width) => set({ filePanelWidth: Math.max(200, Math.min(520, width)) }),
  setTerminalPanelHeight: (height) => set({ terminalPanelHeight: Math.max(180, Math.min(2000, height)) }),
  hydrateEditorsFromStorage: () => set((state) => {
    if (state.editorsHydrated) return state
    const nextEditors = readPersistedEditors().map(toEditorDocument)
    const nextActiveEditorId = (() => {
      const id = readPersistedActiveEditorId()
      return id && nextEditors.some((item) => item.id === id) ? id : nextEditors[nextEditors.length - 1]?.id || null
    })()
    return { openEditors: nextEditors, ...createEditorWorkspaceFromEditors(nextEditors, nextActiveEditorId), editorsHydrated: true }
  }),
  openEditor: (file) => set((state) => {
    const existing = state.openEditors.find((item) => item.id === file.id)
    if (existing) {
      let editorGroups = state.editorGroups.map(normalizeEditorGroup)
      const existingGroupId = findEditorGroupIdByEditor(editorGroups, existing.id)
      if (existingGroupId) {
        const nextState = withLegacyEditorState(finalizeEditorWorkspace({ ...state, editorGroups: editorGroups.map((group) => group.id === existingGroupId ? { ...group, activeEditorId: existing.id } : group), activeEditorId: existing.id, activeEditorGroupId: existingGroupId }))
        writePersistedEditors(state.openEditors, nextState.activeEditorId)
        return nextState
      }
      const targetGroupId = getExistingEditorGroupId(editorGroups, state.activeEditorGroupId) || editorGroups[0]?.id || null
      if (!targetGroupId) return state
      const nextState = withLegacyEditorState(finalizeEditorWorkspace({ ...state, editorGroups: editorGroups.map((group) => group.id === targetGroupId ? { ...group, editorIds: [...group.editorIds, existing.id], activeEditorId: existing.id } : group), activeEditorId: existing.id, activeEditorGroupId: targetGroupId }))
      writePersistedEditors(state.openEditors, nextState.activeEditorId)
      return nextState
    }
    const targetGroupId = getExistingEditorGroupId(state.editorGroups, state.activeEditorGroupId) || state.editorGroups[0]?.id || null
    const nextOpenEditors = [...state.openEditors, { ...file, content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: true, saving: false, binary: false, truncated: false }]
    let editorGroups = state.editorGroups.map(normalizeEditorGroup)
    if (targetGroupId) editorGroups = editorGroups.map((group) => group.id === targetGroupId ? { ...group, editorIds: [...group.editorIds, file.id], activeEditorId: file.id } : group)
    const nextState = withLegacyEditorState(finalizeEditorWorkspace({ ...state, openEditors: nextOpenEditors, editorGroups, activeEditorId: file.id, activeEditorGroupId: targetGroupId }))
    writePersistedEditors(nextOpenEditors, nextState.activeEditorId)
    return { openEditors: nextOpenEditors, ...nextState }
  }),
  openCompareEditor: (leftId, rightId) => {
    const left = useConsoleStore.getState().openEditors.find((item) => item.id === leftId)
    const right = useConsoleStore.getState().openEditors.find((item) => item.id === rightId)
    if (!left || !right) return null
    const compareId = `compare:${[leftId, rightId].sort().join('::')}`
    set((state) => {
      const existing = state.openEditors.find((item) => item.id === compareId)
      if (existing) {
        let editorGroups = state.editorGroups.map(normalizeEditorGroup)
        const existingGroupId = findEditorGroupIdByEditor(editorGroups, existing.id)
        if (existingGroupId) {
          const nextState = withLegacyEditorState(finalizeEditorWorkspace({ ...state, editorGroups: editorGroups.map((group) => group.id === existingGroupId ? { ...group, activeEditorId: existing.id } : group), activeEditorId: existing.id, activeEditorGroupId: existingGroupId }))
          writePersistedEditors(state.openEditors, nextState.activeEditorId)
          return nextState
        }
      }
      const targetGroupId = getExistingEditorGroupId(state.editorGroups, state.activeEditorGroupId) || state.editorGroups[0]?.id || null
      const nextOpenEditors = [...state.openEditors, { id: compareId, hostId: left.hostId, rootId: left.rootId, rootLabel: left.rootLabel, rootPath: left.rootPath, path: left.path, name: `${left.name} <> ${right.name}`, absolutePath: '', language: left.language === right.language ? left.language : 'plaintext', content: '', savedContent: '', modifiedAt: '', size: 0, dirty: false, loading: false, saving: false, binary: false, truncated: false, kind: 'compare' as const, compareLeftId: leftId, compareRightId: rightId }]
      let editorGroups = state.editorGroups.map(normalizeEditorGroup)
      if (targetGroupId) editorGroups = editorGroups.map((group) => group.id === targetGroupId ? { ...group, editorIds: [...group.editorIds, compareId], activeEditorId: compareId } : group)
      const nextState = withLegacyEditorState(finalizeEditorWorkspace({ ...state, openEditors: nextOpenEditors, editorGroups, activeEditorId: compareId, activeEditorGroupId: targetGroupId }))
      writePersistedEditors(nextOpenEditors, nextState.activeEditorId)
      return { openEditors: nextOpenEditors, ...nextState }
    })
    return compareId
  },
  placeEditorInSplit: (id, placement, targetGroupId) => set((state) => {
    if (!state.openEditors.some((item) => item.id === id)) return state
    const resolvedTargetGroupId = getExistingEditorGroupId(state.editorGroups, targetGroupId) || getExistingEditorGroupId(state.editorGroups, state.activeEditorGroupId) || findEditorGroupIdByEditor(state.editorGroups, id) || state.editorGroups[0]?.id || null
    if (!resolvedTargetGroupId) return state
    if (placement === 'center') {
      const nextState = moveEditorBetweenGroups(state, id, resolvedTargetGroupId)
      if (!nextState) return state
      const nextLegacyState = withLegacyEditorState(nextState)
      writePersistedEditors(state.openEditors, nextLegacyState.activeEditorId)
      return nextLegacyState
    }
    const sourceGroupId = findEditorGroupIdByEditor(state.editorGroups, id)
    if (!sourceGroupId) return state
    const direction = placement === 'left' || placement === 'right' ? 'horizontal' : 'vertical'
    const side = placement === 'left' || placement === 'top' ? 'before' as const : 'after' as const
    const newGroup = createEditorGroup([id], id)
    let editorGroups = [...state.editorGroups.map(normalizeEditorGroup).map((group) => group.id === sourceGroupId ? { ...group, editorIds: group.editorIds.filter((item) => item !== id), activeEditorId: group.activeEditorId === id ? null : group.activeEditorId } : group), newGroup]
    let editorLayout = state.editorLayout || createEditorLayoutLeaf(resolvedTargetGroupId)
    const split = splitEditorLayout(editorLayout, resolvedTargetGroupId, direction, newGroup.id, side)
    editorLayout = split.inserted ? split.node : side === 'before' ? createEditorLayoutSplit(direction, createEditorLayoutLeaf(newGroup.id), editorLayout) : createEditorLayoutSplit(direction, editorLayout, createEditorLayoutLeaf(newGroup.id))
    const nextState = withLegacyEditorState(finalizeEditorWorkspace({ ...state, editorGroups, editorLayout, activeEditorId: id, activeEditorGroupId: newGroup.id }))
    writePersistedEditors(state.openEditors, nextState.activeEditorId)
    return nextState
  }),
  moveEditorToGroup: (id, targetGroupId, targetId) => set((state) => {
    if (!state.openEditors.some((item) => item.id === id)) return state
    const nextState = moveEditorBetweenGroups(state, id, targetGroupId, targetId)
    if (!nextState) return state
    const nextLegacyState = withLegacyEditorState(nextState)
    writePersistedEditors(state.openEditors, nextLegacyState.activeEditorId)
    return nextLegacyState
  }),
  setEditorSplitRatio: (splitId, ratio) => set((state) => {
    if (!state.editorLayout) return state
    const nextLayout = updateEditorLayoutSplitRatio(state.editorLayout, splitId, ratio)
    if (!nextLayout.updated) return state
    return withLegacyEditorState({ editorGroups: state.editorGroups, editorLayout: nextLayout.node, activeEditorGroupId: state.activeEditorGroupId })
  }),
  closeEditor: (id) => set((state) => {
    const nextEditors = state.openEditors.filter((item) => item.id !== id)
    const nextState = withLegacyEditorState(finalizeEditorWorkspace({
      ...state,
      openEditors: nextEditors,
      editorGroups: state.editorGroups.map((group) => group.id === findEditorGroupIdByEditor(state.editorGroups, id) ? { ...group, editorIds: group.editorIds.filter((item) => item !== id), activeEditorId: group.activeEditorId === id ? null : group.activeEditorId } : group),
      activeEditorId: state.activeEditorId === id ? null : state.activeEditorId,
    }))
    writePersistedEditors(nextEditors, nextState.activeEditorId)
    return { openEditors: nextEditors, ...nextState }
  }),
  setActiveEditor: (id) => set((state) => {
    writePersistedEditors(state.openEditors, id)
    if (!id) return { activeEditorId: null }
    const groupId = findEditorGroupIdByEditor(state.editorGroups, id)
    if (!groupId) return state
    return withLegacyEditorState(finalizeEditorWorkspace({ ...state, editorGroups: state.editorGroups.map((group) => group.id === groupId ? { ...group, activeEditorId: id } : group), activeEditorId: id, activeEditorGroupId: groupId }))
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
  updateConnection: (newState) => set((state) => ({ connection: { ...state.connection, ...newState } })),
  updateTerminalPerf: (newState) => set((state) => ({ terminalPerf: { ...state.terminalPerf, ...newState } })),
}))
