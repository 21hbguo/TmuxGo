import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, fetchApiBlob } from './api'
import { __resetViewIdForTest, getViewId } from './view-identity'
describe('api git error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('uses message when ok is false and error is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: false, message: 'SSH authentication failed', conflicts: true }),
      })),
    )
    await expect(api.git.pull('local', '/repo')).rejects.toMatchObject({
      message: 'SSH authentication failed',
      code: 'REQUEST_FAILED',
    })
  })
  it('treats created session as success when follow-up list confirms it', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              id: 'session-local-demo',
              hostId: 'local',
              name: 'demo',
              windowCount: 1,
              createdAt: '2026-06-03T00:00:00.000Z',
              lastActiveAt: '2026-06-03T00:00:00.000Z',
              attached: false,
            },
          ]),
      })
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.sessions.create('local', 'demo')).resolves.toMatchObject({
      id: 'session-local-demo',
      name: 'demo',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('treats deleted session as success when response body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
      })),
    )
    await expect(api.sessions.delete('local', 'session-local-demo')).resolves.toMatchObject({
      success: true,
      sessionId: 'session-local-demo',
    })
  })
  it('forwards the search cancellation signal', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => '[]',
    }))
    vi.stubGlobal('fetch', fetchMock)
    await api.files.searchName('local', 'root-0', 'demo', '', true, controller.signal)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal })
  })
  it('fetches protected binary resources with credentials', async () => {
    const blob = new Blob(['image'])
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      blob: async () => blob,
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchApiBlob('/api/hosts/local/files/image')).resolves.toBe(blob)
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/hosts/local/files/image')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' })
  })
  it('starts a background host test', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 202,
      text: async () =>
        JSON.stringify({ task: { id: 'task-1', type: 'host-test', title: 'Test host edge', status: 'running' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.hosts.startTest('edge')).resolves.toMatchObject({ task: { id: 'task-1', type: 'host-test' } })
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/hosts/edge/test-tasks')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })
  // 切窗口要带浏览器视角，否则多个浏览器会互相抢 tmux 的 current window
  it('sends windowId together with the stable viewId when selecting a window', async () => {
    __resetViewIdForTest()
    window.localStorage.clear()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, sessionId: 's1', windowId: 'local:@2' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await api.windows.select('local', 's1', 'local:@2')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain('/api/hosts/local/sessions/s1/windows/select')
    expect(init).toMatchObject({ method: 'POST' })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ windowId: 'local:@2', viewId: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(body.viewId).toBe(getViewId())
    expect(window.localStorage.getItem('tmuxgo.viewId.v1')).toBe(body.viewId)
  })
  // 读路径同样要带视角，否则 windows/panes/snapshot 会按 base 的 current window 返回
  it('sends the viewId on window list, session snapshot and pane list reads', async () => {
    __resetViewIdForTest()
    window.localStorage.clear()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => '[]',
    }))
    vi.stubGlobal('fetch', fetchMock)
    await api.windows.list('local', 's1')
    await api.snapshot.get('local', 's1')
    await api.panes.list('local:@1')
    const viewId = getViewId()
    expect(viewId).toMatch(/^[0-9a-f]{32}$/)
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toContain(`/api/hosts/local/sessions/s1/windows?viewId=${viewId}`)
    expect(urls[1]).toContain(`/api/hosts/local/sessions/s1/snapshot?viewId=${viewId}`)
    expect(urls[2]).toContain(`/api/windows/local:@1/panes?viewId=${viewId}`)
  })
})
