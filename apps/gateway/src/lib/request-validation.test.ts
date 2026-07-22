import assert from 'node:assert/strict'
import test from 'node:test'
import { fileEntryBodySchema, gitFilesBodySchema, paneSplitBodySchema } from './request-validation.js'

test('accepts valid file entry input', () => {
  assert.deepEqual(fileEntryBodySchema.parse({ root: 'root-0', path: 'src', name: 'index.ts' }), { root: 'root-0', path: 'src', name: 'index.ts' })
})
test('rejects invalid git file paths', () => {
  assert.equal(gitFilesBodySchema.safeParse({ path: '/repo', filePaths: ['../secret'] }).success, false)
})
test('rejects unsupported pane directions', () => {
  assert.equal(paneSplitBodySchema.safeParse({ paneId: 'local:%1', direction: 'diagonal' }).success, false)
})
