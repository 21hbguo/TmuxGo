import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveEditorDefinition } from './code-navigation'

const contentMock = vi.fn()
const searchContentMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    files: {
      content: (...args: any[]) => contentMock(...args),
      searchContent: (...args: any[]) => searchContentMock(...args),
    },
  },
}))

describe('resolveEditorDefinition', () => {
  afterEach(() => {
    contentMock.mockReset()
    searchContentMock.mockReset()
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
    expect(result).toMatchObject({
      status: 'success',
      target: { id: 'editor-local', path: 'src/index.ts', line: 1, column: 7 },
    })
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
    const target = {
      ...entry,
      id: 'editor-alias-target',
      path: 'src/other.ts',
      name: 'other.ts',
      absolutePath: '/workspace/src/other.ts',
      content: 'export const value = 1\n',
      savedContent: 'export const value = 1\n',
    }
    const result = await resolveEditorDefinition(entry as any, { line: 2, column: 13 }, [entry as any, target as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { id: 'editor-alias-target', path: 'src/other.ts', line: 1 },
    })
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
  it('reports not-found when no word sits at the position', async () => {
    const editor = {
      id: 'editor-py-empty',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'main.py',
      name: 'main.py',
      absolutePath: '/workspace/main.py',
      type: 'file',
      language: 'python',
      content: '',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 1 }, [])
    expect(result).toEqual({ status: 'not-found' })
    expect(contentMock).not.toHaveBeenCalled()
  })
  it('resolves a same-file python def without network calls', async () => {
    const editor = {
      id: 'editor-py',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'main.py',
      name: 'main.py',
      absolutePath: '/workspace/main.py',
      type: 'file',
      language: 'python',
      content: 'def helper():\n    return 1\n\nprint(helper())\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const result = await resolveEditorDefinition(editor as any, { line: 4, column: 8 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'main.py', line: 1, column: 5 },
    })
    expect(contentMock).not.toHaveBeenCalled()
    expect(searchContentMock).not.toHaveBeenCalled()
  })
  it('resolves a cross-file definition through content search', async () => {
    const editor = {
      id: 'editor-py2',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'main.py',
      name: 'main.py',
      absolutePath: '/workspace/main.py',
      type: 'file',
      language: 'python',
      content: 'from lib import worker\nworker.run()\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    searchContentMock.mockResolvedValue([
      {
        path: 'lib/worker.py',
        name: 'worker.py',
        type: 'file',
        size: 10,
        modifiedAt: '',
        matches: [
          { number: 1, content: 'worker = None' },
          { number: 9, content: 'def worker():' },
        ],
      },
    ])
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 2 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'lib/worker.py', absolutePath: '/workspace/lib/worker.py', line: 9, column: 5 },
    })
  })
  it('scopes content search to the entry directory and prefers sibling files', async () => {
    // 大 root 下整树搜索分钟级且会跳错 worktree：必须带 basePath 且按目录邻近度排序
    const editor = {
      id: 'editor-py3',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/user',
      path: 'project/repo-a/train.py',
      name: 'train.py',
      absolutePath: '/home/user/project/repo-a/train.py',
      type: 'file',
      language: 'python',
      content: 'from val import run\nresult = run()\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    searchContentMock.mockResolvedValue([
      // 别的 worktree 排在前面也不能抢
      {
        path: 'project/repo-b/val.py',
        name: 'val.py',
        type: 'file',
        size: 10,
        modifiedAt: '',
        matches: [{ number: 5, content: 'def run(x):' }],
      },
      {
        path: 'project/repo-a/val.py',
        name: 'val.py',
        type: 'file',
        size: 10,
        modifiedAt: '',
        matches: [{ number: 12, content: 'def run(x):' }],
      },
    ])
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 11 }, [editor as any])
    expect(searchContentMock).toHaveBeenNthCalledWith(
      1,
      'local',
      'root-home',
      'run',
      'project/repo-a',
      true,
      expect.anything(),
      '.py',
    )
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'project/repo-a/val.py', line: 12, column: 5 },
    })
  })
  it('uses import module hints to disambiguate same-dir duplicate definitions', async () => {
    // from val import run：即使 test_val.py 也定义 run 且搜索返回序靠前，仍跳 val.py
    const editor = {
      id: 'editor-py6',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/user',
      path: 'project/repo-a/train.py',
      name: 'train.py',
      absolutePath: '/home/user/project/repo-a/train.py',
      type: 'file',
      language: 'python',
      content: 'from val import run\nresult = run()\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    searchContentMock.mockResolvedValue([
      {
        path: 'project/repo-a/test_val.py',
        name: 'test_val.py',
        type: 'file',
        size: 10,
        modifiedAt: '',
        matches: [{ number: 8, content: 'def run(case):' }],
      },
      {
        path: 'project/repo-a/val.py',
        name: 'val.py',
        type: 'file',
        size: 10,
        modifiedAt: '',
        matches: [{ number: 12, content: 'def run(x):' }],
      },
    ])
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 11 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'project/repo-a/val.py', line: 12 },
    })
  })
  it('falls back to root-wide search when the entry subtree has no match', async () => {
    const editor = {
      id: 'editor-py4',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/user',
      path: 'project/repo-a/train.py',
      name: 'train.py',
      absolutePath: '/home/user/project/repo-a/train.py',
      type: 'file',
      language: 'python',
      content: 'result = helper()\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    // 逐级后退：project/repo-a → project 都落空，最后 '' 整 root 命中
    searchContentMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          path: 'shared/lib.py',
          name: 'lib.py',
          type: 'file',
          size: 10,
          modifiedAt: '',
          matches: [{ number: 3, content: 'def helper():' }],
        },
      ])
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 11 }, [editor as any])
    expect(searchContentMock).toHaveBeenCalledTimes(3)
    expect(searchContentMock).toHaveBeenLastCalledWith(
      'local',
      'root-home',
      'helper',
      '',
      true,
      expect.anything(),
      '.py',
    )
    expect(result).toMatchObject({ status: 'success', target: { path: 'shared/lib.py', line: 3 } })
  })
  it('returns not-found instead of wedging when content search fails', async () => {
    const editor = {
      id: 'editor-py5',
      hostId: 'local',
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/user',
      path: 'project/repo-a/train.py',
      name: 'train.py',
      absolutePath: '/home/user/project/repo-a/train.py',
      type: 'file',
      language: 'python',
      content: 'result = helper()\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    searchContentMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 11 }, [editor as any])
    expect(result).toEqual({ status: 'not-found' })
  })
  it('prefers definitions from open editors over remote search', async () => {
    const entry = {
      id: 'editor-sh',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'run.sh',
      name: 'run.sh',
      absolutePath: '/workspace/run.sh',
      type: 'file',
      language: 'shell',
      content: 'deploy\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const target = {
      ...entry,
      id: 'editor-sh-lib',
      path: 'lib.sh',
      name: 'lib.sh',
      absolutePath: '/workspace/lib.sh',
      content: 'deploy() {\n  echo ok\n}\n',
    }
    const result = await resolveEditorDefinition(entry as any, { line: 1, column: 2 }, [entry as any, target as any])
    expect(result).toMatchObject({ status: 'success', target: { id: 'editor-sh-lib', path: 'lib.sh', line: 1 } })
    expect(searchContentMock).not.toHaveBeenCalled()
  })
  it('resolves definitions when the stored language is missing or stale', async () => {
    const editor = {
      id: 'editor-stale',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.ts',
      name: 'index.ts',
      absolutePath: '/workspace/src/index.ts',
      type: 'file',
      language: 'plaintext',
      content: 'const localValue = 1\nconsole.log(localValue)\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 13 }, [editor as any])
    expect(result).toMatchObject({ status: 'success', target: { path: 'src/index.ts', line: 1 } })
  })
  it('resolves definitions in .mts files reported as plaintext', async () => {
    const editor = {
      id: 'editor-mts',
      hostId: 'local',
      rootId: 'root-workspace',
      rootLabel: 'Workspace',
      rootPath: '/workspace',
      path: 'src/index.mts',
      name: 'index.mts',
      absolutePath: '/workspace/src/index.mts',
      type: 'file',
      language: 'plaintext',
      content: 'const localValue = 1\nconsole.log(localValue)\n',
      savedContent: '',
      modifiedAt: '',
      size: 0,
      dirty: false,
      loading: false,
      saving: false,
      binary: false,
      truncated: false,
    }
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 13 }, [editor as any])
    expect(result).toMatchObject({ status: 'success', target: { path: 'src/index.mts', line: 1 } })
  })
  const mockFiles = (files: Record<string, string>) => {
    contentMock.mockImplementation(async (_hostId: string, _rootId: string, path: string) => {
      if (!(path in files)) throw new Error('ENOENT')
      return {
        path,
        type: 'file',
        size: files[path].length,
        modifiedAt: '',
        binary: false,
        truncated: false,
        encoding: 'utf8',
        content: files[path],
      }
    })
  }
  const pyEditor = (overrides: Record<string, unknown>) => ({
    id: 'editor-py-import',
    hostId: 'local',
    rootId: 'root-workspace',
    rootLabel: 'Workspace',
    rootPath: '/workspace',
    path: 'main.py',
    name: 'main.py',
    absolutePath: '/workspace/main.py',
    type: 'file',
    language: 'python',
    content: '',
    savedContent: '',
    modifiedAt: '',
    size: 0,
    dirty: false,
    loading: false,
    saving: false,
    binary: false,
    truncated: false,
    ...overrides,
  })
  it('resolves a from-import symbol by direct module read without content search', async () => {
    const editor = pyEditor({ content: 'from lib.worker import run\nresult = run\n' })
    mockFiles({ 'lib/worker.py': 'def run():\n    return 1\n' })
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 10 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'lib/worker.py', absolutePath: '/workspace/lib/worker.py', line: 1, column: 5 },
    })
    expect(searchContentMock).not.toHaveBeenCalled()
  })
  it('resolves a from-import submodule to the file itself', async () => {
    // from lib import worker：worker 是子模块 lib/worker.py 而非符号，跳文件顶部
    const editor = pyEditor({ content: 'from lib import worker\nworker.run()\n' })
    mockFiles({ 'lib/worker.py': 'def run():\n    pass\n' })
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 1 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'lib/worker.py', line: 1, column: 1 },
    })
    expect(searchContentMock).not.toHaveBeenCalled()
  })
  it('resolves relative imports by counting leading dots (PEP 328)', async () => {
    // from ..shared import util：2 个点 = 入口目录向上 1 层再找 shared.py
    const editor = pyEditor({
      path: 'pkg/sub/main.py',
      name: 'main.py',
      absolutePath: '/workspace/pkg/sub/main.py',
      content: 'from ..shared import util\nresult = util\n',
    })
    mockFiles({ 'pkg/shared.py': 'def util():\n    return 0\n' })
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 10 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'pkg/shared.py', absolutePath: '/workspace/pkg/shared.py', line: 1, column: 5 },
    })
    expect(searchContentMock).not.toHaveBeenCalled()
  })
  it('resolves same-package relative imports (from . import x)', async () => {
    const editor = pyEditor({
      path: 'pkg/main.py',
      name: 'main.py',
      absolutePath: '/workspace/pkg/main.py',
      content: 'from . import helper\nhelper.do()\n',
    })
    mockFiles({ 'pkg/helper.py': 'def do():\n    pass\n' })
    const result = await resolveEditorDefinition(editor as any, { line: 2, column: 1 }, [editor as any])
    expect(result).toMatchObject({
      status: 'success',
      target: { path: 'pkg/helper.py', line: 1, column: 1 },
    })
    expect(searchContentMock).not.toHaveBeenCalled()
  })
  it('backs off search scope level by level before falling back to root', async () => {
    // 深层入口目录：scope 序列 = entryDir 逐级退 3 级 + '' 兜底
    const editor = pyEditor({
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/user',
      path: 'a/b/c/d/e/f.py',
      name: 'f.py',
      absolutePath: '/home/user/a/b/c/d/e/f.py',
      content: 'result = helper()\n',
    })
    searchContentMock.mockResolvedValue([])
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 11 }, [editor as any])
    expect(result).toEqual({ status: 'not-found' })
    expect(searchContentMock.mock.calls.map((call) => call[3])).toEqual(['a/b/c/d/e', 'a/b/c/d', 'a/b/c', 'a/b', ''])
    // ext 透传：.py 入口只扫 *.py
    expect(searchContentMock.mock.calls.every((call) => call[6] === '.py')).toBe(true)
  })
  it('stops at the first scope that produces a definition hit', async () => {
    const editor = pyEditor({
      rootId: 'root-home',
      rootLabel: 'Home',
      rootPath: '/home/user',
      path: 'a/b/c/f.py',
      name: 'f.py',
      absolutePath: '/home/user/a/b/c/f.py',
      content: 'result = helper()\n',
    })
    searchContentMock.mockImplementation(async (_h: string, _r: string, _q: string, basePath: string) =>
      basePath === 'a/b'
        ? [
            {
              path: 'a/b/lib.py',
              name: 'lib.py',
              type: 'file',
              size: 10,
              modifiedAt: '',
              matches: [{ number: 7, content: 'def helper():' }],
            },
          ]
        : [],
    )
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 11 }, [editor as any])
    expect(result).toMatchObject({ status: 'success', target: { path: 'a/b/lib.py', line: 7 } })
    expect(searchContentMock.mock.calls.map((call) => call[3])).toEqual(['a/b/c', 'a/b'])
  })
  it('omits the ext filter for extensionless entry files', async () => {
    const editor = pyEditor({
      path: 'Makefile',
      name: 'Makefile',
      absolutePath: '/workspace/Makefile',
      language: 'makefile',
      content: 'all: deploy\n',
    })
    searchContentMock.mockResolvedValue([])
    const result = await resolveEditorDefinition(editor as any, { line: 1, column: 7 }, [editor as any])
    expect(result).toEqual({ status: 'not-found' })
    expect(searchContentMock.mock.calls[0][6]).toBeUndefined()
  })
})
