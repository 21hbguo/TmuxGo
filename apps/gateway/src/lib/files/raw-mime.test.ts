import assert from 'node:assert/strict'
import test from 'node:test'
import { isHtmlMime, resolveRawMime } from './raw-mime.js'

test('resolveRawMime: media and document types are inline-capable', () => {
  assert.equal(resolveRawMime('/tmp/a.pdf', false), 'application/pdf')
  assert.equal(resolveRawMime('/tmp/a.mp4', false), 'video/mp4')
  assert.equal(resolveRawMime('/tmp/a.webm', false), 'video/webm')
  assert.equal(resolveRawMime('/tmp/a.mp3', false), 'audio/mpeg')
  assert.equal(resolveRawMime('/tmp/a.flac', false), 'audio/flac')
  assert.equal(resolveRawMime('/tmp/a.png', false), 'image/png')
  assert.equal(resolveRawMime('/tmp/a.webp', false), 'image/webp')
})

test('resolveRawMime: text-ish files keep a charset', () => {
  assert.equal(resolveRawMime('/tmp/a.txt', false), 'text/plain; charset=utf-8')
  assert.equal(resolveRawMime('/tmp/a.log', false), 'text/plain; charset=utf-8')
  assert.equal(resolveRawMime('/tmp/a.csv', false), 'text/csv; charset=utf-8')
  assert.equal(resolveRawMime('/tmp/a.md', false), 'text/markdown; charset=utf-8')
  assert.equal(resolveRawMime('/tmp/a.json', false), 'application/json; charset=utf-8')
  assert.equal(resolveRawMime('/tmp/a.html', false), 'text/html; charset=utf-8')
})

test('resolveRawMime: extension matching is case-insensitive', () => {
  assert.equal(resolveRawMime('/tmp/A.PDF', false), 'application/pdf')
  assert.equal(resolveRawMime('/tmp/A.Mp4', false), 'video/mp4')
})

test('resolveRawMime: svg never leaves the gateway inline', () => {
  assert.equal(resolveRawMime('/tmp/icon.svg', false), null)
  assert.equal(resolveRawMime('/tmp/icon.svg', true), null)
  assert.equal(resolveRawMime('/tmp/icon.svgz', false), null)
})

test('resolveRawMime: unknown extensions are 415 unless downloading', () => {
  assert.equal(resolveRawMime('/tmp/model.bin', false), null)
  assert.equal(resolveRawMime('/tmp/README', false), null)
  assert.equal(resolveRawMime('/tmp/model.bin', true), 'application/octet-stream')
})

test('isHtmlMime: only html/xhtml get the sandbox CSP', () => {
  assert.equal(isHtmlMime('text/html; charset=utf-8'), true)
  assert.equal(isHtmlMime('application/xhtml+xml; charset=utf-8'), true)
  assert.equal(isHtmlMime('application/pdf'), false)
  assert.equal(isHtmlMime('text/plain; charset=utf-8'), false)
  assert.equal(isHtmlMime(null), false)
})
