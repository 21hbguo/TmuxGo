import { beforeEach, describe, expect, it, vi } from 'vitest'
import { navigateInboxRoute, selectPaneInSession } from './inbox-navigation'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { Session } from '@/types'

/**
 * 跳 pane 的三档（T-239）：
 *   session 切换 → window 切换 → pane 聚焦。
 * 这段链路被 inbox 消息、fleet 行、待办行共用，所以单独锁住顺序与边界：
 * window 必须在 pane 之前选，否则跨 window 跳会落在旧 window 的 %N 上。
 */
const apiMocks = vi.hoisted(() => ({
  sessionsList: vi.fn(),
  snapshotGet: vi.fn(),
  windowsSelect: vi.fn(),
  panesSelect: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  api: {
    sessions: { list: apiMocks.sessionsList },
    snapshot: { get: apiMocks.snapshotGet },
    windows: { select: apiMocks.windowsSelect },
    panes: { select: apiMocks.panesSelect },
  },
}))

const session = (id: string, name: string): Session => ({ id, name, hostId: 'local' }) as Session

function snapshotWith(paneId: string, windowId: string, activeWindowId = windowId) {
  return {
    sessionId: 'local:s1',
    sessionName: 'dev',
    windows: [{ id: windowId, index: 0, name: 'w', active: true }],
    panes: [{ id: paneId, windowId, tmuxPaneId: paneId.split(':')[1] }],
    activeWindowId,
    activePaneId: paneId,
  }
}

describe('inbox 跳 pane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.sessionsList.mockResolvedValue([session('local:s1', 'dev')])
    apiMocks.snapshotGet.mockResolvedValue(snapshotWith('local:%2', 'local:@9'))
    apiMocks.windowsSelect.mockResolvedValue({ ok: true })
    apiMocks.panesSelect.mockResolvedValue({ ok: true })
    useConsoleStore.setState({ activeHostId: 'local', activeSessionId: 'local:s1', activePaneId: 'local:%0' })
  })

  it('跨 window 跳 pane 时先 select-window 再 select-pane', async () => {
    await selectPaneInSession({
      hostId: 'local',
      sessionId: 'local:s1',
      pane: { id: 'local:%2', windowId: 'local:@9' },
      // 当前激活的是另一个 window：必须切
      activeWindowId: 'local:@1',
      queryClient: null,
    })
    expect(apiMocks.windowsSelect).toHaveBeenCalledWith('local', 'local:s1', 'local:@9')
    expect(apiMocks.panesSelect).toHaveBeenCalledWith('local:%2')
    // 顺序是硬约束：window 先、pane 后
    expect(apiMocks.windowsSelect.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.panesSelect.mock.invocationCallOrder[0],
    )
    // 收尾回填 activePane（否则终端区还指着旧 pane）
    expect(useConsoleStore.getState().activePaneId).toBe('local:%2')
  })

  it('pane 已在当前 window 时不重复 select-window', async () => {
    await selectPaneInSession({
      hostId: 'local',
      sessionId: 'local:s1',
      pane: { id: 'local:%2', windowId: 'local:@9' },
      activeWindowId: 'local:@9',
      queryClient: null,
    })
    expect(apiMocks.windowsSelect).not.toHaveBeenCalled()
    expect(apiMocks.panesSelect).toHaveBeenCalledWith('local:%2')
  })

  it('route 带 sessionName 时按名字解析 session，切 host/session 后聚焦 pane', async () => {
    const result = await navigateInboxRoute({ hostId: 'local', sessionName: 'dev', paneId: 'local:%2' }, null)
    expect(result).toBe('pane')
    expect(apiMocks.sessionsList).toHaveBeenCalledWith('local')
    expect(apiMocks.panesSelect).toHaveBeenCalledWith('local:%2')
    expect(useConsoleStore.getState().activeSessionId).toBe('local:s1')
    expect(useConsoleStore.getState().activePaneId).toBe('local:%2')
  })

  it('只有 session 的 route 只切 session，不碰 pane', async () => {
    const result = await navigateInboxRoute({ hostId: 'local', sessionName: 'dev' }, null)
    expect(result).toBe('session')
    expect(apiMocks.panesSelect).not.toHaveBeenCalled()
    expect(useConsoleStore.getState().activeSessionId).toBe('local:s1')
  })

  it('paneId 的 host 前缀与 route.hostId 冲突时不跨 host 误选', async () => {
    const result = await navigateInboxRoute({ hostId: 'local', paneId: 'edge:%2' }, null)
    expect(result).toBe('not-found')
    expect(apiMocks.panesSelect).not.toHaveBeenCalled()
  })

  it('session 名解析不到时返回 not-found，不做兜底跳转', async () => {
    apiMocks.sessionsList.mockResolvedValue([session('local:s1', 'other')])
    const result = await navigateInboxRoute({ hostId: 'local', sessionName: 'dev', paneId: 'local:%2' }, null)
    expect(result).toBe('not-found')
    expect(apiMocks.panesSelect).not.toHaveBeenCalled()
  })
})
