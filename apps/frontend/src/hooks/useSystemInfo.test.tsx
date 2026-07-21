import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSystemInfo } from './useSystemInfo'

const systemInfo = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { system: { info: systemInfo } } }))
function response(hostId: string, cpu: number) {
  return { hostId, gpu: null, cpu, mem: { used: 1, total: 2 }, disks: [], dependencies: { tmux: true, git: true, python: true, rg: true, sshpass: true }, stream: {} }
}
describe('useSystemInfo', () => {
  it('clears stale metrics and ignores the previous host response', async () => {
    let resolveLocal: (value: any) => void = () => {}
    systemInfo.mockReset()
    systemInfo.mockImplementationOnce(() => new Promise((resolve) => { resolveLocal = resolve })).mockResolvedValueOnce(response('edge', 20))
    const { result, rerender, unmount } = renderHook(({ hostId }) => useSystemInfo(hostId, 60000), { initialProps: { hostId: 'local' } })
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
