import { afterEach, describe, expect, it, vi } from 'vitest'

describe('auth', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })
  it('refreshes an expired access token before retrying a WebSocket ticket', async () => {
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken:'expired-token', expiresIn:900, user:{ username:'admin' }, sessionId:'session-1' }), { status:200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message:'Authentication required' }), { status:401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken:'fresh-token', expiresIn:900, user:{ username:'admin' }, sessionId:'session-1' }), { status:200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket:'fresh-ticket' }), { status:200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { getWebSocketUrl, login }=await import('./auth')
    await login('admin', 'password')
    await expect(getWebSocketUrl()).resolves.toContain('ticket=fresh-ticket')
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer expired-token')
    expect(fetchMock.mock.calls[2][0]).toContain('/api/auth/refresh')
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get('Authorization')).toBe('Bearer fresh-token')
  })
  it('aborts a hung refresh and allows a subsequent refresh', async () => {
    vi.useFakeTimers()
    let firstSignal:AbortSignal | undefined
    const fetchMock=vi.fn().mockImplementationOnce((_url:string, init?:RequestInit) => {
      firstSignal=init?.signal || undefined
      return new Promise<Response>((_resolve, reject) => firstSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    }).mockResolvedValueOnce(new Response(JSON.stringify({ accessToken:'fresh-token', expiresIn:900, user:{ username:'admin' }, sessionId:'session-1' }), { status:200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { refreshAuth }=await import('./auth')
    const firstRefresh=refreshAuth()
    const firstRefreshResult=expect(firstRefresh).rejects.toMatchObject({ name:'AbortError' })
    await vi.advanceTimersByTimeAsync(4000)
    await firstRefreshResult
    expect(firstSignal?.aborted).toBe(true)
    await expect(refreshAuth()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retries a failed read request once', async () => {
    vi.useFakeTimers()
    const fetchMock=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { authenticatedFetch }=await import('./auth')
    const request=authenticatedFetch('/api/hosts')
    await vi.advanceTimersByTimeAsync(500)
    await expect(request).resolves.toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('retries a dead connection without waiting', async () => {
    const fetchMock=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const { authenticatedFetch }=await import('./auth')
    await expect(authenticatedFetch('/api/hosts')).resolves.toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('retries a failed read request until the retry budget is exhausted', async () => {
    vi.useFakeTimers()
    const fetchMock=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const { authenticatedFetch }=await import('./auth')
    const request=authenticatedFetch('/api/hosts')
    const failure=expect(request).rejects.toThrow('Failed to fetch')
    await vi.advanceTimersByTimeAsync(5000)
    await failure
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
  it('does not retry a failed write request', async () => {
    const fetchMock=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const { authenticatedFetch }=await import('./auth')
    await expect(authenticatedFetch('/api/hosts', { method:'POST' })).rejects.toThrow('Failed to fetch')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
