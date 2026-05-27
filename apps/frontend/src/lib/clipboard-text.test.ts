import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStoredClipboardText, readClipboardTextOnly, resetStoredClipboardText, writeClipboardText } from './clipboard-text'

describe('clipboard-text', () => {
  beforeEach(() => {
    resetStoredClipboardText()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = vi.fn(() => false)
  })

  it('falls back to app memory when system write is unavailable', async () => {
    const result = await writeClipboardText('echo test')
    expect(result).toEqual({ copied: true, source: 'memory', unavailable: true, reason: 'api_unavailable' })
    expect(getStoredClipboardText()).toBe('echo test')
  })
  it('returns permission_denied when clipboard permission is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { const err = new Error('blocked') as Error & { name:string }; err.name = 'NotAllowedError'; throw err }) },
      configurable: true,
    })
    const result = await writeClipboardText('echo denied')
    expect(result).toEqual({ copied: true, source: 'memory', unavailable: true, reason: 'permission_denied' })
  })
  it('returns sync_copy_failed when api write throws non-permission error and sync fallback fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('boom') }) },
      configurable: true,
    })
    const result = await writeClipboardText('echo fail')
    expect(result).toEqual({ copied: true, source: 'memory', unavailable: true, reason: 'sync_copy_failed' })
  })
  it('uses sync copy first when preferSync is enabled', async () => {
    document.execCommand = vi.fn(() => true)
    const result = await writeClipboardText('echo sync', { preferSync: true })
    expect(result).toEqual({ copied: true, source: 'system', unavailable: false, reason: 'ok' })
  })

  it('reads from app memory when system clipboard is unavailable', async () => {
    await writeClipboardText('echo memory')
    const result = await readClipboardTextOnly()
    expect(result).toEqual({ text: 'echo memory', source: 'memory', unavailable: true })
  })

  it('prefers system clipboard text when available', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn(async () => 'echo system'), writeText: vi.fn(async () => {}) },
      configurable: true,
    })
    const result = await readClipboardTextOnly()
    expect(result).toEqual({ text: 'echo system', source: 'system', unavailable: false })
  })
})
