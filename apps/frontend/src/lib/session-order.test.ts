import { describe, expect, it } from 'vitest'
import { moveItemsById, orderSessions } from './session-order'

describe('session-order', () => {
  it('moves an item before the hovered target in a stable way', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    expect(moveItemsById(items, 'a', 'c').map((item) => item.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItemsById(items, 'd', 'b').map((item) => item.id)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('orders sessions by saved ids and leaves unknown ids at the end', () => {
    const sessions = [
      { id: 'session-a', name: 'a' },
      { id: 'session-b', name: 'b' },
      { id: 'session-c', name: 'c' },
    ] as any
    expect(orderSessions(sessions, ['session-c', 'session-a']).map((item) => item.id)).toEqual(['session-c', 'session-a', 'session-b'])
  })
})
