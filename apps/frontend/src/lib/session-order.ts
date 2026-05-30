import type { Session } from '@/types'

export function orderSessions(sessions: Session[], orderedSessionIds: string[]) {
  if (!orderedSessionIds.length) return sessions
  const rank = new Map(orderedSessionIds.map((id, index) => [id, index]))
  return [...sessions].sort((a, b) => {
    const rankA = rank.get(a.id)
    const rankB = rank.get(b.id)
    if (rankA == null && rankB == null) return 0
    if (rankA == null) return 1
    if (rankB == null) return -1
    return rankA - rankB
  })
}

export function moveItemsById<T extends { id: string }>(items: T[], activeId: string, overId: string) {
  if (!activeId || !overId || activeId === overId) return items
  const activeIndex = items.findIndex((item) => item.id === activeId)
  const overIndex = items.findIndex((item) => item.id === overId)
  if (activeIndex === -1 || overIndex === -1) return items
  const nextItems = [...items]
  const [activeItem] = nextItems.splice(activeIndex, 1)
  nextItems.splice(overIndex, 0, activeItem)
  return nextItems
}
