import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalSearch } from './TerminalSearch'
import { I18nProvider } from '@/i18n'
import { registerSearchAddon } from '@/lib/terminal-search-addon'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'

// 组件只允许走公开 addon API：registry 里塞一个假 addon，断言调用形状
function createFakeAddon() {
  const listeners: Array<(event: { resultIndex: number; resultCount: number }) => void> = []
  const addon = {
    findNext: vi.fn((_term: string, _options?: Record<string, unknown>) => true),
    findPrevious: vi.fn((_term: string, _options?: Record<string, unknown>) => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((listener: (event: { resultIndex: number; resultCount: number }) => void) => {
      listeners.push(listener)
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }
    }),
    emitResults: (event: { resultIndex: number; resultCount: number }) => listeners.forEach((l) => l(event)),
  }
  return addon
}

function setup() {
  const fake = createFakeAddon()
  const terminal = { clearSelection: vi.fn() } as unknown as Terminal
  registerSearchAddon(terminal, fake as unknown as SearchAddon)
  const onClose = vi.fn()
  render(
    <I18nProvider>
      <TerminalSearch terminal={terminal} onClose={onClose} />
    </I18nProvider>,
  )
  return { fake, terminal, onClose }
}

describe('TerminalSearch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drives findNext through the public addon API with decorations', async () => {
    const { fake } = setup()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'foo' } })
    await waitFor(() => expect(fake.findNext).toHaveBeenCalled())
    const [term, options] = fake.findNext.mock.calls[0]
    expect(term).toBe('foo')
    expect(options).toMatchObject({
      incremental: true,
      decorations: expect.objectContaining({ matchBackground: expect.any(String) }),
    })
  })

  it('navigates with Enter / Shift+Enter and shows the match counter', async () => {
    const { fake } = setup()
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'foo' } })
    act(() => fake.emitResults({ resultIndex: 0, resultCount: 3 }))
    await waitFor(() => expect(screen.getByTestId('terminal-search-counter').textContent).toBe('1/3'))

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(fake.findNext).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(fake.findPrevious).toHaveBeenCalledTimes(1)

    act(() => fake.emitResults({ resultIndex: -1, resultCount: 3 }))
    await waitFor(() => expect(screen.getByTestId('terminal-search-counter').textContent).toBe('3+'))
  })

  it('reports no results and clears highlight + selection on close', async () => {
    const { fake, terminal, onClose } = setup()
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'zzz' } })
    act(() => fake.emitResults({ resultIndex: -1, resultCount: 0 }))
    await waitFor(() => expect(screen.getByTestId('terminal-search-counter').textContent).toBe('无匹配'))

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(fake.clearDecorations).toHaveBeenCalled()
    expect(terminal.clearSelection).toHaveBeenCalled()
  })

  it('clears the highlight without issuing a search when the query is emptied', async () => {
    const { fake, terminal } = setup()
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'foo' } })
    fake.findNext.mockClear()
    fireEvent.change(input, { target: { value: '' } })
    expect(fake.findNext).not.toHaveBeenCalled()
    expect(fake.clearDecorations).toHaveBeenCalled()
    expect(terminal.clearSelection).toHaveBeenCalled()
  })
})
