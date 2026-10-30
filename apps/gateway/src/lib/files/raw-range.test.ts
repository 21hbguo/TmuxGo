import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSingleRange } from './raw-range.js'

test('parseSingleRange: missing or empty header falls back to full body', () => {
  assert.equal(parseSingleRange(undefined, 100), null)
  assert.equal(parseSingleRange('', 100), null)
  assert.equal(parseSingleRange('   ', 100), null)
})

test('parseSingleRange: closed range is returned as-is', () => {
  assert.deepEqual(parseSingleRange('bytes=0-99', 100), { start: 0, end: 99 })
  assert.deepEqual(parseSingleRange('bytes=10-20', 100), { start: 10, end: 20 })
})

test('parseSingleRange: open-ended range runs to the last byte', () => {
  assert.deepEqual(parseSingleRange('bytes=10-', 100), { start: 10, end: 99 })
  assert.deepEqual(parseSingleRange('bytes=99-', 100), { start: 99, end: 99 })
})

test('parseSingleRange: suffix range is clamped to the file start', () => {
  assert.deepEqual(parseSingleRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseSingleRange('bytes=-200', 100), { start: 0, end: 99 })
})

test('parseSingleRange: end is trimmed to size-1', () => {
  assert.deepEqual(parseSingleRange('bytes=0-999', 100), { start: 0, end: 99 })
})

test('parseSingleRange: start at or past EOF is unsatisfiable', () => {
  assert.equal(parseSingleRange('bytes=100-', 100), 'invalid')
  assert.equal(parseSingleRange('bytes=100-120', 100), 'invalid')
  assert.equal(parseSingleRange('bytes=999999999999999999999-', 100), 'invalid')
})

test('parseSingleRange: reversed and zero-length ranges are unsatisfiable', () => {
  assert.equal(parseSingleRange('bytes=50-10', 100), 'invalid')
  assert.equal(parseSingleRange('bytes=-0', 100), 'invalid')
})

test('parseSingleRange: any range on a zero-byte file is unsatisfiable', () => {
  assert.equal(parseSingleRange('bytes=0-', 0), 'invalid')
  assert.equal(parseSingleRange('bytes=0-0', 0), 'invalid')
  assert.equal(parseSingleRange('bytes=-5', 0), 'invalid')
})

test('parseSingleRange: single-byte file', () => {
  assert.deepEqual(parseSingleRange('bytes=0-0', 1), { start: 0, end: 0 })
  assert.deepEqual(parseSingleRange('bytes=-1', 1), { start: 0, end: 0 })
})

test('parseSingleRange: multi-range requests fall back to full body', () => {
  assert.equal(parseSingleRange('bytes=0-1,4-5', 100), null)
})

test('parseSingleRange: malformed syntax falls back to full body', () => {
  assert.equal(parseSingleRange('bytes=--', 100), null)
  assert.equal(parseSingleRange('bytes=abc', 100), null)
  assert.equal(parseSingleRange('items=0-1', 100), null)
  assert.equal(parseSingleRange('bytes= 0-1', 100), null)
  assert.equal(parseSingleRange('bytes=0 - 1', 100), null)
  assert.equal(parseSingleRange('bytes=1.5-2', 100), null)
})

test('parseSingleRange: unit name is case-insensitive', () => {
  assert.deepEqual(parseSingleRange('BYTES=0-1', 100), { start: 0, end: 1 })
})

test('parseSingleRange: huge file sizes stay exact', () => {
  const size = Number.MAX_SAFE_INTEGER
  assert.deepEqual(parseSingleRange('bytes=9007199254740987-', size), {
    start: 9007199254740987,
    end: size - 1,
  })
})
