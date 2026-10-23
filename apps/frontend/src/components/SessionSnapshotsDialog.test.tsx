import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSnapshotsDialog } from './SessionSnapshotsDialog'
import { api } from '@/lib/api'

// 用真 zh 词表断言文案（含「历史回显」这类不可过度承诺的表述）
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

const summary = {
  kind: 'tmuxgo.session-snapshot' as const,
  version: 1 as const,
  id: 'snap-1',
  hostId: 'local',
  sessionId: 'session-local-work',
  sessionName: 'work',
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-27T10:00:00.000Z',
  stats: { paneCount: 2, tailLines: 200, bytes: 15400 },
  degraded: [] as string[],
}

const detail = {
  ...summary,
  layout: { kind: 'tmuxgo.session-layout', version: 1, name: 'work', windows: [] },
  panes: [
    {
      tmuxPaneId: '%0',
      windowIndex: 0,
      paneIndex: 0,
      title: 'nvim',
      cwd: '/repo/app',
      command: 'nvim',
      inMode: false,
      scrollbackTail: 'old build output\n',
    },
    {
      tmuxPaneId: '%1',
      windowIndex: 0,
      paneIndex: 1,
      title: 'shell',
      cwd: '/repo/app',
      command: 'zsh',
      inMode: true,
      scrollbackTail: '',
    },
  ],
}

const onClose = vi.fn()

function renderDialog(overrides: Partial<Parameters<typeof SessionSnapshotsDialog>[0]> = {}) {
  return render(
    <SessionSnapshotsDialog
      open
      onClose={onClose}
      hostId="local"
      activeSessionId="session-local-work"
      {...overrides}
    />,
  )
}

describe('SessionSnapshotsDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    onClose.mockClear()
    vi.spyOn(api.sessionSnapshots, 'list').mockResolvedValue({ snapshots: [summary] })
    vi.spyOn(api.sessionSnapshots, 'get').mockResolvedValue(detail)
    vi.spyOn(api.sessionSnapshots, 'capture').mockResolvedValue(detail)
    vi.spyOn(api.sessionSnapshots, 'restore').mockResolvedValue({
      sessionName: 'work',
      restoredFrom: 'snap-1',
      paneCount: 2,
      panes: detail.panes,
      degraded: [],
    })
    vi.spyOn(api.sessionSnapshots, 'remove').mockResolvedValue({ ok: true })
  })

  it('lists snapshots for the host and loads details on click', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('snapshot-item-snap-1')).toBeTruthy())
    expect(screen.getByTestId('snapshot-item-snap-1').textContent).toContain('work')
    expect(screen.getByTestId('snapshot-item-snap-1').textContent).toContain('2 pane')
    fireEvent.click(screen.getByTestId('snapshot-item-snap-1'))
    await waitFor(() => expect(api.sessionSnapshots.get).toHaveBeenCalledWith('local', 'snap-1'))
    // 尾部内容标成历史回显，不能看起来像可交互的终端
    expect(screen.getByTestId('snapshot-tail-0').textContent).toBe('old build output\n')
    expect(screen.getAllByText('历史回显').length).toBe(2)
    expect(screen.getByTestId('snapshot-tail-1').textContent).toContain('快照里没有尾部内容')
  })

  it('states that restore does not revive processes', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('session-snapshots-dialog')).toBeTruthy())
    expect(screen.getByTestId('session-snapshots-dialog').textContent).toContain('进程不会复活')
  })

  it('restores the selected snapshot, forwarding the replace flag', async () => {
    const onRestored = vi.fn()
    renderDialog({ onRestored })
    await waitFor(() => expect(screen.getByTestId('snapshot-item-snap-1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('snapshot-item-snap-1'))
    await waitFor(() => expect(screen.getByTestId('snapshot-replace')).toBeTruthy())
    fireEvent.click(screen.getByTestId('snapshot-replace'))
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(api.sessionSnapshots.restore).toHaveBeenCalledWith('local', 'snap-1', { replace: true }))
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith('work'))
    expect(onClose).toHaveBeenCalled()
  })

  it('captures the active session and shows the new detail', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '快照当前会话' }))
    await waitFor(() => expect(api.sessionSnapshots.capture).toHaveBeenCalledWith('local', 'session-local-work'))
    await waitFor(() => expect(screen.getByTestId('snapshot-tail-0')).toBeTruthy())
  })

  it('disables capture without an active session and deletes snapshots', async () => {
    renderDialog({ activeSessionId: null })
    await waitFor(() => expect(screen.getByTestId('snapshot-item-snap-1')).toBeTruthy())
    expect((screen.getByRole('button', { name: '快照当前会话' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('删除快照'))
    await waitFor(() => expect(api.sessionSnapshots.remove).toHaveBeenCalledWith('local', 'snap-1'))
  })

  it('surfaces degraded capture warnings', async () => {
    vi.spyOn(api.sessionSnapshots, 'get').mockResolvedValue({ ...detail, degraded: ['scrollback'] })
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('snapshot-item-snap-1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('snapshot-item-snap-1'))
    await waitFor(() => expect(screen.getByTestId('snapshot-degraded').textContent).toContain('scrollback'))
  })
})
