import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneSearchPanel } from './PaneSearchPanel'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'

const run = vi.fn()
const jump = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    paneSearch: { run: (...args: unknown[]) => run(...args) },
  },
}))
vi.mock('@/lib/pane-search-jump', () => ({
  jumpToPaneSearchHit: (...args: unknown[]) => jump(...args),
}))

const hit = {
  paneId: 'local:%3',
  windowIndex: 0,
  paneIndex: 2,
  paneTitle: 'claude',
  windowName: 'work',
  line: 12,
  lineFromEnd: 8,
  preview: 'error: build failed',
  historySize: 400,
}

function renderPanel() {
  const onClose = vi.fn()
  render(
    <I18nProvider>
      <PaneSearchPanel onClose={onClose} />
    </I18nProvider>,
  )
  return { onClose }
}

describe('PaneSearchPanel', () => {
  beforeEach(() => {
    run.mockReset()
    jump.mockReset()
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'session-dev' })
  })

  it('renders hits with pane coordinates and previews', async () => {
    run.mockResolvedValue({
      ok: true,
      query: 'fail',
      mode: 'literal',
      maxLines: 1000,
      hits: [hit],
      panes: [{ paneId: 'local:%3', hits: 1, capturedLines: 1000, cached: false }],
      truncated: false,
      elapsedMs: 12,
    })
    renderPanel()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'fail' } })
    // 防抖 250ms 后才发请求
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(run.mock.calls[0][2]).toMatchObject({ query: 'fail', lines: 1000 })
    const item = await screen.findByText('error: build failed')
    expect(item).toBeTruthy()
    // 1 起显示 window:pane 与「距末尾行数」
    expect(screen.getByText(/1:3 claude/)).toBeTruthy()
    expect(screen.getByText(/距末尾 8 行/)).toBeTruthy()
  })

  it('jumps to the selected hit on click and closes the panel', async () => {
    run.mockResolvedValue({
      ok: true,
      query: 'fail',
      mode: 'literal',
      maxLines: 1000,
      hits: [hit],
      panes: [],
      truncated: false,
      elapsedMs: 9,
    })
    jump.mockResolvedValue({ scrolled: true })
    const { onClose } = renderPanel()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'fail' } })
    const item = await screen.findByText('error: build failed')
    fireEvent.click(item)
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(1))
    expect(jump.mock.calls[0][1]).toEqual({ lineFromEnd: 8 })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows the empty state instead of firing a request for blank input', async () => {
    renderPanel()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(run).not.toHaveBeenCalled()
  })
})
