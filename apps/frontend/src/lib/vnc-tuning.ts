import type RFBType from '@novnc/novnc'
import { authenticatedFetch } from './auth'

// noVNC 合法范围 0–9（内部校验），帧率上限走自实现的请求节流
export const VNC_QUALITY_RANGE = { min: 0, max: 9 } as const
export const VNC_COMPRESSION_RANGE = { min: 0, max: 9 } as const
export const VNC_FPS_RANGE = { min: 5, max: 60 } as const
// 与 gateway 侧 loopback 端口白名单一致
export const VNC_PORT_RANGE = { min: 5900, max: 5999 } as const

export interface VncTuning {
  quality: number
  compression: number
  maxFps: number
  lossless: boolean
}

export const VNC_TUNING_PRESETS: Record<string, VncTuning> = {
  speed: { quality: 8, compression: 1, maxFps: 60, lossless: false },
  balanced: { quality: 6, compression: 2, maxFps: 30, lossless: false },
  saver: { quality: 3, compression: 6, maxFps: 15, lossless: false },
}
export const VNC_TUNING_DEFAULT = VNC_TUNING_PRESETS.balanced

export interface VncStatsSample {
  fps: number
  inKbps: number
  outKbps: number
}

interface InstrumentedSock {
  _websocket?: WebSocket | null
  __tmuxgoMaxFps?: number
  __tmuxgoFbuAt?: number
  __tmuxgoFbuTimer?: ReturnType<typeof setTimeout> | null
}

// RFB 是拉取模型：每个 FBU 完成后客户端才发下一次 FramebufferUpdateRequest。
// 在 messages.fbUpdateRequest 上节流即可压低服务端推帧频率（对 continuous-updates 服务端不生效）。
// 该函数挂在导出类上（RFB.messages），属模块内可替换的属性，按 1.7.0 结构实现并带防御回退。
let requestThrottled = false
export function installVncRequestThrottle(RFB: typeof RFBType) {
  if (requestThrottled) return
  const messages = (RFB as any).messages
  const original = messages?.fbUpdateRequest
  if (typeof original !== 'function') return
  requestThrottled = true
  messages.fbUpdateRequest = (
    sock: InstrumentedSock,
    incremental: boolean,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    const maxFps = sock.__tmuxgoMaxFps
    if (!incremental || !maxFps || maxFps >= VNC_FPS_RANGE.max) {
      return original(sock, incremental, x, y, w, h)
    }
    const interval = 1000 / maxFps
    const now = performance.now()
    const elapsed = now - (sock.__tmuxgoFbuAt || 0)
    if (elapsed >= interval) {
      sock.__tmuxgoFbuAt = now
      return original(sock, incremental, x, y, w, h)
    }
    // 请求在途则丢弃：同一 sock 只会并发一个 pending request，延迟到间隔点发出
    if (sock.__tmuxgoFbuTimer) return
    sock.__tmuxgoFbuTimer = setTimeout(() => {
      sock.__tmuxgoFbuTimer = null
      sock.__tmuxgoFbuAt = performance.now()
      original(sock, incremental, x, y, w, h)
    }, interval - elapsed)
  }
}

export interface VncInstrumentation {
  setMaxFps: (fps: number) => void
  setLossless: (on: boolean) => void
  sample: () => VncStatsSample
  dispose: () => void
}

// 无损模式：从 SetEncodings 协商列表剔除可携带 JPEG/H.264 有损载荷的编码
//（encodings.encodingTight=7 在 quality<9 时会发 JPEG 子块，encodingJPEG=21，encodingH264=50），
// 保留 copyRect/tightPNG/ZRLE/hextile/RRE/zlib/raw 这些恒无损编码。ID 与 core/encodings.js 对齐。
const LOSSY_ENCODINGS = new Set([7, 21, 50])
let losslessActive = false
let encodingsPatched = false
export function installVncLosslessFilter(RFB: typeof RFBType) {
  if (encodingsPatched) return
  const messages = (RFB as any).messages
  const original = messages?.clientEncodings
  if (typeof original !== 'function') return
  encodingsPatched = true
  messages.clientEncodings = (sock: unknown, encs: number[]) =>
    original(sock, losslessActive ? encs.filter((e) => !LOSSY_ENCODINGS.has(e)) : encs)
}

export function attachVncInstrumentation(rfb: RFBType): VncInstrumentation {
  let frames = 0
  let bytesIn = 0
  let bytesOut = 0
  let disposed = false
  const noop = {
    setMaxFps: () => {},
    setLossless: () => {},
    sample: () => ({ fps: 0, inKbps: 0, outKbps: 0 }),
    dispose: () => {},
  }
  const anyRfb = rfb as any
  const sock = anyRfb._sock as InstrumentedSock | undefined
  const ws = sock?._websocket
  if (!sock || !ws || typeof anyRfb._framebufferUpdate !== 'function') return noop

  // 实例方法遮蔽原型：_normalMsg 走 this._framebufferUpdate，完成一次 FBU 计一帧
  const originalFbu = anyRfb._framebufferUpdate.bind(rfb)
  anyRfb._framebufferUpdate = () => {
    const done = originalFbu()
    if (done) frames++
    return done
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data
    bytesIn += typeof data?.byteLength === 'number' ? data.byteLength : typeof data === 'string' ? data.length : 0
  }
  ws.addEventListener('message', onMessage)
  const originalSend = ws.send.bind(ws)
  ws.send = (data: any) => {
    bytesOut += typeof data?.byteLength === 'number' ? data.byteLength : data?.size || 0
    return originalSend(data)
  }

  let lastAt = performance.now()
  return {
    setMaxFps(fps) {
      sock.__tmuxgoMaxFps = fps
    },
    setLossless(on) {
      losslessActive = on
      // 重发 SetEncodings 让协商立刻生效；仅 connected 态可发，与 noVNC 内部用法一致
      if (anyRfb._rfbConnectionState === 'connected' && typeof anyRfb._sendEncodings === 'function')
        anyRfb._sendEncodings()
    },
    sample() {
      const now = performance.now()
      const seconds = Math.max(0.1, (now - lastAt) / 1000)
      lastAt = now
      const result = {
        fps: Math.round(frames / seconds),
        inKbps: Math.round(bytesIn / seconds / 1024),
        outKbps: Math.round(bytesOut / seconds / 1024),
      }
      frames = 0
      bytesIn = 0
      bytesOut = 0
      return result
    },
    dispose() {
      if (disposed) return
      disposed = true
      ws.removeEventListener('message', onMessage)
      ws.send = originalSend
      if (sock.__tmuxgoFbuTimer) clearTimeout(sock.__tmuxgoFbuTimer)
      sock.__tmuxgoFbuTimer = null
    },
  }
}

// 远端分辨率调节：'off' 不动远端；'auto' 跟随视口（rfb.resizeSession）；
// 'WxH' 直接发 SetDesktopSize。仅 ExtendedDesktopSize 协商成功后生效（x11vnc 不支持则自动无效）。
// cleanup 会把远端恢复到协商时快照的原始分辨率——必须在 RFB.disconnect() 之前调用，socket 关了就发不出去了。
export const VNC_RESOLUTION_PRESETS = ['2560x1440', '1920x1080', '1600x900', '1366x768', '1280x720'] as const

export function applyVncResolution(rfb: RFBType, RFB: typeof RFBType, mode: string, viewOnly: boolean): () => void {
  const anyRfb = rfb as any
  // 仅查看模式下禁止改远端分辨率
  if (viewOnly || mode === 'off') return () => {}
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(mode)
  const fixed = mode === 'auto' ? null : match ? { w: Number(match[1]), h: Number(match[2]) } : null
  if (mode !== 'auto' && !fixed) return () => {}
  const send = (w: number, h: number) => {
    if (!anyRfb._sock || !anyRfb._supportsSetDesktopSize) return
    ;(RFB as any).messages.setDesktopSize(anyRfb._sock, w, h, anyRfb._screenID, anyRfb._screenFlags)
  }
  let applied = false
  let tries = 0
  const timer = setInterval(() => {
    if (tries++ > 20 || !anyRfb._sock) {
      clearInterval(timer)
      return
    }
    // 服务端宣告支持 ExtendedDesktopSize 且首帧到位前发 SetDesktopSize 是协议违规
    if (!anyRfb._supportsSetDesktopSize || !anyRfb._fbWidth) return
    // 每条连接只快照一次原始分辨率：切换模式时 cleanup 先恢复，若此刻重取会拿到已改过的尺寸
    if (!anyRfb.__tmuxgoOriginalSize) anyRfb.__tmuxgoOriginalSize = { w: anyRfb._fbWidth, h: anyRfb._fbHeight }
    clearInterval(timer)
    applied = true
    if (fixed) send(fixed.w, fixed.h)
    else anyRfb.resizeSession = true
  }, 500)
  return () => {
    clearInterval(timer)
    anyRfb.resizeSession = false
    const original = anyRfb.__tmuxgoOriginalSize
    if (applied && original && (anyRfb._fbWidth !== original.w || anyRfb._fbHeight !== original.h)) {
      send(original.w, original.h)
    }
  }
}

// 按宿主机记住上次连接的 VNC 端口：不同机器的 display 号不同
export function readVncPort(hostId: string): number | null {
  try {
    const raw = Number(localStorage.getItem(`tmuxgo:vnc-port:${hostId}`))
    return Number.isInteger(raw) && raw >= VNC_PORT_RANGE.min && raw <= VNC_PORT_RANGE.max ? raw : null
  } catch {
    return null
  }
}

export function writeVncPort(hostId: string, port: number) {
  try {
    localStorage.setItem(`tmuxgo:vnc-port:${hostId}`, String(port))
  } catch {
    /* 存储不可用时静默 */
  }
}

// 浏览器侧无法看到 TCP 重传，RTT 用一次到 gateway 的轻量请求近似衡量链路质量
export async function measureVncRtt() {
  const start = performance.now()
  try {
    await authenticatedFetch('/api/vnc/ping', { method: 'GET', cache: 'no-store' })
    return Math.round(performance.now() - start)
  } catch {
    return null
  }
}
