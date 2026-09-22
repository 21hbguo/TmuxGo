import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSystemInfo } from './useSystemInfo'

const systemInfo = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { system: { info: systemInfo } } }))
function response(hostId: string, cpu: number) {
  return {
    hostId,
    gpu: null,
    cpu,
    mem: { used: 1, total: 2 },
    disks: [],
    dependencies: { tmux: true, git: true, python: true, rg: true, sshpass: true },
    stream: {},
  }
}
describe('useSystemInfo', () => {
  it('clears stale metrics and ignores the previous host response', async () => {
    let resolveLocal: (value: any) => void = () => {}
    systemInfo.mockReset()
    systemInfo
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLocal = resolve
          }),
      )
      .mockResolvedValueOnce(response('edge', 20))
    const { result, rerender, unmount } = renderHook(({ hostId }) => useSystemInfo(hostId, 60000), {
      initialProps: { hostId: 'local' },
    })
    expect(result.current).toBeNull()
    rerender({ hostId: 'edge' })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current?.hostId).toBe('edge'))
    await act(async () => resolveLocal(response('local', 90)))
    expect(result.current?.hostId).toBe('edge')
    expect(systemInfo).toHaveBeenNthCalledWith(1, 'local')
    expect(systemInfo).toHaveBeenNthCalledWith(2, 'edge')
    unmount()
  })
})

describe('useSystemInfo enabled flag', () => {
  it('does not poll while disabled and starts after enable', async () => {
    systemInfo.mockReset()
    systemInfo.mockResolvedValue(response('local', 11))
    const { result, rerender, unmount } = renderHook(({ enabled }) => useSystemInfo('local', 60000, enabled), {
      initialProps: { enabled: false },
    })
    expect(result.current).toBeNull()
    expect(systemInfo).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(result.current?.cpu).toBe(11))
    expect(systemInfo).toHaveBeenCalledWith('local')
    unmount()
  })

  it('pauses interval polls while disabled and refreshes on re-enable', async () => {
    vi.useFakeTimers()
    try {
      systemInfo.mockReset()
      systemInfo.mockResolvedValue(response('local', 11))
      const { rerender, unmount } = renderHook(({ enabled }) => useSystemInfo('local', 1000, enabled), {
        initialProps: { enabled: true },
      })
      expect(systemInfo).toHaveBeenCalledTimes(1)
      // 用 advanceTimersByTimeAsync 让每个 tick 间的微任务落地，inflight 才会随响应复位
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      const whileEnabled = systemInfo.mock.calls.length
      expect(whileEnabled).toBeGreaterThan(1)
      rerender({ enabled: false })
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      expect(systemInfo).toHaveBeenCalledTimes(whileEnabled)
      rerender({ enabled: true })
      expect(systemInfo).toHaveBeenCalledTimes(whileEnabled + 1)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not write results that resolve after disable or unmount', async () => {
    systemInfo.mockReset()
    const pending: Array<(value: any) => void> = []
    systemInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        }),
    )
    const { result, rerender, unmount } = renderHook(({ enabled }) => useSystemInfo('local', 60000, enabled), {
      initialProps: { enabled: true },
    })
    expect(systemInfo).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    await act(async () => pending[0](response('local', 77)))
    expect(result.current).toBeNull()
    rerender({ enabled: true })
    expect(systemInfo).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => pending[1](response('local', 88)))
    expect(result.current).toBeNull()
  })
})

describe('useSystemInfo overlapping polls', () => {
  it('keeps at most one request in flight when responses outlast the interval', async () => {
    vi.useFakeTimers()
    try {
      systemInfo.mockReset()
      let resolveFirst: (value: any) => void = () => {}
      systemInfo
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve
            }),
        )
        .mockResolvedValue(response('local', 30))
      const { unmount } = renderHook(() => useSystemInfo('local', 1000))
      expect(systemInfo).toHaveBeenCalledTimes(1)
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      expect(systemInfo).toHaveBeenCalledTimes(1)
      await act(async () => resolveFirst(response('local', 40)))
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
      expect(systemInfo).toHaveBeenCalledTimes(2)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
