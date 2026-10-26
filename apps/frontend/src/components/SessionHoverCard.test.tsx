import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '@/types'
import { SessionHoverCard } from './SessionHoverCard'

const getSnapshot = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { snapshot: { get: (hostId: string, sessionId: string) => getSnapshot(hostId, sessionId) } },
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      key === 'sessionHover.summary' ? `${vars?.windows}w/${vars?.panes}p` : key,
  }),
}))

const snapshot: SessionSnapshot = {
  sessionId: 'session-a',
  sessionName: 'tmuxgo-work',
  windows: [
    { id: 'win-1', sessionId: 'session-a', index: 0, name: 'editor', active: true },
    { id: 'win-2', sessionId: 'session-a', index: 1, name: 'logs', active: false },
  ],
  panes: [
    {
      id: 'pane-1',
      windowId: 'win-1',
      index: 0,
      title: 'devin',
      active: true,
      size: { cols: 80, rows: 24 },
      agentStatus: 'working',
    },
    { id: 'pane-2', windowId: 'win-2', index: 0, title: 'tail -f app.log', active: true, size: { cols: 80, rows: 24 } },
  ],
  activeWindowId: 'win-1',
  activePaneId: 'pane-1',
}

const anchorRect = { top: 40, bottom: 72, left: 0, right: 240, width: 240, height: 32 } as DOMRect

function renderCard(props: Partial<React.ComponentProps<typeof SessionHoverCard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SessionHoverCard
        hostId="local"
        sessionId="session-a"
        sessionName="tmuxgo-work"
        anchorRect={anchorRect}
        {...props}
      />
    </QueryClientProvider>,
  )
}

const cardElement = (client: QueryClient, props: Partial<React.ComponentProps<typeof SessionHoverCard>> = {}) => (
  <QueryClientProvider client={client}>
    <SessionHoverCard
      hostId="local"
      sessionId="session-a"
      sessionName="tmuxgo-work"
      anchorRect={anchorRect}
      {...props}
    />
  </QueryClientProvider>
)

function renderCardWith(client: QueryClient, props: Partial<React.ComponentProps<typeof SessionHoverCard>> = {}) {
  return render(cardElement(client, props))
}

describe('SessionHoverCard', () => {
  afterEach(() => {
    getSnapshot.mockReset()
  })

  it('stays closed until the hover delay elapses, then lazily fetches and renders the tree', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    renderCard()
    // 划过不触发：延迟窗口内既无卡片也无请求
    expect(screen.queryByTestId('session-hover-card')).toBeNull()
    expect(getSnapshot).not.toHaveBeenCalled()

    expect(await screen.findByTestId('session-hover-card')).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledWith('local', 'session-a')
    expect(screen.getByTestId('session-hover-card-name').textContent).toBe('tmuxgo-work')
    expect(screen.getByText('2w/2p')).toBeInTheDocument()
    expect(screen.getByText('editor')).toBeInTheDocument()
    expect(screen.getByText('tail -f app.log')).toBeInTheDocument()
  })

  it('closes after the leave grace period and cancels closing when the pointer enters the card', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    const card = renderCard()
    const element = await screen.findByTestId('session-hover-card')

    // 移入卡片 → 取消宽限关闭
    fireEvent.mouseEnter(element)
    card.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionHoverCard hostId="local" sessionId="session-a" sessionName="tmuxgo-work" anchorRect={null} />
      </QueryClientProvider>,
    )
    expect(screen.queryByTestId('session-hover-card')).not.toBeNull()

    // 真正移出卡片 → 宽限后关闭
    fireEvent.mouseLeave(element)
    await waitFor(() => expect(screen.queryByTestId('session-hover-card')).toBeNull())
  })

  it('waits out the hover delay before showing and fetching', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    renderCard()
    // 延迟窗口内保持静默（迟滞阈值 > 250ms，划过列表不该弹）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(screen.queryByTestId('session-hover-card')).toBeNull()
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(await screen.findByTestId('session-hover-card')).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending open when the pointer leaves before the delay', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = renderCardWith(client)
    view.rerender(cardElement(client, { anchorRect: null }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(screen.queryByTestId('session-hover-card')).toBeNull()
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('renders loading and error states without a snapshot', async () => {
    getSnapshot.mockReturnValue(new Promise(() => {}))
    const first = renderCard()
    expect(await screen.findByText('sessionHover.loading')).toBeInTheDocument()
    first.unmount()

    getSnapshot.mockRejectedValue(new Error('snapshot failed'))
    renderCard()
    expect(await screen.findByText('sessionHover.error')).toBeInTheDocument()
  })

  it('shows an empty hint for a session without windows', async () => {
    getSnapshot.mockResolvedValue({ ...snapshot, windows: [], panes: [], activeWindowId: null, activePaneId: null })
    renderCard()
    expect(await screen.findByText('sessionHover.noWindows')).toBeInTheDocument()
    expect(screen.getByText('0w/0p')).toBeInTheDocument()
  })

  it('reuses the cached snapshot when hovered again', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = renderCardWith(client)
    await screen.findByTestId('session-hover-card')
    // 离开 → 宽限关闭
    view.rerender(cardElement(client, { anchorRect: null }))
    await waitFor(() => expect(screen.queryByTestId('session-hover-card')).toBeNull())
    // 再次 hover：命中 react-query 缓存，不再打一次 api
    view.rerender(cardElement(client, { anchorRect }))
    await screen.findByTestId('session-hover-card')
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and reports it to the caller', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    const onClose = vi.fn()
    renderCard({ onClose })
    await screen.findByTestId('session-hover-card')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('session-hover-card')).toBeNull())
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on outside pointer down and on page scroll', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    const outside = renderCard()
    await screen.findByTestId('session-hover-card')
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('session-hover-card')).toBeNull())
    outside.unmount()

    renderCard()
    await screen.findByTestId('session-hover-card')
    // 侧栏滚动容器滚动（window 上 capture 监听）：锚点失效即关
    const scroller = document.createElement('div')
    document.body.appendChild(scroller)
    fireEvent.scroll(scroller)
    scroller.remove()
    await waitFor(() => expect(screen.queryByTestId('session-hover-card')).toBeNull())
  })

  it('keeps the card open while the pointer is inside it', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = renderCardWith(client)
    const element = await screen.findByTestId('session-hover-card')
    // 行上移出（anchorRect=null）但指针已进入卡片 → 宽限期被取消
    view.rerender(cardElement(client, { anchorRect: null }))
    fireEvent.mouseEnter(element)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(screen.queryByTestId('session-hover-card')).not.toBeNull()
  })

  it('places the card next to the anchor row', async () => {
    getSnapshot.mockResolvedValue(snapshot)
    renderCard()
    const element = await screen.findByTestId('session-hover-card')
    // 右放得下（jsdom 量不到宽度）：贴行右侧
    await waitFor(() => expect(element.style.left).toBe('248px'))
    expect(element.style.top).toBe('40px')
  })
})
