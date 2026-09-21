import { describe, expect, it } from 'vitest'
import { findPreviewGroup, movePreviewBetweenGroups } from './SessionSortableList'

describe('movePreviewBetweenGroups', () => {
  const preview = { 'ws-1': ['a', 'b'], 'ws-2': ['c'], '': ['d'] }
  it('moves a session across groups onto an item position', () => {
    const next = movePreviewBetweenGroups(preview, 'a', 'c')
    expect(next['ws-1']).toEqual(['b'])
    expect(next['ws-2']).toEqual(['a', 'c'])
    expect(next['']).toEqual(['d'])
  })
  it('drops onto a group container appending at the end', () => {
    const next = movePreviewBetweenGroups(preview, 'a', 'group:ws-2')
    expect(next['ws-2']).toEqual(['c', 'a'])
    expect(next['ws-1']).toEqual(['b'])
  })
  it('drops onto the unclassified group container', () => {
    const next = movePreviewBetweenGroups(preview, 'c', 'group:')
    expect(next['']).toEqual(['d', 'c'])
    expect(next['ws-2']).toEqual([])
  })
  it('reorders within the same group', () => {
    const next = movePreviewBetweenGroups(preview, 'a', 'b')
    expect(next['ws-1']).toEqual(['b', 'a'])
  })
  it('returns the same preview for unknown or self targets', () => {
    expect(movePreviewBetweenGroups(preview, 'a', 'missing')).toBe(preview)
    expect(movePreviewBetweenGroups(preview, 'ghost', 'b')).toBe(preview)
  })
})
describe('findPreviewGroup', () => {
  it('locates the group key containing a session', () => {
    expect(findPreviewGroup({ 'ws-1': ['a'], '': ['b'] }, 'b')).toBe('')
    expect(findPreviewGroup({ 'ws-1': ['a'] }, 'x')).toBeNull()
  })
})
