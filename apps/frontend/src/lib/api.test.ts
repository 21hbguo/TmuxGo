import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
describe('api git error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('uses message when ok is false and error is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, message: 'SSH authentication failed', conflicts: true }),
    })))
    await expect(api.git.pull('local', '/repo')).rejects.toMatchObject({ message: 'SSH authentication failed', code: 'REQUEST_FAILED' })
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
        text: async () => JSON.stringify([{ id: 'session-local-demo', hostId: 'local', name: 'demo', windowCount: 1, createdAt: '2026-06-03T00:00:00.000Z', lastActiveAt: '2026-06-03T00:00:00.000Z', attached: false }]),
      })
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.sessions.create('local', 'demo')).resolves.toMatchObject({ id: 'session-local-demo', name: 'demo' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('treats deleted session as success when response body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    })))
    await expect(api.sessions.delete('local', 'session-local-demo')).resolves.toMatchObject({ success: true, sessionId: 'session-local-demo' })
  })
})
