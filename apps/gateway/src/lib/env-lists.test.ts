import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNameList } from './env-lists.js'

test('splits, trims and drops empty entries', () => {
  assert.deepEqual(parseNameList(' test , work ,,'), ['test', 'work'])
})

test('returns an empty list for unset/blank env (callers treat it as "no restriction")', () => {
  assert.deepEqual(parseNameList(undefined), [])
  assert.deepEqual(parseNameList(null), [])
  assert.deepEqual(parseNameList(''), [])
  assert.deepEqual(parseNameList('   '), [])
  assert.deepEqual(parseNameList(', ,'), [])
})

test('keeps declaration order and drops duplicates', () => {
  assert.deepEqual(parseNameList('b,a,b'), ['b', 'a'])
})

test('keeps names with separators intact after trimming', () => {
  assert.deepEqual(parseNameList(' TmuxGo-1 , test '), ['TmuxGo-1', 'test'])
})
