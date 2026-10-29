import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDocumentHandle } from '@/types'

const handle = (id: string, path: string): FileDocumentHandle & { language: string } => ({
  id,
  hostId: 'local',
  rootId: 'root-workspace',
  rootLabel: 'Workspace',
  rootPath: '/workspace',
  path,
  name: path.split('/').pop() || path,
  absolutePath: `/workspace/${path}`,
  type: 'file',
  language: 'typescript',
})

async function importStore() {
  const { useConsoleStore } = await import('./useConsoleStore')
  return useConsoleStore
}

describe('useConsoleStore editor tab actions', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('closes a batch of editors in a single update', async () => {
    const useConsoleStore = await importStore()
    const store = useConsoleStore.getState()
    const pinned = { preview: false, replacePreview: false }
    store.openEditor(handle('a', 'src/a.ts'), pinned)
    store.openEditor(handle('b', 'src/b.ts'), pinned)
    store.openEditor(handle('c', 'src/c.ts'), pinned)
    store.setActiveEditor('a')

    let updates = 0
    const unsubscribe = useConsoleStore.subscribe(() => {
      updates += 1
    })
    useConsoleStore.getState().closeEditors(['b', 'c'])
    unsubscribe()

    const state = useConsoleStore.getState()
    expect(state.openEditors.map((editor) => editor.id)).toEqual(['a'])
    expect(state.activeEditorId).toBe('a')
    expect(state.editorGroups[0].editorIds).toEqual(['a'])
    // 批量关闭只应通知一次订阅者（close others/right/all 都走这里）
    expect(updates).toBe(1)
  })

  it('keeps the remaining group and drops empty split groups', async () => {
    const useConsoleStore = await importStore()
    const store = useConsoleStore.getState()
    const pinned = { preview: false, replacePreview: false }
    store.openEditor(handle('a', 'src/a.ts'), pinned)
    store.openEditor(handle('b', 'src/b.ts'), pinned)
    store.placeEditorInSplit('b', 'right')
    expect(useConsoleStore.getState().editorGroups).toHaveLength(2)

    useConsoleStore.getState().closeEditors(['b'])
    const state = useConsoleStore.getState()
    expect(state.openEditors.map((editor) => editor.id)).toEqual(['a'])
    expect(state.editorGroups).toHaveLength(1)
    expect(state.editorLayout?.type).toBe('group')
  })

  it('ignores unknown ids and empty batches', async () => {
    const useConsoleStore = await importStore()
    useConsoleStore.getState().openEditor(handle('a', 'src/a.ts'), { preview: false, replacePreview: false })
    const before = useConsoleStore.getState().openEditors
    useConsoleStore.getState().closeEditors([])
    useConsoleStore.getState().closeEditors(['nope'])
    expect(useConsoleStore.getState().openEditors).toBe(before)
  })

  it('pushes and pops the closed editor stack (LIFO, deduped)', async () => {
    const useConsoleStore = await importStore()
    const store = useConsoleStore.getState()
    const entry = (id: string) => ({
      id,
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: `src/${id}.ts`,
      name: `${id}.ts`,
      absolutePath: `/workspace/src/${id}.ts`,
      language: 'typescript',
    })
    store.pushClosedEditor(entry('a'))
    store.pushClosedEditor(entry('b'))
    useConsoleStore.getState().pushClosedEditor(entry('a'))
    expect(useConsoleStore.getState().closedEditors.map((item) => item.id)).toEqual(['b', 'a'])

    expect(useConsoleStore.getState().takeClosedEditor()?.id).toBe('a')
    expect(useConsoleStore.getState().takeClosedEditor()?.id).toBe('b')
    expect(useConsoleStore.getState().takeClosedEditor()).toBeNull()
    expect(useConsoleStore.getState().closedEditors).toEqual([])
  })

  it('clears the closed editor stack', async () => {
    const useConsoleStore = await importStore()
    useConsoleStore.getState().pushClosedEditor({
      id: 'x',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/x.ts',
      name: 'x.ts',
      absolutePath: '/workspace/src/x.ts',
      language: 'typescript',
    })
    useConsoleStore.getState().clearClosedEditors()
    expect(useConsoleStore.getState().closedEditors).toEqual([])
  })
})
