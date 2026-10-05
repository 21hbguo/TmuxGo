import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { AgentRecoveryBadge } from './AgentRecovery'
import { I18nProvider } from '@/i18n'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { AgentRecoveryCandidate } from '@/types'

const resumeMock = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    agentRecovery: {
      list: vi.fn(async () => ({ version: 1, candidates: [] })),
      resume: (...args: any[]) => resumeMock(...args),
    },
  },
}))

const candidate = (overrides: Partial<AgentRecoveryCandidate> = {}): AgentRecoveryCandidate => ({
  id: 'c1',
  hostId: 'local',
  sessionName: 'dev',
  paneId: 'local:%5',
  tmuxPaneId: '%5',
  agent: 'claude',
  agentSessionId: 'sess-1',
  reason: 'pane_exited',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  resumable: true,
  occupant: 'shell',
  ...overrides,
})

const renderBadge = (candidates: AgentRecoveryCandidate[] | undefined, onResumed = vi.fn()) =>
  render(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AgentRecoveryBadge, { hostId: 'local', candidates, onResumed }),
    ),
  )
const badgeButton = () => screen.findByRole('button', { name: '可恢复的 Agent' })
const lastResumeButton = async () => {
  const buttons = await screen.findAllByRole('button', { name: '恢复' })
  return buttons[buttons.length - 1]
}

beforeEach(() => {
  resumeMock.mockReset()
})
afterEach(cleanup)

describe('AgentRecoveryBadge', () => {
  it('renders nothing when there are no pending candidates', () => {
    const { container } = renderBadge(undefined)
    expect(container.textContent).toBe('')
    const { container: empty } = renderBadge([])
    expect(empty.textContent).toBe('')
  })
  it('shows the pending candidate count and lists block reasons', async () => {
    renderBadge([candidate(), candidate({ id: 'c2', resumable: false, blockReason: 'pane_occupied' })])
    const badge = await badgeButton()
    expect(badge.textContent).toContain('2')
    fireEvent.click(badge)
    expect(await screen.findByText(/Pane 被占用/)).toBeTruthy()
    const resumeButtons = await screen.findAllByRole('button', { name: '恢复' })
    expect((resumeButtons[1] as HTMLButtonElement).disabled).toBe(true)
  })
  it('sends pane and session identity on explicit resume confirm', async () => {
    resumeMock.mockResolvedValue({ ok: true, paneId: 'local:%5', command: 'claude --resume sess-1' })
    const pushToast = vi.fn()
    const onResumed = vi.fn()
    useConsoleStore.setState({ pushToast, toasts: [] })
    renderBadge([candidate()], onResumed)
    fireEvent.click(await badgeButton())
    // 行内 恢复 → 确认弹窗里的同名按钮
    fireEvent.click((await screen.findAllByRole('button', { name: '恢复' }))[0])
    fireEvent.click(await lastResumeButton())
    await waitFor(() =>
      expect(resumeMock).toHaveBeenCalledWith('local', 'c1', { paneId: 'local:%5', agentSessionId: 'sess-1' }),
    )
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })))
    expect(onResumed).toHaveBeenCalled()
  })
  it('offers resume-to-active-pane even when the origin pane is blocked', async () => {
    resumeMock.mockResolvedValue({ ok: true, paneId: 'local:%5', tmuxPaneId: '%9', command: 'claude --resume sess-1' })
    const pushToast = vi.fn()
    const onResumed = vi.fn()
    useConsoleStore.setState({ pushToast, toasts: [] })
    // 原 pane 被占（pane_occupied）只禁「恢复」，不禁「当前面板」
    renderBadge([candidate({ resumable: false, blockReason: 'pane_occupied' })], onResumed)
    fireEvent.click(await badgeButton())
    const originButton = (await screen.findAllByRole('button', { name: '恢复' }))[0] as HTMLButtonElement
    expect(originButton.disabled).toBe(true)
    const activeButton = (await screen.findByRole('button', { name: '当前面板' })) as HTMLButtonElement
    expect(activeButton.disabled).toBe(false)
    fireEvent.click(activeButton)
    fireEvent.click(await lastResumeButton())
    await waitFor(() =>
      expect(resumeMock).toHaveBeenCalledWith('local', 'c1', {
        paneId: 'local:%5',
        agentSessionId: 'sess-1',
        targetMode: 'active',
      }),
    )
    expect(onResumed).toHaveBeenCalled()
  })
  it('disables resume-to-active-pane on hard blocks without a session id', async () => {
    renderBadge([candidate({ agentSessionId: undefined, resumable: false, blockReason: 'missing_session_id' })])
    fireEvent.click(await badgeButton())
    const activeButton = (await screen.findByRole('button', { name: '当前面板' })) as HTMLButtonElement
    expect(activeButton.disabled).toBe(true)
  })
  it('reports resume failure without silently retrying', async () => {
    resumeMock.mockRejectedValue(new Error('pane occupied'))
    const pushToast = vi.fn()
    useConsoleStore.setState({ pushToast, toasts: [] })
    renderBadge([candidate()])
    fireEvent.click(await badgeButton())
    fireEvent.click((await screen.findAllByRole('button', { name: '恢复' }))[0])
    fireEvent.click(await lastResumeButton())
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'pane occupied' })),
    )
    expect(resumeMock).toHaveBeenCalledTimes(1)
  })
})
