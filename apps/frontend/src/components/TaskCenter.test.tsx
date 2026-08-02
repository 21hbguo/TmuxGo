import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskCenter } from './TaskCenter'

const cancelTask=vi.fn()
const retryTask=vi.fn()
const tasks=[{ id:'restart-rebuild', type:'restart-rebuild', title:'Restart + Rebuild', status:'running' as const, startedAt:'2026-08-02T00:00:00.000Z', finishedAt:null, summaryLines:['Starting...'], exitCode:null, errorMessage:null, cancellable:true, retryable:false }]

vi.mock('@/hooks/useApi', () => ({
  useSystemTasks: () => ({ data:{tasks}, isLoading:false }),
  useCancelSystemTask: () => ({ mutateAsync:cancelTask, isPending:false }),
  useRetrySystemTask: () => ({ mutateAsync:retryTask, isPending:false }),
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t:(key:string) => ({
    'tasks.title':'Tasks',
    'tasks.cancel':'Cancel',
    'tasks.retry':'Retry',
    'tasks.startedAt':'Started',
    'tasks.finishedAt':'Finished',
    'tasks.error':'Error',
    'tasks.logs':'Logs',
    'tasks.noLogs':'No logs yet',
    'tasks.status.running':'Running',
  }[key] || key) }),
}))

describe('TaskCenter', () => {
  beforeEach(() => {
    cancelTask.mockReset()
    retryTask.mockReset()
  })
  it('shows task details and cancels the selected running task', () => {
    render(React.createElement(TaskCenter, { onClose:vi.fn() }))
    expect(screen.getAllByText('Restart + Rebuild')).toHaveLength(2)
    expect(screen.getByText('Starting...')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name:'Cancel' }))
    expect(cancelTask).toHaveBeenCalledWith('restart-rebuild')
  })
})
