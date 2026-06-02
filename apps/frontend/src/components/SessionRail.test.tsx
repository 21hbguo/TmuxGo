import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SessionRail } from './SessionRail'

const setActiveSession = vi.fn()
const setSessionPanelExpanded = vi.fn()
const pushToast = vi.fn()
const prompt = vi.fn(async () => null)

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: ((selector?: any) => {
    const state = {
      activeSessionId: 'session-a',
      activeHostId: 'local',
      setActiveSession,
      pushToast,
      setSessionPanelExpanded,
    }
    return typeof selector === 'function' ? selector(state) : state
  }) as any,
}))
vi.mock('@/hooks/useOrderedSessions', () => ({
  useOrderedSessions: () => ({
    data: [
      { id: 'session-a', name: 'alpha', windowCount: 1 },
      { id: 'session-b', name: 'beta', windowCount: 2 },
    ],
    moveSession: vi.fn(),
  }),
}))
vi.mock('@/hooks/useApi', () => ({
  useCreateSession: () => ({ mutateAsync: vi.fn() }),
  useRenameSession: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('./SessionTemplates', () => ({
  SessionTemplates: () => null,
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string, vars?: any) => key === 'sidebar.windows' ? `${vars?.count ?? 0} windows` : key }),
}))
vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: () => ({ prompt, PromptElement: null }),
}))

describe('SessionRail', () => {
  it('activates another session from compact rail', async () => {
    render(React.createElement(SessionRail))
    fireEvent.click(screen.getByText('beta'))
    expect(setActiveSession).toHaveBeenCalledWith('session-b')
  })
})
