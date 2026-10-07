import { describe, expect, it } from 'vitest'
import { orderActivityItems } from './ActivityBar'

const items = (...ids: string[]) => ids.map((id) => ({ id }))

describe('orderActivityItems', () => {
  it('keeps natural order when no saved order exists', () => {
    expect(orderActivityItems(items('a', 'b'), []).map((i) => i.id)).toEqual(['a', 'b'])
  })
  it('applies saved order and drops unknown ids', () => {
    expect(orderActivityItems(items('a', 'b', 'c'), ['c', 'ghost', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })
  it('appends new items after saved order', () => {
    expect(orderActivityItems(items('a', 'b', 'plugin:x:y'), ['b']).map((i) => i.id)).toEqual(['b', 'a', 'plugin:x:y'])
  })
  it('dedupes repeated ids in saved order', () => {
    expect(orderActivityItems(items('a', 'b'), ['b', 'b', 'a']).map((i) => i.id)).toEqual(['b', 'a'])
  })
})
