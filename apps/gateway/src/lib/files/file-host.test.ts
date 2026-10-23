// file-host 是 local/remote 的统一分派层，也是文件操作的最终入口。分两类断言：
// 1) local 通道跑真实临时根目录（二进制/大文件/符号链接逃逸这些闸门只有碰真 fs 才算验证过）；
// 2) remote 通道用 ssh 桩捕获整条远端命令，解 base64 payload 断言「分派参数与 local 一致」，
//    再用真 python3 跑一次 REMOTE_FILE_SCRIPT 证明编码往返与远端守卫真的成立。
import '../../test-env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test, { after } from 'node:test'
import { installShims, lastShimArgs } from '../../test-shims.js'
import { upsertRemoteHost } from '../hosts.js'
import { getHostConnectivity, removeHostConnectivity } from '../host-connectivity.js'

const execFileAsync = promisify(execFile)
const shims = installShims(['ssh', 'sshpass'])
after(() => shims.restore())

const workspace = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-filehost-ws-'))
const other = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-filehost-out-'))
const outside = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-filehost-outside-'))
const tmpUploadDir = await mkdtemp(path.join(os.tmpdir(), 'tmuxgo-filehost-tmp-'))
// rootSpec 在模块加载时解析：必须先落 env 再动态 import（与 file-ops.test.ts 同一先例）
process.env.TMUX_WEB_FILE_ROOTS = `workspace=${workspace}${path.delimiter}out=${other}`
process.env.TMUXGO_TMP_DIR = tmpUploadDir
const fh = await import('./file-host.js')
const roots = await import('./file-roots.js')

// file-host 的返回类型是 local 对象 ∪ runRemoteFileJson<unknown>，实现层没写显式返回类型，
// 于是拿到的都是 unknown。这里按真实契约声明一次门面类型，用例才有字段级检查；
// 分派参数本身由下面的 remote payload 断言守着，门面漂移会立刻在断言里红。
interface FileItem {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
  mode?: number
}
interface Listing {
  root: { id: string; label: string; path: string }
  path: string
  breadcrumbs: Array<{ name: string; path: string }>
  items: FileItem[]
  truncated: boolean
  totalCount: number
}
interface Preview {
  path: string
  type: 'file' | 'directory'
  size: number
  binary: boolean
  truncated: boolean
  reason?: string
  modifiedAt: string
  lines: Array<{ number: number; content: string }>
}
interface ContentView {
  path: string
  type: 'file' | 'directory'
  binary: boolean
  truncated: boolean
  reason?: string
  encoding: string
  content: string
  modifiedAt: string
}
interface Mutation {
  ok: true
  item: FileItem
  previousPath?: string
  parentPath?: string
}
interface UploadTarget {
  rootId: string
  rootLabel: string
  rootPath: string
  path: string
  absolutePath: string
  source: string
}
type SearchHit = FileItem & { matches: Array<{ number: number; content: string }> }
const host: {
  listDirectoryForHost: (h: string, rootId: string, p: string, limit?: number) => Promise<Listing>
  readPreviewForHost: (h: string, rootId: string, p: string, line?: number) => Promise<Preview>
  readContentForHost: (h: string, rootId: string, p: string) => Promise<ContentView>
  saveContentForHost: (
    h: string,
    rootId: string,
    p: string,
    content: string,
    modifiedAt?: string,
  ) => Promise<{ ok: true; content: string; size: number; modifiedAt: string }>
  createFileForHost: (h: string, rootId: string, dir: string, name: string) => Promise<Mutation>
  createDirectoryForHost: (h: string, rootId: string, dir: string, name: string) => Promise<Mutation>
  renameEntryForHost: (h: string, rootId: string, p: string, name: string) => Promise<Mutation>
  transferEntryForHost: (
    h: string,
    rootId: string,
    p: string,
    targetRoot: string,
    targetPath: string,
    move: boolean,
  ) => Promise<Mutation>
  trashEntryForHost: (
    h: string,
    rootId: string,
    p: string,
  ) => Promise<{ ok: true; entry: { id: string; name: string; path: string; rootId: string } }>
  listTrashEntriesForHost: (h: string) => Promise<Array<{ id: string; name: string; path: string; rootId: string }>>
  restoreTrashEntryForHost: (h: string, trashId: string) => Promise<{ ok: true; item: FileItem }>
  removeEntryForHost: (
    h: string,
    rootId: string,
    p: string,
  ) => Promise<{ ok: true; path: string; type: 'file' | 'directory' }>
  searchNameForHost: (h: string, rootId: string, q: string, base?: string, dot?: boolean) => Promise<FileItem[]>
  searchContentForHost: (
    h: string,
    rootId: string,
    q: string,
    base?: string,
    dot?: boolean,
    ext?: string,
  ) => Promise<SearchHit[]>
  resolveDefaultUploadTargetForHost: (h: string, pane?: string) => Promise<UploadTarget>
  discoverGitRepositoriesForHost: (h: string) => Promise<Array<{ path: string; label: string }>>
  resolveTemporaryUploadTargetForHost: (h: string) => Promise<UploadTarget>
} = fh as unknown as never

const BINARY = Buffer.from([0x00, 0x01, 0x02, 0xff])
// NUL 落在第一个 4KiB 之后：探测只看头部 4096 字节，这类文件会被当成文本
const LATE_NUL = Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0x00]), Buffer.from('tail')])

async function seed() {
  await mkdir(path.join(workspace, 'docs'), { recursive: true })
  await writeFile(path.join(workspace, 'docs', 'notes.md'), 'alpha first\nbeta second\ngamma third\n')
  await writeFile(path.join(workspace, 'docs', 'keep.txt'), 'alpha in txt\n')
  await writeFile(path.join(workspace, 'docs', '.hidden.md'), 'alpha hidden\n')
  await writeFile(path.join(workspace, 'data.bin'), BINARY)
  await writeFile(path.join(workspace, 'late-nul.txt'), LATE_NUL)
  await writeFile(path.join(workspace, 'big.txt'), 'x'.repeat(600 * 1024))
  await writeFile(path.join(workspace, 'with space.txt'), 'space\n')
  await mkdir(path.join(workspace, 'repo', '.git'), { recursive: true })
  await writeFile(path.join(outside, 'secret.txt'), 'outside secret\n')
  // 指到根外的符号链接：realpath 后必须被 isPathInside 拦住
  await symlink(outside, path.join(workspace, 'link-out'))
}
await seed()

test('listDirectoryForHost lists real directories first with a 50-entry floor', async () => {
  const manyDir = path.join(workspace, 'many')
  await mkdir(manyDir, { recursive: true })
  for (let index = 0; index < 55; index++)
    await writeFile(path.join(manyDir, `f${String(index).padStart(2, '0')}.txt`), 'x')

  const rootListing = await host.listDirectoryForHost('local', 'root-0', '')
  assert.equal(rootListing.root.id, 'root-0')
  assert.equal(rootListing.root.label, 'workspace')
  const types = rootListing.items.map((item) => item.type)
  assert.deepEqual(
    types,
    [...types].sort((left, right) => (left === right ? 0 : left === 'directory' ? -1 : 1)),
  )
  const docs = rootListing.items.find((item) => item.name === 'docs')
  assert.ok(docs)
  assert.equal(docs.type, 'directory')
  assert.equal(docs.path, 'docs')
  assert.equal(typeof docs.mode, 'number')

  // limit 有 50 的下界：传 1 也只能缩到 50 条，避免一次请求把目录全量吐回来
  const paged = await host.listDirectoryForHost('local', 'root-0', 'many', 1)
  assert.equal(paged.items.length, 50)
  assert.equal(paged.totalCount, 55)
  assert.equal(paged.truncated, true)
  const nested = await host.listDirectoryForHost('local', 'root-0', 'docs')
  assert.deepEqual(
    nested.breadcrumbs.map((crumb) => crumb.path),
    ['', 'docs'],
  )
  assert.equal(nested.truncated, false)
})

test('readPreviewForHost flags binary, large files and honours the line offset', async () => {
  const text = await host.readPreviewForHost('local', 'root-0', 'docs/notes.md', 2)
  assert.equal(text.binary, false)
  // 文件以换行结尾时 split 会多出一条空行，行号连续是契约、末尾空行是现状
  assert.deepEqual(text.lines, [
    { number: 2, content: 'beta second' },
    { number: 3, content: 'gamma third' },
    { number: 4, content: '' },
  ])
  // truncated 的语义是「还有行没返回」：从第 2 行起读会漏掉第 1 行 → 必须为 true
  assert.equal(text.truncated, true)
  const whole = await host.readPreviewForHost('local', 'root-0', 'docs/notes.md')
  assert.equal(whole.truncated, false)
  assert.deepEqual(
    whole.lines.map((line) => line.number),
    [1, 2, 3, 4],
  )

  const binary = await host.readPreviewForHost('local', 'root-0', 'data.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.reason, 'binary-file')
  assert.deepEqual(binary.lines, [])

  // 只看前 4096 字节：NUL 在后半段的文件被当文本（已知口径，改探测范围时这条会红）
  const lateNul = await host.readPreviewForHost('local', 'root-0', 'late-nul.txt')
  assert.equal(lateNul.binary, false)
  assert.equal(lateNul.lines[0].content.startsWith('aaa'), true)

  const large = await host.readPreviewForHost('local', 'root-0', 'big.txt')
  assert.equal(large.reason, 'large-file')
  assert.equal(large.truncated, true)
  assert.deepEqual(large.lines, [], 'large files must not be read into memory at all')

  const directory = await host.readPreviewForHost('local', 'root-0', 'docs')
  assert.equal(directory.type, 'directory')
  assert.deepEqual(directory.lines, [])
})

test('readContentForHost returns text but never binary or oversized payloads', async () => {
  const text = await host.readContentForHost('local', 'root-0', 'docs/notes.md')
  assert.equal(text.content, 'alpha first\nbeta second\ngamma third\n')
  assert.equal(text.binary, false)
  assert.equal(text.encoding, 'utf8')

  const binary = await host.readContentForHost('local', 'root-0', 'data.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.reason, 'binary-file')
  assert.equal(binary.content, '')

  const large = await host.readContentForHost('local', 'root-0', 'big.txt')
  assert.equal(large.reason, 'large-file')
  assert.equal(large.content, '')

  const directory = await host.readContentForHost('local', 'root-0', 'docs')
  assert.equal(directory.reason, 'directory')
})

test('saveContentForHost enforces the optimistic-lock and read-only guards', async () => {
  const filePath = 'docs/notes.md'
  const before = await host.readContentForHost('local', 'root-0', filePath)
  const saved = await host.saveContentForHost('local', 'root-0', filePath, 'rewritten\n', before.modifiedAt)
  assert.equal(saved.ok, true)
  assert.equal(saved.content, 'rewritten\n')
  assert.equal(saved.size, 'rewritten\n'.length)
  assert.equal(await readFile(path.join(workspace, filePath), 'utf8'), 'rewritten\n')

  // 冲突令牌过期（文件已被别人改过）→ 必须带 code 而不是只给文案，路由层靠 code 回 409
  const stale = await host
    .saveContentForHost('local', 'root-0', filePath, 'clobber\n', '2000-01-01T00:00:00.000Z')
    .then(
      () => null,
      (error: Error & { code?: string }) => error,
    )
  assert.ok(stale, 'stale token must be rejected')
  assert.equal(stale.message, 'File changed on disk')
  assert.equal(stale.code, 'FILE_MODIFIED')
  assert.equal(
    await readFile(path.join(workspace, filePath), 'utf8'),
    'rewritten\n',
    'rejected save must not touch the file',
  )

  for (const [target, message] of [
    ['data.bin', 'Binary files are read only'],
    ['big.txt', 'Large files are read only'],
    ['docs', 'Directories cannot be saved'],
  ] as const) {
    await assert.rejects(host.saveContentForHost('local', 'root-0', target, 'x'), { message })
  }
})

test('createFile/createDirectory/rename validate names and never overwrite', async () => {
  const created = await host.createFileForHost('local', 'root-0', 'docs', 'new file.txt')
  assert.equal(created.ok, true)
  assert.equal(created.item.path, 'docs/new file.txt')
  assert.equal((await stat(path.join(workspace, 'docs', 'new file.txt'))).isFile(), true)
  await assert.rejects(host.createFileForHost('local', 'root-0', 'docs', 'new file.txt'), {
    message: 'File already exists',
  })
  await assert.rejects(host.createFileForHost('local', 'root-0', 'docs', '../escape.txt'), { message: 'Invalid name' })
  await assert.rejects(host.createFileForHost('local', 'root-0', 'docs/notes.md', 'x.txt'), {
    message: 'Target directory not found',
  })

  const directory = await host.createDirectoryForHost('local', 'root-0', '', 'fresh')
  assert.equal(directory.item.type, 'directory')
  await assert.rejects(host.createDirectoryForHost('local', 'root-0', '', 'fresh'), {
    message: 'Directory already exists',
  })

  const renamed = await host.renameEntryForHost('local', 'root-0', 'docs/keep.txt', 'kept.txt')
  assert.equal(renamed.item.name, 'kept.txt')
  assert.equal(renamed.previousPath, 'docs/keep.txt')
  await assert.rejects(host.renameEntryForHost('local', 'root-0', 'docs/kept.txt', 'notes.md'), {
    message: 'Target already exists',
  })
  await assert.rejects(host.renameEntryForHost('local', 'root-0', '', 'renamed-root'), {
    message: 'Root cannot be renamed',
  })
})

test('transferEntryForHost copies with conflict naming and moves across roots', async () => {
  const copied = await host.transferEntryForHost('local', 'root-0', 'docs/notes.md', 'root-0', 'docs', false)
  assert.equal(copied.item.name, 'notes copy.md')
  assert.equal(copied.previousPath, 'docs/notes.md')

  const moved = await host.transferEntryForHost('local', 'root-0', 'docs/notes copy.md', 'root-1', '', true)
  assert.equal(moved.item.name, 'notes copy.md')
  assert.equal((await stat(path.join(other, 'notes copy.md'))).isFile(), true)
  assert.equal(
    await stat(path.join(workspace, 'docs', 'notes copy.md')).then(
      () => 'present',
      () => 'gone',
    ),
    'gone',
    'move must remove the source',
  )
  await assert.rejects(host.transferEntryForHost('local', 'root-0', '', 'root-1', '', false), {
    message: 'Root cannot be transferred',
  })
  // 目标路径不存在时是 fs 层 ENOENT（实现先 stat 再判目录），目标是文件才命中业务文案
  await assert.rejects(
    host.transferEntryForHost('local', 'root-0', 'docs/notes.md', 'root-1', 'missing', false),
    /ENOENT/,
  )
  await assert.rejects(
    host.transferEntryForHost('local', 'root-0', 'docs/notes.md', 'root-1', 'notes copy.md', false),
    {
      message: 'Target directory not found',
    },
  )
})

test('trash keeps metadata, restore puts the file back and refuses overwrite', async () => {
  await writeFile(path.join(workspace, 'docs', 'trash-me.txt'), 'bye\n')
  const trashed = await host.trashEntryForHost('local', 'root-0', 'docs/trash-me.txt')
  assert.equal(trashed.ok, true)
  assert.equal(trashed.entry.name, 'trash-me.txt')
  assert.equal(trashed.entry.path, 'docs/trash-me.txt')
  assert.equal(trashed.entry.rootId, 'root-0')
  assert.equal(
    await stat(path.join(workspace, 'docs', 'trash-me.txt')).then(
      () => 'present',
      () => 'gone',
    ),
    'gone',
  )

  const listed = await host.listTrashEntriesForHost('local')
  assert.equal(
    listed.some((entry) => entry.id === trashed.entry.id),
    true,
  )
  const restored = await host.restoreTrashEntryForHost('local', trashed.entry.id)
  assert.equal(restored.ok, true)
  assert.equal(await readFile(path.join(workspace, 'docs', 'trash-me.txt'), 'utf8'), 'bye\n')
  await assert.rejects(host.restoreTrashEntryForHost('local', trashed.entry.id))
  await assert.rejects(host.trashEntryForHost('local', 'root-0', ''), { message: 'Root cannot be trashed' })
})

test('removeEntryForHost deletes files and directories but never the root itself', async () => {
  await writeFile(path.join(workspace, 'docs', 'remove-me.txt'), 'x')
  const removed = await host.removeEntryForHost('local', 'root-0', 'docs/remove-me.txt')
  assert.deepEqual(removed, { ok: true, path: 'docs/remove-me.txt', type: 'file' })
  await mkdir(path.join(workspace, 'docs', 'rm-dir'))
  const removedDir = await host.removeEntryForHost('local', 'root-0', 'docs/rm-dir')
  assert.equal(removedDir.type, 'directory')
  await assert.rejects(host.removeEntryForHost('local', 'root-0', ''), { message: 'Root cannot be removed' })
})

test('searchName/searchContent honour dotfile and extension filters', async () => {
  await mkdir(path.join(workspace, 'search'), { recursive: true })
  await writeFile(path.join(workspace, 'search', 'needle.txt'), 'alpha needle\nsecond needle line\n')
  await writeFile(path.join(workspace, 'search', 'needle.md'), 'alpha needle md\n')
  await writeFile(path.join(workspace, 'search', '.needle-hidden.md'), 'alpha needle hidden\n')

  const byName = await host.searchNameForHost('local', 'root-0', 'needle', 'search')
  assert.deepEqual(byName.map((item) => item.path).sort(), [
    'search/.needle-hidden.md',
    'search/needle.md',
    'search/needle.txt',
  ])
  // includeDotFiles=false 必须丢掉每一段以 . 开头的相对路径
  const withoutHidden = await host.searchNameForHost('local', 'root-0', 'needle', 'search', false)
  assert.deepEqual(withoutHidden.map((item) => item.path).sort(), ['search/needle.md', 'search/needle.txt'])

  const content = await host.searchContentForHost('local', 'root-0', 'alpha needle', 'search')
  const found = content.find((item) => item.path === 'search/needle.txt')
  assert.deepEqual(found?.matches, [
    { number: 1, content: 'alpha needle' },
    { number: 2, content: 'second needle line' },
  ])
  assert.deepEqual(
    content.map((item) => item.path).sort(),
    ['search/.needle-hidden.md', 'search/needle.md', 'search/needle.txt'],
    'dotfiles are searched unless includeDotFiles=false',
  )

  const mdOnly = await host.searchContentForHost('local', 'root-0', 'alpha needle', 'search', true, '.md')
  assert.deepEqual(mdOnly.map((item) => item.path).sort(), ['search/.needle-hidden.md', 'search/needle.md'])
  const hiddenExcluded = await host.searchContentForHost('local', 'root-0', 'alpha needle', 'search', false, '.md')
  assert.deepEqual(
    hiddenExcluded.map((item) => item.path),
    ['search/needle.md'],
  )
})

test('default upload target falls back to the workspace root uploads dir', async () => {
  const target = await host.resolveDefaultUploadTargetForHost('local')
  assert.equal(target.rootId, 'root-0')
  assert.equal(target.rootLabel, 'workspace')
  assert.equal(target.path, 'uploads')
  assert.equal(target.source, 'fallback')
  assert.equal(target.absolutePath, path.join(workspace, 'uploads'))
})

test('git repository discovery finds .git dirs and skips heavy dirs', async () => {
  await mkdir(path.join(workspace, 'node_modules', 'pkg', '.git'), { recursive: true })
  const found = await host.discoverGitRepositoriesForHost('local')
  const paths = found.map((item) => item.path)
  assert.equal(paths.includes(path.join(workspace, 'repo')), true)
  assert.equal(
    paths.some((item) => item.includes('node_modules')),
    false,
    'node_modules is in the skip set',
  )
})

test('temporary upload target lives under TMUXGO_TMP_DIR with its own root id', async () => {
  const target = await host.resolveTemporaryUploadTargetForHost('local')
  assert.equal(target.rootId, 'app-tmp')
  assert.equal(target.rootLabel, 'tmp')
  assert.equal(target.source, 'temporary')
  assert.equal(target.absolutePath, path.resolve(tmpUploadDir))
  assert.equal((await stat(target.absolutePath)).isDirectory(), true)
})

test('path guards reject traversal and symlink escapes on the local channel', async () => {
  await assert.rejects(host.readContentForHost('local', 'root-0', '../etc/passwd'), { message: 'Path escapes root' })
  // 符号链接本身在根内，但解析目标在根外：只有 realpath 复查才能拦住
  assert.equal((await lstat(path.join(workspace, 'link-out'))).isSymbolicLink(), true)
  await assert.rejects(host.readContentForHost('local', 'root-0', 'link-out/secret.txt'), {
    message: 'Path escapes root',
  })
  await assert.rejects(host.listDirectoryForHost('local', 'root-0', 'link-out'))
  await assert.rejects(host.readContentForHost('local', 'no-such-root', 'x'), { message: 'Invalid root' })
  // app-tmp 走的是独立的 resolveTemporaryInside 分支，逃逸守卫要单独验（变异验证时发现这里没盖住）
  await assert.rejects(host.readContentForHost('local', 'app-tmp', '../escape.txt'), { message: 'Path escapes root' })
  await symlink(outside, path.join(tmpUploadDir, 'tmp-link'))
  await assert.rejects(host.readContentForHost('local', 'app-tmp', 'tmp-link/secret.txt'), {
    message: 'Path escapes root',
  })
  // git: 伪根同样要挡住越界与非法的 root id
  const gitRoot = `git:${encodeURIComponent(workspace)}`
  const insideGitRoot = await host.readContentForHost('local', gitRoot, 'docs/notes.md')
  assert.equal(insideGitRoot.binary, false)
  await assert.rejects(host.readContentForHost('local', gitRoot, '../../etc/passwd'), { message: 'Path escapes root' })
  await assert.rejects(host.readContentForHost('local', 'git:', 'x'), { message: 'Invalid root' })
})

test('save touches mtime so the next optimistic-lock token changes', async () => {
  const target = 'docs/notes.md'
  const first = await host.readContentForHost('local', 'root-0', target)
  // mtime 精度不足时要显式推进时间戳，否则「令牌变了」的断言会假阴性
  await utimes(path.join(workspace, target), new Date(), new Date(Date.now() + 1500))
  const second = await host.readContentForHost('local', 'root-0', target)
  assert.notEqual(second.modifiedAt, first.modifiedAt)
  await assert.rejects(host.saveContentForHost('local', 'root-0', target, 'stale\n', first.modifiedAt), {
    message: 'File changed on disk',
  })
  const ok = await host.saveContentForHost('local', 'root-0', target, 'fresh\n', second.modifiedAt)
  assert.equal(ok.content, 'fresh\n')
})

// ---- remote 通道：ssh 桩捕获远端命令，解 payload 断言分派参数 ----

const REMOTE_HOST = { id: 'remote-box', address: '192.0.2.110', user: 'dev', port: 22 }
await upsertRemoteHost(REMOTE_HOST)
after(() => removeHostConnectivity(REMOTE_HOST.id))

function lastPayload() {
  const sshArgs = lastShimArgs(shims, 'ssh') ?? []
  const command = sshArgs.at(-1) ?? ''
  const match = command.match(/'([A-Za-z0-9+/=]+)'\s*$/)
  assert.ok(match, `remote command must end with a base64 payload: ${command.slice(-80)}`)
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Record<string, unknown>
}
function stubRemoteResponse(value: unknown) {
  process.env.SHIM_SSH_EXIT = '0'
  process.env.SHIM_SSH_STDERR = ''
  process.env.SHIM_SSH_STDOUT = `${JSON.stringify(value)}\n`
}

test('every host entry dispatches the same logical arguments to the remote channel', async () => {
  const cases: Array<{ label: string; run: () => Promise<unknown>; reply: unknown; payload: Record<string, unknown> }> =
    [
      {
        label: 'listDirectoryForHost',
        run: () => host.listDirectoryForHost(REMOTE_HOST.id, 'root-0', 'docs', 20),
        reply: { root: { id: 'root-0' }, items: [] },
        payload: { op: 'list', root: 'root-0', path: 'docs', limit: 20 },
      },
      {
        label: 'readPreviewForHost',
        run: () => host.readPreviewForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md', 7),
        reply: { path: 'docs/a.md', lines: [] },
        payload: { op: 'preview', root: 'root-0', path: 'docs/a.md', line: 7 },
      },
      {
        label: 'readContentForHost',
        run: () => host.readContentForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md'),
        reply: { path: 'docs/a.md', content: 'x' },
        payload: { op: 'content', root: 'root-0', path: 'docs/a.md' },
      },
      {
        label: 'saveContentForHost',
        run: () => host.saveContentForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md', 'text\n', '2026-01-01T00:00:00.000Z'),
        reply: { ok: true, content: 'text\n' },
        payload: {
          op: 'save',
          root: 'root-0',
          path: 'docs/a.md',
          content: 'text\n',
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        label: 'createFileForHost',
        run: () => host.createFileForHost(REMOTE_HOST.id, 'root-0', 'docs', 'new.txt'),
        reply: { ok: true, item: { name: 'new.txt' } },
        payload: { op: 'create-file', root: 'root-0', path: 'docs', name: 'new.txt' },
      },
      {
        label: 'createDirectoryForHost',
        run: () => host.createDirectoryForHost(REMOTE_HOST.id, 'root-0', 'docs', 'dir'),
        reply: { ok: true, item: { name: 'dir' } },
        payload: { op: 'create-directory', root: 'root-0', path: 'docs', name: 'dir' },
      },
      {
        label: 'renameEntryForHost',
        run: () => host.renameEntryForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md', 'b.md'),
        reply: { ok: true, item: { name: 'b.md' } },
        payload: { op: 'rename', root: 'root-0', path: 'docs/a.md', name: 'b.md' },
      },
      {
        label: 'transferEntryForHost copy',
        run: () => host.transferEntryForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md', 'root-1', 'inbox', false),
        reply: { ok: true, item: { name: 'a.md' } },
        payload: { op: 'copy', root: 'root-0', path: 'docs/a.md', targetRoot: 'root-1', targetPath: 'inbox' },
      },
      {
        label: 'transferEntryForHost move',
        run: () => host.transferEntryForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md', 'root-1', 'inbox', true),
        reply: { ok: true, item: { name: 'a.md' } },
        payload: { op: 'move', root: 'root-0', path: 'docs/a.md', targetRoot: 'root-1', targetPath: 'inbox' },
      },
      {
        label: 'trashEntryForHost',
        run: () => host.trashEntryForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md'),
        reply: { ok: true, entry: { id: 't1' } },
        payload: { op: 'trash', root: 'root-0', path: 'docs/a.md' },
      },
      {
        label: 'listTrashEntriesForHost',
        run: () => host.listTrashEntriesForHost(REMOTE_HOST.id),
        reply: [{ id: 't1' }],
        payload: { op: 'trash-list' },
      },
      {
        label: 'restoreTrashEntryForHost',
        run: () => host.restoreTrashEntryForHost(REMOTE_HOST.id, 't1'),
        reply: { ok: true, item: { name: 'a.md' } },
        payload: { op: 'trash-restore', trashId: 't1' },
      },
      {
        label: 'removeEntryForHost',
        run: () => host.removeEntryForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md'),
        reply: { ok: true, path: 'docs/a.md', type: 'file' },
        payload: { op: 'remove', root: 'root-0', path: 'docs/a.md' },
      },
      {
        label: 'searchNameForHost',
        run: () => host.searchNameForHost(REMOTE_HOST.id, 'root-0', 'q', 'base', false),
        reply: [],
        payload: { op: 'search-name', root: 'root-0', path: 'base', query: 'q', includeDotFiles: false },
      },
      {
        label: 'searchContentForHost',
        run: () => host.searchContentForHost(REMOTE_HOST.id, 'root-0', 'q', 'base', true, '.md'),
        reply: [],
        payload: { op: 'search-content', root: 'root-0', path: 'base', query: 'q', includeDotFiles: true, ext: '.md' },
      },
      {
        label: 'resolveDefaultUploadTargetForHost',
        run: () => host.resolveDefaultUploadTargetForHost(REMOTE_HOST.id),
        reply: { rootId: 'root-0', path: 'uploads', source: 'fallback' },
        payload: { op: 'default-upload-target' },
      },
      {
        label: 'discoverGitRepositoriesForHost',
        run: () => host.discoverGitRepositoriesForHost(REMOTE_HOST.id),
        reply: [{ path: '/srv/repo', label: 'repo' }],
        payload: { op: 'git-repositories' },
      },
    ]

  for (const item of cases) {
    stubRemoteResponse(item.reply)
    const result = await item.run()
    assert.deepEqual(result, item.reply, `${item.label} must pass the remote JSON through untouched`)
    assert.deepEqual(lastPayload(), item.payload, `${item.label} payload mismatch`)
    const sshArgs = lastShimArgs(shims, 'ssh') ?? []
    assert.equal(sshArgs[sshArgs.length - 2], '--', 'remote command must stay behind --')
    assert.ok(sshArgs.includes('dev@192.0.2.110'))
  }
})

test('remote payload round-trips quotes, newlines, unicode and NUL-free text', async () => {
  const content = `line1 'single' "double" --flag\n中文 emoji 🚀\n\ttabbed\n`
  stubRemoteResponse({ ok: true, content })
  const saved = await host.saveContentForHost(
    REMOTE_HOST.id,
    'root-0',
    `docs/weird 'name'.md`,
    content,
    '2026-01-01T00:00:00.000Z',
  )
  assert.equal(saved.content, content)
  const payload = lastPayload()
  assert.equal(payload.path, `docs/weird 'name'.md`)
  assert.equal(payload.content, content, 'payload must survive base64+JSON round-trip byte for byte')
})

test('remote FILE_MODIFIED is mapped to a code the routes can turn into 409', async () => {
  process.env.SHIM_SSH_EXIT = '1'
  process.env.SHIM_SSH_STDOUT = ''
  // 远端脚本 raise Exception('FILE_MODIFIED:...')，stderr 是整段 traceback，标记在末行——
  // 只按开头 startsWith 判定会漏，必须按标记位置切
  process.env.SHIM_SSH_STDERR =
    'Traceback (most recent call last):\n  File "<string>", line 12, in <module>\nException: FILE_MODIFIED:File changed on disk\n'
  const error = await host
    .saveContentForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md', 'x', '2026-01-01T00:00:00.000Z')
    .then(
      () => null,
      (err: Error & { code?: string }) => err,
    )
  assert.ok(error)
  assert.equal(error.code, 'FILE_MODIFIED')
  // traceback 不外泄：只留标记同行的人类文案
  assert.equal(error.message, 'File changed on disk')
})

test('remote transport failures are classified and mark the host offline', async () => {
  removeHostConnectivity(REMOTE_HOST.id)
  process.env.SHIM_SSH_EXIT = '255'
  process.env.SHIM_SSH_STDOUT = ''
  process.env.SHIM_SSH_STDERR = 'dev@192.0.2.110: Permission denied (publickey).'
  await assert.rejects(host.readContentForHost(REMOTE_HOST.id, 'root-0', 'docs/a.md'), {
    message: 'SSH authentication failed',
  })
  assert.equal(getHostConnectivity(REMOTE_HOST.id)?.status, 'offline')
  assert.equal(getHostConnectivity(REMOTE_HOST.id)?.lastError, 'SSH authentication failed')

  // 远端脚本的业务错误原样透传（不能吞成 SSH 失败）
  removeHostConnectivity(REMOTE_HOST.id)
  process.env.SHIM_SSH_STDERR = 'Traceback (most recent call last):\nException: Invalid root\n'
  await assert.rejects(host.readContentForHost(REMOTE_HOST.id, 'root-9', 'x'), /Invalid root/)
  assert.equal(getHostConnectivity(REMOTE_HOST.id), undefined)
})

// ---- 真 python：远端脚本本体与 payload 编码的端到端校验（无需 SSH） ----

async function runRemoteScript(payload: Record<string, unknown>) {
  const encoded = roots.encodeRemotePayload(payload)
  return execFileAsync('python3', ['-c', roots.REMOTE_FILE_SCRIPT, encoded], {
    env: { ...process.env, TMUX_WEB_FILE_ROOTS: `workspace=${workspace}` },
  })
}

test('encodeRemotePayload is a plain base64 JSON envelope', () => {
  const encoded = roots.encodeRemotePayload({ op: 'x', path: `a 'b'`, content: '中\n' })
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/)
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), {
    op: 'x',
    path: `a 'b'`,
    content: '中\n',
  })
})

test('remote python script runs the same guards as the local implementation', async () => {
  const listed = JSON.parse((await runRemoteScript({ op: 'list', root: 'root-0', path: 'docs' })).stdout) as {
    items: Array<{ name: string; type: string }>
    totalCount: number
  }
  assert.equal(
    listed.items.some((entry) => entry.name === 'notes.md'),
    true,
  )

  const binary = JSON.parse((await runRemoteScript({ op: 'preview', root: 'root-0', path: 'data.bin' })).stdout) as {
    binary: boolean
    reason: string
  }
  assert.deepEqual({ binary: binary.binary, reason: binary.reason }, { binary: true, reason: 'binary-file' })

  const large = JSON.parse((await runRemoteScript({ op: 'preview', root: 'root-0', path: 'big.txt' })).stdout) as {
    truncated: boolean
    reason: string
    lines: unknown[]
  }
  assert.equal(large.reason, 'large-file')
  assert.deepEqual(large.lines, [])

  await writeFile(path.join(workspace, 'docs', 'python-probe.md'), 'python alpha\nbeta\n')
  const content = JSON.parse(
    (await runRemoteScript({ op: 'content', root: 'root-0', path: 'docs/python-probe.md' })).stdout,
  ) as { content: string; binary: boolean }
  assert.equal(content.binary, false)
  assert.equal(content.content, 'python alpha\nbeta\n')

  const escaped = await runRemoteScript({ op: 'content', root: 'root-0', path: '../secret.txt' }).then(
    () => null,
    (error: Error & { stderr?: string }) => error,
  )
  assert.ok(escaped)
  assert.match(String(escaped.stderr), /Path escapes root/)

  const staleSave = await runRemoteScript({
    op: 'save',
    root: 'root-0',
    path: 'docs/python-probe.md',
    content: 'x',
    modifiedAt: '2000-01-01T00:00:00.000Z',
  }).then(
    () => null,
    (error: Error & { stderr?: string }) => error,
  )
  assert.ok(staleSave)
  // 这行同时是上面那条 code 映射失效的原因：前缀藏在 traceback 末行
  assert.match(String(staleSave.stderr), /Exception: FILE_MODIFIED:File changed on disk/)
})
