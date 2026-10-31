import { act, render } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCustomShortcuts, type CustomShortcut } from './useCustomShortcuts'

const getMock = vi.fn()
const updateMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    preferences: {
      get: (...args: unknown[]) => getMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}))

let firstHook: ReturnType<typeof useCustomShortcuts> | null = null
let secondHook: ReturnType<typeof useCustomShortcuts> | null = null

function ShortcutProbe({ slot }: { slot: 'first' | 'second' }) {
  const hook = useCustomShortcuts()
  if (slot === 'first') firstHook = hook
  else secondHook = hook
  return React.createElement('div')
}

describe('useCustomShortcuts same-page sync', () => {
  beforeEach(() => {
    localStorage.clear()
    firstHook = null
    secondHook = null
    getMock.mockReset()
    updateMock.mockReset()
    getMock.mockResolvedValue({ customShortcuts: [], customShortcutsUpdatedAt: '' })
    updateMock.mockResolvedValue({})
  })

  it('updates the mobile dock instance after another instance adds a shortcut', async () => {
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ShortcutProbe, { slot: 'first' }),
        React.createElement(ShortcutProbe, { slot: 'second' }),
      ),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      firstHook?.addShortcut({ label: 'Status', mode: 'text', text: 'echo ok', appendEnter: true })
    })
    const shortcut = secondHook?.shortcuts[0] as CustomShortcut | undefined
    expect(shortcut).toMatchObject({ label: 'Status', mode: 'text', text: 'echo ok', appendEnter: true })
  })

  it('imports bundles in merge mode and skips duplicates by label plus steps', async () => {
    render(React.createElement(ShortcutProbe, { slot: 'first' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      firstHook?.addShortcut({ label: 'A', steps: [{ type: 'keys', keys: 'Ctrl+A' }] })
    })
    let result: { added: number; skipped: number } | undefined
    await act(async () => {
      result = firstHook?.importShortcuts(
        [
          { label: 'A', steps: [{ type: 'keys', keys: 'ctrl+a' }] },
          { label: 'B', steps: [{ type: 'text', text: 'ls', appendEnter: true }] },
        ],
        'merge',
      )
    })
    expect(result).toEqual({ added: 1, skipped: 1 })
    expect(firstHook?.shortcuts.map((item) => item.label)).toEqual(['A', 'B'])
    expect(firstHook?.shortcuts.every((item) => item.id)).toBe(true)
  })

  it('replaces the whole list when importing in replace mode', async () => {
    render(React.createElement(ShortcutProbe, { slot: 'first' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      firstHook?.addShortcut({ label: 'old', steps: [{ type: 'keys', keys: 'Ctrl+Z' }] })
    })
    await act(async () => {
      firstHook?.importShortcuts([{ label: 'only', steps: [{ type: 'keys', keys: 'Ctrl+Y' }] }], 'replace')
    })
    expect(firstHook?.shortcuts.map((item) => item.label)).toEqual(['only'])
  })
})
