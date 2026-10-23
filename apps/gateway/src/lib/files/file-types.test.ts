// file-types 是「能不能碰这个路径」那套常量的单一出处：阈值、跳过目录、可内联图片类型。
// 这里断言的是相互约束（预览必须小于只读阈值、搜索跳过必须覆盖 git 发现跳过）与安全默认
// （svg 不在 image map 里），数值改动若破坏约束会直接红，而不是靠人读 diff。
import '../../test-env.js'
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_DOWNLOAD_ARTIFACT_MAX_BYTES,
  DEFAULT_DOWNLOAD_ARTIFACT_MAX_COUNT,
  DEFAULT_TEMP_UPLOAD_TTL_MS,
  DEFAULT_UPLOAD_DIR,
  DEFAULT_UPLOAD_RATE_LIMIT_KBPS,
  FILE_SEARCH_SKIP_DIRS,
  GIT_REPOSITORY_SKIP_DIRS,
  IMAGE_MIME_BY_EXT,
  LARGE_FILE_LIMIT,
  MAX_DIRS,
  MAX_FILES,
  MAX_READ_LINES,
  MAX_RESULTS,
  MAX_UPLOAD_RATE_LIMIT_KBPS,
  PREVIEW_LIMIT,
  readPositiveIntegerEnv,
  rootSpec,
  TEMP_UPLOAD_ROOT_ID,
  defaultRoot,
} from './file-types.js'

test('readPositiveIntegerEnv accepts only positive numbers and rounds the rest away', () => {
  const name = 'TMUXGO_TEST_POSITIVE_INT'
  const restore = () => delete process.env[name]
  try {
    restore()
    assert.equal(readPositiveIntegerEnv(name, 42), 42, 'unset -> fallback')
    process.env[name] = ''
    assert.equal(readPositiveIntegerEnv(name, 42), 42, 'empty string is not a positive integer')
    process.env[name] = '0'
    assert.equal(readPositiveIntegerEnv(name, 42), 42, 'zero is rejected (a 0 TTL would delete everything)')
    process.env[name] = '-7'
    assert.equal(readPositiveIntegerEnv(name, 42), 42, 'negative is rejected')
    process.env[name] = 'abc'
    assert.equal(readPositiveIntegerEnv(name, 42), 42, 'non-numeric is rejected')
    process.env[name] = 'Infinity'
    assert.equal(readPositiveIntegerEnv(name, 42), 42, 'Infinity is not a usable limit')
    process.env[name] = '12'
    assert.equal(readPositiveIntegerEnv(name, 42), 12)
    process.env[name] = ' 12 '
    assert.equal(readPositiveIntegerEnv(name, 42), 12, 'surrounding spaces are tolerated')
    process.env[name] = '3.6'
    assert.equal(readPositiveIntegerEnv(name, 42), 4, 'fractional values round to the nearest integer')
  } finally {
    restore()
  }
})

test('size thresholds keep preview strictly below the read-only limit', () => {
  assert.equal(PREVIEW_LIMIT, 200 * 1024)
  assert.equal(LARGE_FILE_LIMIT, 512 * 1024)
  // 预览截断阈值必须小于「大文件只读」阈值，否则超大文件会先被整块读进来再截断
  assert.ok(PREVIEW_LIMIT < LARGE_FILE_LIMIT)
  assert.equal(MAX_READ_LINES, 1200)
  assert.equal(MAX_RESULTS, 200)
  assert.ok(MAX_DIRS > 0 && MAX_FILES > 0)
  assert.ok(DEFAULT_TEMP_UPLOAD_TTL_MS > 0)
  assert.ok(DEFAULT_DOWNLOAD_ARTIFACT_MAX_COUNT > 0)
  assert.ok(DEFAULT_DOWNLOAD_ARTIFACT_MAX_BYTES > 0)
  assert.ok(MAX_UPLOAD_RATE_LIMIT_KBPS >= DEFAULT_UPLOAD_RATE_LIMIT_KBPS)
  assert.equal(DEFAULT_UPLOAD_DIR, 'uploads')
})

test('search skips a strict superset of git-discovery skips', () => {
  // 搜索必须跳过 .git 等 VCS 目录；git 发现反而必须能看见 .git，所以两者不能共用同一个集合
  assert.equal(GIT_REPOSITORY_SKIP_DIRS.has('.git'), false)
  for (const skipped of GIT_REPOSITORY_SKIP_DIRS)
    assert.equal(FILE_SEARCH_SKIP_DIRS.has(skipped), true, `${skipped} must also be skipped by search`)
  for (const extra of ['.git', '.hg', '.svn', 'coverage', 'target', 'vendor'])
    assert.equal(FILE_SEARCH_SKIP_DIRS.has(extra), true, `${extra} must be skipped by search`)
  assert.ok(FILE_SEARCH_SKIP_DIRS.size > GIT_REPOSITORY_SKIP_DIRS.size)
  assert.equal(GIT_REPOSITORY_SKIP_DIRS.has('node_modules'), true)
})

test('inline image mime map never serves svg (stored XSS guard)', () => {
  assert.equal(IMAGE_MIME_BY_EXT['.svg'], undefined)
  assert.equal(
    Object.values(IMAGE_MIME_BY_EXT).some((mime) => mime.includes('svg')),
    false,
  )
  for (const [ext, mime] of Object.entries(IMAGE_MIME_BY_EXT)) {
    assert.match(ext, /^\.[a-z0-9]+$/, 'keys are lowercase dotted extensions')
    assert.match(mime, /^image\/[a-z0-9.+-]+$/)
  }
  assert.equal(IMAGE_MIME_BY_EXT['.jpg'], IMAGE_MIME_BY_EXT['.jpeg'])
  assert.equal(IMAGE_MIME_BY_EXT['.tif'], IMAGE_MIME_BY_EXT['.tiff'])
})

test('rootSpec mirrors the configured roots and defaultRoot stays absolute', () => {
  // test-env.ts 已把 TMUX_WEB_FILE_ROOTS 指到临时 workspace，避免读到真实家目录
  assert.equal(rootSpec, process.env.TMUX_WEB_FILE_ROOTS)
  assert.match(rootSpec, /^workspace=/)
  assert.equal(path.isAbsolute(defaultRoot), true)
  assert.equal(TEMP_UPLOAD_ROOT_ID, 'app-tmp')
})
