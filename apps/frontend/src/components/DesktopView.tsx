'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type RFBType from '@novnc/novnc'
import {
  FiActivity,
  FiClipboard,
  FiCopy,
  FiEye,
  FiEyeOff,
  FiKey,
  FiMaximize2,
  FiMinimize2,
  FiMinus,
  FiMonitor,
  FiPlay,
  FiSliders,
  FiSquare,
  FiTool,
  FiType,
  FiX,
} from 'react-icons/fi'
import { Button } from './Button'
import { api, type VncDisplay, type VncSetupStatus } from '@/lib/api'
import { getWebSocketUrl } from '@/lib/auth'
import {
  applyVncResolution,
  attachVncInstrumentation,
  installVncLosslessFilter,
  installVncRequestThrottle,
  measureVncRtt,
  VNC_RESOLUTION_PRESETS,
  VNC_COMPRESSION_RANGE,
  VNC_FPS_RANGE,
  VNC_PORT_RANGE,
  VNC_QUALITY_RANGE,
  VNC_TUNING_DEFAULT,
  VNC_TUNING_PRESETS,
  type VncInstrumentation,
  type VncStatsSample,
  type VncTuning,
  writeVncPort,
} from '@/lib/vnc-tuning'
import { getVncWebSocketBase } from '@/lib/runtime-endpoints'
import { attachVncClipboardSync } from '@/lib/vnc-clipboard'
import { useConsoleStore, type DesktopViewMode } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { MOBILE_QUERY } from '@/lib/console-device-state'
import { Select } from './Select'

// 可打印字符 → XK keysym：ASCII 直映射，其余用 Unicode code point + 0x01000000（XK 扩展规则）
const keysymForChar = (ch: string) => {
  const cp = ch.codePointAt(0)!
  return cp >= 0x20 && cp <= 0x7e ? cp : 0x01000000 | cp
}
const MOBILE_KEYSYM: Record<string, number> = {
  Backspace: 0xff08,
  Enter: 0xff0d,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
}

type VncStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

// VNC 排障日志：localStorage tmuxgo:vnc-debug=1 时输出到 console，默认关闭
const vncDebug = (...args: unknown[]) => {
  try {
    if (localStorage.getItem('tmuxgo:vnc-debug') === '1') console.debug('[vnc]', ...args)
  } catch {
    /* localStorage 不可用时静默 */
  }
}

const clampVncTuning = (saved: Partial<VncTuning>): VncTuning => ({
  quality: Math.min(
    VNC_QUALITY_RANGE.max,
    Math.max(VNC_QUALITY_RANGE.min, Number(saved.quality) || VNC_TUNING_DEFAULT.quality),
  ),
  compression: Math.min(
    VNC_COMPRESSION_RANGE.max,
    Math.max(VNC_COMPRESSION_RANGE.min, Number(saved.compression) || VNC_TUNING_DEFAULT.compression),
  ),
  maxFps: Math.min(VNC_FPS_RANGE.max, Math.max(VNC_FPS_RANGE.min, Number(saved.maxFps) || VNC_TUNING_DEFAULT.maxFps)),
  lossless: Boolean(saved.lossless),
})
const sameVncTuning = (a: VncTuning, b: VncTuning) =>
  a.quality === b.quality && a.compression === b.compression && a.maxFps === b.maxFps && a.lossless === b.lossless
const formatSize = (bytes: number) => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}
interface DesktopViewProps {
  hostId: string
  port: number
  view: DesktopViewMode
  onViewChange: (view: DesktopViewMode) => void
  onMinimize: () => void
  onClose: () => void
}

export function DesktopView({ hostId, port, view, onViewChange, onMinimize, onClose }: DesktopViewProps) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFBType | null>(null)
  const connectSeqRef = useRef(0)
  const [status, setStatus] = useState<VncStatus>('idle')
  const [error, setError] = useState('')
  const [desktopName, setDesktopName] = useState('')
  const [credentialTypes, setCredentialTypes] = useState<string[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [viewOnly, setViewOnly] = useState(false)
  const [selectedDisplay, setSelectedDisplay] = useState(port - 5900)
  // 虚拟屏选择器：displays 为 null 表示尚未探测
  const [displays, setDisplays] = useState<VncDisplay[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [displayBusy, setDisplayBusy] = useState<number | null>(null)
  const [displayHint, setDisplayHint] = useState('')
  const [customPort, setCustomPort] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupBusy, setSetupBusy] = useState<'' | 'check' | 'install' | 'start'>('')
  const [setupInfo, setSetupInfo] = useState<{
    status: VncSetupStatus
    manualCommand: string
    needSudo?: boolean
  } | null>(null)
  const [setupCopied, setSetupCopied] = useState(false)
  // 画质参数与统计开关持久化到 localStorage；RFB setter 支持运行中实时生效，无需重连
  const [tuning, setTuning] = useState<VncTuning>(() => {
    try {
      return clampVncTuning(JSON.parse(localStorage.getItem('tmuxgo:vnc-tuning') || ''))
    } catch {
      return VNC_TUNING_DEFAULT
    }
  })
  // 上一次画质配置：供"恢复上次"快速切回，随 current 一起持久化
  const [prevTuning, setPrevTuning] = useState<VncTuning | null>(() => {
    try {
      const raw = localStorage.getItem('tmuxgo:vnc-tuning-prev')
      return raw ? clampVncTuning(JSON.parse(raw)) : null
    } catch {
      return null
    }
  })
  // 800ms 内的连续调整（滑杆拖动/连点）算同一轮，prev 只记录本轮开始前的值
  const tuningChangedAtRef = useRef(0)
  const applyTuning = useCallback(
    (next: VncTuning) => {
      const now = Date.now()
      if (now - tuningChangedAtRef.current > 800 && !sameVncTuning(tuning, next)) {
        setPrevTuning(tuning)
        try {
          localStorage.setItem('tmuxgo:vnc-tuning-prev', JSON.stringify(tuning))
        } catch {
          /* 存储不可用时静默 */
        }
      }
      tuningChangedAtRef.current = now
      setTuning(next)
    },
    [tuning],
  )
  // 远端分辨率：'off' 不动 / 'auto' 跟随窗口 / 'WxH' 固定预设；viewOnly 下不生效
  const [resolution, setResolution] = useState(() => localStorage.getItem('tmuxgo:vnc-resolution') || 'off')
  const resolutionCleanupRef = useRef<(() => void) | null>(null)
  const [tuningOpen, setTuningOpen] = useState(false)
  const [showStats, setShowStats] = useState(() => localStorage.getItem('tmuxgo:vnc-stats') === '1')
  const [stats, setStats] = useState<VncStatsSample & { rtt: number | null }>({
    fps: 0,
    inKbps: 0,
    outKbps: 0,
    rtt: null,
  })
  const instrumentationRef = useRef<VncInstrumentation | null>(null)
  const tuningRef = useRef(tuning)
  tuningRef.current = tuning
  const resolutionRef = useRef(resolution)
  resolutionRef.current = resolution
  const portRef = useRef(port)
  const hiddenRef = useRef(typeof document !== 'undefined' && document.hidden)
  // 隐藏时记录是否有活动连接：手动断开过的会话回到前台不自动重连；初始 true 兜底"挂着后台打开"场景
  const wasActiveRef = useRef(true)
  // 可见性重连时免重复弹窗：提交过的凭据存 ref，securityfailure 时作废
  const credentialsRef = useRef<{ username?: string; password: string } | null>(null)
  // 凭据属于哪个 display：切屏时旧屏密码不能带过去自动应答（会顶掉新屏已存的正确密码）
  const credentialsForRef = useRef<number | null>(null)
  const [rememberPassword, setRememberPassword] = useState(false)
  // 移动端适配：窄屏+竖屏给横屏引导，键盘条走 sendKey 逐字符注入
  const [isMobileLayout, setIsMobileLayout] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  )
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches,
  )
  const [rotateHintDismissed, setRotateHintDismissed] = useState(false)
  const [mobileKeyboardOpen, setMobileKeyboardOpen] = useState(false)
  const keyboardInputRef = useRef<HTMLInputElement>(null)
  // 我们主动 lock 过横屏才在卸载/断开时 unlock，避免动用户原本的系统方向锁
  const orientationLockedRef = useRef(false)
  // 底层 WS 关闭码/原因：RFB 的 disconnect 事件不带这些，单独捕获用于错误提示
  const wsCloseRef = useRef<{ code: number; reason: string } | null>(null)
  // 剪贴板双向透传：本地→远端靠 paste 事件零权限同步，远端→本地挂起补写到下一次手势
  const clipboardSyncRef = useRef<ReturnType<typeof attachVncClipboardSync> | null>(null)
  // RFB 事件回调在 connect 时注册一次，用 ref 拿最新 viewOnly/t，避免 connect 身份抖动触发重连
  const viewOnlyRef = useRef(viewOnly)
  const tRef = useRef(t)
  viewOnlyRef.current = viewOnly
  tRef.current = t

  const connect = useCallback(
    async (targetPort: number) => {
      if (!containerRef.current) return
      resolutionCleanupRef.current?.()
      resolutionCleanupRef.current = null
      rfbRef.current?.disconnect()
      rfbRef.current = null
      containerRef.current.innerHTML = ''
      setStatus('connecting')
      setError('')
      setDesktopName('')
      setCredentialTypes([])
      const seq = ++connectSeqRef.current
      const targetDisplay = targetPort - VNC_PORT_RANGE.min
      // 换屏时丢弃上一屏的暂存凭据，避免旧密码被自动应答到新屏
      if (credentialsForRef.current !== null && credentialsForRef.current !== targetDisplay) {
        credentialsRef.current = null
      }
      credentialsForRef.current = targetDisplay
      let url: string
      let RFB: typeof RFBType
      let storedPassword: string | undefined
      try {
        let stored: { password?: string } | undefined
        ;[url, { default: RFB }, stored] = await Promise.all([
          getWebSocketUrl(getVncWebSocketBase(hostId, targetPort)),
          import('@novnc/novnc'),
          api.vnc.getPassword(hostId, targetDisplay).catch(() => undefined),
        ])
        storedPassword = stored?.password
      } catch (err) {
        setStatus('idle')
        setError(err instanceof Error ? err.message : String(err))
        return
      }
      // 等待 ticket/模块期间发生了新的 connect 或卸载，丢弃本次结果避免双 RFB
      if (seq !== connectSeqRef.current || !containerRef.current) return
      // 命中存储：预置 credentialsRef 让 credentialsrequired 自动应答不弹表单，同时预填表单给可手改路径
      if (storedPassword) {
        credentialsRef.current = { password: storedPassword }
        setPassword(storedPassword)
        setRememberPassword(true)
      } else {
        setRememberPassword(false)
      }
      portRef.current = targetPort
      wsCloseRef.current = null
      vncDebug('connect', { hostId, port: targetPort, url: url.replace(/ticket=[^&]+/, 'ticket=<redacted>') })
      installVncRequestThrottle(RFB)
      installVncLosslessFilter(RFB)
      const rfb = new RFB(containerRef.current, url, { shared: true })
      const ws = (rfb as unknown as { _sock?: { _websocket?: WebSocket } })._sock?._websocket
      ws?.addEventListener('close', (event) => {
        wsCloseRef.current = { code: event.code, reason: event.reason }
        vncDebug('ws close', event.code, event.reason)
      })
      ws?.addEventListener('error', () => vncDebug('ws error'))
      rfb.scaleViewport = true
      rfb.viewOnly = viewOnlyRef.current
      rfb.qualityLevel = tuningRef.current.quality
      rfb.compressionLevel = tuningRef.current.compression
      const instrumentation = attachVncInstrumentation(rfb)
      instrumentation.setMaxFps(tuningRef.current.maxFps)
      instrumentation.setLossless(tuningRef.current.lossless)
      instrumentationRef.current = instrumentation
      resolutionCleanupRef.current = applyVncResolution(rfb, RFB, resolutionRef.current, viewOnlyRef.current)
      rfb.addEventListener('connect', () => {
        vncDebug('rfb connected')
        setStatus('connected')
      })
      rfb.addEventListener('disconnect', (event) => {
        vncDebug('rfb disconnect', event.detail)
        rfbRef.current = null
        instrumentationRef.current?.dispose()
        instrumentationRef.current = null
        resolutionCleanupRef.current?.()
        resolutionCleanupRef.current = null
        setStatus('disconnected')
        setCredentialTypes([])
        if (!event.detail.clean) {
          const wsClose = wsCloseRef.current
          setError(
            wsClose?.reason
              ? `${tRef.current('vnc.disconnectUnclean')} (${wsClose.code} ${wsClose.reason})`
              : tRef.current('vnc.disconnectUnclean'),
          )
        }
      })
      rfb.addEventListener('credentialsrequired', (event) => {
        vncDebug('credentialsrequired', event.detail.types)
        const saved = credentialsRef.current
        if (saved) {
          rfb.sendCredentials({ username: saved.username, password: saved.password })
          return
        }
        setCredentialTypes(event.detail.types)
      })
      rfb.addEventListener('securityfailure', (event) => {
        vncDebug('securityfailure', event.detail)
        credentialsRef.current = null
        setRememberPassword(false)
        // 存储的密码已被服务端拒绝：清掉防 auto-send→失败死循环，回落表单（预填值仍在可手改）
        void api.vnc.deletePassword(hostId, targetDisplay).catch(() => {})
        setError(event.detail.reason || `${tRef.current('vnc.securityFailure')} (${event.detail.status})`)
      })
      rfb.addEventListener('desktopname', (event) => setDesktopName(event.detail.name))
      // 远端→本地剪贴板透传：浏览器要求聚焦/激活态/权限，写不进时挂起到下一次手势补写
      rfb.addEventListener('clipboard', (event) => {
        clipboardSyncRef.current?.onServerClipboard(event.detail.text)
      })
      rfbRef.current = rfb
      wasActiveRef.current = true
    },
    [hostId],
  )

  const disconnect = useCallback(() => {
    connectSeqRef.current += 1
    wasActiveRef.current = false
    // 先恢复远端分辨率再断连，cleanup 里发 SetDesktopSize 需要 socket 还活着
    resolutionCleanupRef.current?.()
    resolutionCleanupRef.current = null
    rfbRef.current?.disconnect()
    rfbRef.current = null
    setStatus('idle')
  }, [])

  const connectPort = useCallback(
    (target: number) => {
      setSelectedDisplay(target - VNC_PORT_RANGE.min)
      setPickerOpen(false)
      setCustomPort('')
      writeVncPort(hostId, target)
      void connect(target)
    },
    [connect, hostId],
  )
  const handleConnect = useCallback(() => {
    connectPort(Math.min(VNC_PORT_RANGE.max, Math.max(VNC_PORT_RANGE.min, VNC_PORT_RANGE.min + selectedDisplay)))
  }, [connectPort, selectedDisplay])

  const refreshDisplays = useCallback(async () => {
    try {
      const result = await api.vnc.displays(hostId)
      setDisplays(result.displays)
    } catch {
      setDisplays(null)
    }
  }, [hostId])

  const displayAction = useCallback(
    async (action: 'start' | 'stop', display: number) => {
      setDisplayBusy(display)
      setDisplayHint('')
      try {
        const result = await api.vnc.displayAction(hostId, action, display)
        setDisplays(result.displays)
        if (result.needPassword) setDisplayHint(t('vnc.displayNeedPassword'))
        else if (result.noServer) setDisplayHint(t('vnc.displayNoServer'))
        if (action === 'start' && result.ok) connectPort(VNC_PORT_RANGE.min + display)
      } catch {
        setDisplayHint(t('vnc.displayActionFailed'))
      } finally {
        setDisplayBusy(null)
      }
    },
    [connectPort, hostId, t],
  )

  // 连接状态变化后刷新 display 列表，让状态点跟上真实监听情况
  useEffect(() => {
    if (status === 'connected' || status === 'disconnected') void refreshDisplays()
  }, [status, refreshDisplays])

  // 5s 轮询 displays：stats 条 mem 列与 picker 行内存共用这一份数据，不起第二个定时器
  useEffect(() => {
    if (!((showStats && status === 'connected') || pickerOpen)) return
    void refreshDisplays()
    const timer = setInterval(() => void refreshDisplays(), 5000)
    return () => clearInterval(timer)
  }, [showStats, status, pickerOpen, refreshDisplays])
  const selectedDisplayRssKB = displays?.find((d) => d.display === selectedDisplay)?.rssKB

  // 窄屏/竖屏状态实时跟随（窗口缩放、设备旋转）
  useEffect(() => {
    const mobileMq = window.matchMedia(MOBILE_QUERY)
    const portraitMq = window.matchMedia('(orientation: portrait)')
    const syncMobile = () => setIsMobileLayout(mobileMq.matches)
    const syncPortrait = () => setIsPortrait(portraitMq.matches)
    mobileMq.addEventListener('change', syncMobile)
    portraitMq.addEventListener('change', syncPortrait)
    syncMobile()
    syncPortrait()
    return () => {
      mobileMq.removeEventListener('change', syncMobile)
      portraitMq.removeEventListener('change', syncPortrait)
    }
  }, [])
  // 卸载或断开连接时归还方向锁（仅我们 lock 过的情况）
  useEffect(() => {
    if (status === 'connected' || !orientationLockedRef.current) return
    orientationLockedRef.current = false
    try {
      screen.orientation?.unlock?.()
    } catch {
      /* iOS Safari 无此 API */
    }
  }, [status])
  useEffect(
    () => () => {
      if (!orientationLockedRef.current) return
      orientationLockedRef.current = false
      try {
        screen.orientation?.unlock?.()
      } catch {
        /* 同上 */
      }
    },
    [],
  )
  const enterLandscapeFullscreen = () => {
    setRotateHintDismissed(true)
    // Android Chrome 要先 fullscreen 才能 lock；iOS Safari 两 API 都没有，失败静默只当提示
    containerRef.current
      ?.requestFullscreen?.()
      .then(() => {
        // lock 在部分 TS DOM lib / iOS Safari 缺席：可选调用+失败静默
        return (screen.orientation as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.('landscape')
      })
      .then(() => {
        orientationLockedRef.current = true
      })
      .catch(() => {})
  }
  const sendMobileKey = (keysym: number, code = '') => {
    rfbRef.current?.sendKey(keysym, code, true)
    rfbRef.current?.sendKey(keysym, code, false)
  }
  // 非受控 input + inputType 分支：IME 组字整串提交也逐字符发，Backspace 在 keydown 已拦故不会重复
  const handleKeyboardNativeInput = (event: React.FormEvent<HTMLInputElement>) => {
    const ev = event.nativeEvent as InputEvent
    if ((ev.inputType === 'insertText' || ev.inputType === 'insertCompositionText') && ev.data) {
      for (const ch of ev.data) sendMobileKey(keysymForChar(ch))
    } else if (ev.inputType === 'deleteContentBackward') {
      sendMobileKey(MOBILE_KEYSYM.Backspace, 'Backspace')
    } else if (ev.inputType === 'deleteContentForward') {
      sendMobileKey(MOBILE_KEYSYM.Delete, 'Delete')
    }
  }
  const handleKeyboardKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const keysym = MOBILE_KEYSYM[event.key]
    if (keysym === undefined) return
    event.preventDefault()
    sendMobileKey(keysym, event.key)
    if (event.key === 'Escape') setMobileKeyboardOpen(false)
  }
  // 输入条存在期间失焦即收回；开/关条都不动 rfb 连接
  const toggleMobileKeyboard = () => {
    setMobileKeyboardOpen((open) => {
      const next = !open
      if (next) {
        if (keyboardInputRef.current) keyboardInputRef.current.value = ''
        setTimeout(() => keyboardInputRef.current?.focus(), 0)
      }
      return next
    })
  }

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly
  }, [viewOnly])
  // 画质实时生效：quality/compression setter 会重发 SetEncodings；帧率写回 FBU 请求节流器
  useEffect(() => {
    try {
      localStorage.setItem('tmuxgo:vnc-tuning', JSON.stringify(tuning))
    } catch {
      /* 存储不可用时静默 */
    }
    if (rfbRef.current) {
      rfbRef.current.qualityLevel = tuning.quality
      rfbRef.current.compressionLevel = tuning.compression
    }
    instrumentationRef.current?.setMaxFps(tuning.maxFps)
    instrumentationRef.current?.setLossless(tuning.lossless)
  }, [tuning])
  // 分辨率实时生效：断连时随 RFB 一起释放，连接中直接发 SetDesktopSize
  useEffect(() => {
    try {
      localStorage.setItem('tmuxgo:vnc-resolution', resolution)
    } catch {
      /* 存储不可用时静默 */
    }
    resolutionCleanupRef.current?.()
    resolutionCleanupRef.current = null
    const rfb = rfbRef.current
    if (rfb) {
      const RFB = rfb.constructor as typeof RFBType
      resolutionCleanupRef.current = applyVncResolution(rfb, RFB, resolution, viewOnly)
    }
  }, [resolution, viewOnly])
  useEffect(() => {
    try {
      localStorage.setItem('tmuxgo:vnc-stats', showStats ? '1' : '0')
    } catch {
      /* 同上 */
    }
  }, [showStats])
  // 统计采样：1s 出 fps/带宽，2s 一次 gateway RTT；仅连接中且开关打开时跑
  useEffect(() => {
    if (!showStats || status !== 'connected') return
    // 打开面板前先丢弃累计值重置基线，否则首个样本把连接以来的总量摊进速率
    instrumentationRef.current?.sample()
    const sampleTimer = setInterval(() => {
      const sample = instrumentationRef.current?.sample() || { fps: 0, inKbps: 0, outKbps: 0 }
      setStats((prev) => ({ ...sample, rtt: prev.rtt }))
    }, 1000)
    let rttCancelled = false
    const pollRtt = () =>
      void measureVncRtt().then((rtt) => {
        if (!rttCancelled) setStats((prev) => ({ ...prev, rtt }))
      })
    pollRtt()
    const rttTimer = setInterval(pollRtt, 2000)
    return () => {
      rttCancelled = true
      clearInterval(sampleTimer)
      clearInterval(rttTimer)
    }
  }, [showStats, status])
  useEffect(() => {
    if (!document.hidden) void connect(port)
    return () => {
      connectSeqRef.current += 1
      resolutionCleanupRef.current?.()
      resolutionCleanupRef.current = null
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [connect, port])
  // 浏览器 tab 隐藏即断流：整棵 VNC 链路（WS→TCP）随 RFB.disconnect 拆除，回前台自动重连
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        hiddenRef.current = true
        wasActiveRef.current = rfbRef.current !== null
        vncDebug('hidden: disconnect', { wasActive: wasActiveRef.current })
        connectSeqRef.current += 1
        resolutionCleanupRef.current?.()
        resolutionCleanupRef.current = null
        rfbRef.current?.disconnect()
        rfbRef.current = null
        setCredentialTypes([])
      } else if (hiddenRef.current) {
        hiddenRef.current = false
        vncDebug('visible: reconnect?', { wasActive: wasActiveRef.current })
        if (wasActiveRef.current) void connect(portRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [connect])
  // 剪贴板双向透传：本地→远端走 paste 事件（零权限），远端→本地挂起补写到下一次手势；详见 lib/vnc-clipboard
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const sync = attachVncClipboardSync(
      container,
      () => rfbRef.current,
      () => viewOnlyRef.current,
    )
    clipboardSyncRef.current = sync
    return () => {
      clipboardSyncRef.current = null
      sync.dispose()
    }
  }, [])

  const submitCredentials = () => {
    const credentials = { username: credentialTypes.includes('username') ? username : undefined, password }
    credentialsRef.current = credentials
    rfbRef.current?.sendCredentials(credentials)
    // 记住密码：勾选写存储，未勾清残留（旧密码不能留下次误用）
    const display = portRef.current - VNC_PORT_RANGE.min
    if (rememberPassword) void api.vnc.setPassword(hostId, display, password).catch(() => {})
    else void api.vnc.deletePassword(hostId, display).catch(() => {})
    setCredentialTypes([])
    setPassword('')
  }
  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) rfbRef.current?.clipboardPasteFrom(text)
    } catch {
      pushToast({ type: 'error', message: t('vnc.clipboardDenied') })
    }
  }

  const checkSetup = useCallback(async () => {
    setSetupBusy('check')
    try {
      const result = await api.vnc.status(hostId)
      setSetupInfo({ status: result.status, manualCommand: result.manualCommand })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSetupBusy('')
    }
  }, [hostId, pushToast])

  const runSetup = useCallback(
    async (action: 'install' | 'start') => {
      setSetupBusy(action)
      try {
        const result = await api.vnc.setup(hostId, action)
        setSetupInfo({ status: result.status, manualCommand: result.manualCommand, needSudo: result.needSudo })
        if (result.ok) {
          setSetupOpen(false)
          void connect(portRef.current)
        }
      } catch (err) {
        pushToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        setSetupBusy('')
      }
    },
    [hostId, pushToast, connect],
  )

  const copyManualCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setSetupCopied(true)
      setTimeout(() => setSetupCopied(false), 1500)
    } catch {
      setSetupCopied(false)
    }
  }, [])

  const statusLabel =
    status === 'connected'
      ? t('vnc.connected')
      : status === 'connecting'
        ? t('vnc.connecting')
        : status === 'disconnected'
          ? t('vnc.disconnected')
          : ''
  return (
    <section className="tmuxgo-content-surface flex h-full min-h-0 flex-col overflow-hidden">
      <header
        data-desktop-titlebar
        className={`flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 ${
          view === 'window' ? 'touch-none select-none' : ''
        }`}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-apple bg-bg-2 text-accent">
          <FiMonitor size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-text-1">{desktopName || t('vnc.title')}</div>
          <div className="truncate text-caption text-text-3">
            {hostId}
            {statusLabel ? ` · ${statusLabel}` : ''}
          </div>
        </div>
        <div className="relative" onMouseLeave={() => setPickerOpen(false)}>
          <button
            type="button"
            onClick={() => {
              const next = !pickerOpen
              setPickerOpen(next)
              if (next) void refreshDisplays()
            }}
            aria-label={t('vnc.displays')}
            title={t('vnc.displays')}
            className="flex h-7 items-center gap-1.5 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none hover:border-accent"
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background:
                  displayBusy === selectedDisplay
                    ? 'var(--warning, #d29922)'
                    : displays?.some((d) => d.display === selectedDisplay)
                      ? 'var(--accent-2)'
                      : 'var(--text-3)',
              }}
            />
            :{selectedDisplay}
          </button>
          {pickerOpen && (
            <div className="tmuxgo-glass absolute left-0 top-8 z-20 flex w-52 flex-col gap-0.5 rounded-apple-lg p-1.5 text-xs text-text-1">
              {/* 基础候选 :0-:9 ∪ 已探测到的运行中 display ∪ 当前选中项 */}
              {[...new Set([...Array(10).keys(), ...(displays || []).map((d) => d.display), selectedDisplay])]
                .sort((a, b) => a - b)
                .map((n) => {
                  const running = displays?.find((d) => d.display === n)
                  const busy = displayBusy === n
                  return (
                    <div
                      key={n}
                      className={`group flex h-7 items-center gap-2 rounded-apple px-2 ${
                        n === selectedDisplay ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--line)]/40'
                      }`}
                    >
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${busy ? 'animate-pulse' : ''}`}
                        style={{
                          background: busy ? 'var(--warning, #d29922)' : running ? 'var(--accent-2)' : 'var(--text-3)',
                        }}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
                        onClick={() => {
                          if (running) connectPort(VNC_PORT_RANGE.min + n)
                          else {
                            setSelectedDisplay(n)
                            setPickerOpen(false)
                          }
                        }}
                      >
                        <span className="font-mono">:{n}</span>
                        <span className="truncate text-text-3">
                          {running?.process || `59${String(n).padStart(2, '0')}`}
                        </span>
                      </button>
                      <span className="shrink-0 font-mono text-[10px] text-text-3">
                        {running?.rssKB ? formatSize(running.rssKB * 1024) : '~'}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={running ? t('vnc.displayStop') : t('vnc.displayStart')}
                        title={running ? t('vnc.displayStop') : t('vnc.displayStart')}
                        onClick={(event) => {
                          event.stopPropagation()
                          void displayAction(running ? 'stop' : 'start', n)
                        }}
                        className={`shrink-0 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-50 ${
                          running ? 'text-red-400 hover:text-red-300' : 'text-accent-2 hover:text-accent'
                        }`}
                      >
                        {running ? <FiSquare size={11} /> : <FiPlay size={11} />}
                      </button>
                    </div>
                  )
                })}
              {displays === null && <div className="px-2 py-1 text-text-3">{t('vnc.displaysLoading')}</div>}
              {displayHint && <div className="px-2 py-1 text-[11px] text-warning">{displayHint}</div>}
              {/* 兜底：列表外的端口手动输入（候选覆盖不到的非标准 display 仍可连） */}
              <div className="mt-0.5 flex items-center gap-1.5 border-t border-[var(--line)]/50 px-2 pt-1.5">
                <input
                  value={customPort}
                  onChange={(event) => setCustomPort(event.target.value.replace(/\D/g, '').slice(0, 4))}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    const next = Number(customPort)
                    if (Number.isInteger(next) && next >= VNC_PORT_RANGE.min && next <= VNC_PORT_RANGE.max)
                      connectPort(next)
                  }}
                  inputMode="numeric"
                  placeholder="5900-5999"
                  aria-label={t('vnc.customPort')}
                  title={t('vnc.customPort')}
                  className="h-6 min-w-0 flex-1 rounded-apple border border-[var(--line)] bg-bg-1 px-1.5 font-mono text-xs text-text-1 outline-none focus:border-accent"
                />
                <button
                  type="button"
                  aria-label={t('vnc.connect')}
                  title={t('vnc.connect')}
                  onClick={() => {
                    const next = Number(customPort)
                    if (Number.isInteger(next) && next >= VNC_PORT_RANGE.min && next <= VNC_PORT_RANGE.max)
                      connectPort(next)
                  }}
                  className="shrink-0 text-accent hover:text-accent-2"
                >
                  <FiPlay size={11} />
                </button>
              </div>
            </div>
          )}
        </div>
        {status === 'connected' || status === 'connecting' ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={disconnect}
            aria-label={t('vnc.disconnect')}
            title={t('vnc.disconnect')}
          >
            <FiSquare size={14} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleConnect}
            aria-label={t('vnc.connect')}
            title={t('vnc.connect')}
          >
            <FiPlay size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setViewOnly((value) => !value)}
          aria-label={t('vnc.viewOnly')}
          title={t('vnc.viewOnly')}
          className={viewOnly ? 'text-accent' : ''}
        >
          {viewOnly ? <FiEyeOff size={14} /> : <FiEye size={14} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => rfbRef.current?.sendCtrlAltDel()}
          disabled={status !== 'connected' || viewOnly}
          aria-label={t('vnc.sendCad')}
          title={t('vnc.sendCad')}
        >
          <FiKey size={14} />
        </Button>
        {isMobileLayout && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleMobileKeyboard}
            disabled={status !== 'connected' || viewOnly}
            aria-label={t('vnc.mobileKeyboard')}
            title={t('vnc.mobileKeyboard')}
            className={mobileKeyboardOpen ? 'text-accent' : ''}
          >
            <FiType size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void pasteClipboard()}
          disabled={status !== 'connected' || viewOnly}
          aria-label={t('vnc.paste')}
          title={t('vnc.paste')}
        >
          <FiClipboard size={14} />
        </Button>
        {status !== 'connected' && status !== 'connecting' && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              const next = !setupOpen
              setSetupOpen(next)
              if (next && !setupInfo && !setupBusy) void checkSetup()
            }}
            aria-label={t('vnc.setupCheck')}
            title={t('vnc.setupCheck')}
            className={setupOpen ? 'text-accent' : ''}
          >
            <FiTool size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setTuningOpen((value) => !value)}
          aria-label={t('vnc.tuning')}
          title={t('vnc.tuning')}
          className={tuningOpen ? 'text-accent' : ''}
        >
          <FiSliders size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowStats((value) => !value)}
          aria-label={t('vnc.showStats')}
          title={t('vnc.showStats')}
          className={showStats ? 'text-accent' : ''}
        >
          <FiActivity size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onViewChange('full')}
          aria-label={t('vnc.fullscreen')}
          title={t('vnc.fullscreen')}
          className={view === 'full' ? 'text-accent' : ''}
        >
          <FiMaximize2 size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onMinimize}
          aria-label={t('vnc.minimize')}
          title={t('vnc.minimize')}
        >
          <FiMinus size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onViewChange('window')}
          aria-label={t('vnc.windowed')}
          title={t('vnc.windowed')}
          className={view === 'window' ? 'text-accent' : ''}
        >
          <FiMinimize2 size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <FiX size={15} />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 bg-black">
        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
        {isMobileLayout && isPortrait && status === 'connected' && !rotateHintDismissed && (
          <div className="tmuxgo-glass absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-apple-lg px-3 py-1.5 text-xs text-text-1">
            <span>{t('vnc.rotateHint')}</span>
            <button
              type="button"
              onClick={enterLandscapeFullscreen}
              className="rounded-apple bg-accent/15 px-2 py-0.5 text-accent"
            >
              {t('vnc.landscapeFullscreen')}
            </button>
            <button
              type="button"
              onClick={() => setRotateHintDismissed(true)}
              aria-label={t('common.close')}
              className="text-text-3"
            >
              <FiX size={13} />
            </button>
          </div>
        )}
        {isMobileLayout && mobileKeyboardOpen && status === 'connected' && (
          // 虚拟键盘顶起时画布被压缩：bottom 跟随 --mobile-keyboard-inset（与 MobileNav 同一变量）
          <div
            className="tmuxgo-glass absolute inset-x-2 z-20 flex items-center gap-1.5 rounded-apple-lg p-1.5"
            style={{ bottom: 'calc(8px + var(--mobile-keyboard-inset, 0px))' }}
          >
            <input
              ref={keyboardInputRef}
              onInput={handleKeyboardNativeInput}
              onKeyDown={handleKeyboardKeyDown}
              onBlur={() => setMobileKeyboardOpen(false)}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              aria-label={t('vnc.mobileKeyboard')}
              placeholder={t('vnc.mobileKeyboardPlaceholder')}
              className="h-8 min-w-0 flex-1 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-accent"
            />
            <button
              type="button"
              // mousedown 抢在 input blur 前：否则失焦先收条，点击丢失
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => sendMobileKey(MOBILE_KEYSYM.Enter, 'Enter')}
              className="h-8 shrink-0 rounded-apple bg-accent/15 px-2.5 text-xs text-accent"
            >
              Enter
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setMobileKeyboardOpen(false)}
              className="h-8 shrink-0 rounded-apple px-2.5 text-xs text-text-2"
            >
              {t('common.close')}
            </button>
          </div>
        )}
        {showStats && status === 'connected' && (
          // 浮层永远压在黑色画布上：文字固定白色，不随主题切换，浅色主题下也可读
          <div className="absolute right-3 top-3 z-20 rounded-apple bg-black/70 px-2.5 py-1 font-mono text-caption tabular-nums text-white">
            {stats.fps} fps · ↓{stats.inKbps.toFixed(1)} KB/s ↑{stats.outKbps.toFixed(1)} KB/s
            {stats.rtt !== null ? ` · ${stats.rtt}ms` : ''} · mem{' '}
            {selectedDisplayRssKB ? formatSize(selectedDisplayRssKB * 1024) : '~'}
          </div>
        )}
        {tuningOpen && (
          <div className="tmuxgo-glass absolute right-3 top-10 z-20 flex w-64 flex-col gap-2.5 rounded-apple-lg p-3 text-xs text-text-1">
            <div className="flex items-center justify-between">
              <span className="font-medium">{t('vnc.tuning')}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setTuningOpen(false)}
                aria-label={t('common.close')}
              >
                <FiX size={13} />
              </Button>
            </div>
            <div className="flex gap-1.5">
              {(['speed', 'balanced', 'saver'] as const).map((key) => {
                const preset = VNC_TUNING_PRESETS[key]
                const active = sameVncTuning(tuning, preset)
                return (
                  <Button
                    key={key}
                    variant={active ? 'primary' : 'ghost'}
                    size="sm"
                    className="flex-1"
                    onClick={() => applyTuning({ ...preset })}
                  >
                    {t(`vnc.preset.${key}`)}
                  </Button>
                )
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={!prevTuning || sameVncTuning(prevTuning, tuning)}
              onClick={() => prevTuning && applyTuning({ ...prevTuning })}
              title={prevTuning ? `${prevTuning.quality}/${prevTuning.compression}/${prevTuning.maxFps}` : undefined}
            >
              {t('vnc.restorePrev')}
            </Button>
            {(
              [
                { key: 'quality', label: t('vnc.quality'), range: VNC_QUALITY_RANGE },
                { key: 'compression', label: t('vnc.compression'), range: VNC_COMPRESSION_RANGE },
                { key: 'maxFps', label: t('vnc.maxFps'), range: VNC_FPS_RANGE },
              ] as const
            ).map(({ key, label, range }) => (
              <label key={key} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-text-3">{label}</span>
                <input
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={1}
                  value={tuning[key]}
                  onChange={(event) => applyTuning({ ...tuning, [key]: Number(event.target.value) })}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                  aria-label={label}
                />
                <span className="w-6 text-right font-mono text-text-2">{tuning[key]}</span>
              </label>
            ))}
            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-text-3">{t('vnc.resolution')}</span>
              <Select
                value={resolution}
                onChange={setResolution}
                disabled={viewOnly}
                title={viewOnly ? t('vnc.viewOnly') : undefined}
                options={[
                  { value: 'off', label: t('vnc.resolution.off') },
                  { value: 'auto', label: t('vnc.resolution.auto') },
                  ...VNC_RESOLUTION_PRESETS.map((preset) => ({ value: preset, label: preset.replace('x', '×') })),
                ]}
                className="h-7 min-w-0 flex-1 rounded-apple px-1.5 text-xs"
              />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-text-3">{t('vnc.lossless')}</span>
              <input
                type="checkbox"
                checked={tuning.lossless}
                onChange={(event) => applyTuning({ ...tuning, lossless: event.target.checked })}
                className="accent-[var(--accent)]"
                title={t('vnc.losslessHint')}
              />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-text-3">{t('vnc.showStats')}</span>
              <input
                type="checkbox"
                checked={showStats}
                onChange={(event) => setShowStats(event.target.checked)}
                className="accent-[var(--accent)]"
              />
            </label>
          </div>
        )}
        {credentialTypes.length > 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
            <form
              className="tmuxgo-glass flex w-64 flex-col gap-2 rounded-apple-lg p-4"
              onSubmit={(event) => {
                event.preventDefault()
                submitCredentials()
              }}
            >
              <div className="text-xs font-medium text-text-1">{t('vnc.credentialsRequired')}</div>
              {credentialTypes.includes('username') && (
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t('vnc.username')}
                  autoComplete="username"
                  className="h-8 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-accent"
                />
              )}
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('vnc.password')}
                autoComplete="current-password"
                autoFocus
                className="h-8 rounded-apple border border-[var(--line)] bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-accent"
              />
              <label className="flex items-center gap-1.5 text-caption text-text-2">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(event) => setRememberPassword(event.target.checked)}
                />
                {t('vnc.rememberPassword')}
              </label>
              <Button type="submit" size="sm">
                {t('vnc.connect')}
              </Button>
            </form>
          </div>
        )}
        {setupOpen && credentialTypes.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
            <div className="tmuxgo-glass flex w-80 max-w-full flex-col gap-2 rounded-apple-lg p-4 text-xs text-text-1">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t('vnc.setupCheck')}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSetupOpen(false)}
                  aria-label={t('common.close')}
                >
                  <FiX size={13} />
                </Button>
              </div>
              {setupBusy === 'check' && <div className="text-text-3">{t('vnc.setupChecking')}</div>}
              {setupInfo && (
                <>
                  <div className="text-text-3">
                    {setupInfo.status.os || '?'}
                    {setupInfo.status.server ? ` · ${setupInfo.status.server}` : ' · no vnc server'}
                    {setupInfo.status.listening ? ' · :5900' : ''}
                  </div>
                  {setupInfo.status.hint === 'macos-builtin' && <div>{t('vnc.setupMacos')}</div>}
                  {setupInfo.status.hint === 'wayland-compositor' && <div>{t('vnc.setupWayland')}</div>}
                  {setupInfo.status.hint === 'unsupported-os' && <div>{t('vnc.setupUnsupported')}</div>}
                  {setupInfo.status.listening && <div className="text-accent-2">{t('vnc.setupReady')}</div>}
                  {setupInfo.status.supported && setupInfo.status.server && !setupInfo.status.listening && (
                    <Button size="sm" disabled={!!setupBusy} onClick={() => void runSetup('start')}>
                      {setupBusy === 'start' ? t('vnc.setupInstalling') : t('vnc.setupStart')}
                    </Button>
                  )}
                  {setupInfo.status.supported &&
                    !setupInfo.status.server &&
                    setupInfo.status.sudo &&
                    !setupInfo.needSudo && (
                      <Button size="sm" disabled={!!setupBusy} onClick={() => void runSetup('install')}>
                        {setupBusy === 'install' ? t('vnc.setupInstalling') : t('vnc.setupInstall')}
                      </Button>
                    )}
                  {(setupInfo.needSudo ||
                    (setupInfo.status.supported && !setupInfo.status.sudo && !setupInfo.status.server) ||
                    setupInfo.status.hint === 'unsupported-os') && (
                    <>
                      <div className="text-text-3">
                        {t(setupInfo.needSudo ? 'vnc.setupNeedSudo' : 'vnc.setupManual')}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-bg-1 px-2 py-1 text-caption">
                          {setupInfo.manualCommand}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void copyManualCommand(setupInfo.manualCommand)}
                          aria-label={t('vnc.copyCommand')}
                          title={t('vnc.copyCommand')}
                        >
                          <FiCopy size={13} />
                        </Button>
                      </div>
                      {setupCopied && <div className="text-accent-2">{t('vnc.copied')}</div>}
                    </>
                  )}
                </>
              )}
              {!setupInfo && setupBusy !== 'check' && (
                <Button size="sm" onClick={() => void checkSetup()}>
                  {t('vnc.setupCheck')}
                </Button>
              )}
            </div>
          </div>
        )}
        {(status !== 'connected' || error) && credentialTypes.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
            <div
              className={`rounded-apple px-3 py-1.5 text-xs ${error ? 'bg-danger/90 text-white' : 'bg-bg-1/90 text-text-2'}`}
            >
              {error ||
                (status === 'connecting'
                  ? t('vnc.connecting')
                  : status === 'disconnected'
                    ? t('vnc.disconnected')
                    : t('vnc.idle'))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
