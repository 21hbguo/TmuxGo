import { fireEvent, render } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSplitView } from './SessionSplitView'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { STREAM_EVENT, subscribeStreamEvent } from '@/lib/stream-events'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useSplitGroups', () => ({
  useSplitGroups: () => ({ update: vi.fn() }),
}))
vi.mock('@/hooks/useSessionSocket', () => ({
  useSessionSocket: () => null,
}))
vi.mock('@/hooks/useApi', () => ({
  useSessions: () => ({ data: [] }),
}))
vi.mock('./PaneGrid', () => ({
  PaneGrid: () => React.createElement('div', null, 'grid'),
}))
vi.mock('./ShortcutBar', () => ({
  ShortcutBar: () => React.createElement('div', null, 'bar'),
}))

const group = {
  id: 'g1',
  direction: 'horizontal',
  primarySessionId: 'dev1',
  secondarySessionId: 'dev2',
  primaryRatio: 0.6,
} as any

describe('SessionSplitView divider gesture lifecycle', () => {
  beforeEach(() => {
    useConsoleStore.setState({ activeHostId: 'local' } as any)
  })

  it('emits start on pointerdown and end on pointerup (listeners registered without re-render)', () => {
    const gestures: string[] = []
    const unsub = subscribeStreamEvent(STREAM_EVENT.resizeGesture, (d: any) => gestures.push(d?.phase))
    const { container } = render(<SessionSplitView group={group} />)
    const divider = container.querySelector('.cursor-col-resize') as HTMLElement
    expect(divider).toBeTruthy()
    fireEvent.pointerDown(divider, { clientX: 500, clientY: 300 })
    fireEvent.pointerMove(window, { clientX: 520, clientY: 300 })
    fireEvent.pointerUp(window)
    expect(gestures).toEqual(['start', 'end'])
    unsub()
  })

  it('settles exactly once on unmount mid-drag', () => {
    const gestures: string[] = []
    const unsub = subscribeStreamEvent(STREAM_EVENT.resizeGesture, (d: any) => gestures.push(d?.phase))
    const { container, unmount } = render(<SessionSplitView group={group} />)
    const divider = container.querySelector('.cursor-col-resize') as HTMLElement
    fireEvent.pointerDown(divider, { clientX: 500, clientY: 300 })
    unmount()
    expect(gestures).toEqual(['start', 'end'])
    unsub()
  })

  it('does not emit end for a pointerup when no drag is active', () => {
    const gestures: string[] = []
    const unsub = subscribeStreamEvent(STREAM_EVENT.resizeGesture, (d: any) => gestures.push(d?.phase))
    render(<SessionSplitView group={group} />)
    fireEvent.pointerUp(window)
    expect(gestures).toEqual([])
    unsub()
  })
})
