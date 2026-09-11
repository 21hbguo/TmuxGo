import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryProvider } from './QueryProvider'

function Capture({ onReady }: { onReady: (client: QueryClient) => void }) {
  onReady(useQueryClient())
  return null
}

describe('QueryProvider', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('refreshes active stale queries once after returning to the foreground', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 })))
    const recovered = vi.fn()
    let queryClient: QueryClient | null = null
    window.addEventListener('tmuxgo-app-recovered', recovered)
    render(<QueryProvider><Capture onReady={(client) => { queryClient = client }} /></QueryProvider>)
    const refetchQueries = vi.spyOn(queryClient!, 'refetchQueries').mockResolvedValue(undefined)
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(refetchQueries).toHaveBeenCalledTimes(1)
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active', stale: true })
    window.removeEventListener('tmuxgo-app-recovered', recovered)
  })
  it('keeps probing until the gateway is reachable', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const recovered = vi.fn()
    window.addEventListener('tmuxgo-app-recovered', recovered)
    render(<QueryProvider><Capture onReady={() => {}} /></QueryProvider>)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(recovered).toHaveBeenCalledTimes(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(recovered).toHaveBeenCalledTimes(1)
    window.removeEventListener('tmuxgo-app-recovered', recovered)
  })
})
