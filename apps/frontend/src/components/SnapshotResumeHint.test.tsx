import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotResumeHint } from './SnapshotResumeHint'
import { api } from '@/lib/api'

// 用真 zh 词表断言文案：入口是「提示恢复路径」，措辞不能被悄悄改营销
vi.mock('@/i18n', async () => {
  const { zh } = await import('@/i18n/zh')
  return {
    useTranslation: () => ({
      language: 'zh',
      t: (key: string, params?: Record<string, string | number>) => {
        let text = (zh as Record<string, string>)[key] ?? key
        if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v))
        return text
      },
    }),
  }
})

// 弹层内部自己会再取一次列表 + 详情，这里只需要它能挂载
vi.mock('@/lib/api', () => ({
  api: {
    sessionSnapshots: {
      list: vi.fn(),
      get: vi.fn(),
      capture: vi.fn(),
      restore: vi.fn(),
      remove: vi.fn(),
    },
  },
}))

const summary = (id: string) => ({
  kind: 'tmuxgo.session-snapshot' as const,
  version: 1 as const,
  id,
  hostId: 'local',
  sessionId: 'session-local-work',
  sessionName: 'work',
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-27T10:00:00.000Z',
  stats: { paneCount: 2, tailLines: 200, bytes: 15400 },
  degraded: [] as string[],
})

function renderHint() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SnapshotResumeHint hostId="local" />
    </QueryClientProvider>,
  )
}

describe('SnapshotResumeHint', () => {
  beforeEach(() => {
    vi.mocked(api.sessionSnapshots.list).mockReset()
    vi.mocked(api.sessionSnapshots.get).mockReset()
  })

  it('renders nothing when the host has no snapshots', async () => {
    vi.mocked(api.sessionSnapshots.list).mockResolvedValue({ snapshots: [] })
    const { container } = renderHint()
    await waitFor(() => expect(api.sessionSnapshots.list).toHaveBeenCalledWith('local'))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the snapshot list fails (empty state stays quiet)', async () => {
    vi.mocked(api.sessionSnapshots.list).mockRejectedValue(new Error('boom'))
    const { container } = renderHint()
    await waitFor(() => expect(api.sessionSnapshots.list).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the snapshot count and opens the existing dialog on click', async () => {
    vi.mocked(api.sessionSnapshots.list).mockResolvedValue({
      snapshots: [summary('snap-1'), summary('snap-2')],
    })
    renderHint()
    const entry = await screen.findByTestId('snapshot-resume-hint')
    expect(entry).toHaveTextContent('最近快照 2 个 · 恢复布局')
    await userEvent.click(entry)
    // 复用现成弹层：进入后能看到快照标题与恢复红线说明
    expect(await screen.findByTestId('session-snapshots-dialog')).toBeInTheDocument()
    expect(screen.getByText('会话快照')).toBeInTheDocument()
  })

  it('re-reads the count after the dialog closes so the entry never shows a stale number', async () => {
    vi.mocked(api.sessionSnapshots.list)
      .mockResolvedValueOnce({ snapshots: [summary('snap-1')] })
      .mockResolvedValueOnce({ snapshots: [summary('snap-1')] })
      .mockResolvedValue({ snapshots: [] })
    renderHint()
    await userEvent.click(await screen.findByTestId('snapshot-resume-hint'))
    const dialog = await screen.findByTestId('session-snapshots-dialog')
    await userEvent.click(dialog)
    await waitFor(() => expect(screen.queryByTestId('session-snapshots-dialog')).not.toBeInTheDocument())
    // 快照在弹层里被删掉后，入口应随之消失
    await waitFor(() => expect(screen.queryByTestId('snapshot-resume-hint')).not.toBeInTheDocument())
  })
})
