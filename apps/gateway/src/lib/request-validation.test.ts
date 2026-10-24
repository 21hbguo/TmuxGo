import '../test-env.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { describeZodError, fileEntryBodySchema, gitFilesBodySchema, paneSplitBodySchema } from './request-validation.js'

test('accepts valid file entry input', () => {
  assert.deepEqual(fileEntryBodySchema.parse({ root: 'root-0', path: 'src', name: 'index.ts' }), {
    root: 'root-0',
    path: 'src',
    name: 'index.ts',
  })
})
test('rejects invalid git file paths', () => {
  assert.equal(gitFilesBodySchema.safeParse({ path: '/repo', filePaths: ['../secret'] }).success, false)
})
test('rejects unsupported pane directions', () => {
  assert.equal(paneSplitBodySchema.safeParse({ paneId: 'local:%1', direction: 'diagonal' }).success, false)
})

test('describes zod issues as path: reason pairs', () => {
  // index.ts 的 400 INVALID_REQUEST message 就由它生成：前端直接展示，必须可读
  const parsed = fileEntryBodySchema.safeParse({ root: 'root-0', path: 'src' })
  assert.equal(parsed.success, false)
  if (parsed.success) return
  // zod4 的文案从 `Required` 变成 `Invalid input: expected string, received undefined`，
  // describeZodError 剥掉 `Invalid input: ` 前缀后前端看到的是后者
  assert.equal(describeZodError(parsed.error), 'name: expected string, received undefined')
  assert.match(describeZodError(parsed.error), /^name: /)
})

test('falls back to a request placeholder for top-level issues', () => {
  const parsed = paneSplitBodySchema.safeParse('not-an-object')
  assert.equal(parsed.success, false)
  if (parsed.success) return
  assert.match(describeZodError(parsed.error), /^request: /)
})
