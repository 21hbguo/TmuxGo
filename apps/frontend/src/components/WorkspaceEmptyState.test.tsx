import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toggleFilePanel = vi.fn()

vi.mock('@/stores/useConsoleStore', () => ({
  useConsoleStore: (selector: (state: { toggleFilePanel: () => void }) => unknown) => selector({ toggleFilePanel }),
}))

import { WorkspaceEmptyState } from './WorkspaceEmptyState'

describe('WorkspaceEmptyState', () => {
  beforeEach(() => toggleFilePanel.mockClear())

  it('renders the ready title and both guidance actions', () => {
    const { container } = render(<WorkspaceEmptyState dropActive={false} />)
    expect((container.firstElementChild as HTMLElement).className).toContain('tmuxgo-workspace-empty')
    expect(screen.getByText('workspace.empty.title')).toBeTruthy()
    expect(screen.getByRole('button', { name: /workspace.empty.browse/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /workspace.empty.newSession/ })).toBeTruthy()
  })

  it('switches to the drop copy while a file hovers the area', () => {
    render(<WorkspaceEmptyState dropActive />)
    expect(screen.getByText('workspace.empty.dropTitle')).toBeTruthy()
    expect(screen.queryByText('workspace.empty.title')).toBeNull()
  })

  it('opens the file panel instead of duplicating file logic', () => {
    render(<WorkspaceEmptyState dropActive={false} />)
    fireEvent.click(screen.getByRole('button', { name: /workspace.empty.browse/ }))
    expect(toggleFilePanel).toHaveBeenCalledTimes(1)
  })

  it('broadcasts the new-session command as a window event', () => {
    const listener = vi.fn()
    window.addEventListener('tmuxgo-new-session', listener)
    render(<WorkspaceEmptyState dropActive={false} />)
    fireEvent.click(screen.getByRole('button', { name: /workspace.empty.newSession/ }))
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('tmuxgo-new-session', listener)
  })
})
