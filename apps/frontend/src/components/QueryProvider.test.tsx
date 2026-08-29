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
  })
  it('refreshes active stale queries once after returning to the foreground', () => {
    vi.useFakeTimers()
    const recovered = vi.fn()
    let queryClient: QueryClient | null = null
    window.addEventListener('tmuxgo-app-recovered', recovered)
    render(<QueryProvider><Capture onReady={(client) => { queryClient = client }} /></QueryProvider>)
    const refetchQueries = vi.spyOn(queryClient!, 'refetchQueries').mockResolvedValue(undefined)
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      vi.advanceTimersByTime(250)
    })
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(refetchQueries).toHaveBeenCalledTimes(1)
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active', stale: true })
    window.removeEventListener('tmuxgo-app-recovered', recovered)
  })
})
