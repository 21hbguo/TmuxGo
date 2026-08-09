import { render, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskNotifications } from './TaskNotifications'

const mocks = vi.hoisted(() => ({ tasks: [] as any[], pushToast: vi.fn(), invalidateQueries: vi.fn(), useSystemTasks: vi.fn() }))
const originalNotification = window.Notification
const originalMatchMedia = window.matchMedia

vi.mock('@/hooks/useApi', () => ({ useSystemTasks: (...args: unknown[]) => { mocks.useSystemTasks(...args); return { data: { tasks: mocks.tasks } } } }))
vi.mock('@/stores/useConsoleStore', () => ({ useConsoleStore: (selector: any) => selector({ pushToast: mocks.pushToast }) }))
vi.mock('@/hooks/useOptionalQueryClient', () => ({ useOptionalQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }))
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => key === 'tasks.notificationSuccess' ? `${params?.title} completed` : key === 'tasks.notificationFailed' ? `${params?.title} failed: ${params?.message}` : key }) }))
vi.mock('@/lib/api', () => ({ fetchApiBlob: vi.fn(async () => new Blob(['download'])) }))

function task(status: 'running' | 'success' | 'error', patch: Record<string, unknown> = {}) {
  return { id: 'git-push-1', type: 'git-push', title: 'Git Push', status, attempt: 1, errorMessage: null, ...patch }
}

describe('TaskNotifications', () => {
  beforeEach(() => {
    mocks.tasks = []
    mocks.pushToast.mockReset()
    mocks.invalidateQueries.mockReset()
    mocks.useSystemTasks.mockReset()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'Notification', { configurable: true, value: originalNotification })
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
  })
  it('does not notify for tasks completed before the initial load', () => {
    mocks.tasks = [task('success')]
    render(<TaskNotifications />)
    expect(mocks.pushToast).not.toHaveBeenCalled()
  })
  it('notifies newly completed tasks after the initial load', () => {
    mocks.tasks = []
    const view = render(<TaskNotifications />)
    mocks.tasks = [task('success')]
    view.rerender(<TaskNotifications />)
    expect(mocks.pushToast).toHaveBeenCalledWith({ type: 'success', message: 'Git Push completed' })
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['git-status'] })
    expect(mocks.useSystemTasks).toHaveBeenCalledWith(true, true)
  })
  it('shows the task error when a task fails', () => {
    mocks.tasks = [task('running')]
    const view = render(<TaskNotifications />)
    mocks.tasks = [task('error', { errorMessage: 'Permission denied' })]
    view.rerender(<TaskNotifications />)
    expect(mocks.pushToast).toHaveBeenCalledWith({ type: 'error', message: 'Git Push failed: Permission denied' })
  })
  it('refreshes host diagnostics when a host test finishes', () => {
    mocks.tasks = [task('running', { type: 'host-test', title: 'Test host edge' })]
    const view = render(<TaskNotifications />)
    mocks.tasks = [task('success', { type: 'host-test', title: 'Test host edge' })]
    view.rerender(<TaskNotifications />)
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hosts'] })
  })
  it('starts the prepared download after a download task succeeds', async () => {
    const appendChild = vi.spyOn(document.body, 'appendChild')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mocks.tasks = [task('running', { type: 'file-download' })]
    const view = render(<TaskNotifications />)
    mocks.tasks = [task('success', { type: 'file-download', title: 'Download demo.txt', result: { downloadUrl: '/api/hosts/local/files/download-tasks/00000000-0000-4000-8000-000000000000', fileName: 'demo.txt' } })]
    view.rerender(<TaskNotifications />)
    let anchor: HTMLAnchorElement | undefined
    await waitFor(() => {
      anchor = appendChild.mock.calls.find(([element]) => element instanceof HTMLAnchorElement)?.[0] as HTMLAnchorElement | undefined
      expect(anchor).toBeDefined()
    })
    expect(anchor?.href).toMatch(/^blob:/)
    expect(anchor?.download).toBe('demo.txt')
    expect(click).toHaveBeenCalled()
  })
  it('uses a browser notification while the page is hidden', () => {
    const close = vi.fn()
    const browserNotification = vi.fn(function (this: any) { this.close = close }) as any
    browserNotification.permission = 'granted'
    Object.defineProperty(window, 'Notification', { configurable: true, value: browserNotification })
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true })) })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    mocks.tasks = [task('running')]
    const view = render(<TaskNotifications />)
    mocks.tasks = [task('success')]
    view.rerender(<TaskNotifications />)
    expect(browserNotification).toHaveBeenCalledWith('tasks.title', { body: 'Git Push completed', tag: 'task:git-push-1:1' })
  })
})
