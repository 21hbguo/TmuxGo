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
})
