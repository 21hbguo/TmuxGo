import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachVncInstrumentation, installVncRequestThrottle, VNC_FPS_RANGE } from './vnc-tuning'

function makeRfbClass() {
  const calls: unknown[][] = []
  const messages = { fbUpdateRequest: (...args: unknown[]) => calls.push(args) }
  class FakeRfb {}
  ;(FakeRfb as any).messages = messages
  return { FakeRfb, calls }
}

describe('installVncRequestThrottle', () => {
  afterEach(() => vi.useRealTimers())

  it('limits incremental FBU requests to the configured fps', () => {
    vi.useFakeTimers()
    const { FakeRfb, calls } = makeRfbClass()
    installVncRequestThrottle(FakeRfb as any)
    const sock: any = { __tmuxgoMaxFps: 30 }
    const send = (FakeRfb as any).messages.fbUpdateRequest
    send(sock, true, 0, 0, 100, 100)
    send(sock, true, 0, 0, 100, 100)
    send(sock, true, 0, 0, 100, 100)
    // fake timers 下 performance.now 也被冻结：首个请求 elapsed=0 被延迟，重复请求合并为一个 pending
    expect(calls).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(calls).toHaveLength(1)
    send(sock, true, 0, 0, 100, 100)
    vi.advanceTimersByTime(100)
    expect(calls).toHaveLength(2)
  })

  it('passes through non-incremental requests and unlimited fps', () => {
    const { FakeRfb, calls } = makeRfbClass()
    installVncRequestThrottle(FakeRfb as any)
    const send = (FakeRfb as any).messages.fbUpdateRequest
    const sock: any = { __tmuxgoMaxFps: VNC_FPS_RANGE.max }
    send(sock, false, 0, 0, 100, 100)
    send(sock, true, 0, 0, 100, 100)
    send(sock, true, 0, 0, 100, 100)
    expect(calls).toHaveLength(3)
  })
})

describe('attachVncInstrumentation', () => {
  it('counts completed framebuffer updates and ws bytes', () => {
    const listeners: Record<string, (event: any) => void> = {}
    const sent: number[] = []
    const ws = {
      addEventListener: (name: string, fn: (event: any) => void) => (listeners[name] = fn),
      removeEventListener: () => {},
      send: (data: ArrayBuffer) => sent.push(data.byteLength),
    } as unknown as WebSocket
    let fbuDone = false
    const rfb = {
      _sock: { _websocket: ws },
      _framebufferUpdate() {
        return fbuDone
      },
    } as any
    const instrumentation = attachVncInstrumentation(rfb)
    instrumentation.setMaxFps(30)
    expect((rfb._sock as any).__tmuxgoMaxFps).toBe(30)
    listeners.message?.({ data: new ArrayBuffer(2048) })
    ws.send(new ArrayBuffer(100))
    fbuDone = true
    rfb._framebufferUpdate()
    rfb._framebufferUpdate()
    const sample = instrumentation.sample()
    expect(sample.fps).toBeGreaterThan(0)
    expect(sample.inKbps).toBeGreaterThan(0)
    expect(sent).toEqual([100])
    instrumentation.dispose()
  })

  it('returns a no-op instrumentation when internals are missing', () => {
    const instrumentation = attachVncInstrumentation({} as any)
    expect(instrumentation.sample()).toEqual({ fps: 0, inKbps: 0, outKbps: 0 })
    instrumentation.dispose()
  })
})
