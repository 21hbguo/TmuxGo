import assert from 'node:assert/strict'
import test from 'node:test'
import { getBreadcrumbs, isPathInside, normalizeRelativePath, sanitizePathSegment } from './file-path.js'

test('normalizes relative paths', () => {
  assert.equal(normalizeRelativePath('/src\\lib//index.ts'), 'src/lib/index.ts')
})
test('rejects unsafe file names', () => {
  assert.throws(() => sanitizePathSegment('../secret'), /Invalid name/)
})
test('keeps resolved paths within their root', () => {
  assert.equal(isPathInside('/workspace', '/workspace/src/index.ts'), true)
  assert.equal(isPathInside('/workspace', '/workspace-other/index.ts'), false)
  assert.deepEqual(getBreadcrumbs('src/lib'), [{ name: '/', path: '' }, { name: 'src', path: 'src' }, { name: 'lib', path: 'src/lib' }])
})
