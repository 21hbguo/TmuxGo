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
    expect(result).toEqual({ copied: true, source: 'memory', unavailable: true })
    expect(getStoredClipboardText()).toBe('echo test')
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
