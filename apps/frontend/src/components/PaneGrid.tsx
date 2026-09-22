'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'
import { useSessionSnapshot, useWindows } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { api } from '@/lib/api'
import { parseSessionName } from '@/lib/session-id'
import { useSessionContinuity } from '@/hooks/useSessionContinuity'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { emitStreamEvent, subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { shouldUsePasteBinary } from '@/lib/paste-safety'

const ATTACH_TIMEOUT = 5000
const ATTACH_RETRY_DELAY = 900
const INPUT_QUEUE_LIMIT = 128
const INPUT_FLUSH_INTERVAL = 4
const INPUT_BATCH_CHARS = 768
// 远端 resize 真 trailing debounce：拖动期间只更新目标尺寸，静止窗口到期且
// 无在途请求才发送；ACK 只是释放在途许可，不得穿透未到期的静止窗口。
// 桌面 80ms（实测最后 activity→fit ~50ms，留 30ms 余量）；移动端 150ms
const RESIZE_QUIET_DESKTOP_MS = 80
const RESIZE_QUIET_MOBILE_MS = 150
// 指针拖拽语义：move 全程零远端发送，pointerup 后短 settle 只发最终一次；
// settle 窗口内新的 pointerdown 取消待发、合并回同一 burst
const RESIZE_POINTER_SETTLE_MS = 50
// settle 期间 RO 尾声活动的短顺延窗——保证 pointerup→发送在 60ms 量级
const RESIZE_POINTER_ACTIVITY_MS = 20
// settle 提交硬上限：窗口内活动顺延不得越过 pointerup+50ms
const RESIZE_POINTER_COMMIT_CAP_MS = 50
// 在途 resize 的 ACK 兜底超时：resized 不带代次，丢 ACK 不能永久卡住后续发送
const RESIZE_ACK_STALE_MS = 1200

export interface PaneGridSocket {
  send: (data: any) => boolean
  isConnected: boolean
  isSocketReady: boolean
  subscribeOutput: (
    hostId: string,
    sessionName: string,
    listener: (message: {
      data: string
      sessionName?: string | null
      hostId?: string | null
      resync?: boolean
    }) => void,
  ) => () => void
}

export function PaneGrid({
  sessionId: controlledSessionId,
  socket,
  shared = false,
}: {
  sessionId?: string
  socket?: PaneGridSocket
  shared?: boolean
}) {
  const activeHostId = useConsoleStore((s) => s.activeHostId)
  const activeSessionId = useConsoleStore((s) => s.activeSessionId)
  const connectionStatus = useConsoleStore((s) => s.connection.status)
  const updateConnection = useConsoleStore((s) => s.updateConnection)
  const updateTerminalPerf = useConsoleStore((s) => s.updateTerminalPerf)
  const defaultConnection = useWebSocket()
  const { send, isConnected, isSocketReady, subscribeOutput } = socket || defaultConnection
  const updateConnectionState = useCallback(
    (...args: Parameters<typeof updateConnection>) => {
      if (!socket) updateConnection(...args)
    },
    [socket, updateConnection],
  )
  const { t } = useTranslation()
  const { preferences } = usePreferences()
  const { sessionContinuity, upsertResumePoint } = useSessionContinuity()
  const isMobile = isMobileDevice()
  const queryClient = useOptionalQueryClient()
  const { syncAfterWindowChange } = useSessionSnapshotSync()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const setActiveSession = useConsoleStore((s) => s.setActiveSession)
  const setActivePane = useConsoleStore((s) => s.setActivePane)
  const sessionId = controlledSessionId === undefined ? activeSessionId : controlledSessionId
  const isControlled = controlledSessionId !== undefined
  const { data: orderedSessions = [] } = useOrderedSessions(activeHostId || '')
  const { data: windowsData = [] } = useWindows(activeHostId || '', sessionId || '')
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', sessionId || '')
  const { getWindows, setWindows } = useWindowQueryState(activeHostId || '', sessionId || '')
  const [pageActive, setPageActive] = useState(
    () => typeof document === 'undefined' || (document.visibilityState !== 'hidden' && document.hasFocus()),
  )
  useEffect(() => {
    let blurTimer: ReturnType<typeof setTimeout> | null = null
    const sync = () => setPageActive(document.visibilityState !== 'hidden' && document.hasFocus())
    // blur 防抖：地址栏/DevTools 等瞬时失焦不触发降级，250ms 未回归才认定失活
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = setTimeout(sync, 250)
    }
    const onFocus = () => {
      if (blurTimer) {
        clearTimeout(blurTimer)
        blurTimer = null
      }
      sync()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', sync)
      if (blurTimer) clearTimeout(blurTimer)
    }
  }, [])
  // 非激活页降级为被动旁观附着：独占 client 的 attach/resize 按 tmux
  // window-size latest 抢占会话尺寸、reflow 激活页画面；后台键鼠输入
  // （滚轮→copy-mode 是 pane 全局状态）也会越权影响他人——passive 让网关
  // 丢弃 input/pane_scroll/copy_mode_cancel，配合 ignore-size 彻底交出控制权
  // 被其它端抢走 session 独占所有权时降级为旁观，直到本页再次获得焦点
  // （pageActive 上升沿）才重新 claim exclusive——避免双端 pageActive 互抢
  const [ownershipLost, setOwnershipLost] = useState(false)
  // 失焦只降 passive（禁写），保持 exclusive 尺寸/渲染：
  // 若失焦就交出 exclusive，会走 shared 重附着并拆掉 height:100%，终端高度立刻变矮，
  // 且要刷新才能恢复。仅 ownership 被抢时才真正交出 exclusive。
  const exclusive = shared ? false : preferences.attachExclusive && !ownershipLost
  const attachPassive = !pageActive || (!shared && ownershipLost)
  const attachedRef = useRef<string | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const terminalReadyRef = useRef(false)
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachInFlightRef = useRef<string | null>(null)
  const lastSessionRef = useRef<string | null>(sessionId || null)
  const inputQueueRef = useRef<string[]>([])
  const resizeFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRemoteResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  // 远端发送的静止窗口截止时刻：每次新尺寸/真实容器活动顺延；到期后由
  // resizeFlushTimer 评估；layoutSyncPendingRef 判定本地 fit 是否仍在落地
  const remoteQuietDeadlineRef = useRef(0)
  const lastResizeActivityAtRef = useRef(0)
  // pointer 生命周期：down..up 之间硬抑制一切远端发送；up 后进入短 settle
  // 模式（RO 尾声用短顺延窗），settle 内新的 down 取消待发、合并回同一 burst
  const pointerDragActiveRef = useRef(false)
  const pointerSettleModeRef = useRef(false)
  // settle 提交上限：RO 尾声/稳定帧链可拖过 60ms，settle 期内的顺延一律不超过
  // pointerup+COMMIT_CAP，保证最终尺寸在 ~60ms 内提交
  const pointerCommitCapRef = useRef(0)
  const layoutSyncPendingRef = useRef<(() => boolean) | undefined>(undefined)
  const peekFitSizeRef = useRef<(() => { cols: number; rows: number } | null) | undefined>(undefined)
  const resizeQuietMs = isMobile ? RESIZE_QUIET_MOBILE_MS : RESIZE_QUIET_DESKTOP_MS
  // 服务端 window 尺寸仲裁推送的尺寸：服务端已把本端 pty 同步过去，
  // 布局回声 resize 须被识别（不发包、不覆盖 sizeRef 期望尺寸）
  const pushedSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  // 已发送未等回 resized 的 resize：在途限 1，期间新尺寸只进 pending 队列（latest-wins）
  const awaitingResizeAckRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeAckStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const lastAttachModeRef = useRef(`${exclusive}:${attachPassive}`)
  const prevPageActiveRef = useRef(pageActive)
  const lastExternalInputRef = useRef<{ data: string; at: number } | null>(null)
  const attachStartedAtRef = useRef(0)
  const lastOutputAtRef = useRef('')
  const lastArchiveCaptureRef = useRef<{ key: string; at: number } | null>(null)
  const continuityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSessionAttachedRef = useRef(false)
  const pendingSessionIdRef = useRef<string | null>(null)
  const pendingSessionNameRef = useRef<string | null>(null)
  const [visibleSessionId, setVisibleSessionId] = useState(sessionId || '')

  const sessionName = parseSessionName(activeHostId || 'local', sessionId || '')
  const targetSessionName = pendingSessionNameRef.current || sessionName
  const renderedSessionName = targetSessionName

  const sessionWindows = useMemo(
    () => windowsData.filter((w: any) => w.sessionId === sessionId),
    [windowsData, sessionId],
  )
  const activeWindowIndex = useMemo(() => sessionWindows.findIndex((w: any) => w.active), [sessionWindows])
  const navLockRef = useRef(0)
  const switchSession = useCallback(
    (direction: -1 | 1) => {
      if (!sessionId || orderedSessions.length <= 1) return
      const currentIndex = orderedSessions.findIndex((item: any) => item.id === sessionId)
      if (currentIndex < 0) return
      const next = orderedSessions[(currentIndex + direction + orderedSessions.length) % orderedSessions.length]
      if (next && next.id !== sessionId) setActiveSession(next.id)
    },
    [orderedSessions, sessionId, setActiveSession],
  )
  const switchWindow = useCallback(
    async (direction: -1 | 1) => {
      if (!activeHostId || !sessionId || sessionWindows.length === 0) return
      const nextIndex = activeWindowIndex + direction
      if (nextIndex < 0 || nextIndex >= sessionWindows.length) {
        switchSession(direction)
        return
      }
      const targetWindow = sessionWindows[nextIndex]
      if (!targetWindow) return
      const previousWindows = getWindows()
      setWindows(
        previousWindows.map((w: any) => (w.sessionId === sessionId ? { ...w, active: w.id === targetWindow.id } : w)),
      )
      try {
        const result = await api.windows.select(activeHostId, sessionId, targetWindow.id)
        if (result.windows) setWindows(result.windows)
        await syncAfterWindowChange()
      } catch {
        setWindows(previousWindows)
        pushToast({ type: 'error', message: t('window.switchFailed') })
      }
    },
    [
      activeHostId,
      sessionId,
      sessionWindows,
      activeWindowIndex,
      switchSession,
      getWindows,
      setWindows,
      pushToast,
      syncAfterWindowChange,
      t,
    ],
  )
  const activeWindow = sessionWindows.find((item: any) => item.active) || sessionWindows[0] || null
  const activeWindowZoomed = useMemo(() => {
    const snapshotWindows = Array.isArray((snapshotData as any)?.windows) ? (snapshotData as any).windows : []
    const snapshotWindow =
      snapshotWindows.find((w: any) => w.id === (snapshotData as any)?.activeWindowId) ||
      snapshotWindows.find((w: any) => w.id === activeWindow?.id)
    if (snapshotWindow) return Boolean(snapshotWindow.zoomed)
    return Boolean(activeWindow?.zoomed)
  }, [snapshotData, activeWindow])
  const zoomedPaneCount = useMemo(() => {
    if (!activeWindowZoomed || !activeWindow) return 0
    const panes = Array.isArray((snapshotData as any)?.panes) ? (snapshotData as any).panes : []
    return panes.filter((pane: any) => pane.windowId === activeWindow.id).length
  }, [activeWindowZoomed, activeWindow, snapshotData])
  const switchPane = useCallback(
    async (direction: -1 | 1) => {
      const panes = Array.isArray((snapshotData as any)?.panes) ? (snapshotData as any).panes : []
      const windowId = (snapshotData as any)?.activeWindowId || activeWindow?.id || ''
      const windowPanes = panes
        .filter((pane: any) => pane.windowId === windowId)
        .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      if (windowPanes.length <= 1) return
      const currentPaneId = String((snapshotData as any)?.activePaneId || useConsoleStore.getState().activePaneId || '')
      const currentIndex = Math.max(
        0,
        windowPanes.findIndex((pane: any) => pane.id === currentPaneId),
      )
      const next = windowPanes[(currentIndex + direction + windowPanes.length) % windowPanes.length]
      if (!next || next.id === currentPaneId) return
      setActivePane(next.id)
      try {
        const result = await api.panes.select(next.id)
        if (result?.ok === false) throw new Error(result.error || 'select pane failed')
        void queryClient?.invalidateQueries({
          queryKey: ['session-snapshot', activeHostId || 'local', sessionId || ''],
        })
      } catch {
        pushToast({ type: 'error', message: t('pane.switchFailed') })
      }
    },
    [snapshotData, activeWindow, setActivePane, queryClient, activeHostId, sessionId, pushToast, t],
  )
  const handleSwipeRef = useRef<(direction: -1 | 1) => void>(() => {})
  useEffect(() => {
    handleSwipeRef.current = (direction: -1 | 1) => {
      const now = Date.now()
      if (now - navLockRef.current < 400) return
      navLockRef.current = now
      if (activeWindowZoomed && zoomedPaneCount > 1) void switchPane(direction)
      else void switchWindow(direction)
    }
  })
  const handleSwipeLeft = useCallback(() => {
    handleSwipeRef.current(1)
  }, [])
  const handleSwipeRight = useCallback(() => {
    handleSwipeRef.current(-1)
  }, [])

  const flushPendingRemoteResizeRef = useRef<() => void>(() => {})
  const sendResizeNow = useCallback(
    (size: { cols: number; rows: number }) => {
      if (!size.cols || !size.rows) return false
      // 后台页不得向远端推尺寸：降级切换窗口期内仍持有独占 pty，一笔迟到的
      // resize 会抢会话尺寸；调用方收到 false 走 localOnly 本地确认收尾
      if (document.visibilityState === 'hidden') return false
      // 非独占/旁观端只本地对齐共享尺寸，禁止向服务端推 size：
      // 否则降级竞态里一笔 120x36 resize 会经 exclusive pty 把 window 抢回
      if (!exclusive || attachPassive) return false
      const prev = sentResizeRef.current
      if (prev && prev.cols === size.cols && prev.rows === size.rows) return false
      const sent = send({ type: 'resize', hostId: activeHostId || 'local', cols: size.cols, rows: size.rows })
      if (sent) {
        sentResizeRef.current = size
        awaitingResizeAckRef.current = size
        if (resizeAckStaleTimerRef.current) clearTimeout(resizeAckStaleTimerRef.current)
        // resized ACK 丢失兜底：超时清在途并把队列里最新尺寸补发出去
        resizeAckStaleTimerRef.current = setTimeout(() => {
          resizeAckStaleTimerRef.current = null
          awaitingResizeAckRef.current = null
          flushPendingRemoteResizeRef.current()
        }, RESIZE_ACK_STALE_MS)
      }
      return sent
    },
    [activeHostId, attachPassive, exclusive, send],
  )
  const clearAttachTimers = useCallback(() => {
    if (attachTimerRef.current) {
      clearTimeout(attachTimerRef.current)
      attachTimerRef.current = null
    }
    if (attachRetryTimerRef.current) {
      clearTimeout(attachRetryTimerRef.current)
      attachRetryTimerRef.current = null
    }
  }, [])
  const clearInputFlushTimer = useCallback(() => {
    if (!inputFlushTimerRef.current) return
    clearTimeout(inputFlushTimerRef.current)
    inputFlushTimerRef.current = null
  }, [])
  const clearResizeFlushTimer = useCallback(() => {
    if (!resizeFlushTimerRef.current) return
    clearTimeout(resizeFlushTimerRef.current)
    resizeFlushTimerRef.current = null
  }, [])
  // resize 在途态整体清理：卸载/切换/断线/出错时统一调用——
  // 漏清 stale timer 会让卸载后的回调按过期状态补发排队尺寸
  const clearRemoteResizeState = useCallback(() => {
    pendingRemoteResizeRef.current = null
    awaitingResizeAckRef.current = null
    remoteQuietDeadlineRef.current = 0
    if (resizeAckStaleTimerRef.current) {
      clearTimeout(resizeAckStaleTimerRef.current)
      resizeAckStaleTimerRef.current = null
    }
    clearResizeFlushTimer()
  }, [clearResizeFlushTimer])
  const flushPendingRemoteResize = useCallback(() => {
    let size = pendingRemoteResizeRef.current
    if (!size) {
      clearResizeFlushTimer()
      remoteQuietDeadlineRef.current = 0
      return
    }
    if (!isConnected || attachedRef.current !== targetSessionName) {
      clearRemoteResizeState()
      emitStreamEvent(STREAM_EVENT.resized, {
        hostId: activeHostId || 'local',
        sessionName: targetSessionName,
        cols: size.cols,
        rows: size.rows,
        localOnly: true,
      })
      return
    }
    // 在途限 1：上一笔 resize 的 resized 未回前不再发送，队列只留最新尺寸；
    // ACK 回来由 resized 订阅补发（latest-wins），停拖后的最终尺寸优先
    if (awaitingResizeAckRef.current) return
    // pointer 按住期间硬抑制远端发送：move 只更新本地 fit 与 latest target，
    // 重排短 timer 等 pointerup/settle 到期再评估（burst 内只提交最终尺寸）
    if (pointerDragActiveRef.current) {
      if (!resizeFlushTimerRef.current)
        resizeFlushTimerRef.current = setTimeout(() => {
          resizeFlushTimerRef.current = null
          flushPendingRemoteResize()
        }, RESIZE_POINTER_SETTLE_MS)
      return
    }
    // 静止窗口未到期不发送（含 ACK 触发的补评估）：重排剩余时间再醒一次
    const remaining = remoteQuietDeadlineRef.current - Date.now()
    if (remaining > 0) {
      if (!resizeFlushTimerRef.current)
        resizeFlushTimerRef.current = setTimeout(() => {
          resizeFlushTimerRef.current = null
          flushPendingRemoteResize()
        }, remaining)
      return
    }
    // 静止窗到但本地 fit 还在落地（稳定帧/调度在途）：8ms 粒度重试，
    // 保证发送的是最终尺寸而非中间态——最终尺寸只允许一次发送。
    // pointer settle 例外：fit 链（RO→2 帧稳定→layout rAF）可拖到 up+80ms，
    // 直接同步读容器几何作为权威目标尺寸提交，fit 落地后同尺寸走 dedup
    if (layoutSyncPendingRef.current?.()) {
      const peeked = pointerSettleModeRef.current ? peekFitSizeRef.current?.() : null
      if (peeked && peeked.cols > 0 && peeked.rows > 0) {
        size = peeked
        pendingRemoteResizeRef.current = peeked
      } else {
        if (!resizeFlushTimerRef.current)
          resizeFlushTimerRef.current = setTimeout(() => {
            resizeFlushTimerRef.current = null
            flushPendingRemoteResize()
          }, 8)
        return
      }
    }
    clearResizeFlushTimer()
    remoteQuietDeadlineRef.current = 0
    pointerSettleModeRef.current = false
    const sent = sentResizeRef.current
    if (sent && sent.cols === size.cols && sent.rows === size.rows) {
      pendingRemoteResizeRef.current = null
      // 到达此分支时无在途（上方已拦），同尺寸去重不是"流程完成"：
      // layout 侧 pendingRemoteResize 在 onResize 前已置位，须补 localOnly
      // 本地确认，否则终端等待态残留到超时兜底
      emitStreamEvent(STREAM_EVENT.resized, {
        hostId: activeHostId || 'local',
        sessionName: targetSessionName,
        cols: size.cols,
        rows: size.rows,
        localOnly: true,
      })
      return
    }
    pendingRemoteResizeRef.current = null
    if (!sendResizeNow(size)) {
      emitStreamEvent(STREAM_EVENT.resized, {
        hostId: activeHostId || 'local',
        sessionName: targetSessionName,
        cols: size.cols,
        rows: size.rows,
        localOnly: true,
      })
    }
  }, [activeHostId, clearRemoteResizeState, clearResizeFlushTimer, isConnected, sendResizeNow, targetSessionName])
  flushPendingRemoteResizeRef.current = flushPendingRemoteResize
  // 分隔条/桌面窗口边缘/面板分割条的 pointer 生命周期：
  // start 进入 burst（move 期间零远端发送）；end 短 settle 后只发最终尺寸。
  // settle 窗口内再次 start 视为同一 burst 延续——短间隔连续拖拽合并为一次提交
  useEffect(() => {
    const handleResizeGesture = (detail: { phase?: string } = {}) => {
      if (detail.phase === 'start') {
        pointerDragActiveRef.current = true
        pointerSettleModeRef.current = false
        clearResizeFlushTimer()
        remoteQuietDeadlineRef.current = 0
        return
      }
      if (detail.phase !== 'end') return
      pointerDragActiveRef.current = false
      pointerSettleModeRef.current = true
      pointerCommitCapRef.current = Date.now() + RESIZE_POINTER_COMMIT_CAP_MS
      remoteQuietDeadlineRef.current = Math.min(Date.now() + RESIZE_POINTER_SETTLE_MS, pointerCommitCapRef.current)
      if (!pendingRemoteResizeRef.current || resizeFlushTimerRef.current) return
      resizeFlushTimerRef.current = setTimeout(() => {
        resizeFlushTimerRef.current = null
        flushPendingRemoteResize()
      }, RESIZE_POINTER_SETTLE_MS)
    }
    return subscribeStreamEvent(STREAM_EVENT.resizeGesture, handleResizeGesture)
  }, [clearResizeFlushTimer, flushPendingRemoteResize])
  // 服务端 window 尺寸仲裁：本端 client pty 已被同步到推送尺寸——记 pushed
  // 并把 sentResize 对齐，让随后布局回声 resize 走 dedup 不再发包
  useEffect(() => {
    const handleWindowSize = (detail: any = {}) => {
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName !== targetSessionName) return
      const cols = Number(detail.cols)
      const rows = Number(detail.rows)
      if (cols <= 0 || rows <= 0) return
      pushedSizeRef.current = { cols, rows }
      sentResizeRef.current = { cols, rows }
      // 推送尺寸推翻了在途 resize 的目标：ACK 不会按旧尺寸回来，直接释放在途
      awaitingResizeAckRef.current = null
      if (resizeAckStaleTimerRef.current) {
        clearTimeout(resizeAckStaleTimerRef.current)
        resizeAckStaleTimerRef.current = null
      }
    }
    return subscribeStreamEvent(STREAM_EVENT.windowSize, handleWindowSize)
  }, [activeHostId, targetSessionName])
  const clearContinuityTimer = useCallback(() => {
    if (!continuityTimerRef.current) return
    clearTimeout(continuityTimerRef.current)
    continuityTimerRef.current = null
  }, [])
  const flushResumePoint = useCallback(() => {
    if (isControlled || !sessionContinuity.enabled) return
    if (!activeHostId || !sessionId || !sessionName) return
    const activeWindow = sessionWindows.find((item: any) => item.active) || sessionWindows[0] || null
    const now = new Date().toISOString()
    const size = sizeRef.current
    upsertResumePoint({
      hostId: activeHostId,
      sessionId,
      sessionName,
      windowId: activeWindow?.id || null,
      paneId: useConsoleStore.getState().activePaneId || null,
      cols: size?.cols || 120,
      rows: size?.rows || 36,
      exclusive,
      lastSeenAt: now,
      lastOutputAt: lastOutputAtRef.current || now,
    })
    const archive = sessionContinuity.archive
    const key = `${activeHostId}:${sessionId}`
    const previous = lastArchiveCaptureRef.current
    if (
      archive.enabled &&
      archive.captureMode !== 'none' &&
      (!previous || previous.key !== key || Date.now() - previous.at >= 60000)
    ) {
      lastArchiveCaptureRef.current = { key, at: Date.now() }
      void api.sessionArchives.capture(activeHostId, sessionId, archive).catch(() => {})
    }
  }, [
    activeHostId,
    sessionId,
    isControlled,
    sessionContinuity.enabled,
    sessionContinuity.archive,
    sessionName,
    sessionWindows,
    upsertResumePoint,
    exclusive,
  ])
  const scheduleContinuityFlush = useCallback(
    (delay = 0) => {
      if (!sessionContinuity.enabled) return
      if (continuityTimerRef.current) return
      continuityTimerRef.current = setTimeout(
        () => {
          continuityTimerRef.current = null
          flushResumePoint()
        },
        Math.max(0, delay),
      )
    },
    [flushResumePoint, sessionContinuity.enabled],
  )
  const flushInputQueue = useCallback(() => {
    clearInputFlushTimer()
    if (!isConnected || !isSessionAttachedRef.current || attachedRef.current !== targetSessionName) return
    if (inputQueueRef.current.length === 0) return
    const queued = inputQueueRef.current.splice(0)
    let batch = ''
    for (const chunk of queued) {
      if (!chunk) continue
      if (batch.length + chunk.length > INPUT_BATCH_CHARS && batch) {
        send({ type: 'input', data: batch })
        batch = ''
      }
      batch += chunk
      if (batch.length >= INPUT_BATCH_CHARS) {
        send({ type: 'input', data: batch })
        batch = ''
      }
    }
    if (batch) send({ type: 'input', data: batch })
  }, [clearInputFlushTimer, isConnected, send, targetSessionName])
  const scheduleInputFlush = useCallback(() => {
    if (inputFlushTimerRef.current) return
    inputFlushTimerRef.current = setTimeout(() => {
      inputFlushTimerRef.current = null
      flushInputQueue()
    }, INPUT_FLUSH_INTERVAL)
  }, [flushInputQueue])
  const attachNow = useCallback(() => {
    if (!targetSessionName || !isSocketReady || !terminalReadyRef.current) return
    const attachKey = `${activeHostId || 'local'}:${targetSessionName}:${exclusive ? 'exclusive' : 'shared'}:${attachPassive ? 'passive' : 'active'}`
    if (attachInFlightRef.current === attachKey) return
    const size = sizeRef.current
    clearAttachTimers()
    attachInFlightRef.current = attachKey
    attachStartedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now()
    isSessionAttachedRef.current = false
    updateConnectionState({ status: 'attaching' })
    const sent = send({
      type: 'attach',
      hostId: activeHostId || 'local',
      sessionName: targetSessionName,
      cols: size?.cols || 120,
      rows: size?.rows || 36,
      exclusive,
      ...(attachPassive ? { passive: true } : {}),
    })
    if (!sent) {
      attachInFlightRef.current = null
      return
    }
    attachTimerRef.current = setTimeout(() => {
      attachInFlightRef.current = null
      attachedRef.current = null
      sentResizeRef.current = null
      pushedSizeRef.current = null
      updateConnectionState({ status: 'attaching' })
      attachRetryTimerRef.current = setTimeout(() => {
        attachTimerRef.current = null
        attachRetryTimerRef.current = null
        attachNow()
      }, ATTACH_RETRY_DELAY)
    }, ATTACH_TIMEOUT)
  }, [
    activeHostId,
    attachPassive,
    clearAttachTimers,
    exclusive,
    isSocketReady,
    send,
    targetSessionName,
    updateConnectionState,
  ])

  useEffect(() => {
    if (!sessionId) {
      lastSessionRef.current = null
      pendingSessionIdRef.current = null
      pendingSessionNameRef.current = null
      setVisibleSessionId('')
      return
    }
    if (!lastSessionRef.current) {
      lastSessionRef.current = sessionId
      pendingSessionIdRef.current = null
      pendingSessionNameRef.current = null
      if (!visibleSessionId) {
        setVisibleSessionId(sessionId)
      }
      return
    }
    if (lastSessionRef.current !== sessionId) {
      lastSessionRef.current = sessionId
      pendingSessionIdRef.current = sessionId
      pendingSessionNameRef.current = sessionName
    }
  }, [sessionId, sessionName, visibleSessionId])
  useEffect(() => {
    clearAttachTimers()
    clearInputFlushTimer()
    clearContinuityTimer()
    clearRemoteResizeState()
    attachedRef.current = null
    attachInFlightRef.current = null
    isSessionAttachedRef.current = false
    sentResizeRef.current = null
    pushedSizeRef.current = null
    inputQueueRef.current = []
  }, [targetSessionName, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer, clearRemoteResizeState])
  useEffect(() => {
    if (!socket && connectionStatus === 'disconnected') {
      clearAttachTimers()
      clearInputFlushTimer()
      clearContinuityTimer()
      clearRemoteResizeState()
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      pushedSizeRef.current = null
      flushResumePoint()
    }
  }, [
    socket,
    connectionStatus,
    clearAttachTimers,
    clearInputFlushTimer,
    clearContinuityTimer,
    clearRemoteResizeState,
    flushResumePoint,
  ])

  useEffect(() => {
    const handleReconnect = () => {
      clearAttachTimers()
      clearInputFlushTimer()
      clearContinuityTimer()
      clearRemoteResizeState()
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      pushedSizeRef.current = null
      if (terminalReadyRef.current) attachNow()
    }
    return subscribeStreamEvent(STREAM_EVENT.reconnected, handleReconnect)
  }, [attachNow, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer, clearRemoteResizeState])
  useEffect(() => {
    const mode = `${exclusive}:${attachPassive}`
    if (lastAttachModeRef.current === mode) return
    lastAttachModeRef.current = mode
    if (!targetSessionName || !terminalReadyRef.current) return
    clearAttachTimers()
    clearRemoteResizeState()
    attachedRef.current = null
    attachInFlightRef.current = null
    isSessionAttachedRef.current = false
    sentResizeRef.current = null
    pushedSizeRef.current = null
    attachNow()
  }, [exclusive, attachPassive, targetSessionName, attachNow, clearAttachTimers, clearRemoteResizeState])
  useEffect(() => {
    if (!isSocketReady) return
    const profile = isMobile ? 'mobile' : document.visibilityState === 'visible' ? 'foreground' : 'background'
    send({ type: 'stream_profile', hostId: activeHostId || 'local', profile })
    const handleVisibilityChange = () => {
      const nextProfile = isMobile ? 'mobile' : document.visibilityState === 'visible' ? 'foreground' : 'background'
      send({ type: 'stream_profile', hostId: activeHostId || 'local', profile: nextProfile })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [activeHostId, isMobile, isSocketReady, send])
  useEffect(() => {
    // 失焦→聚焦的上升沿才重新争用独占；已聚焦时被 revoke 不自动抢回，防止双活互抢
    if (pageActive && !prevPageActiveRef.current) setOwnershipLost(false)
    prevPageActiveRef.current = pageActive
  }, [pageActive])
  const ownershipSessionRef = useRef<string | null>(targetSessionName)
  useEffect(() => {
    // 仅在真正切换 session 时清所有权丢失标记，避免与 exclusive-revoked 抢状态
    if (ownershipSessionRef.current === targetSessionName) return
    ownershipSessionRef.current = targetSessionName
    setOwnershipLost(false)
  }, [targetSessionName, activeHostId])
  useEffect(() => {
    const handleExclusiveRevoked = (detail: any = {}) => {
      // 同 host 即降级：多端抢焦时 session 名解析可能短暂不一致，宁可降级也不双写
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && targetSessionName && detail.sessionName !== targetSessionName) return
      setOwnershipLost(true)
    }
    return subscribeStreamEvent(STREAM_EVENT.exclusiveRevoked, handleExclusiveRevoked)
  }, [activeHostId, targetSessionName])
  useEffect(() => {
    // 所有权变化必须立刻重建附着（shared+passive 或重新 claim），不能只依赖 mode 字符串
    if (!targetSessionName || !terminalReadyRef.current || !isSocketReady) return
    clearAttachTimers()
    clearRemoteResizeState()
    attachedRef.current = null
    attachInFlightRef.current = null
    isSessionAttachedRef.current = false
    attachNow()
    // attachNow 必须进依赖：ownershipLost 翻转会连带更新 exclusive/passive 闭包
  }, [ownershipLost, attachNow, isSocketReady, targetSessionName, clearAttachTimers, clearRemoteResizeState])
  useEffect(() => {
    const handleAttached = (detail: any = {}) => {
      if (detail.sessionName !== targetSessionName) return
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      clearAttachTimers()
      attachInFlightRef.current = null
      attachedRef.current = targetSessionName
      isSessionAttachedRef.current = true
      if (pendingSessionIdRef.current && pendingSessionNameRef.current === detail.sessionName) {
        setVisibleSessionId(pendingSessionIdRef.current)
        pendingSessionIdRef.current = null
        pendingSessionNameRef.current = null
      }
      const attachedCols = Number(detail.cols)
      const attachedRows = Number(detail.rows)
      if (attachedCols > 0 && attachedRows > 0) sentResizeRef.current = { cols: attachedCols, rows: attachedRows }
      // 新 attach 上下文里上一 session 的在途/排队 resize 无意义
      clearRemoteResizeState()
      const attachLatency = Math.max(
        0,
        Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - attachStartedAtRef.current),
      )
      updateConnectionState({ status: 'connected' })
      updateTerminalPerf({ attachLatency })
      flushInputQueue()
      if (exclusive && sizeRef.current) sendResizeNow(sizeRef.current)
      scheduleContinuityFlush(0)
    }
    return subscribeStreamEvent(STREAM_EVENT.attached, handleAttached)
  }, [
    activeHostId,
    exclusive,
    targetSessionName,
    clearAttachTimers,
    updateConnectionState,
    updateTerminalPerf,
    flushInputQueue,
    sendResizeNow,
    clearRemoteResizeState,
    scheduleContinuityFlush,
  ])
  useEffect(() => {
    const handleDetached = (detail: any = {}) => {
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      pushedSizeRef.current = null
      clearRemoteResizeState()
      clearAttachTimers()
      updateConnectionState({ status: 'attaching' })
      if (terminalReadyRef.current && isSocketReady) {
        attachRetryTimerRef.current = setTimeout(() => {
          attachRetryTimerRef.current = null
          attachNow()
        }, ATTACH_RETRY_DELAY)
      }
    }
    return subscribeStreamEvent(STREAM_EVENT.detached, handleDetached)
  }, [
    activeHostId,
    attachNow,
    clearAttachTimers,
    clearRemoteResizeState,
    isSocketReady,
    targetSessionName,
    updateConnectionState,
  ])
  useEffect(() => {
    const handleRemoteResized = (detail: any = {}) => {
      if (detail?.localOnly) return
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      // ACK 无代次：只认与在途尺寸匹配的 resized——异尺寸旧 ACK（尤其 stale
      // 超时后迟到的）不得解锁在途并发；无在途的重复 ACK 也不凭空推进
      const awaiting = awaitingResizeAckRef.current
      if (!awaiting || detail.cols !== awaiting.cols || detail.rows !== awaiting.rows) return
      awaitingResizeAckRef.current = null
      if (resizeAckStaleTimerRef.current) {
        clearTimeout(resizeAckStaleTimerRef.current)
        resizeAckStaleTimerRef.current = null
      }
      flushPendingRemoteResize()
    }
    return subscribeStreamEvent(STREAM_EVENT.resized, handleRemoteResized)
  }, [activeHostId, flushPendingRemoteResize, targetSessionName])
  useEffect(() => {
    const handleError = (detail: { hostId?: string; sessionName?: string; message?: string } = {}) => {
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      clearAttachTimers()
      attachInFlightRef.current = null
      attachedRef.current = null
      isSessionAttachedRef.current = false
      sentResizeRef.current = null
      pushedSizeRef.current = null
      clearRemoteResizeState()
      if (pendingSessionNameRef.current === detail.sessionName) {
        pendingSessionIdRef.current = null
        pendingSessionNameRef.current = null
      }
      if (!isControlled && visibleSessionId && visibleSessionId !== activeSessionId) setActiveSession(visibleSessionId)
      updateConnectionState({ status: 'disconnected' })
      pushToast({ type: 'error', message: detail.message || t('session.requestFailed') })
      void queryClient?.invalidateQueries({ queryKey: ['sessions', activeHostId || 'local'] })
    }
    return subscribeStreamEvent(STREAM_EVENT.error, handleError)
  }, [
    activeHostId,
    activeSessionId,
    isControlled,
    clearAttachTimers,
    clearRemoteResizeState,
    pushToast,
    queryClient,
    setActiveSession,
    t,
    targetSessionName,
    updateConnectionState,
    visibleSessionId,
  ])
  useEffect(() => {
    if (isConnected) flushInputQueue()
  }, [isConnected, flushInputQueue])

  useEffect(
    () => () => {
      clearAttachTimers()
      clearInputFlushTimer()
      clearRemoteResizeState()
      clearContinuityTimer()
      flushResumePoint()
    },
    [clearAttachTimers, clearInputFlushTimer, clearRemoteResizeState, clearContinuityTimer, flushResumePoint],
  )

  const handleInput = useCallback(
    (data: string) => {
      scheduleContinuityFlush(100)
      const canWriteDirectly = isConnected && isSessionAttachedRef.current && attachedRef.current === targetSessionName
      // Oversized paste: single binary paste-data frame, skip 768-char JSON batching.
      if (canWriteDirectly && shouldUsePasteBinary(data)) {
        send({
          type: 'input',
          data,
          hostId: activeHostId || 'local',
          sessionName: targetSessionName,
        })
        return
      }
      if (canWriteDirectly) {
        if (inputQueueRef.current.length === 0 && data.length <= INPUT_BATCH_CHARS) {
          send({ type: 'input', data })
          return
        }
        inputQueueRef.current.push(data)
        scheduleInputFlush()
        return
      }
      inputQueueRef.current.push(data)
      if (isSocketReady) {
        scheduleInputFlush()
      }
      if (inputQueueRef.current.length > INPUT_QUEUE_LIMIT) {
        inputQueueRef.current.splice(0, inputQueueRef.current.length - INPUT_QUEUE_LIMIT)
      }
      if (isSocketReady && terminalReadyRef.current) attachNow()
    },
    [attachNow, isConnected, isSocketReady, send, targetSessionName, scheduleInputFlush, scheduleContinuityFlush],
  )
  useEffect(() => {
    if (attachedRef.current === targetSessionName) return
    attachNow()
  }, [targetSessionName, attachNow, isSocketReady])
  useEffect(() => {
    const handleTerminalInput = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: string }>).detail
      if (!detail?.data) return
      const now = Date.now()
      const last = lastExternalInputRef.current
      if (last && last.data === detail.data && now - last.at < 120) return
      lastExternalInputRef.current = { data: detail.data, at: now }
      handleInput(detail.data)
    }
    window.addEventListener('tmuxgo-terminal-input', handleTerminalInput as EventListener)
    return () => window.removeEventListener('tmuxgo-terminal-input', handleTerminalInput as EventListener)
  }, [handleInput])
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      const nextSize = { cols, rows }
      // 仲裁推送尺寸的布局回声：服务端已把本端 pty 同步到该尺寸——不发包、
      // 不覆盖 sizeRef 期望尺寸（refocus 重新 attach 时要按期望尺寸主张）
      const pushed = pushedSizeRef.current
      if (pushed && pushed.cols === cols && pushed.rows === rows) {
        pendingRemoteResizeRef.current = null
        remoteQuietDeadlineRef.current = 0
        clearResizeFlushTimer()
        emitStreamEvent(STREAM_EVENT.resized, {
          hostId: activeHostId || 'local',
          sessionName: targetSessionName,
          cols,
          rows,
          localOnly: true,
        })
        return
      }
      pushedSizeRef.current = null
      sizeRef.current = nextSize
      scheduleContinuityFlush(100)
      if (!isConnected || attachedRef.current !== targetSessionName) {
        emitStreamEvent(STREAM_EVENT.resized, {
          hostId: activeHostId || 'local',
          sessionName: targetSessionName,
          cols,
          rows,
          localOnly: true,
        })
        return
      }
      // 与远端当前尺寸一致且没在途：不产生任何发送，但要补 localOnly
      // 完成本地确认——layout 在回调前已置 pendingRemoteResize，零网络发送
      // 不等于流程完成，不补会残留终端等待态直到超时兜底
      const sent = sentResizeRef.current
      if (sent && sent.cols === cols && sent.rows === rows && !awaitingResizeAckRef.current) {
        pendingRemoteResizeRef.current = null
        remoteQuietDeadlineRef.current = 0
        clearResizeFlushTimer()
        emitStreamEvent(STREAM_EVENT.resized, {
          hostId: activeHostId || 'local',
          sessionName: targetSessionName,
          cols,
          rows,
          localOnly: true,
        })
        return
      }
      pendingRemoteResizeRef.current = nextSize
      // 静止窗锚定到最后一次真实容器活动，而非本次 onResize 到达时刻：RO→稳定
      // 帧→fit 链固有 ~50ms，用 now+quiet 会把已耗时间再叠加一遍（50+80=130）。
      // 活动仍在窗内则沿用其锚点（最终 fit 只更新目标、不重开窗口）；无近期
      // 活动源的独立 onResize（初始 fit/字体变化等）走完整 now+quiet。
      if (!pointerDragActiveRef.current) {
        const lastActivity = lastResizeActivityAtRef.current
        remoteQuietDeadlineRef.current = pointerSettleModeRef.current
          ? Math.min(Date.now() + RESIZE_POINTER_ACTIVITY_MS, pointerCommitCapRef.current)
          : lastActivity && Date.now() - lastActivity < resizeQuietMs
            ? lastActivity + resizeQuietMs
            : Date.now() + resizeQuietMs
      }
      if (resizeFlushTimerRef.current) return
      // 按真实剩余时间 arm：settle 模式下 deadline 可能已过/封顶，固定 50ms
      // 会把提交拖过 pointerup+60ms
      const delay = pointerDragActiveRef.current
        ? RESIZE_POINTER_SETTLE_MS
        : Math.max(0, remoteQuietDeadlineRef.current - Date.now())
      resizeFlushTimerRef.current = setTimeout(() => {
        resizeFlushTimerRef.current = null
        flushPendingRemoteResize()
      }, delay)
    },
    [
      activeHostId,
      clearResizeFlushTimer,
      flushPendingRemoteResize,
      isConnected,
      resizeQuietMs,
      scheduleContinuityFlush,
      targetSessionName,
    ],
  )
  // RO 级真实容器活动（含同格像素变、慢拖）：每次观察都顺延远端静止截止——
  // 节流后的 onResize 间隔可超静止窗，不能用 fit 通知反推拖动已停止
  const handleResizeActivity = useCallback(() => {
    if (!isConnected || attachedRef.current !== targetSessionName) return
    lastResizeActivityAtRef.current = Date.now()
    if (pointerDragActiveRef.current) return
    remoteQuietDeadlineRef.current = pointerSettleModeRef.current
      ? Math.min(Date.now() + RESIZE_POINTER_ACTIVITY_MS, pointerCommitCapRef.current)
      : Date.now() + resizeQuietMs
  }, [isConnected, resizeQuietMs, targetSessionName])
  const handleReady = useCallback(() => {
    terminalReadyRef.current = true
    if (attachedRef.current === targetSessionName) return
    attachNow()
    scheduleContinuityFlush(50)
  }, [targetSessionName, attachNow, scheduleContinuityFlush])
  useEffect(() => {
    if (isControlled || !sessionContinuity.enabled) return
    const timer = setInterval(() => {
      if (attachedRef.current !== targetSessionName) return
      flushResumePoint()
    }, 8000)
    return () => clearInterval(timer)
  }, [flushResumePoint, isControlled, sessionContinuity.enabled, targetSessionName])
  useEffect(() => {
    const handleOutput = (message: {
      data: string
      sessionName?: string | null
      hostId?: string | null
      resync?: boolean
    }) => {
      if ((message.hostId || activeHostId || 'local') !== (activeHostId || 'local')) return
      if (message.sessionName && message.sessionName !== targetSessionName) return
      if (!message.data) return
      lastOutputAtRef.current = new Date().toISOString()
      scheduleContinuityFlush(150)
    }
    const unsubscribe = subscribeOutput(activeHostId || 'local', targetSessionName, handleOutput)
    return () => {
      unsubscribe()
    }
  }, [activeHostId, scheduleContinuityFlush, targetSessionName, subscribeOutput])

  if (!sessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-3 gap-4">
        <div className="text-6xl">⊞</div>
        <div className="text-lg">{t('grid.noWindows')}</div>
        <div className="text-sm">{t('grid.selectSession')}</div>
      </div>
    )
  }

  // 控制权状态条：区分 可输入/旁观/附着中/只读分享——被动旁观时输入会被
  // 服务端丢弃，若没有提示用户会以为键盘失灵；只读分享绝不显示接管入口
  const ownershipStatus = shared
    ? 'readonly'
    : ownershipLost
      ? 'spectating'
      : !isSocketReady || !isConnected || connectionStatus !== 'connected'
        ? 'attaching'
        : !pageActive
          ? 'inactive'
          : 'owned'
  const ownershipLabel =
    ownershipStatus === 'attaching'
      ? connectionStatus === 'reconnecting'
        ? t('status.reconnecting')
        : connectionStatus === 'disconnected'
          ? t('status.disconnected')
          : t('grid.control.attaching')
      : t(`grid.control.${ownershipStatus}`)
  return (
    <div className="tmuxgo-content-surface relative h-full w-full min-h-0 min-w-0 overflow-hidden">
      <div
        data-ownership={ownershipStatus}
        className={`absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1 rounded-full border text-xs transition-opacity ${
          ownershipStatus === 'owned'
            ? 'border-transparent bg-transparent text-text-3/70'
            : ownershipStatus === 'spectating' || ownershipStatus === 'inactive'
              ? 'border-[var(--line)] bg-bg-2/95 text-warn'
              : 'border-[var(--line)] bg-bg-2/95 text-text-1'
        }`}
      >
        {ownershipLabel}
        {ownershipStatus === 'spectating' && (
          <button className="text-accent hover:underline" onClick={() => setOwnershipLost(false)}>
            {t('grid.control.takeover')}
          </button>
        )}
      </div>
      <TerminalPane
        sessionName={renderedSessionName}
        onInput={handleInput}
        onResize={handleResize}
        onResizeActivity={handleResizeActivity}
        layoutSyncPendingRef={layoutSyncPendingRef}
        peekFitSizeRef={peekFitSizeRef}
        attachExclusive={exclusive}
        onReady={handleReady}
        subscribeOutput={subscribeOutput}
        send={send}
        onSwipeLeft={!isControlled ? handleSwipeLeft : undefined}
        onSwipeRight={!isControlled ? handleSwipeRight : undefined}
      />
    </div>
  )
}
