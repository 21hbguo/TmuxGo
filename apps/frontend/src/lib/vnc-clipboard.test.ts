import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writeClipboardTextMock = vi.hoisted(() => vi.fn())
vi.mock('./clipboard-text', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./clipboard-text')>()
  return { ...mod, writeClipboardText: writeClipboardTextMock }
})

import { attachVncClipboardSync, type VncClipboardRfb } from './vnc-clipboard'

function makeRfb() {
  const calls: Array<{ type: 'paste' | 'key'; text?: string; keysym?: number; code?: string; down?: boolean }> = []
  const rfb: VncClipboardRfb = {
    clipboardPasteFrom: (text) => calls.push({ type: 'paste', text }),
    sendKey: (keysym, code, down) => calls.push({ type: 'key', keysym, code, down }),
  }
  return { rfb, calls }
}
function makeContainer() {
  const container = document.createElement('div')
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  document.body.appendChild(container)
  return { container, canvas }
}
function firePaste(target: HTMLElement, text: string) {
  const dt = { getData: (type: string) => (type === 'text/plain' ? text : '') } as DataTransfer
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: dt })
  target.dispatchEvent(event)
}
function fireKey(target: HTMLElement, init: KeyboardEventInit) {
  return target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

describe('attachVncClipboardSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    writeClipboardTextMock.mockReset()
    writeClipboardTextMock.mockResolvedValue({ copied: true, source: 'system', unavailable: false, reason: 'ok' })
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('swallows the paste-combo keydown, pushes clipboard text, then replays keys', () => {
    const { container, canvas } = makeContainer()
    const { rfb, calls } = makeRfb()
    const cleanup = attachVncClipboardSync(
      container,
      () => rfb,
      () => false,
    )
    const canvasKeys: string[] = []
    canvas.addEventListener('keydown', (e) => canvasKeys.push(e.code))
    fireKey(canvas, { code: 'ControlLeft', key: 'Control', ctrlKey: true })
    fireKey(canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    expect(canvasKeys).toEqual(['ControlLeft']) // V 被拦下
    firePaste(canvas, 'hello-clip')
    expect(calls[0]).toEqual({ type: 'paste', text: 'hello-clip' }) // 先推文本
    vi.advanceTimersByTime(0)
    const keys = calls.slice(1)
    expect(keys).toEqual([
      { type: 'key', keysym: 0xffe3, code: 'ControlLeft', down: true },
      { type: 'key', keysym: 0x76, code: 'KeyV', down: true },
      { type: 'key', keysym: 0x76, code: 'KeyV', down: false },
      { type: 'key', keysym: 0xffe3, code: 'ControlLeft', down: false },
    ])
    cleanup.dispose()
  })

  it('delays key replay under extended clipboard so the Provide round-trip lands first', () => {
    const { container, canvas } = makeContainer()
    const { rfb, calls } = makeRfb()
    ;(rfb as unknown as Record<string, unknown>)._clipboardServerCapabilitiesActions = { [1 << 27]: true }
    attachVncClipboardSync(
      container,
      () => rfb,
      () => false,
    )
    fireKey(canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    firePaste(canvas, 'x')
    expect(calls.map((c) => c.type)).toEqual(['paste'])
    vi.advanceTimersByTime(300)
    expect(calls.map((c) => c.type)).toEqual(['paste', 'key', 'key', 'key', 'key'])
  })

  it('replays held keys after the fallback window when no paste event arrives', () => {
    const { container, canvas } = makeContainer()
    const { rfb, calls } = makeRfb()
    attachVncClipboardSync(
      container,
      () => rfb,
      () => false,
    )
    fireKey(canvas, { code: 'KeyV', key: 'v', metaKey: true })
    expect(calls).toHaveLength(0)
    vi.advanceTimersByTime(450)
    // meta → Super_L
    expect(calls.map((c) => c.code)).toEqual(['MetaLeft', 'KeyV', 'KeyV', 'MetaLeft'])
  })

  it('ignores non-paste combos like Ctrl+C and Ctrl+Insert', () => {
    const { container, canvas } = makeContainer()
    const { rfb, calls } = makeRfb()
    attachVncClipboardSync(
      container,
      () => rfb,
      () => false,
    )
    const canvasKeys: string[] = []
    canvas.addEventListener('keydown', (e) => canvasKeys.push(e.code))
    fireKey(canvas, { code: 'KeyC', key: 'c', ctrlKey: true })
    fireKey(canvas, { code: 'Insert', key: 'Insert', ctrlKey: true })
    fireKey(canvas, { code: 'KeyV', key: 'v' })
    expect(canvasKeys).toEqual(['KeyC', 'Insert', 'KeyV'])
    vi.advanceTimersByTime(500)
    expect(calls).toHaveLength(0)
  })

  it('does not intercept when view-only', () => {
    const { container, canvas } = makeContainer()
    const { rfb, calls } = makeRfb()
    attachVncClipboardSync(
      container,
      () => rfb,
      () => true,
    )
    const canvasKeys: string[] = []
    canvas.addEventListener('keydown', (e) => canvasKeys.push(e.code))
    fireKey(canvas, { code: 'KeyV', key: 'v', ctrlKey: true })
    firePaste(canvas, 'text')
    vi.advanceTimersByTime(500)
    expect(canvasKeys).toEqual(['KeyV'])
    expect(calls).toHaveLength(0)
  })

  it('writes remote clipboard locally and retries on the next user gesture when denied', async () => {
    const { container } = makeContainer()
    const { rfb } = makeRfb()
    writeClipboardTextMock.mockResolvedValue({
      copied: true,
      source: 'memory',
      unavailable: true,
      reason: 'permission_denied',
    })
    const sync = attachVncClipboardSync(
      container,
      () => rfb,
      () => false,
    )
    sync.onServerClipboard('remote-text')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeClipboardTextMock).toHaveBeenCalledTimes(1)
    // 写进的是 memory → 挂起；下一次页面内手势补写
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(writeClipboardTextMock).toHaveBeenCalledTimes(2)
    expect(writeClipboardTextMock.mock.calls[1][0]).toBe('remote-text')
    // 成功后不再补写
    writeClipboardTextMock.mockResolvedValue({ copied: true, source: 'system', unavailable: false, reason: 'ok' })
    await vi.advanceTimersByTimeAsync(0)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(writeClipboardTextMock).toHaveBeenCalledTimes(3)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(writeClipboardTextMock).toHaveBeenCalledTimes(3)
    sync.dispose()
  })
})
