'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FiArrowLeft,
  FiArrowRight,
  FiCompass,
  FiCopy,
  FiCrosshair,
  FiMaximize2,
  FiMinimize,
  FiMinimize2,
  FiMinus,
  FiPlus,
  FiRefreshCw,
  FiSquare,
  FiTool,
  FiX,
} from 'react-icons/fi'
import { Button } from './Button'
import { BrowserPickResultCard } from './BrowserPickResult'
import { api, type BrowserEngineState, type BrowserPickElement } from '@/lib/api'
import { getWebSocketUrl } from '@/lib/auth'
import { getApiBase } from '@/lib/runtime-endpoints'
import { isImeKeyEvent } from '@/lib/terminal-platform'
import { useConsoleStore, type DesktopViewMode } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { MOBILE_QUERY } from '@/lib/console-device-state'

type WsState = 'connecting' | 'open' | 'closed'
interface BrowserTarget {
  id: string
  url: string
  title: string
}

const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const
// gateway 侧 resize 钳制 200..3840，前端用同一阈值过滤掉过小尺寸
const MIN_VIEW_SIZE = 200
const RESIZE_DEBOUNCE_MS = 150
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 8000
// 进入 ready 后等首帧的宽限：正常绑定路径首帧要几百 ms 才到；超时无帧说明 client 没被绑 page
const READY_REBIND_DELAY_MS = 700
// mousemove 节流：screencast 本身 ~5fps，高频指针事件合并到 32ms 粒度足够
const MOUSE_MOVE_INTERVAL_MS = 32

// WS 只跑 JSON 文本帧；getApiBase() 在浏览器里即页面 origin，http(s) 换成 ws(s)
const getStreamBase = () => `${getApiBase().replace(/^http/, 'ws')}/api/browser/stream`

// 裸词进搜索；scheme/localhost/IP:port/带点域名直开。
// scheme 判定不能只看 `foo:` 前缀——`localhost:8080` 会被误吃成 scheme，故要求 `://` 或已知裸 scheme
const BARE_SCHEMES = /^(about|data|blob|chrome|chrome-error|devtools|edge|file|javascript|mailto|tel|view-source):/i
export function normalizeBrowserAddress(raw: string) {
  const value = raw.trim()
  if (!value) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || BARE_SCHEMES.test(value)) return value
  if (!/\s/.test(value) && (value.includes('.') || value.includes(':') || value === 'localhost'))
    return `https://${value}`
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
}

interface BrowserViewProps {
  hostId: string
  view: DesktopViewMode
  // 应用内面板最小化（页面仍可见）：暂停画面流但保留 WS/session
  minimized?: boolean
  onViewChange: (view: DesktopViewMode) => void
  onMinimize: () => void
  onClose: () => void
}

export function BrowserView({ hostId, view, minimized = false, onViewChange, onMinimize, onClose }: BrowserViewProps) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const sectionRef = useRef<HTMLElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 隐藏 input 承担键盘/IME：canvas 不可编辑，composition 事件只在可编辑元素上触发
  const kbdInputRef = useRef<HTMLInputElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const connectSeqRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  // 帧页面尺寸（CSS px，screencast metadata.deviceWidth/Height）：坐标换算基准
  const frameSizeRef = useRef({ w: 0, h: 0 })
  const frameSeqRef = useRef(0)
  // idle/launching 期就连上的 client 在 gateway 侧没绑 page session；进入 ready 后
  // 若仍无帧流入说明没绑上，重连让 addClient→bindClient 补上（每次 ready 跃迁只补一次）
  const frameSeenRef = useRef(false)
  const readyRebindRef = useRef(false)
  const readyCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewSizeRef = useRef({ w: 0, h: 0 })
  const composingRef = useRef(false)
  // Chrome 在 compositionend 后补发一个 insertText input 事件重放提交串：靠它去重
  const justComposedRef = useRef(false)
  const movePendingRef = useRef<{ x: number; y: number } | null>(null)
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMoveAtRef = useRef(0)
  const pressedButtonRef = useRef(0)
  // 画面流暂停态：面板最小化或文档隐藏即停推。want 记录目标态，sent 记录已向当前
  // socket 推送的态——重连后服务端 client 重置为非暂停，sentPausedRef 必须在 onopen 归零
  const minimizedRef = useRef(minimized)
  minimizedRef.current = minimized
  const sentPausedRef = useRef(false)
  // pick 去抖/归属：seq 作废迟到的响应（取消/重发），targetRef 记发起时的 tab 供 cancel 指认
  const pickSeqRef = useRef(0)
  const pickTargetRef = useRef<string | null>(null)

  const [wsState, setWsState] = useState<WsState>('connecting')
  const [phase, setPhase] = useState<BrowserEngineState>('idle')
  const [phaseError, setPhaseError] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [targets, setTargets] = useState<BrowserTarget[]>([])
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null)
  const activeTargetIdRef = useRef<string | null>(null)
  activeTargetIdRef.current = activeTargetId
  const [addrDraft, setAddrDraft] = useState('')
  const [addrFocused, setAddrFocused] = useState(false)
  const [launchBusy, setLaunchBusy] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupInfo, setSetupInfo] = useState<{ installed: boolean; binary: string | null; hint: string } | null>(null)
  const [setupCopied, setSetupCopied] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isMobileLayout, setIsMobileLayout] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  )
  // IME 候选窗跟随点击点：把隐藏 input 挪到最近一次 canvas 点击处
  const [kbdPos, setKbdPos] = useState({ x: 0, y: 0 })
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)
  pickingRef.current = picking
  const [pickResult, setPickResult] = useState<BrowserPickElement | null>(null)

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  // 目标暂停态 = 面板最小化或文档隐藏；状态无变化或 ws 未 OPEN 时不发（onopen 统一补发）
  const pushPauseState = useCallback(() => {
    const want = minimizedRef.current || document.hidden
    if (sentPausedRef.current === want) return
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    sentPausedRef.current = want
    send({ type: want ? 'pause' : 'resume' })
  }, [send])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])
  const clearReadyCheck = useCallback(() => {
    if (readyCheckTimerRef.current !== null) {
      clearTimeout(readyCheckTimerRef.current)
      readyCheckTimerRef.current = null
    }
  }, [])

  const drawFrame = useCallback((data: unknown, width: unknown, height: unknown) => {
    const canvas = canvasRef.current
    if (!canvas || typeof data !== 'string') return
    const seq = ++frameSeqRef.current
    const img = new Image()
    img.onload = () => {
      // 只画最新帧：解码异步，旧帧后到不覆盖新画面
      if (seq !== frameSeqRef.current) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // 画布像素取 JPEG 实尺寸；screencast 超 maxWidth/maxHeight 会被缩图
      const w = img.naturalWidth || Number(width) || 0
      const h = img.naturalHeight || Number(height) || 0
      if (!w || !h) return
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      ctx.drawImage(img, 0, 0)
      // 坐标换算基准是页面 CSS px：metadata.deviceWidth/Height 即视口尺寸，
      // 缩图后 naturalWidth ≠ 页面宽，不能直接用它做映射
      frameSizeRef.current = { w: Number(width) || w, h: Number(height) || h }
      frameSeenRef.current = true
    }
    img.src = `data:image/jpeg;base64,${data}`
  }, [])

  const connectRef = useRef<() => void>(() => {})
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) return
    const attempt = reconnectAttemptsRef.current++
    reconnectTimerRef.current = setTimeout(
      () => {
        reconnectTimerRef.current = null
        // 页面隐藏期间不重连省流；回前台由 visibilitychange 触发
        if (!document.hidden) connectRef.current()
      },
      Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS),
    )
  }, [])

  const connect = useCallback(async () => {
    const seq = ++connectSeqRef.current
    clearReconnectTimer()
    clearReadyCheck()
    frameSeenRef.current = false
    wsRef.current?.close()
    wsRef.current = null
    setWsState('connecting')
    let url: string
    try {
      url = await getWebSocketUrl(getStreamBase())
    } catch {
      if (seq !== connectSeqRef.current) return
      setWsState('closed')
      scheduleReconnect()
      return
    }
    if (seq !== connectSeqRef.current) return
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      if (connectSeqRef.current !== seq || wsRef.current !== ws) return
      reconnectAttemptsRef.current = 0
      setWsState('open')
      // 断线期画布尺寸照常记录：open 后补发 resize，远端按当前画布排版
      const { w, h } = viewSizeRef.current
      if (w >= MIN_VIEW_SIZE && h >= MIN_VIEW_SIZE) send({ type: 'resize', width: w, height: h })
      // 新 socket = 服务端新 client（默认非暂停）：本地记录归零后补发当前目标态，
      // 覆盖"暂停期间重连/隐藏中连上"的竞态
      sentPausedRef.current = false
      pushPauseState()
    }
    ws.onmessage = (event) => {
      if (connectSeqRef.current !== seq) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      switch (msg.type) {
        case 'frame':
          drawFrame(msg.data, msg.width, msg.height)
          break
        case 'page':
          if (typeof msg.url === 'string') {
            setPageUrl(msg.url)
            // tab 条上同步最新 url（targets 广播有延迟，标题仍走 targets）
            const activeId = activeTargetIdRef.current
            if (activeId)
              setTargets((prev) =>
                prev.map((item) => (item.id === activeId ? { ...item, url: msg.url as string } : item)),
              )
          }
          break
        case 'targets':
          setTargets(Array.isArray(msg.targets) ? (msg.targets as BrowserTarget[]) : [])
          setActiveTargetId(typeof msg.activeTargetId === 'string' ? msg.activeTargetId : null)
          break
        case 'status': {
          const state = msg.state as BrowserEngineState
          setPhase(state)
          setPhaseError(typeof msg.error === 'string' ? msg.error : '')
          clearReadyCheck()
          if (state === 'ready') {
            // 延迟判定而非同步重连：连上已 ready 实例时首帧尚未到达，直接查 frameSeen 会误重连
            if (!readyRebindRef.current) {
              readyCheckTimerRef.current = setTimeout(() => {
                readyCheckTimerRef.current = null
                if (!frameSeenRef.current && connectSeqRef.current === seq) {
                  readyRebindRef.current = true
                  connectRef.current()
                }
              }, READY_REBIND_DELAY_MS)
            }
          } else {
            frameSeenRef.current = false
            readyRebindRef.current = false
          }
          break
        }
      }
    }
    ws.onclose = () => {
      if (connectSeqRef.current !== seq) return
      if (wsRef.current === ws) wsRef.current = null
      setWsState('closed')
      scheduleReconnect()
    }
    // error 细节拿不到有效信息，统一由 close 走重连
    ws.onerror = () => {}
  }, [clearReconnectTimer, clearReadyCheck, drawFrame, pushPauseState, scheduleReconnect, send])
  connectRef.current = () => void connect()

  // 本地立即复位；服务端挂起的 pick 由 cancel 端点收尾，其迟到响应被 seq 守卫丢弃
  const cancelPick = useCallback(() => {
    pickSeqRef.current += 1
    const targetId = pickTargetRef.current
    pickTargetRef.current = null
    setPicking(false)
    void api.browser.pickCancel(targetId ?? undefined).catch(() => {})
  }, [])

  const startPick = useCallback(async () => {
    const seq = ++pickSeqRef.current
    pickTargetRef.current = activeTargetIdRef.current
    setPicking(true)
    setPickResult(null)
    pushToast({ type: 'info', message: t('browser.pickHint') })
    try {
      const res = await api.browser.pick(activeTargetIdRef.current ?? undefined)
      if (seq !== pickSeqRef.current) return
      const result = res?.result
      if (result && !result.cancelled) setPickResult(result)
    } catch (err) {
      if (seq !== pickSeqRef.current) return
      const status = (err as { status?: number }).status
      pushToast({
        type: 'error',
        message: status === 409 ? t('browser.pickBusy') : err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (seq === pickSeqRef.current) {
        pickTargetRef.current = null
        setPicking(false)
      }
    }
  }, [pushToast, t])

  // 画布 CSS 像素 → 页面 CSS px：canvas 元素被 CSS 拉满容器，getBoundingClientRect 即显示尺寸
  const toPagePoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const frame = frameSizeRef.current
    if (!canvas || !frame.w || !frame.h) return null
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return {
      x: Math.round((Math.min(Math.max(clientX - rect.left, 0), rect.width) / rect.width) * frame.w),
      y: Math.round((Math.min(Math.max(clientY - rect.top, 0), rect.height) / rect.height) * frame.h),
    }
  }, [])
  const toPagePointRef = useRef(toPagePoint)
  toPagePointRef.current = toPagePoint

  const flushMouseMove = useCallback(() => {
    moveTimerRef.current = null
    lastMoveAtRef.current = Date.now()
    const pending = movePendingRef.current
    movePendingRef.current = null
    if (pending) send({ type: 'input', kind: 'mousemove', x: pending.x, y: pending.y })
  }, [send])
  const sendMouseMove = useCallback(
    (x: number, y: number) => {
      movePendingRef.current = { x, y }
      // 首个 move 立即发（leading），窗口内的后续 move 合成一次尾随发（trailing）
      const elapsed = Date.now() - lastMoveAtRef.current
      if (elapsed >= MOUSE_MOVE_INTERVAL_MS) {
        if (moveTimerRef.current !== null) clearTimeout(moveTimerRef.current)
        flushMouseMove()
      } else if (moveTimerRef.current === null) {
        moveTimerRef.current = setTimeout(flushMouseMove, MOUSE_MOVE_INTERVAL_MS - elapsed)
      }
    },
    [flushMouseMove],
  )

  // ResizeObserver 跟踪画布容器 → {type:'resize'}（setDeviceMetricsOverride + 重启 screencast 尺寸）
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      const rect = stage.getBoundingClientRect()
      const w = Math.round(rect.width)
      const h = Math.round(rect.height)
      if (w < MIN_VIEW_SIZE || h < MIN_VIEW_SIZE) return
      if (w === viewSizeRef.current.w && h === viewSizeRef.current.h) return
      viewSizeRef.current = { w, h }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        send({ type: 'resize', width: w, height: h })
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(stage)
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [send])

  // wheel 需要 preventDefault 且 React 17+ 根委托是 passive，只能原生挂非 passive 监听
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = toPagePointRef.current(event.clientX, event.clientY)
      if (point)
        send({ type: 'input', kind: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [send])

  // 挂载即连 WS：status/targets 由 gateway 主动推，未启动时也能看到 idle 态
  useEffect(() => {
    if (!document.hidden) void connect()
    return () => {
      connectSeqRef.current += 1
      pickSeqRef.current += 1
      clearReconnectTimer()
      clearReadyCheck()
      wsRef.current?.close()
      wsRef.current = null
      // 卸载时若有挂起 pick，通知 gateway 收尾，避免远端 evaluate 挂到超时
      if (pickingRef.current) void api.browser.pickCancel(pickTargetRef.current ?? undefined).catch(() => {})
    }
  }, [connect, clearReconnectTimer, clearReadyCheck])
  // tab 隐藏或面板最小化只暂停画面流不断 WS：浏览器实例/tab/session 全部保活；
  // 恢复续流（服务端补一帧）。隐藏期间掉线的由这里补连——scheduleReconnect 在 hidden 下会跳过
  useEffect(() => {
    const onVisibility = () => {
      pushPauseState()
      if (!document.hidden && !wsRef.current) void connect()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [connect, pushPauseState])
  useEffect(() => {
    pushPauseState()
  }, [minimized, pushPauseState])

  // 拾取态绑定发起时的 target：切 tab/断线/引擎退出后结果已无意义，兜底取消让按钮复位
  useEffect(() => {
    if (!picking) return
    if (phase !== 'ready' || wsState === 'closed' || activeTargetId !== pickTargetRef.current) cancelPick()
  }, [picking, phase, wsState, activeTargetId, cancelPick])

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const sync = () => setIsMobileLayout(mq.matches)
    mq.addEventListener('change', sync)
    sync()
    return () => mq.removeEventListener('change', sync)
  }, [])
  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void sectionRef.current?.requestFullscreen?.()
  }

  // 地址栏失焦期间跟随远端页面 url；编辑中不动用户输入
  useEffect(() => {
    if (!addrFocused) setAddrDraft(pageUrl)
  }, [pageUrl, addrFocused])

  const launch = useCallback(async () => {
    setLaunchBusy(true)
    try {
      const res = await api.browser.launch()
      if (res?.state) {
        setPhase(res.state)
        setPhaseError(res.error || '')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pushToast({ type: 'error', message })
      setPhase('error')
      setPhaseError(message)
    } finally {
      setLaunchBusy(false)
    }
  }, [pushToast])

  const stop = useCallback(() => {
    void api.browser.stop().catch((err) => {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }, [pushToast])

  const checkSetup = useCallback(async () => {
    setSetupBusy(true)
    try {
      const res = await api.browser.setup()
      setSetupInfo({ installed: res.status.installed, binary: res.status.binary, hint: res.hint })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSetupBusy(false)
    }
  }, [pushToast])

  const copySetupHint = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setSetupCopied(true)
      setTimeout(() => setSetupCopied(false), 1500)
    } catch {
      setSetupCopied(false)
    }
  }, [])

  const submitAddress = useCallback(() => {
    const url = normalizeBrowserAddress(addrDraft)
    if (!url) return
    if (wsRef.current?.readyState === WebSocket.OPEN) send({ type: 'navigate', url })
    else void api.browser.navigate(url).catch(() => {})
  }, [addrDraft, send])

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // preventDefault 抑制兼容 mouse 事件的默认动作（焦点转移/选字），随后手动聚焦键盘通道
    event.preventDefault()
    const stage = stageRef.current
    if (stage) {
      const rect = stage.getBoundingClientRect()
      setKbdPos({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    kbdInputRef.current?.focus({ preventScroll: true })
    const point = toPagePoint(event.clientX, event.clientY)
    if (!point) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pressedButtonRef.current = event.button
    send({
      type: 'input',
      kind: 'mousedown',
      x: point.x,
      y: point.y,
      button: MOUSE_BUTTONS[event.button] || 'left',
    })
  }
  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toPagePoint(event.clientX, event.clientY)
    if (point) sendMouseMove(point.x, point.y)
  }
  const handleCanvasPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toPagePoint(event.clientX, event.clientY)
    if (!point) return
    // pointercancel 的 button 不可靠，用按下时记下的按钮
    const button = event.type === 'pointerup' ? event.button : pressedButtonRef.current
    send({ type: 'input', kind: 'mouseup', x: point.x, y: point.y, button: MOUSE_BUTTONS[button] || 'left' })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // IME 组字期按键归输入法；选词 Enter/空格不得透传给远端页面
    if (isImeKeyEvent(event.nativeEvent)) return
    if (event.nativeEvent.key === 'Unidentified') return
    justComposedRef.current = false
    event.preventDefault()
    send({ type: 'input', kind: 'keydown', key: event.nativeEvent.key, code: event.nativeEvent.code })
    // gateway 把 keydown 映射成 rawKeyDown（不产生字符）：可打印字符需另发 char 走 insertText
    const key = event.nativeEvent.key
    if (key.length === 1 && !event.nativeEvent.ctrlKey && !event.nativeEvent.metaKey && !event.nativeEvent.altKey)
      send({ type: 'input', kind: 'char', key: '', code: '', text: key })
  }
  const handleKeyUp = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return
    if (event.nativeEvent.key === 'Unidentified') return
    event.preventDefault()
    send({ type: 'input', kind: 'keyup', key: event.nativeEvent.key, code: event.nativeEvent.code })
  }
  const handleInput = (event: React.FormEvent<HTMLInputElement>) => {
    const ev = event.nativeEvent as InputEvent
    // 组字期的 DOM 文本是 IME 暂存：不转发也不清空——动 value 会打断本次组字导致拼音上不了屏
    if (composingRef.current || ev.isComposing) return
    if ((ev.inputType === 'insertText' || ev.inputType === 'insertCompositionText') && ev.data) {
      // 非 IME 路径的文本注入（移动端 GBoard 自动补全/滑动输入等不走 keydown）；
      // justComposed 排除 compositionend 已发过的提交串重放
      if (!justComposedRef.current) {
        for (const ch of ev.data) send({ type: 'input', kind: 'char', key: '', code: '', text: ch })
      }
    } else if (ev.inputType === 'deleteContentBackward') {
      send({ type: 'input', kind: 'keydown', key: 'Backspace', code: 'Backspace' })
      send({ type: 'input', kind: 'keyup', key: 'Backspace', code: 'Backspace' })
    } else if (ev.inputType === 'deleteContentForward') {
      send({ type: 'input', kind: 'keydown', key: 'Delete', code: 'Delete' })
      send({ type: 'input', kind: 'keyup', key: 'Delete', code: 'Delete' })
    }
    event.currentTarget.value = ''
  }
  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    // 远端无剪贴板通道：粘贴手势把本地文本走 insertText 注入
    event.preventDefault()
    const text = event.clipboardData.getData('text')
    if (text) send({ type: 'input', kind: 'char', key: '', code: '', text })
    event.currentTarget.value = ''
  }

  const activeTarget = targets.find((item) => item.id === activeTargetId) || null
  const pageTitle = activeTarget?.title || ''
  const statusLabel =
    phase === 'error'
      ? phaseError || t('browser.error')
      : phase === 'launching'
        ? t('browser.launching')
        : phase === 'ready'
          ? wsState === 'open'
            ? t('browser.connected')
            : wsState === 'connecting'
              ? t('browser.connecting')
              : t('browser.disconnected')
          : t('browser.idle')

  return (
    <section ref={sectionRef} className="tmuxgo-content-surface flex h-full min-h-0 flex-col overflow-hidden">
      <header
        data-desktop-titlebar
        className={`flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 ${
          view === 'window' ? 'touch-none select-none' : ''
        }`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-apple bg-bg-2 text-accent">
          <FiCompass size={13} />
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => send({ type: 'back' })}
            aria-label={t('browser.back')}
            data-tip={t('browser.back')}
            className="tmuxgo-tip"
          >
            <FiArrowLeft size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => send({ type: 'forward' })}
            aria-label={t('browser.forward')}
            data-tip={t('browser.forward')}
            className="tmuxgo-tip"
          >
            <FiArrowRight size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => send({ type: 'reload' })}
            aria-label={t('browser.reload')}
            data-tip={t('browser.reload')}
            className="tmuxgo-tip"
          >
            <FiRefreshCw size={14} />
          </Button>
        </div>
        {picking ? (
          <Button variant="accent" size="sm" onClick={cancelPick} className="shrink-0">
            <FiCrosshair size={12} className="mr-1 inline" />
            {t('browser.pickCancel')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void startPick()}
            disabled={phase !== 'ready'}
            aria-label={t('browser.pick')}
            data-tip={t('browser.pick')}
            className="tmuxgo-tip"
          >
            <FiCrosshair size={14} />
          </Button>
        )}
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            submitAddress()
          }}
        >
          <input
            value={addrDraft}
            onChange={(event) => setAddrDraft(event.target.value)}
            onFocus={() => setAddrFocused(true)}
            onBlur={() => setAddrFocused(false)}
            onKeyDown={(event) => {
              // 地址栏自己的 Enter：IME 选词 Enter 不触发导航
              if (isImeKeyEvent(event.nativeEvent)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                submitAddress()
                event.currentTarget.blur()
              }
            }}
            placeholder={t('browser.addressPlaceholder')}
            aria-label={t('browser.addressPlaceholder')}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="h-7 w-full rounded-apple border border-[var(--line)] bg-bg-1 px-2.5 text-xs text-text-1 outline-none focus:border-accent"
          />
        </form>
        <div className="hidden min-w-0 max-w-40 shrink-0 flex-col justify-center sm:flex">
          <div className="truncate text-caption leading-tight text-text-3">
            {pageTitle || t('browser.title')}
            <span className="text-text-3/70">
              {' '}
              · {hostId} · {statusLabel}
            </span>
          </div>
        </div>
        {phase === 'ready' && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={stop}
            aria-label={t('browser.stop')}
            data-tip={t('browser.stop')}
            className="tmuxgo-tip"
          >
            <FiSquare size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleFullscreen}
          aria-label={t('browser.fullscreen')}
          data-tip={t('browser.fullscreen')}
          className={`tmuxgo-tip ${isFullscreen ? 'text-accent' : ''}`}
        >
          {isFullscreen ? <FiMinimize size={14} /> : <FiMaximize2 size={14} />}
        </Button>
        {!isMobileLayout && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onViewChange(view === 'window' ? 'full' : 'window')}
            aria-label={view === 'window' ? t('browser.fullView') : t('browser.windowed')}
            data-tip={view === 'window' ? t('browser.fullView') : t('browser.windowed')}
            className={`tmuxgo-tip ${view === 'window' ? 'text-accent' : ''}`}
          >
            <FiMinimize2 size={14} />
          </Button>
        )}
        {!isMobileLayout && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onMinimize}
            aria-label={t('browser.minimize')}
            data-tip={t('browser.minimize')}
            className="tmuxgo-tip"
          >
            <FiMinus size={14} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
          data-tip={t('common.close')}
          className="tmuxgo-tip tmuxgo-tip--right"
        >
          <FiX size={15} />
        </Button>
      </header>
      {targets.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--line)] px-2 scrollbar-none">
          {targets.map((target) => {
            const active = target.id === activeTargetId
            return (
              <div
                key={target.id}
                className={`group flex h-7 max-w-44 shrink-0 items-center gap-1 rounded-apple border px-2 text-xs ${
                  active ? 'border-accent/40 bg-accent/10 text-text-1' : 'border-[var(--line)] text-text-2'
                }`}
              >
                <button
                  type="button"
                  onClick={() => send({ type: 'tab', action: 'activate', targetId: target.id })}
                  className="min-w-0 flex-1 truncate text-left"
                  title={target.url || target.title}
                >
                  {target.title || target.url || t('browser.newTab')}
                </button>
                <button
                  type="button"
                  onClick={() => send({ type: 'tab', action: 'close', targetId: target.id })}
                  aria-label={t('browser.closeTab')}
                  className="shrink-0 text-text-3 hover:text-text-1"
                >
                  <FiX size={11} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => send({ type: 'tab', action: 'open', url: 'about:blank' })}
            aria-label={t('browser.newTab')}
            data-tip={t('browser.newTab')}
            className="tmuxgo-tip flex h-7 w-7 shrink-0 items-center justify-center rounded-apple text-text-3 hover:text-text-1"
          >
            <FiPlus size={13} />
          </button>
        </div>
      )}
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-black">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full cursor-default touch-none"
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          onContextMenu={(event) => event.preventDefault()}
        />
        {/* 键盘通道必须非受控：value="" 会在 IME 组字期被 React 拉回空串，直接打死拼音输入 */}
        <input
          ref={kbdInputRef}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPaste={handlePaste}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false
            justComposedRef.current = true
            const text = (event.nativeEvent as CompositionEvent).data || ''
            event.currentTarget.value = ''
            if (text) send({ type: 'input', kind: 'char', key: '', code: '', text })
            // 提交后的尾随 insertText 事件在同一 task 内到达，下一拍再清标记
            setTimeout(() => {
              justComposedRef.current = false
            }, 0)
          }}
          aria-label={t('browser.keyboardInput')}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="absolute h-px w-px opacity-0"
          style={{ left: kbdPos.x, top: kbdPos.y }}
        />
        {phase === 'idle' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg-0/60 p-4 text-center">
            <FiCompass size={28} className="text-text-3" />
            <div className="text-xs text-text-3">{t('browser.launchDesc')}</div>
            <Button size="sm" onClick={() => void launch()} disabled={launchBusy}>
              {launchBusy ? t('browser.launching') : t('browser.launch')}
            </Button>
            <button
              type="button"
              onClick={() => void checkSetup()}
              className="text-caption text-text-3 underline-offset-2 hover:text-text-1 hover:underline"
            >
              {setupBusy ? t('browser.setupChecking') : t('browser.setupCheck')}
            </button>
          </div>
        )}
        {phase === 'launching' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-0/60">
            <div className="rounded-apple bg-bg-1/90 px-3 py-1.5 text-xs text-text-2">{t('browser.launching')}</div>
          </div>
        )}
        {phase === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg-0/60 p-4 text-center">
            <div className="max-w-md text-xs text-danger">{phaseError || t('browser.error')}</div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void launch()} disabled={launchBusy}>
                {launchBusy ? t('browser.launching') : t('browser.launch')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void checkSetup()} disabled={setupBusy}>
                <FiTool size={12} className="mr-1 inline" />
                {setupBusy ? t('browser.setupChecking') : t('browser.setupCheck')}
              </Button>
            </div>
          </div>
        )}
        {setupInfo && !setupInfo.installed && setupInfo.hint && (
          <div className="tmuxgo-glass absolute bottom-3 left-1/2 z-20 flex w-[min(26rem,90%)] -translate-x-1/2 flex-col gap-1.5 rounded-apple-lg p-3 text-xs text-text-1">
            <div className="flex items-center justify-between">
              <span className="font-medium">{t('browser.setupCheck')}</span>
              <button
                type="button"
                onClick={() => setSetupInfo(null)}
                aria-label={t('common.close')}
                className="text-text-3 hover:text-text-1"
              >
                <FiX size={13} />
              </button>
            </div>
            <div className="text-text-3">{t('browser.engineMissing')}</div>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-bg-1 px-2 py-1 text-caption">
                {setupInfo.hint}
              </code>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void copySetupHint(setupInfo.hint)}
                aria-label={t('browser.copyCommand')}
                data-tip={t('browser.copyCommand')}
                className="tmuxgo-tip"
              >
                <FiCopy size={13} />
              </Button>
            </div>
            {setupCopied && <div className="text-accent-2">{t('browser.copied')}</div>}
          </div>
        )}
        {phase === 'ready' && wsState === 'closed' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/50">
            <div className="rounded-apple bg-bg-1/90 px-3 py-1.5 text-xs text-text-2">{t('browser.disconnected')}</div>
            <Button size="sm" onClick={() => void connect()}>
              {t('browser.reconnect')}
            </Button>
          </div>
        )}
        {pickResult && <BrowserPickResultCard result={pickResult} onClose={() => setPickResult(null)} />}
        {phase === 'ready' && wsState === 'connecting' && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
            <div className="rounded-apple bg-bg-1/90 px-3 py-1.5 text-xs text-text-2">{t('browser.connecting')}</div>
          </div>
        )}
      </div>
    </section>
  )
}
