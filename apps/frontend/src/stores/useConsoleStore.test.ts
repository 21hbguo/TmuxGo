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
}
function createEditor(id: string, path: string, language = 'typescript') {
  return {
    ...sampleEditor,
    id,
    path,
    name: path.split('/').pop() || path,
    absolutePath: `/workspace/${path}`,
    language,
  }
}
function collectGroupIds(node: any): string[] {
  if (!node) return []
  if (node.type === 'group') return [node.groupId]
  return [...collectGroupIds(node.first), ...collectGroupIds(node.second)]
}

describe('useConsoleStore editor persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  it('restores persisted editors from localStorage', async () => {
    localStorage.setItem('tmuxgo-open-editors', JSON.stringify([sampleEditor]))
    localStorage.setItem('tmuxgo-active-editor', sampleEditor.id)
    const { useConsoleStore } = await import('./useConsoleStore')
    useConsoleStore.getState().hydrateEditorsFromStorage()
    const state = useConsoleStore.getState()
    expect(state.openEditors).toHaveLength(1)
    expect(state.openEditors[0]).toMatchObject(sampleEditor)
    expect(state.openEditors[0].loading).toBe(true)
    expect(state.activeEditorId).toBe(sampleEditor.id)
  })
  it('persists opened and closed editors', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    useConsoleStore.getState().openEditor(sampleEditor)
    expect(JSON.parse(localStorage.getItem('tmuxgo-open-editors') || '[]')).toEqual([sampleEditor])
    expect(localStorage.getItem('tmuxgo-active-editor')).toBe(sampleEditor.id)
    useConsoleStore.getState().closeEditor(sampleEditor.id)
    expect(JSON.parse(localStorage.getItem('tmuxgo-open-editors') || '[]')).toEqual([])
    expect(localStorage.getItem('tmuxgo-active-editor')).toBeNull()
  })
  it('updates persisted active editor when switching tabs', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    useConsoleStore.getState().openEditor(sampleEditor)
    useConsoleStore.getState().openEditor({ ...sampleEditor, id: 'local:root-workspace:docs/guide.md', path: 'docs/guide.md', name: 'guide.md', absolutePath: '/workspace/docs/guide.md', language: 'markdown' })
    useConsoleStore.getState().setActiveEditor(sampleEditor.id)
    expect(localStorage.getItem('tmuxgo-active-editor')).toBe(sampleEditor.id)
  })
  it('tracks git follow-editor and locked repo state per host', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    useConsoleStore.getState().ensureGitHostState('local')
    useConsoleStore.getState().setGitFollowEditorRepo('local', '/workspace/app', '/workspace/app/src/index.ts')
    expect(useConsoleStore.getState().gitByHost.local).toMatchObject({ mode: 'follow-editor', currentRepoPath: '/workspace/app', currentFilePath: '/workspace/app/src/index.ts', source: 'editor' })
    useConsoleStore.getState().setGitLockedRepo('local', '/workspace/other')
    expect(useConsoleStore.getState().gitByHost.local).toMatchObject({ mode: 'locked', currentRepoPath: '/workspace/other', lockedRepoPath: '/workspace/other', source: 'manual' })
    useConsoleStore.getState().resumeGitFollowEditor('local')
    expect(useConsoleStore.getState().gitByHost.local).toMatchObject({ mode: 'follow-editor', lockedRepoPath: null, currentRepoPath: '/workspace/other' })
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
    expect(state.activeEditorGroupId).toBe(state.editorGroups.find((group) => group.editorIds.includes(editor3.id))?.id || null)
  })
  it('collapses empty groups after moving the last editor out', async () => {
    const { useConsoleStore } = await import('./useConsoleStore')
    const editor2 = createEditor('local:root-workspace:src/other.ts', 'src/other.ts')
    useConsoleStore.getState().openEditor(sampleEditor)
    useConsoleStore.getState().openEditor(editor2)
    useConsoleStore.getState().placeEditorInSplit(editor2.id, 'right')
    const primaryGroupId = useConsoleStore.getState().editorGroups.find((group) => group.editorIds.includes(sampleEditor.id))?.id
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
