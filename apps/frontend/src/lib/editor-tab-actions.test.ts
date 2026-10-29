import { describe, expect, it } from 'vitest'
import {
  CLOSED_EDITOR_STACK_LIMIT,
  idsToCloseOthers,
  idsToCloseSaved,
  idsToCloseToRight,
  pushClosedEntry,
  takeClosedEntry,
} from './editor-tab-actions'

describe('tab batch close', () => {
  const order = ['a', 'b', 'c', 'd']

  it('closes everything except the kept tab', () => {
    expect(idsToCloseOthers(order, 'b')).toEqual(['a', 'c', 'd'])
  })

  it('closes tabs to the right of the anchor', () => {
    expect(idsToCloseToRight(order, 'b')).toEqual(['c', 'd'])
    expect(idsToCloseToRight(order, 'd')).toEqual([])
    expect(idsToCloseToRight(order, 'missing')).toEqual([])
  })

  it('closes only clean tabs', () => {
    const dirty = new Set(['b'])
    expect(idsToCloseSaved(order, (id) => dirty.has(id))).toEqual(['a', 'c', 'd'])
  })
})

describe('closed editor stack', () => {
  it('pushes newest entries to the top', () => {
    const stack = pushClosedEntry(pushClosedEntry([], { id: 'a' }), { id: 'b' })
    expect(stack.map((item) => item.id)).toEqual(['a', 'b'])
    expect(takeClosedEntry(stack)).toEqual({ entry: { id: 'b' }, rest: [{ id: 'a' }] })
  })

  it('dedupes by id so reopening then closing does not duplicate', () => {
    const stack = pushClosedEntry(pushClosedEntry([], { id: 'a' }), { id: 'a' })
    expect(stack).toEqual([{ id: 'a' }])
  })

  it('caps the stack length by dropping the oldest entries', () => {
    let stack: { id: string }[] = []
    for (let index = 0; index < CLOSED_EDITOR_STACK_LIMIT + 5; index += 1) stack = pushClosedEntry(stack, { id: `e${index}` })
    expect(stack).toHaveLength(CLOSED_EDITOR_STACK_LIMIT)
    expect(stack[0].id).toBe('e5')
    expect(stack.at(-1)?.id).toBe(`e${CLOSED_EDITOR_STACK_LIMIT + 4}`)
  })

  it('reports an empty stack without mutating it', () => {
    const stack: { id: string }[] = []
    expect(takeClosedEntry(stack)).toEqual({ entry: null, rest: [] })
  })
})
