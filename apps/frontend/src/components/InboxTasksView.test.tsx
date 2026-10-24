import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxTasksView } from './InboxTasksView'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { AgentTodoQueue } from '@/lib/api'

const apiMocks = vi.hoisted(() => ({ tasks: vi.fn(), clearDoneTasks: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { agentNotifications: { tasks: apiMocks.tasks, clearDoneTasks: apiMocks.clearDoneTasks } },
}))

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}(${JSON.stringify(params)})` : key) as never

const doneItem = {
  id: 'n1',
  eventId: 'n1',
  hostId: 'local',
  sessionName: 'dev',
  paneId: 'local:%1',
  agent: 'claude',
  status: 'done' as const,
  message: 'claude completed a turn',
  timestamp: '2026-01-01T00:00:00.000Z',
  readBy: [],
  kind: 'todo' as const,
  todoState: 'done' as const,
}
const queue = (overrides: Partial<AgentTodoQueue> = {}): AgentTodoQueue => ({
  blocked: [],
  pending: [],
  done: [doneItem],
  counts: { blocked: 0, pending: 0, done: 1 },
  ...overrides,
})

const pushToast = vi.fn()
beforeEach(() => {
  useConsoleStore.setState({ pushToast })
  pushToast.mockReset()
  apiMocks.tasks.mockReset()
  apiMocks.clearDoneTasks.mockReset()
  apiMocks.tasks.mockResolvedValue(queue())
  apiMocks.clearDoneTasks.mockResolvedValue({ ok: true, removed: 3, hosts: ['local'], tasksBlocked: 0 })
})
afterEach(cleanup)

describe('InboxTasksView clear-done', () => {
  it('only calls the API after the confirmation is accepted', async () => {
    render(<InboxTasksView t={t} />)
    const open = await screen.findByRole('button', { name: 'inbox.tasksClearDone' })
    act(() => open.click())
    // 点了按钮只是弹确认，绝不能已经把 done 删了
    expect(apiMocks.clearDoneTasks).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('button', { name: 'inbox.tasksClearDoneConfirm' })
    act(() => confirm.click())
    await waitFor(() => expect(apiMocks.clearDoneTasks).toHaveBeenCalledTimes(1))
  })

  it('reloads the queue and reports how many were removed', async () => {
    render(<InboxTasksView t={t} />)
    const open = await screen.findByRole('button', { name: 'inbox.tasksClearDone' })
    act(() => open.click())
    act(() => screen.getByRole('button', { name: 'inbox.tasksClearDoneConfirm' }).click())
    await waitFor(() => expect(apiMocks.tasks).toHaveBeenCalledTimes(2))
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringContaining('"count":3') }),
    )
  })

  it('hides the action when the done section is empty', async () => {
    apiMocks.tasks.mockResolvedValue(queue({ done: [], counts: { blocked: 0, pending: 0, done: 0 } }))
    render(<InboxTasksView t={t} />)
    expect((await screen.findAllByText('inbox.tasksEmpty')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'inbox.tasksClearDone' })).toBeNull()
  })

  it('surfaces a failure instead of silently dropping it', async () => {
    apiMocks.clearDoneTasks.mockRejectedValue(new Error('boom'))
    render(<InboxTasksView t={t} />)
    const open = await screen.findByRole('button', { name: 'inbox.tasksClearDone' })
    act(() => open.click())
    act(() => screen.getByRole('button', { name: 'inbox.tasksClearDoneConfirm' }).click())
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })))
  })
})
