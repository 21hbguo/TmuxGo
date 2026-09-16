import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalOutputInput } from './terminal-output-input'

function makeHarness(selection = '') {
  const pushed: string[] = []
  const terminal = { write: vi.fn(), getSelection: () => selection }
  const outputInput = createTerminalOutputInput({
    getTerminal: () => terminal,
    pushOutput: (data) => pushed.push(data),
    disposeOutput: vi.fn(),
    isDesktopImeComposing: () => false,
    isMobile: false,
    getHostId: () => 'local',
    getSessionName: () => 'main',
    controlCarryRef: { current: '' },
  })
  return { outputInput, pushed, terminal }
}

describe('createTerminalOutputInput selection hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('buffers output while a hold is armed during pointer sync', () => {
    const { outputInput, pushed } = makeHarness()
    outputInput.armPointerSync()
    outputInput.holdSelection()
    outputInput.handleOutput('tick-1')
    expect(pushed).toEqual([])
  })

  it('self-releases a hold that has no pointer and no selection', () => {
    const { outputInput, pushed } = makeHarness('')
    outputInput.holdSelection()
    outputInput.handleOutput('tick-1')
    expect(outputInput.isSelectionHoldActive()).toBe(false)
    expect(pushed).toEqual(['tick-1'])
  })

  it('releases the hold on pointer sync clear when nothing is selected', () => {
    const { outputInput, pushed } = makeHarness('')
    outputInput.armPointerSync()
    outputInput.holdSelection()
    outputInput.handleOutput('tick-1')
    outputInput.clearPointerSync()
    expect(outputInput.isSelectionHoldActive()).toBe(false)
    expect(pushed).toEqual(['tick-1'])
  })

  it('keeps the hold on pointer sync clear while text is still selected', () => {
    const { outputInput, pushed } = makeHarness('selected-text')
    outputInput.armPointerSync()
    outputInput.holdSelection()
    outputInput.handleOutput('tick-1')
    outputInput.clearPointerSync()
    expect(outputInput.isSelectionHoldActive()).toBe(true)
    expect(pushed).toEqual([])
    outputInput.releaseSelection()
    expect(pushed).toEqual(['tick-1'])
  })

  it('drops a stale pointer hold once the arm outlives the stale window', () => {
    const { outputInput, pushed } = makeHarness('')
    outputInput.armPointerSync()
    outputInput.holdSelection()
    outputInput.handleOutput('tick-1')
    vi.advanceTimersByTime(2400)
    outputInput.handleOutput('tick-2')
    expect(outputInput.isSelectionHoldActive()).toBe(false)
    expect(pushed).toEqual(['tick-1tick-2'])
  })

  it('survives an active pointer while the selection check window is fresh', () => {
    const { outputInput, pushed } = makeHarness('')
    outputInput.armPointerSync()
    outputInput.holdSelection()
    outputInput.handleOutput('tick-1')
    vi.advanceTimersByTime(900)
    outputInput.handleOutput('tick-2')
    expect(outputInput.isSelectionHoldActive()).toBe(true)
    expect(pushed).toEqual([])
  })
})
