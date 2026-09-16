import { beforeEach, describe, expect, it, vi } from 'vitest'

const sampleEditor = {
  id: 'local:root-workspace:src/index.ts',
  hostId: 'local',
  rootId: 'root-workspace',
  rootLabel: 'Workspace',
  rootPath: '/workspace',
  path: 'src/index.ts',
  name: 'index.ts',
  absolutePath: '/workspace/src/index.ts',
  language: 'typescript',
  type: 'file' as const,
}
function createEditor(id: string, path: string, language = 'typescript') {
  return {
    ...sampleEditor,
    id,
    path,
    name: path.split('/').pop() || path,
    absolutePath: `/workspace/${path}`,
    language,
    type: 'file' as const,
  }
}
function collectGroupIds(node: any): string[] {
  if (!node) return []
  if (node.type === 'group') return [node.groupId]
  return [...collectGroupIds(node.first), ...collectGroupIds(node.second)]
}

async function importStore() {
  const { useConsoleStore } = await import('./useConsoleStore')
  const { flushPersistedStorage } = await import('@/lib/persist-storage')
  return { useConsoleStore, flushPersistedStorage }
}
describe('useConsoleStore editor persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  it('restores persisted editors from legacy localStorage', async () => {
    localStorage.setItem('tmuxgo-open-editors', JSON.stringify([sampleEditor]))
    localStorage.setItem('tmuxgo-active-editor', sampleEditor.id)
    const { useConsoleStore } = await importStore()
    const state = useConsoleStore.getState()
    expect(state.openEditors).toHaveLength(1)
    expect(state.openEditors[0]).toMatchObject(sampleEditor)
    expect(state.openEditors[0].loading).toBe(true)
    expect(state.activeEditorId).toBe(sampleEditor.id)
    expect(localStorage.getItem('tmuxgo-open-editors')).toBeNull()
  })
  it('persists opened and closed editors', async () => {
    const { useConsoleStore, flushPersistedStorage } = await importStore()
    useConsoleStore.getState().openEditor(sampleEditor)
    flushPersistedStorage()
    const persisted = JSON.parse(localStorage.getItem('tmuxgo-console-state:desktop') || '{}')
    expect(persisted.state.openEditors).toHaveLength(1)
    expect(persisted.state.openEditors[0]).toMatchObject({ id: sampleEditor.id, path: sampleEditor.path })
    expect(persisted.state.activeEditorId).toBe(sampleEditor.id)
    useConsoleStore.getState().closeEditor(sampleEditor.id)
    flushPersistedStorage()
    const afterClose = JSON.parse(localStorage.getItem('tmuxgo-console-state:desktop') || '{}')
    expect(afterClose.state.openEditors).toEqual([])
    expect(afterClose.state.activeEditorId).toBeNull()
  })
  it('backfills a missing language when reopening an existing editor', async () => {
    const { useConsoleStore } = await importStore()
    useConsoleStore.getState().openEditor({ ...sampleEditor, language: '' })
    expect(useConsoleStore.getState().openEditors[0].language).toBe('')
    useConsoleStore.getState().openEditor(sampleEditor)
    expect(useConsoleStore.getState().openEditors[0].language).toBe('typescript')
  })
  it('updates persisted active editor when switching tabs', async () => {
    const { useConsoleStore, flushPersistedStorage } = await importStore()
    useConsoleStore.getState().openEditor(sampleEditor)
    useConsoleStore
      .getState()
      .openEditor({
        ...sampleEditor,
        id: 'local:root-workspace:docs/guide.md',
        path: 'docs/guide.md',
        name: 'guide.md',
        absolutePath: '/workspace/docs/guide.md',
        language: 'markdown',
      })
    useConsoleStore.getState().setActiveEditor(sampleEditor.id)
    flushPersistedStorage()
    const persisted = JSON.parse(localStorage.getItem('tmuxgo-console-state:desktop') || '{}')
    expect(persisted.state.activeEditorId).toBe(sampleEditor.id)
  })
  it('persists panel widths and layout across rehydrate', async () => {
    const { useConsoleStore, flushPersistedStorage } = await importStore()
    useConsoleStore.getState().setSessionPanelWidth(300)
    useConsoleStore.getState().setGitPanelWidth(700)
    useConsoleStore.getState().setFilePanelOpen(true)
    flushPersistedStorage()
    const persisted = JSON.parse(localStorage.getItem('tmuxgo-console-state:desktop') || '{}')
    expect(persisted.state.sessionPanelWidth).toBe(300)
    expect(persisted.state.gitPanelWidth).toBe(700)
    expect(persisted.state.filePanelOpen).toBe(true)
  })
  it('separates mobile storage from desktop and skips desktop-only fields', async () => {
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      configurable: true,
    })
    try {
      const { useConsoleStore, flushPersistedStorage } = await importStore()
      useConsoleStore.getState().setSessionPanelWidth(300)
      useConsoleStore.getState().openEditor(sampleEditor)
      useConsoleStore.getState().setGitPanelOpen(true)
      flushPersistedStorage()
      expect(localStorage.getItem('tmuxgo-console-state:mobile')).not.toBeNull()
      expect(localStorage.getItem('tmuxgo-console-state:desktop')).toBeNull()
      const persisted = JSON.parse(localStorage.getItem('tmuxgo-console-state:mobile') || '{}')
      expect(persisted.state.sessionPanelWidth).toBeUndefined()
      expect(persisted.state.openEditors).toBeUndefined()
      expect(persisted.state.gitPanelOpen).toBeUndefined()
      expect(persisted.state.gitByHost).toEqual({})
      expect(persisted.state.activeHostId).not.toBeUndefined()
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true })
    }
  })
  it('migrates legacy unified key to device-specific key for mobile', async () => {
    const originalUA = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      configurable: true,
    })
    try {
      const legacyState = {
        activeHostId: 'local',
        activeSessionId: 's1',
        gitByHost: {
          local: {
            mode: 'follow-editor',
            currentRepoPath: null,
            currentFilePath: null,
            source: null,
            lockedRepoPath: null,
            recentRepos: [],
          },
        },
        sessionPanelWidth: 300,
        openEditors: [sampleEditor],
      }
      localStorage.setItem('tmuxgo-console-state', JSON.stringify({ state: legacyState, version: 1 }))
      const { useConsoleStore } = await importStore()
      const state = useConsoleStore.getState()
      expect(state.activeHostId).toBe('local')
      expect(state.activeSessionId).toBe('s1')
      expect(state.gitByHost.local).toBeDefined()
      expect(state.openEditors).toEqual([])
      expect(localStorage.getItem('tmuxgo-console-state')).toBeNull()
      expect(localStorage.getItem('tmuxgo-console-state:mobile')).not.toBeNull()
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true })
    }
  })
  it('ignores selecting the already active session', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-a', activePaneId: 'pane-a' })
    localStorage.setItem('tmuxgo-active-session', 'session-a')
    localStorage.setItem('tmuxgo-active-session:local', 'session-a')
    useConsoleStore.getState().setActiveSession('session-a')
    const state = useConsoleStore.getState()
    expect(state.activeSessionId).toBe('session-a')
    expect(state.activePaneId).toBe('pane-a')
    expect(localStorage.getItem('tmuxgo-active-session')).toBe('session-a')
    expect(localStorage.getItem('tmuxgo-active-session:local')).toBe('session-a')
  })
  it('tracks git follow-editor and locked repo state per host', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    useConsoleStore.getState().ensureGitHostState('local')
    useConsoleStore.getState().setGitFollowEditorRepo('local', '/workspace/app', '/workspace/app/src/index.ts')
    expect(useConsoleStore.getState().gitByHost.local).toMatchObject({
      mode: 'follow-editor',
      currentRepoPath: '/workspace/app',
      currentFilePath: '/workspace/app/src/index.ts',
      source: 'editor',
    })
    useConsoleStore.getState().setGitLockedRepo('local', '/workspace/other')
    expect(useConsoleStore.getState().gitByHost.local).toMatchObject({
      mode: 'locked',
      currentRepoPath: '/workspace/other',
      lockedRepoPath: '/workspace/other',
      source: 'manual',
    })
    useConsoleStore.getState().resumeGitFollowEditor('local')
    expect(useConsoleStore.getState().gitByHost.local).toMatchObject({
      mode: 'follow-editor',
      lockedRepoPath: null,
      currentRepoPath: '/workspace/other',
    })
  })
  it('creates nested editor groups when splitting multiple times', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    const editor2 = createEditor('local:root-workspace:src/other.ts', 'src/other.ts')
    const editor3 = createEditor('local:root-workspace:src/third.ts', 'src/third.ts')
    useConsoleStore.getState().openEditor(sampleEditor)
    useConsoleStore.getState().openEditor(editor2)
    useConsoleStore.getState().placeEditorInSplit(editor2.id, 'right')
    useConsoleStore.getState().openEditor(editor3)
    useConsoleStore.getState().placeEditorInSplit(editor3.id, 'bottom')
    const state = useConsoleStore.getState()
    expect(state.editorGroups).toHaveLength(3)
    expect(collectGroupIds(state.editorLayout)).toHaveLength(3)
    expect(state.editorLayout?.type).toBe('split')
    expect(state.activeEditorId).toBe(editor3.id)
    expect(state.activeEditorGroupId).toBe(
      state.editorGroups.find((group) => group.editorIds.includes(editor3.id))?.id || null,
    )
  })
  it('collapses empty groups after moving the last editor out', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    const editor2 = createEditor('local:root-workspace:src/other.ts', 'src/other.ts')
    useConsoleStore.getState().openEditor(sampleEditor)
    useConsoleStore.getState().openEditor(editor2)
    useConsoleStore.getState().placeEditorInSplit(editor2.id, 'right')
    const primaryGroupId = useConsoleStore
      .getState()
      .editorGroups.find((group) => group.editorIds.includes(sampleEditor.id))?.id
    expect(primaryGroupId).toBeTruthy()
    useConsoleStore.getState().moveEditorToGroup(editor2.id, primaryGroupId as string)
    const state = useConsoleStore.getState()
    expect(state.editorGroups).toHaveLength(1)
    expect(state.editorLayout?.type).toBe('group')
    expect(state.editorPrimaryGroupIds).toEqual([sampleEditor.id, editor2.id])
    expect(state.editorSecondaryGroupIds).toEqual([])
  })
  it('updates split ratio by split id and clamps the value', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    const editor2 = createEditor('local:root-workspace:src/other.ts', 'src/other.ts')
    useConsoleStore.getState().openEditor(sampleEditor)
    useConsoleStore.getState().openEditor(editor2)
    useConsoleStore.getState().placeEditorInSplit(editor2.id, 'right')
    const layout = useConsoleStore.getState().editorLayout
    const splitId = layout?.type === 'split' ? layout.id : null
    expect(splitId).toBeTruthy()
    useConsoleStore.getState().setEditorSplitRatio(splitId as string, 0.95)
    const state = useConsoleStore.getState()
    expect(state.editorLayout?.type).toBe('split')
    expect(state.editorLayout?.type === 'split' ? state.editorLayout.ratio : null).toBe(0.8)
    expect(state.editorSplitRatio).toBe(0.8)
  })
})
