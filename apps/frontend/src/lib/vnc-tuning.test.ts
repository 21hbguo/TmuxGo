import type RFBType from '@novnc/novnc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachVncInstrumentation,
  installVncLosslessFilter,
  installVncRequestThrottle,
  VNC_FPS_RANGE,
} from './vnc-tuning'

// 假 RFB 只补被 patch 的静态 messages 表，其余按真实类收口
interface FakeRfbMessages {
  fbUpdateRequest: (...args: unknown[]) => void
  clientEncodings: (sock: unknown, encs: number[]) => void
}
type RfbClass = typeof RFBType & { messages: Partial<FakeRfbMessages> }
const asRfbClass = (cls: unknown) => cls as RfbClass

// 测试要读写 noVNC 私有字段，用局部结构声明替代 any
interface RfbInternals {
  _sock: { _websocket: WebSocket; __tmuxgoMaxFps?: number }
  _framebufferUpdate: () => boolean
  _rfbConnectionState: string
  _sendEncodings: ReturnType<typeof vi.fn>
}
const asRfb = (rfb: RfbInternals) => rfb as unknown as RFBType

function makeRfbClass() {
  const calls: unknown[][] = []
  const messages = { fbUpdateRequest: (...args: unknown[]) => calls.push(args) }
  class FakeRfb {}
  const RFB = asRfbClass(FakeRfb)
  RFB.messages = messages
  return { RFB, calls }
}

describe('installVncRequestThrottle', () => {
  afterEach(() => vi.useRealTimers())

  it('limits incremental FBU requests to the configured fps', () => {
    vi.useFakeTimers()
    const { RFB, calls } = makeRfbClass()
    installVncRequestThrottle(RFB)
    const sock = { __tmuxgoMaxFps: 30 }
    const send = RFB.messages.fbUpdateRequest!
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
    const { RFB, calls } = makeRfbClass()
    installVncRequestThrottle(RFB)
    const send = RFB.messages.fbUpdateRequest!
    const sock = { __tmuxgoMaxFps: VNC_FPS_RANGE.max }
    send(sock, false, 0, 0, 100, 100)
    send(sock, true, 0, 0, 100, 100)
    send(sock, true, 0, 0, 100, 100)
    expect(calls).toHaveLength(3)
  })
})

describe('installVncLosslessFilter', () => {
  it('filters lossy encodings only while enabled', () => {
    const sent: number[][] = []
    const ws = {
      addEventListener: () => {},
      removeEventListener: () => {},
      send: () => {},
    } as unknown as WebSocket
    const messages = { clientEncodings: (_sock: unknown, encs: number[]) => sent.push(encs) }
    class FakeRfb {}
    const RFB = asRfbClass(FakeRfb)
    RFB.messages = messages
    installVncLosslessFilter(RFB)
    const internals: RfbInternals = {
      _sock: { _websocket: ws },
      _framebufferUpdate: () => true,
      _rfbConnectionState: 'connected',
      _sendEncodings: vi.fn(),
    }
    const instrumentation = attachVncInstrumentation(asRfb(internals))
    const send = RFB.messages.clientEncodings!
    send({}, [1, 7, -260, 16, 21, 50, 0])
    instrumentation.setLossless(true)
    send({}, [1, 7, -260, 16, 21, 50, 0])
    instrumentation.setLossless(false)
    send({}, [1, 7, -260, 16, 21, 50, 0])
    expect(sent).toEqual([
      [1, 7, -260, 16, 21, 50, 0],
      [1, -260, 16, 0],
      [1, 7, -260, 16, 21, 50, 0],
    ])
    // connected 态切开关会重发协商，非 connected 态不发
    expect(internals._sendEncodings).toHaveBeenCalledTimes(2)
    internals._rfbConnectionState = 'connecting'
    instrumentation.setLossless(true)
    expect(internals._sendEncodings).toHaveBeenCalledTimes(2)
    // 收尾复位模块级开关，避免泄漏到其他用例
    instrumentation.setLossless(false)
    instrumentation.dispose()
  })
})

describe('attachVncInstrumentation', () => {
  it('counts completed framebuffer updates and ws bytes', () => {
    const listeners: Record<string, (event: MessageEvent) => void> = {}
    const sent: number[] = []
    const ws = {
      addEventListener: (name: string, fn: (event: MessageEvent) => void) => (listeners[name] = fn),
      removeEventListener: () => {},
      send: (data: ArrayBuffer) => sent.push(data.byteLength),
    } as unknown as WebSocket
    let fbuDone = false
    const internals: RfbInternals = {
      _sock: { _websocket: ws },
      _framebufferUpdate() {
        return fbuDone
      },
      _rfbConnectionState: 'connected',
      _sendEncodings: vi.fn(),
    }
    const rfb = asRfb(internals)
    const instrumentation = attachVncInstrumentation(rfb)
    instrumentation.setMaxFps(30)
    expect(internals._sock.__tmuxgoMaxFps).toBe(30)
    listeners.message?.(new MessageEvent('message', { data: new ArrayBuffer(2048) }))
    ws.send(new ArrayBuffer(100))
    fbuDone = true
    internals._framebufferUpdate()
    internals._framebufferUpdate()
    const sample = instrumentation.sample()
    expect(sample.fps).toBeGreaterThan(0)
    expect(sample.inKbps).toBeGreaterThan(0)
    expect(sent).toEqual([100])
    instrumentation.dispose()
  })

  it('returns a no-op instrumentation when internals are missing', () => {
    const instrumentation = attachVncInstrumentation({} as unknown as RFBType)
    expect(instrumentation.sample()).toEqual({ fps: 0, inKbps: 0, outKbps: 0 })
    instrumentation.dispose()
  })
})
