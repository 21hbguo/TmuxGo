import { beforeEach, describe, expect, it, vi } from 'vitest'

const sampleEditor = {
  id: 'root-workspace:src/index.ts',
  rootId: 'root-workspace',
  rootLabel: 'Workspace',
  rootPath: '/workspace',
  path: 'src/index.ts',
  name: 'index.ts',
  absolutePath: '/workspace/src/index.ts',
  language: 'typescript',
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
    useConsoleStore.getState().openEditor({ ...sampleEditor, id: 'root-workspace:docs/guide.md', path: 'docs/guide.md', name: 'guide.md', absolutePath: '/workspace/docs/guide.md', language: 'markdown' })
    useConsoleStore.getState().setActiveEditor(sampleEditor.id)
    expect(localStorage.getItem('tmuxgo-active-editor')).toBe(sampleEditor.id)
  })
})
