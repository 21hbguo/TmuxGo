import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearEditorCursor,
  getEditorCursor,
  resetEditorCursorStore,
  setEditorCursor,
  subscribeEditorCursor,
  useEditorCursor,
} from './editor-cursor'

const snapshot = (line: number, column = 1) => ({
  line,
  column,
  lineCount: 100,
  selections: 1,
  selection: null,
})

function Probe({ editorId }: { editorId: string }) {
  const cursor = useEditorCursor(editorId)
  return <div data-testid="probe">{`${cursor.line}:${cursor.column}`}</div>
}

describe('editor cursor store', () => {
  beforeEach(() => {
    resetEditorCursorStore()
  })

  afterEach(() => {
    resetEditorCursorStore()
    vi.unstubAllGlobals()
  })

  it('stores and reads snapshots', () => {
    setEditorCursor('a', snapshot(3, 4))
    expect(getEditorCursor('a')).toMatchObject({ line: 3, column: 4 })
    expect(getEditorCursor('missing')).toBeUndefined()
  })

  it('coalesces multiple updates into one notification per frame', async () => {
    const listener = vi.fn()
    subscribeEditorCursor(listener)
    for (let line = 1; line <= 40; line += 1) setEditorCursor('a', snapshot(line))
    await waitFor(() => expect(listener).toHaveBeenCalled())
    expect(listener.mock.calls.length).toBeLessThanOrEqual(2)
    expect(getEditorCursor('a')?.line).toBe(40)
  })

  it('skips notifications when nothing visible changed', async () => {
    const listener = vi.fn()
    subscribeEditorCursor(listener)
    setEditorCursor('a', snapshot(5, 2))
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    listener.mockClear()
    // 同一行列（只是内部重算）不触发再渲染
    setEditorCursor('a', snapshot(5, 2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops the snapshot when an editor closes', async () => {
    setEditorCursor('a', snapshot(2))
    clearEditorCursor('a')
    expect(getEditorCursor('a')).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('renders only the subscribing component', async () => {
    let siblingRenders = 0
    function Sibling() {
      siblingRenders += 1
      return <div>sibling</div>
    }
    render(
      <>
        <Probe editorId="a" />
        <Sibling />
      </>,
    )
    const baseline = siblingRenders
    setEditorCursor('a', snapshot(9, 7))
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('9:7'))
    expect(siblingRenders).toBe(baseline)
    expect(screen.getByTestId('probe').textContent).toBe('9:7')
  })

  it('returns an empty snapshot for unknown editors without crashing', () => {
    render(<Probe editorId="never-opened" />)
    expect(screen.getByTestId('probe').textContent).toBe('1:1')
  })
})
