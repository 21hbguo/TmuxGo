import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveEditorDefinition } from './code-navigation'

const contentMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    files: {
      content: (...args: any[]) => contentMock(...args),
    },
  },
}))

describe('resolveEditorDefinition', () => {
  afterEach(() => {
    contentMock.mockReset()
    vi.restoreAllMocks()
  })
  it('resolves a local ts import definition across files', async () => {
    const entry = {
      id: 'editor-1',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.ts',
      name: 'index.ts',
      absolutePath: '/workspace/src/index.ts',
      language: 'typescript',
      content: "import { value } from './other'\nconsole.log(value)\n",
      savedContent: "import { value } from './other'\nconsole.log(value)\n",
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    contentMock.mockImplementation(async (_hostId: string, _rootId: string, path: string) => ({
      path,
      type: 'file',
      size: 26,
      modifiedAt: '',
      binary: false,
      truncated: false,
      encoding: 'utf8',
      content: path === 'src/other.ts' ? 'export const value=1\n' : '',
    }))
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 13 }, [entry as any])
    expect(result).toMatchObject({
      status: 'success',
      target: {
        path: 'src/other.ts',
        line: 1,
      },
    })
  })
  it('resolves a declaration in the current file', async () => {
    const editor = {
      id: 'editor-local',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.ts',
      name: 'index.ts',
      absolutePath: '/workspace/src/index.ts',
      type: 'file',
      language: 'typescript',
      content: 'const localValue = 1\nconsole.log(localValue)\n',
      savedContent: 'const localValue = 1\nconsole.log(localValue)\n',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 13 }, [editor as any])
    expect(result).toMatchObject({ status: 'success', target: { id: 'editor-local', path: 'src/index.ts', line: 1, column: 7 } })
    expect(contentMock).not.toHaveBeenCalled()
  })
  it('resolves an import through the src alias', async () => {
    const entry = {
      id: 'editor-alias-entry',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.ts',
      name: 'index.ts',
      absolutePath: '/workspace/src/index.ts',
      type: 'file',
      language: 'typescript',
      content: "import { value } from '@/other'\nconsole.log(value)\n",
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const target = { ...entry, id: 'editor-alias-target', path: 'src/other.ts', name: 'other.ts', absolutePath: '/workspace/src/other.ts', content: 'export const value = 1\n', savedContent: 'export const value = 1\n' }
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 13 }, [entry as any, target as any])
    expect(result).toMatchObject({ status: 'success', target: { id: 'editor-alias-target', path: 'src/other.ts', line: 1 } })
    expect(contentMock).not.toHaveBeenCalled()
  })
  it('prefers unsaved content from an already open target editor', async () => {
    const entry = {
      id: 'editor-entry',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.ts',
      name: 'index.ts',
      absolutePath: '/workspace/src/index.ts',
      language: 'typescript',
      content: "import { value } from './other'\nconsole.log(value)\n",
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: true,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
      type: 'file',
    }
    const target = {
      ...entry,
      id: 'editor-other',
      path: 'src/other.ts',
      name: 'other.ts',
      absolutePath: '/workspace/src/other.ts',
      content: '\n\nexport const value = 2\n',
      savedContent: 'export const value = 1\n',
      dirty: true,
    }
    contentMock.mockRejectedValue(new Error('remote read should not be needed'))
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 13 }, [entry as any, target as any])
    expect(result).toMatchObject({ status: 'success', target: { id: 'editor-other', path: 'src/other.ts', line: 3 } })
    expect(contentMock).not.toHaveBeenCalled()
  })
  it('reports unsupported languages without reading files', async () => {
    const editor = { language: 'python', content: '', absolutePath: '/workspace/main.py' }
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 1 }, [])
    expect(result).toEqual({ status: 'unsupported' })
    expect(contentMock).not.toHaveBeenCalled()
  })
})
