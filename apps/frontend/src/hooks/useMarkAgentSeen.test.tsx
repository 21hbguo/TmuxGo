import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMarkAgentSeen } from './useMarkAgentSeen'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { Session } from '@/types'

const apiMocks = vi.hoisted(() => ({ markSeen: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { panes: { markSeen: apiMocks.markSeen } } }))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}))

const pushToast = vi.fn()
let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
const agent = (paneId: string, agentStatus: 'done' | 'working' | 'blocked') => ({
  paneId,
  tmuxPaneId: paneId.split(':')[1],
  sessionName: 'dev',
  agent: 'codex',
  agentSessionId: `${paneId}:dev`,
  agentStatus,
  phase: 'idle' as const,
  source: 'process' as const,
  confidence: 'high' as const,
  since: 'x',
  updatedAt: 'x',
  eventId: paneId,
  revision: 1,
})
const session: Session = {
  id: 'session-dev',
  hostId: 'local',
  name: 'dev',
  createdAt: '',
  lastActiveAt: '',
  windowCount: 1,
  agents: [agent('local:%1', 'done'), agent('local:%2', 'working'), agent('local:%3', 'blocked')],
  agentSummary: { idle: 0, working: 1, blocked: 1, done: 1, unknown: 0, total: 3 },
}

describe('useMarkAgentSeen', () => {
  beforeEach(() => {
    queryClient = new QueryClient()
    queryClient.setQueryData(['sessions', 'local'], [session])
    apiMocks.markSeen.mockReset().mockResolvedValue({ ok: true, marked: 1 })
    pushToast.mockReset()
    useConsoleStore.setState({ pushToast })
  })

  it('成功：done 翻 idle，working/blocked 缓存原样，toast 可见反馈', async () => {
    const { result } = renderHook(() => useMarkAgentSeen(), { wrapper })
    await act(() => result.current(['local:%1', 'local:%2']))
    expect(apiMocks.markSeen).toHaveBeenCalledWith(['local:%1', 'local:%2'])
    const cached = queryClient.getQueryData<Session[]>(['sessions', 'local'])![0]
    expect(cached.agents?.find((a) => a.paneId === 'local:%1')?.agentStatus).toBe('idle')
    // working/blocked 不被清除语义污染
    expect(cached.agents?.find((a) => a.paneId === 'local:%2')?.agentStatus).toBe('working')
    expect(cached.agents?.find((a) => a.paneId === 'local:%3')?.agentStatus).toBe('blocked')
    expect(cached.agentSummary?.idle).toBe(1)
    expect(cached.agentSummary?.done).toBe(0)
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
  })

  it('幂等：重复调用 marked=0 时不改缓存也不弹 toast', async () => {
    apiMocks.markSeen.mockResolvedValue({ ok: true, marked: 0 })
    const { result } = renderHook(() => useMarkAgentSeen(), { wrapper })
    await act(() => result.current(['local:%1']))
    const cached = queryClient.getQueryData<Session[]>(['sessions', 'local'])![0]
    expect(cached.agents?.find((a) => a.paneId === 'local:%1')?.agentStatus).toBe('done')
    expect(cached.agentSummary?.done).toBe(1)
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('失败：弹 error toast，缓存不动', async () => {
    apiMocks.markSeen.mockRejectedValue(new Error('Forbidden'))
    const { result } = renderHook(() => useMarkAgentSeen(), { wrapper })
    await act(() => result.current(['local:%1']))
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }))
    const cached = queryClient.getQueryData<Session[]>(['sessions', 'local'])![0]
    expect(cached.agentSummary?.done).toBe(1)
  })

  it('空入参不发请求', async () => {
    const { result } = renderHook(() => useMarkAgentSeen(), { wrapper })
    await act(() => result.current([]))
    expect(apiMocks.markSeen).not.toHaveBeenCalled()
  })
})
