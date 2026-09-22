import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalOutputInput } from './terminal-output-input'

function makeHarness(selection = '', overrides: Record<string, unknown> = {}) {
  const pushed: string[] = []
  const terminal = { write: vi.fn(), getSelection: () => selection }
  const disposeOutput = vi.fn()
  const outputInput = createTerminalOutputInput({
    getTerminal: () => terminal,
    pushOutput: (data) => pushed.push(data),
    disposeOutput,
    isDesktopImeComposing: () => false,
    isMobile: false,
    getHostId: () => 'local',
    getSessionName: () => 'main',
    controlCarryRef: { current: '' },
    ...overrides,
  })
  return { outputInput, pushed, terminal, disposeOutput }
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

describe('createTerminalOutputInput default direct write', () => {
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

  it('pushes output directly without touching writeBuffer when no hold is active', () => {
    const { outputInput, pushed } = makeHarness()
    outputInput.handleOutput('direct-1')
    outputInput.handleOutput('direct-2')
    expect(pushed).toEqual(['direct-1', 'direct-2'])
    expect(outputInput.hasWriteBuffered()).toBe(false)
    outputInput.flushWriteBuffer()
    expect(pushed).toEqual(['direct-1', 'direct-2'])
  })

  it('disposes prior output on resync then writes the new frame directly', () => {
    const { outputInput, pushed, disposeOutput } = makeHarness()
    outputInput.handleOutput({ data: 'snap', sessionName: 'main', hostId: 'local', resync: true })
    expect(disposeOutput).toHaveBeenCalledTimes(1)
    expect(pushed).toEqual(['snap'])
    expect(outputInput.hasWriteBuffered()).toBe(false)
  })

  it('still buffers during selection hold and never leaves residue after release', () => {
    const { outputInput, pushed } = makeHarness('selected')
    outputInput.holdSelection()
    outputInput.handleOutput('held')
    expect(pushed).toEqual([])
    expect(outputInput.hasWriteBuffered()).toBe(true)
    outputInput.releaseSelection()
    expect(pushed).toEqual(['held'])
    expect(outputInput.hasWriteBuffered()).toBe(false)
  })

  it('flushes switch hold as one atomic writeAtomic call', () => {
    const writeAtomic = vi.fn()
    const { outputInput, pushed } = makeHarness('', { writeAtomic })
    outputInput.beginSwitchHold()
    outputInput.handleOutput('frame-a')
    outputInput.handleOutput('frame-b')
    expect(pushed).toEqual([])
    expect(outputInput.hasWriteBuffered()).toBe(true)
    outputInput.flushSwitchHold('\x1b[3J\x1b[2J')
    expect(writeAtomic).toHaveBeenCalledTimes(1)
    expect(writeAtomic).toHaveBeenCalledWith('\x1b[3J\x1b[2Jframe-aframe-b')
    expect(pushed).toEqual([])
    expect(outputInput.hasWriteBuffered()).toBe(false)
    expect(outputInput.isSwitchHolding()).toBe(false)
  })

  it('falls back to pushOutput for switch flush when writeAtomic is absent', () => {
    const { outputInput, pushed } = makeHarness()
    outputInput.beginSwitchHold()
    outputInput.handleOutput('only-frame')
    outputInput.flushSwitchHold()
    expect(pushed).toEqual(['only-frame'])
  })
})
