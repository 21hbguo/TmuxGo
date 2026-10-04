import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentStatusBadge } from './AgentStatusBadge'
import type { AgentSummary } from '@/types'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'agent.markSeen') return '标记已查看'
      if (key.startsWith('agent.status.')) return key.slice('agent.status.'.length)
      return `${key}${params ? JSON.stringify(params) : ''}`
    },
  }),
}))

const summary = (over: Partial<AgentSummary>): AgentSummary => ({
  idle: 0,
  working: 0,
  blocked: 0,
  done: 0,
  unknown: 0,
  total: 0,
  ...over,
})

describe('AgentStatusBadge onClearDone', () => {
  it('done 徽标显示清除按钮并触发 onClearDone（不冒泡到 onStatusClick）', () => {
    const onClearDone = vi.fn()
    const onStatusClick = vi.fn()
    render(
      <AgentStatusBadge
        summary={summary({ done: 2, working: 1, total: 3 })}
        onClearDone={onClearDone}
        onStatusClick={onStatusClick}
      />,
    )
    const clear = screen.getByRole('button', { name: '标记已查看' })
    fireEvent.click(clear)
    expect(onClearDone).toHaveBeenCalledTimes(1)
    expect(onStatusClick).not.toHaveBeenCalled()
    // done 计数徽标本体仍可点击跳转
    fireEvent.click(screen.getByRole('button', { name: /done/ }))
    expect(onStatusClick).toHaveBeenCalledWith('done')
  })

  it('working/blocked 不提供清除按钮（避免误清）', () => {
    const onClearDone = vi.fn()
    render(<AgentStatusBadge summary={summary({ working: 1, blocked: 2, total: 3 })} onClearDone={onClearDone} />)
    expect(screen.queryByRole('button', { name: '标记已查看' })).toBeNull()
    render(<AgentStatusBadge status="working" onClearDone={onClearDone} />)
    expect(screen.queryByRole('button', { name: '标记已查看' })).toBeNull()
  })

  it('无 onClearDone 时完全不渲染清除按钮（向后兼容）', () => {
    render(<AgentStatusBadge status="done" />)
    expect(screen.queryByRole('button', { name: '标记已查看' })).toBeNull()
    render(<AgentStatusBadge summary={summary({ done: 1, total: 1 })} />)
    expect(screen.queryByRole('button', { name: '标记已查看' })).toBeNull()
  })

  it('compact 单态徽标带清除按钮（分组点位依赖此形态）', () => {
    const onClearDone = vi.fn()
    render(<AgentStatusBadge summary={summary({ done: 1, total: 1 })} compact onClearDone={onClearDone} />)
    fireEvent.click(screen.getByRole('button', { name: '标记已查看' }))
    expect(onClearDone).toHaveBeenCalledTimes(1)
  })
})
