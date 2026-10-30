'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { SwitchHud, type SwitchHudPayload } from './SwitchHud'
import { PaneNumberOverlay } from './PaneNumberOverlay'
import { PaneMoveOverlay } from './PaneMoveOverlay'
import { EditorContextMenu } from './EditorContextMenu'
import { useDisplayPanes } from '@/hooks/useDisplayPanes'
import { usePaneDrag } from '@/hooks/usePaneDrag'
import { PANE_DRAG_MIME, endPaneDrag, startPaneDrag } from '@/lib/pane-drag'
import type { PaneMoveDirection } from '@/lib/pane-drag'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'
import { usePreferences } from '@/hooks/usePreferences'
import { isMobileDevice } from '@/hooks/useMobileKeyboard'
import { useHosts, useSessionSnapshot, useSetSyncPanes, useSyncPanes, useWindows } from '@/hooks/useApi'
import { useOrderedSessions } from '@/hooks/useOrderedSessions'
import { SnapshotResumeHint } from './SnapshotResumeHint'
import { useWindowQueryState } from '@/hooks/useWindowQueryState'
import { api } from '@/lib/api'
import { parseSessionName } from '@/lib/session-id'
import { getViewId } from '@/lib/view-identity'
import { pickRecentSessionId } from '@/lib/recent-session'
import { useSessionContinuity } from '@/hooks/useSessionContinuity'
import { useSessionSnapshotSync } from '@/hooks/useSessionSnapshotSync'
import { usePrompt } from '@/hooks/usePrompt'
import { useOptionalQueryClient } from '@/hooks/useOptionalQueryClient'
import { emitStreamEvent, subscribeStreamEvent, STREAM_EVENT } from '@/lib/stream-events'
import { createTerminalSizeState, type TerminalSizeState } from '@/lib/terminal-size-state'
import { shouldUsePasteBinary } from '@/lib/paste-safety'
import { withHostPrefix } from '@/lib/tmux-host-id'
import { zoomCssPoint } from '@/lib/workspace-zoom'
import type { Pane, Session, Window } from '@/types'

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
// 在途 resize 的 ACK 兜底超时：丢 ACK 不能永久卡住后续发送
const RESIZE_ACK_STALE_MS = 1200
// resize 请求代次：随消息下发，resized 原样回声——并发闸按 requestId 精确
// 配对（旧 gateway 不回 requestId 时退回尺寸匹配，见 sizeState.ackSentResize）
let nextResizeRequestId = 0
// 链路中断告警延迟：短于该窗口的断线抖动完全静默（不弹条、不出重试），
// 持续中断才升级为可见告警——避免 reconnect 抖动期状态条频闪误导用户
const LINK_DOWN_ALERT_MS = 1200

export interface PaneGridSocket {
  send: (data: Record<string, unknown>) => boolean
  isConnected: boolean
  isSocketReady: boolean
  // 镜像输出序号（可选）：自定义 socket 实现不必提供，缺省就不上报增量
  getLastMirrorSeq?: () => number | null
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
  retryConnection?: () => void
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
  const { send, isConnected, isSocketReady, subscribeOutput, retryConnection, getLastMirrorSeq } =
    socket || defaultConnection
  // hook 每次渲染都会给出新的 getter 实例：直接进 attachNow 的依赖会让回调每帧重建，
  // 连带触发下游 attach 重跑；用 ref 转一手保持身份稳定
  const getLastMirrorSeqRef = useRef(getLastMirrorSeq)
  getLastMirrorSeqRef.current = getLastMirrorSeq
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
  const { syncAfterWindowChange, refreshSnapshot } = useSessionSnapshotSync()
  const { prompt, PromptElement } = usePrompt()
  const pushToast = useConsoleStore((s) => s.pushToast)
  const setActiveSession = useConsoleStore((s) => s.setActiveSession)
  const setActivePane = useConsoleStore((s) => s.setActivePane)
  // 同步输入广播组（服务端持久）：本格显示的是当前会话的活动 pane，开关就作用于它
  const { data: syncPaneData } = useSyncPanes()
  const setSyncPanes = useSetSyncPanes()
  const toggleSshPanel = useConsoleStore((s) => s.toggleSshPanel)
  const setSessionPanelExpanded = useConsoleStore((s) => s.setSessionPanelExpanded)
  const sessionId = controlledSessionId === undefined ? activeSessionId : controlledSessionId
  const isControlled = controlledSessionId !== undefined
  const { data: orderedSessions = [] } = useOrderedSessions(activeHostId || '')
  const { data: hostsData } = useHosts()
  const { data: windowsData = [] } = useWindows(activeHostId || '', sessionId || '')
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', sessionId || '')
  // 输入帧要带 paneId：网关靠它认出这一帧来自哪个成员 pane，缺省不广播。
  // 用 ref 取最新值，避免 handleInput 的依赖链随活动 pane 变化而重建
  const currentPaneId = String(snapshotData?.activePaneId || '')
  // 任务号是冷元数据（pane user-option @tmuxgo_task 带出来的），随 snapshot 一起来
  const currentPaneTask = useMemo(() => {
    const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
    return panes.find((pane) => pane.id === currentPaneId)?.task || ''
  }, [snapshotData, currentPaneId])
  // 任务号只有当前 pane 能改：PaneGrid 就是当前 pane 的视图，跨 pane 改没有落点。
  // 写后必须 refreshSnapshot——task 随 snapshot 下发，不重取角标不会变
  const handleEditTask = async () => {
    if (!currentPaneId) return
    const value = await prompt(t('pane.taskPrompt'), currentPaneTask)
    if (value === null) return
    const trimmed = value.trim()
    try {
      const result = await api.panes.task(currentPaneId, trimmed)
      if (!result.ok) throw new Error(result.error || t('pane.taskFailed'))
      await refreshSnapshot()
      pushToast({
        type: 'success',
        message: trimmed ? t('pane.taskSaved', { task: trimmed }) : t('pane.taskCleared'),
      })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('pane.taskFailed') })
    }
  }
  const currentPaneIdRef = useRef('')
  currentPaneIdRef.current = currentPaneId
  // 活动 pane 的完整元数据（标题/窗口号）：拖拽 payload 与右键菜单标题都要用它
  const activePane = useMemo(() => {
    const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
    return panes.find((pane) => pane.id === currentPaneId) || null
  }, [snapshotData, currentPaneId])
  // 同一 window 内的 pane 才是「拖到另一个 pane」的合法落点；zoom 态（tmux -Z）
  // 下几何不反映屏幕上看到的区域，落点层直接不画（窗口标签那条路仍可用）
  const paneDropPanes = useMemo(() => {
    const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
    const windowId = activePane?.windowId
    if (!windowId) return []
    return panes.filter((pane) => pane.windowId === windowId)
  }, [snapshotData, activePane])
  const dragPayload = usePaneDrag()
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null)
  // 拖拽被浏览器中断（Esc、拖出窗口、宿主组件卸载）时单例不会自己散场，
  // dragend 收尾 + Esc 显式取消，避免落点层永久挂在终端上
  useEffect(() => {
    const handleDragEnd = () => endPaneDrag()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') endPaneDrag()
    }
    window.addEventListener('dragend', handleDragEnd)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('dragend', handleDragEnd)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
  // 拓扑移动：move 落在 tmux 的 join-pane；成功后必须重取 snapshot（拓扑唯一权威源），
  // 失败把后端 message 原样抛给用户，不静默
  const handleMovePane = async (
    paneId: string,
    target: { targetPaneId?: string; targetWindowId?: string },
    direction?: PaneMoveDirection,
  ) => {
    try {
      // 拓扑端点的 id 必须带 host 前缀（local:%5 / local:@3）；snapshot 里的 id 已经是
      // 这种形式，这里再摆正一次，防止上游传进裸 tmux id
      const hostId = activeHostId || 'local'
      await api.panes.move(withHostPrefix(hostId, paneId), {
        ...(target.targetWindowId ? { targetWindowId: withHostPrefix(hostId, target.targetWindowId) } : {}),
        ...(target.targetPaneId ? { targetPaneId: withHostPrefix(hostId, target.targetPaneId) } : {}),
        ...(direction ? { direction } : {}),
      })
      await refreshSnapshot()
      pushToast({ type: 'success', message: t('pane.moveSuccess') })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('pane.moveFailed') })
    }
  }
  // 移入新窗口：break-pane 只认 pane，不传 name 时沿用 tmux 的默认窗口名
  const handleBreakPane = async () => {
    const paneId = currentPaneIdRef.current
    if (!paneId) {
      pushToast({ type: 'error', message: t('pane.noActive') })
      return
    }
    try {
      await api.panes.break(withHostPrefix(activeHostId || 'local', paneId))
      await refreshSnapshot()
      pushToast({ type: 'success', message: t('pane.breakOutSuccess') })
    } catch (err) {
      pushToast({ type: 'error', message: err instanceof Error ? err.message : t('pane.breakOutFailed') })
    }
  }
  // 所有 input 帧都带当前 pane：网关靠它决定这次击键要不要广播给组内其他成员
  const sendInputFrame = useCallback(
    (data: string) => send({ type: 'input', data, paneId: currentPaneIdRef.current || undefined }),
    [send],
  )
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
  // 「接管」进行中标记：完成条件是收到真实 attached 事件（handleAttached 清除），
  // 点击按钮本身不算接管完成；被 revoke 拒绝回落旁观时恢复可重试
  const [takeoverPending, setTakeoverPending] = useState(false)
  // 链路中断已持续 LINK_DOWN_ALERT_MS：短暂波动不置位（状态条保持静默）。
  // linkDown 只看连接态（reconnecting/disconnected 同属中断，防抖不随二者切换重置）；
  // attach 在途（attaching）不算链路中断——「网络恢复」≠「会话可输入」
  const linkDown = connectionStatus === 'reconnecting' || connectionStatus === 'disconnected'
  const [linkDownAlerted, setLinkDownAlerted] = useState(false)
  // 失焦只降 passive（禁写），保持 exclusive 尺寸/渲染：
  // 若失焦就交出 exclusive，会走 shared 重附着并拆掉 height:100%，终端高度立刻变矮，
  // 且要刷新才能恢复。仅 ownership 被抢时才真正交出 exclusive。
  const exclusive = shared ? false : preferences.attachExclusive && !ownershipLost
  const attachPassive = !pageActive || (!shared && ownershipLost)
  const attachedRef = useRef<string | null>(null)
  const terminalReadyRef = useRef(false)
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachInFlightRef = useRef<string | null>(null)
  const lastSessionRef = useRef<string | null>(sessionId || null)
  const inputQueueRef = useRef<string[]>([])
  const [pendingInputCount, setPendingInputCount] = useState(0)
  const resizeFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const resizeAckStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 尺寸协商 controller：与 TerminalPane/runtime/layout 共享同一实例——
  // 发送面（sentSize/awaitingAck/pendingSend/claimedSize）与渲染面
  // （lastSize/sharedSize/followedSize/pendingSize）走同一转移 API
  const attachExclusiveRef = useRef(exclusive)
  const sizeStateRef = useRef<TerminalSizeState | null>(null)
  if (!sizeStateRef.current) {
    sizeStateRef.current = createTerminalSizeState({ attachExclusiveRef, hasResizeConsumer: () => true })
  }
  const sizeState = sizeStateRef.current
  useEffect(() => {
    attachExclusiveRef.current = exclusive
  }, [exclusive])
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
  // useMemo 固定引用：syncMembers 参与 toggleSyncPane 的依赖，写法内联会让回调每次渲染重建
  const syncMembers = useMemo<{ paneId: string; sessionName: string }[]>(
    () => syncPaneData?.panes || [],
    [syncPaneData],
  )
  const syncPaneMax = syncPaneData?.max || 16
  const currentSyncMember = currentPaneId
    ? syncMembers.some((member: { paneId: string }) => member.paneId === currentPaneId)
    : false
  const toggleSyncPane = useCallback(() => {
    if (!currentPaneId) return
    const next = currentSyncMember
      ? syncMembers.filter((member: { paneId: string }) => member.paneId !== currentPaneId)
      : [...syncMembers, { paneId: currentPaneId, sessionName: renderedSessionName }]
    if (!currentSyncMember && next.length > syncPaneMax) {
      pushToast({ type: 'error', message: t('sync.limit', { max: syncPaneMax }) })
      return
    }
    setSyncPanes.mutate(
      next.map((member: { paneId: string; sessionName: string }) => ({
        paneId: member.paneId,
        sessionName: member.sessionName,
      })),
      { onError: (err) => pushToast({ type: 'error', message: err.message }) },
    )
  }, [currentPaneId, currentSyncMember, pushToast, renderedSessionName, setSyncPanes, syncMembers, syncPaneMax, t])

  const sessionWindows = useMemo(
    () => windowsData.filter((w: Window) => w.sessionId === sessionId),
    [windowsData, sessionId],
  )
  const activeWindowIndex = useMemo(() => sessionWindows.findIndex((w: Window) => w.active), [sessionWindows])
  const navLockRef = useRef(0)
  const switchSession = useCallback(
    (direction: -1 | 1) => {
      if (!sessionId || orderedSessions.length <= 1) return
      const currentIndex = orderedSessions.findIndex((item: Session) => item.id === sessionId)
      if (currentIndex < 0) return
      const next = orderedSessions[(currentIndex + direction + orderedSessions.length) % orderedSessions.length]
      if (next && next.id !== sessionId) setActiveSession(next.id)
    },
    [orderedSessions, sessionId, setActiveSession],
  )
  const selectWindowById = useCallback(
    async (targetWindow: Window) => {
      if (!activeHostId || !sessionId) return
      const previousWindows = getWindows()
      setWindows(
        previousWindows.map((w: Window) =>
          w.sessionId === sessionId ? { ...w, active: w.id === targetWindow.id } : w,
        ),
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
    [activeHostId, sessionId, getWindows, setWindows, pushToast, syncAfterWindowChange, t],
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
      if (targetWindow) await selectWindowById(targetWindow)
    },
    [activeHostId, sessionId, sessionWindows, activeWindowIndex, switchSession, selectWindowById],
  )
  const activeWindow = sessionWindows.find((item: Window) => item.active) || sessionWindows[0] || null
  const activeWindowZoomed = useMemo(() => {
    const snapshotWindows = Array.isArray(snapshotData?.windows) ? snapshotData.windows : []
    const snapshotWindow =
      snapshotWindows.find((w: Window) => w.id === snapshotData?.activeWindowId) ||
      snapshotWindows.find((w: Window) => w.id === activeWindow?.id)
    if (snapshotWindow) return Boolean(snapshotWindow.zoomed)
    return Boolean(activeWindow?.zoomed)
  }, [snapshotData, activeWindow])
  const zoomedPaneCount = useMemo(() => {
    if (!activeWindowZoomed || !activeWindow) return 0
    const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
    return panes.filter((pane: Pane) => pane.windowId === activeWindow.id).length
  }, [activeWindowZoomed, activeWindow, snapshotData])
  const selectPaneById = useCallback(
    async (paneId: string) => {
      setActivePane(paneId)
      try {
        // keepZoom → select-pane -Z：zoom 全屏翻页语义，循环到的 pane 保持 zoom，
        // 不掉回平铺；未 zoom 时网关侧为 no-op
        const result = await api.panes.select(paneId, { keepZoom: activeWindowZoomed })
        if (result?.ok === false) throw new Error(result.error || 'select pane failed')
        void queryClient?.invalidateQueries({
          queryKey: ['session-snapshot', activeHostId || 'local', sessionId || ''],
        })
      } catch {
        pushToast({ type: 'error', message: t('pane.switchFailed') })
      }
    },
    [activeWindowZoomed, setActivePane, queryClient, activeHostId, sessionId, pushToast, t],
  )
  const switchPane = useCallback(
    async (direction: -1 | 1) => {
      const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
      const windowId = snapshotData?.activeWindowId || activeWindow?.id || ''
      const windowPanes = panes
        .filter((pane: Pane) => pane.windowId === windowId)
        .sort((a: Pane, b: Pane) => (a.index ?? 0) - (b.index ?? 0))
      if (windowPanes.length <= 1) return
      const currentPaneId = String(snapshotData?.activePaneId || useConsoleStore.getState().activePaneId || '')
      const currentIndex = Math.max(
        0,
        windowPanes.findIndex((pane: Pane) => pane.id === currentPaneId),
      )
      const next = windowPanes[(currentIndex + direction + windowPanes.length) % windowPanes.length]
      if (!next || next.id === currentPaneId) return
      await selectPaneById(next.id)
    },
    [snapshotData, activeWindow, selectPaneById],
  )
  // display-panes 编号层（仅桌面端）：Alt+p 唤起，数字键直接跳到对应 pane/window
  const activeWindowPanes = useMemo(() => {
    const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
    const windowId = activeWindow?.id || ''
    return panes.filter((pane: Pane) => pane.windowId === windowId)
  }, [snapshotData, activeWindow])
  const displayPanes = useDisplayPanes({
    enabled: !isMobile,
    panes: activeWindowPanes,
    windows: sessionWindows,
    zoomed: activeWindowZoomed,
    onPickPane: (paneId: string) => void selectPaneById(paneId),
    onPickWindow: (windowId: string) => {
      const target = sessionWindows.find((window: Window) => window.id === windowId)
      if (target) void selectWindowById(target)
    },
  })
  // 滑动切换后的方位提示（仅移动端）：数据全部从现有 windows/panes 算，不新增 store 字段
  const [switchHud, setSwitchHud] = useState<SwitchHudPayload | null>(null)
  const buildWindowHud = useCallback(
    (direction: -1 | 1): SwitchHudPayload | null => {
      if (!sessionWindows.length) return null
      const currentIndex = Math.max(
        0,
        sessionWindows.findIndex((window: Window) => window.active),
      )
      const nextIndex = currentIndex + direction
      // 到头会切 session（switchWindow 内部行为）：此时没有 window 邻居可预告，只报当前位
      const inRange = nextIndex >= 0 && nextIndex < sessionWindows.length
      const targetIndex = inRange ? nextIndex : currentIndex
      const target = sessionWindows[targetIndex]
      return {
        windowIndex: targetIndex + 1,
        windowTotal: sessionWindows.length,
        windowName: target?.name || '',
        // 邻居以切换后的落点为基准：否则刚落位的这一屏会把自己显示成邻居
        prevLabel: sessionWindows[targetIndex - 1]?.name,
        nextLabel: sessionWindows[targetIndex + 1]?.name,
      }
    },
    [sessionWindows],
  )
  const buildPaneHud = useCallback(
    (direction: -1 | 1): SwitchHudPayload | null => {
      const panes = Array.isArray(snapshotData?.panes) ? snapshotData.panes : []
      const windowId = snapshotData?.activeWindowId || activeWindow?.id || ''
      const windowPanes = panes
        .filter((pane: Pane) => pane.windowId === windowId)
        .sort((a: Pane, b: Pane) => (a.index ?? 0) - (b.index ?? 0))
      if (windowPanes.length <= 1) return null
      const currentPaneId = String(snapshotData?.activePaneId || useConsoleStore.getState().activePaneId || '')
      const currentIndex = Math.max(
        0,
        windowPanes.findIndex((pane: Pane) => pane.id === currentPaneId),
      )
      const nextIndex = (currentIndex + direction + windowPanes.length) % windowPanes.length
      const next = windowPanes[nextIndex]
      if (!next) return null
      const windowIndex = Math.max(
        0,
        sessionWindows.findIndex((window: Window) => window.active),
      )
      // zoom 态 pane 级：邻居用 pane title（无 title 退回序号），窗口信息仍由当前窗口提供。
      // 与 window 级一致，邻居围绕落点算；列表循环（与 switchPane 的回绕语义对齐）
      const label = (pane: Pane | undefined) => (pane ? pane.title || `#${(pane.index ?? 0) + 1}` : undefined)
      const prevPane = windowPanes[(nextIndex - 1 + windowPanes.length) % windowPanes.length]
      const nextPane = windowPanes[(nextIndex + 1) % windowPanes.length]
      return {
        windowIndex: windowIndex + 1,
        windowTotal: sessionWindows.length || 1,
        windowName: sessionWindows[windowIndex]?.name || '',
        paneIndex: nextIndex + 1,
        paneTotal: windowPanes.length,
        prevLabel: prevPane?.id === next.id ? undefined : label(prevPane),
        nextLabel: nextPane?.id === next.id ? undefined : label(nextPane),
      }
    },
    [snapshotData, activeWindow, sessionWindows],
  )
  const handleSwipeRef = useRef<(direction: -1 | 1) => void>(() => {})
  useEffect(() => {
    handleSwipeRef.current = (direction: -1 | 1) => {
      const now = Date.now()
      // 400ms 手势防抖窗口内的连续滑动直接丢弃，HUD 也不闪
      if (now - navLockRef.current < 400) return
      navLockRef.current = now
      if (activeWindowZoomed && zoomedPaneCount > 1) {
        const hud = buildPaneHud(direction)
        if (hud) setSwitchHud(hud)
        void switchPane(direction)
      } else {
        const hud = buildWindowHud(direction)
        if (hud) setSwitchHud(hud)
        void switchWindow(direction)
      }
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
      const prev = sizeState.sentSize
      if (prev && prev.cols === size.cols && prev.rows === size.rows) return false
      const requestId = ++nextResizeRequestId
      const sent = send({
        type: 'resize',
        hostId: activeHostId || 'local',
        cols: size.cols,
        rows: size.rows,
        requestId,
      })
      if (sent) {
        sizeState.noteResizeSent(size, requestId)
        if (resizeAckStaleTimerRef.current) clearTimeout(resizeAckStaleTimerRef.current)
        // resized ACK 丢失兜底：超时清在途并把队列里最新尺寸补发出去
        resizeAckStaleTimerRef.current = setTimeout(() => {
          resizeAckStaleTimerRef.current = null
          sizeState.noteAckStale()
          flushPendingRemoteResizeRef.current()
        }, RESIZE_ACK_STALE_MS)
      }
      return sent
    },
    [activeHostId, attachPassive, exclusive, send, sizeState],
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
    sizeState.resetSendPlane()
    remoteQuietDeadlineRef.current = 0
    if (resizeAckStaleTimerRef.current) {
      clearTimeout(resizeAckStaleTimerRef.current)
      resizeAckStaleTimerRef.current = null
    }
    clearResizeFlushTimer()
  }, [clearResizeFlushTimer, sizeState])
  const flushPendingRemoteResize = useCallback(() => {
    let size = sizeState.pendingSend
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
    if (sizeState.awaitingAck) return
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
        sizeState.queueSend(peeked)
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
    const sent = sizeState.sentSize
    if (sent && sent.cols === size.cols && sent.rows === size.rows) {
      sizeState.clearPendingSend()
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
    sizeState.clearPendingSend()
    if (!sendResizeNow(size)) {
      emitStreamEvent(STREAM_EVENT.resized, {
        hostId: activeHostId || 'local',
        sessionName: targetSessionName,
        cols: size.cols,
        rows: size.rows,
        localOnly: true,
      })
    }
  }, [
    activeHostId,
    clearRemoteResizeState,
    clearResizeFlushTimer,
    isConnected,
    sendResizeNow,
    sizeState,
    targetSessionName,
  ])
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
      if (!sizeState.pendingSend || resizeFlushTimerRef.current) return
      resizeFlushTimerRef.current = setTimeout(() => {
        resizeFlushTimerRef.current = null
        flushPendingRemoteResize()
      }, RESIZE_POINTER_SETTLE_MS)
    }
    return subscribeStreamEvent(STREAM_EVENT.resizeGesture, handleResizeGesture)
  }, [clearResizeFlushTimer, flushPendingRemoteResize, sizeState])
  // 服务端 window 尺寸仲裁：本端 client pty 已被同步到推送尺寸——sentSize
  // 对齐推送值、在途作废弃置，随后布局回声走 isEchoSize/dedup 不再发包
  useEffect(() => {
    const handleWindowSize = (
      detail: {
        hostId?: string
        sessionName?: string
        cols?: number
        rows?: number
        windowVersion?: number
        ownerEpoch?: number
      } = {},
    ) => {
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName !== targetSessionName) return
      const cols = Number(detail.cols)
      const rows = Number(detail.rows)
      if (cols <= 0 || rows <= 0) return
      // 陈旧推送（乱序旧版本/旧 owner 世代）不清理定时器——避免假释放
      if (
        !sizeState.noteWindowSize(cols, rows, {
          windowVersion: Number(detail.windowVersion) || 0,
          ownerEpoch: Number(detail.ownerEpoch) || 0,
        })
      )
        return
      if (resizeAckStaleTimerRef.current) {
        clearTimeout(resizeAckStaleTimerRef.current)
        resizeAckStaleTimerRef.current = null
      }
    }
    return subscribeStreamEvent(STREAM_EVENT.windowSize, handleWindowSize)
  }, [activeHostId, sizeState, targetSessionName])
  const clearContinuityTimer = useCallback(() => {
    if (!continuityTimerRef.current) return
    clearTimeout(continuityTimerRef.current)
    continuityTimerRef.current = null
  }, [])
  const flushResumePoint = useCallback(() => {
    if (isControlled || !sessionContinuity.enabled) return
    if (!activeHostId || !sessionId || !sessionName) return
    const activeWindow = sessionWindows.find((item: Window) => item.active) || sessionWindows[0] || null
    const now = new Date().toISOString()
    const size = sizeState.claimedSize
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
    sizeState,
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
    setPendingInputCount(0)
    let batch = ''
    for (const chunk of queued) {
      if (!chunk) continue
      if (batch.length + chunk.length > INPUT_BATCH_CHARS && batch) {
        sendInputFrame(batch)
        batch = ''
      }
      batch += chunk
      if (batch.length >= INPUT_BATCH_CHARS) {
        sendInputFrame(batch)
        batch = ''
      }
    }
    if (batch) sendInputFrame(batch)
  }, [clearInputFlushTimer, isConnected, sendInputFrame, targetSessionName])
  const scheduleInputFlush = useCallback(() => {
    if (inputFlushTimerRef.current) return
    inputFlushTimerRef.current = setTimeout(() => {
      inputFlushTimerRef.current = null
      flushInputQueue()
    }, INPUT_FLUSH_INTERVAL)
  }, [flushInputQueue])
  // 用户显式丢弃待发输入：清空队列并取消已排程的补发——清空后绝不自动重放
  const clearPendingInput = useCallback(() => {
    clearInputFlushTimer()
    inputQueueRef.current = []
    setPendingInputCount(0)
    // 只给轻量反馈，不回显待发内容（可能含密码）
    pushToast({ type: 'info', message: t('grid.input.cleared') })
  }, [clearInputFlushTimer, pushToast, t])
  const attachNow = useCallback(() => {
    if (!targetSessionName || !isSocketReady || !terminalReadyRef.current) return
    const attachKey = `${activeHostId || 'local'}:${targetSessionName}:${exclusive ? 'exclusive' : 'shared'}:${attachPassive ? 'passive' : 'active'}`
    if (attachInFlightRef.current === attachKey) return
    const size = sizeState.claimedSize
    clearAttachTimers()
    attachInFlightRef.current = attachKey
    attachStartedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now()
    isSessionAttachedRef.current = false
    updateConnectionState({ status: 'attaching' })
    // 断线前收到的镜像输出序号：服务端镜像环里还有这段就只补增量。
    // 拿不到（二进制输出帧/首连/刚收过快照）时一律不发，让服务端走整快照——
    // 报一个偏旧的值会导致重复渲染
    const lastSeq = getLastMirrorSeqRef.current?.()
    const sent = send({
      type: 'attach',
      hostId: activeHostId || 'local',
      sessionName: targetSessionName,
      // 浏览器视角：网关切 tmux grouped session，让每个浏览器有自己的 current window。
      // 不在 attachKey 里——同一浏览器内该值恒定，不影响去重。
      viewId: getViewId(),
      cols: size?.cols || 120,
      rows: size?.rows || 36,
      exclusive,
      ...(attachPassive ? { passive: true } : {}),
      ...(typeof lastSeq === 'number' && lastSeq > 0 ? { lastSeq } : {}),
    })
    if (!sent) {
      attachInFlightRef.current = null
      return
    }
    attachTimerRef.current = setTimeout(() => {
      attachInFlightRef.current = null
      attachedRef.current = null
      sizeState.resetRemoteSize()
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
    sizeState,
    targetSessionName,
    updateConnectionState,
  ])

  useEffect(() => {
    if (!sessionId) {
      lastSessionRef.current = null
      pendingSessionIdRef.current = null
      pendingSessionNameRef.current = null
      // TerminalPane 随空态卸载：ready 必须归位等下一轮挂载重新置位，
      // 否则残留 true 会让 attach 赶在输出订阅注册前发出——attach 后的
      // 首批重绘帧在订阅空窗被丢弃，安静 session 无后续输出即白屏
      terminalReadyRef.current = false
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
    sizeState.resetRemoteSize()
    // 会话几何随目标一起作废旧上下文：上个会话的服务端推送尺寸残留会让
    // 新终端按旧 geometry 走共享布局，且 followedSize 卡住独占 fit 使
    // notifyReady 永不触发（attach 被 ready 闸永久阻塞→白屏）
    sizeState.resetSessionSizes()
    inputQueueRef.current = []
    setPendingInputCount(0)
  }, [
    targetSessionName,
    clearAttachTimers,
    clearInputFlushTimer,
    clearContinuityTimer,
    clearRemoteResizeState,
    sizeState,
  ])
  useEffect(() => {
    if (!socket && connectionStatus === 'disconnected') {
      clearAttachTimers()
      clearInputFlushTimer()
      clearContinuityTimer()
      clearRemoteResizeState()
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sizeState.resetRemoteSize()
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
    sizeState,
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
      sizeState.resetRemoteSize()
      if (terminalReadyRef.current) attachNow()
    }
    return subscribeStreamEvent(STREAM_EVENT.reconnected, handleReconnect)
  }, [attachNow, clearAttachTimers, clearInputFlushTimer, clearContinuityTimer, clearRemoteResizeState, sizeState])
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
    sizeState.resetRemoteSize()
    attachNow()
  }, [exclusive, attachPassive, targetSessionName, attachNow, clearAttachTimers, clearRemoteResizeState, sizeState])
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
  useEffect(() => {
    // 链路中断告警防抖：状态条只在中断持续 LINK_DOWN_ALERT_MS 后升级，期内
    // 恢复即复位；依赖布尔值而非 status——重连周期内 disconnected↔reconnecting
    // 反复切换不重置计时，否则持续中断永远等不到告警
    if (!linkDown) {
      setLinkDownAlerted(false)
      return
    }
    const timer = setTimeout(() => setLinkDownAlerted(true), LINK_DOWN_ALERT_MS)
    return () => clearTimeout(timer)
  }, [linkDown])
  const ownershipSessionRef = useRef<string | null>(targetSessionName)
  useEffect(() => {
    // 仅在真正切换 session 时清所有权丢失标记，避免与 exclusive-revoked 抢状态
    if (ownershipSessionRef.current === targetSessionName) return
    ownershipSessionRef.current = targetSessionName
    setOwnershipLost(false)
    setTakeoverPending(false)
  }, [targetSessionName, activeHostId])
  useEffect(() => {
    const handleExclusiveRevoked = (detail: { hostId?: string; sessionName?: string; ownerEpoch?: number } = {}) => {
      // 同 host 即降级：多端抢焦时 session 名解析可能短暂不一致，宁可降级也不双写
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && targetSessionName && detail.sessionName !== targetSessionName) return
      setOwnershipLost(true)
      setTakeoverPending(false)
      // 新世代已开启：旧世代迟来的 resized/window-size 由 controller 判陈旧
      sizeState.noteOwnerEpoch(Number(detail.ownerEpoch) || 0)
    }
    return subscribeStreamEvent(STREAM_EVENT.exclusiveRevoked, handleExclusiveRevoked)
  }, [activeHostId, sizeState, targetSessionName])
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
    const handleAttached = (
      detail: {
        hostId?: string
        sessionName?: string
        cols?: number
        rows?: number
        exclusive?: boolean
        windowVersion?: number
        ownerEpoch?: number
      } = {},
    ) => {
      if (detail.sessionName !== targetSessionName) return
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      clearAttachTimers()
      attachInFlightRef.current = null
      attachedRef.current = targetSessionName
      isSessionAttachedRef.current = true
      setTakeoverPending(false)
      if (pendingSessionIdRef.current && pendingSessionNameRef.current === detail.sessionName) {
        setVisibleSessionId(pendingSessionIdRef.current)
        pendingSessionIdRef.current = null
        pendingSessionNameRef.current = null
      }
      const attachedCols = Number(detail.cols)
      const attachedRows = Number(detail.rows)
      // 与 runtime 同一 controller：对齐服务端已知尺寸、按 exclusive 重写
      // 跟随态、作废旧上下文在途/排队 resize
      sizeState.noteAttached(detail.exclusive === true, attachedCols, attachedRows, {
        windowVersion: Number(detail.windowVersion) || 0,
        ownerEpoch: Number(detail.ownerEpoch) || 0,
      })
      clearRemoteResizeState()
      const attachLatency = Math.max(
        0,
        Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - attachStartedAtRef.current),
      )
      updateConnectionState({ status: 'connected' })
      updateTerminalPerf({ attachLatency })
      flushInputQueue()
      if (exclusive && sizeState.claimedSize) sendResizeNow(sizeState.claimedSize)
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
    sizeState,
  ])
  useEffect(() => {
    const handleDetached = (detail: { hostId?: string; sessionName?: string } = {}) => {
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      attachedRef.current = null
      attachInFlightRef.current = null
      isSessionAttachedRef.current = false
      sizeState.resetRemoteSize()
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
    sizeState,
    targetSessionName,
    updateConnectionState,
  ])
  useEffect(() => {
    const handleRemoteResized = (
      detail: {
        hostId?: string
        sessionName?: string
        cols?: number
        rows?: number
        requestId?: string | number
        ownerEpoch?: number
        localOnly?: boolean
      } = {},
    ) => {
      if (detail?.localOnly) return
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      // ACK 配对：带 requestId 精确消歧，缺省退回尺寸匹配；旧世代/被覆盖
      // 请求的迟来 ACK 不得解锁在途并发（详见 sizeState.ackSentResize）
      if (
        !sizeState.ackSentResize(Number(detail.cols), Number(detail.rows), {
          requestId: detail.requestId,
          ownerEpoch: Number(detail.ownerEpoch) || 0,
        })
      )
        return
      if (resizeAckStaleTimerRef.current) {
        clearTimeout(resizeAckStaleTimerRef.current)
        resizeAckStaleTimerRef.current = null
      }
      flushPendingRemoteResize()
    }
    return subscribeStreamEvent(STREAM_EVENT.resized, handleRemoteResized)
  }, [activeHostId, flushPendingRemoteResize, sizeState, targetSessionName])
  useEffect(() => {
    const handleError = (detail: { hostId?: string; sessionName?: string; message?: string } = {}) => {
      if ((detail.hostId || 'local') !== (activeHostId || 'local')) return
      if (detail.sessionName && detail.sessionName !== targetSessionName) return
      clearAttachTimers()
      attachInFlightRef.current = null
      attachedRef.current = null
      isSessionAttachedRef.current = false
      sizeState.resetRemoteSize()
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
    sizeState,
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
          paneId: currentPaneIdRef.current || undefined,
          data,
          hostId: activeHostId || 'local',
          sessionName: targetSessionName,
        })
        return
      }
      if (canWriteDirectly) {
        if (inputQueueRef.current.length === 0 && data.length <= INPUT_BATCH_CHARS) {
          sendInputFrame(data)
          return
        }
        inputQueueRef.current.push(data)
        setPendingInputCount(inputQueueRef.current.length)
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
      setPendingInputCount(inputQueueRef.current.length)
      if (isSocketReady && terminalReadyRef.current) attachNow()
    },
    [
      activeHostId,
      attachNow,
      isConnected,
      isSocketReady,
      send,
      targetSessionName,
      scheduleInputFlush,
      scheduleContinuityFlush,
      sendInputFrame,
    ],
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
      // 不覆盖 claimedSize 期望尺寸（refocus 重新 attach 时要按期望尺寸主张）
      if (sizeState.isEchoSize(cols, rows)) {
        sizeState.clearPendingSend()
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
      sizeState.noteClaimed(nextSize)
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
      const sent = sizeState.sentSize
      if (sent && sent.cols === cols && sent.rows === rows && !sizeState.awaitingAck) {
        sizeState.clearPendingSend()
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
      sizeState.queueSend(nextSize)
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
      sizeState,
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
    if (attachedRef.current === targetSessionName) {
      // attach 先于本轮终端就绪完成（如 runtime 就地重建）：attach 后的首批
      // 重绘帧可能赶在输出订阅注册前到达被丢弃，补一发 redraw 兜底恢复画面
      send({ type: 'redraw', hostId: activeHostId || 'local', sessionName: targetSessionName })
      return
    }
    attachNow()
    scheduleContinuityFlush(50)
  }, [targetSessionName, attachNow, scheduleContinuityFlush, send, activeHostId])
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
    // 空状态给明确下一步：无主机→添加主机；有主机无会话→新建会话；
    // 有会话未选中→选最近会话。复用既有入口，不增强制导览
    const hasHosts = (hostsData?.length ?? 0) > 0
    const hasSessions = orderedSessions.length > 0
    // 「最近」按设备端连续性记录取本主机最后访问且仍存在的会话；
    // 无有效记录时退回手动排序首位，不改变用户侧栏排序
    const recentSessionId =
      pickRecentSessionId(
        sessionContinuity.resumePoints,
        activeHostId || 'local',
        orderedSessions.map((item: Session) => item.id),
      ) ?? orderedSessions[0]?.id
    const openCreateSession = () => {
      setSessionPanelExpanded(true)
      window.dispatchEvent(new Event('tmuxgo-open-create-session'))
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-3 gap-4">
        <div className="text-6xl">⊞</div>
        <div className="text-lg">{t('grid.noWindows')}</div>
        <div className="text-sm">{t('grid.selectSession')}</div>
        {hostsData && !hasHosts ? (
          <button
            className="rounded-apple bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
            onClick={() => toggleSshPanel()}
          >
            {t('grid.addHost')}
          </button>
        ) : hasHosts && !hasSessions ? (
          <button
            className="rounded-apple bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
            onClick={openCreateSession}
          >
            {t('grid.createSession')}
          </button>
        ) : hasSessions ? (
          <button
            className="rounded-apple bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
            onClick={() => recentSessionId && setActiveSession(recentSessionId)}
          >
            {t('grid.selectRecent')}
          </button>
        ) : null}
        {/* 有快照才出现：空态本来可能一个会话都没有，恢复入口往往就是唯一能走的路 */}
        <SnapshotResumeHint hostId={activeHostId || 'local'} />
      </div>
    )
  }

  // 控制权状态条：区分 可输入/旁观/附着中/只读分享——被动旁观时输入会被
  // 服务端丢弃，若没有提示用户会以为键盘失灵；只读分享绝不显示接管入口。
  // 「网络恢复」不等于「会话可输入」：attach 未完成（ws 未就绪/attached 未回）
  // 立即显示「正在附着」；链路掉线先静默，持续 LINK_DOWN_ALERT_MS 才升级告警
  const attachPending = !isConnected || !isSocketReady
  const showAttaching = linkDown ? linkDownAlerted : attachPending
  const ownershipStatus = shared
    ? 'readonly'
    : ownershipLost
      ? 'spectating'
      : showAttaching
        ? 'attaching'
        : !pageActive
          ? 'inactive'
          : 'owned'
  const ownershipLabel =
    ownershipStatus === 'attaching'
      ? connectionStatus === 'reconnecting'
        ? t('grid.control.reconnecting')
        : connectionStatus === 'disconnected'
          ? t('status.disconnected')
          : t('grid.control.attaching')
      : t(`grid.control.${ownershipStatus}`)
  // 就绪态无可行动项时整条收起（不再常驻遮挡终端顶部）；旁观/附着中/断连/
  // 待发输入/接管请求中才展开为可行动条。max-w+flex-wrap 让 320px 窄屏下
  // 按钮不被裁掉、可换行；容器 pointer-events-none 不吞终端首行触摸
  const statusCollapsed = ownershipStatus === 'owned' && pendingInputCount === 0 && !takeoverPending
  return (
    <div
      data-sync-member={currentSyncMember ? 'true' : undefined}
      data-terminal-pane
      className={`tmuxgo-content-surface relative h-full w-full min-h-0 min-w-0 overflow-hidden ${
        currentSyncMember ? 'ring-2 ring-inset ring-accent/60' : ''
      }`}
    >
      <div
        data-ownership={ownershipStatus}
        style={{ top: 'calc(0.5rem + env(safe-area-inset-top, 0px))' }}
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 z-20 max-w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-full border px-3 py-1 text-center text-xs transition-opacity ${
          statusCollapsed
            ? 'hidden'
            : `flex flex-wrap ${
                ownershipStatus === 'spectating' || ownershipStatus === 'inactive'
                  ? 'border-[var(--line)] bg-bg-2/95 text-warn'
                  : 'border-[var(--line)] bg-bg-2/95 text-text-1'
              }`
        }`}
      >
        {!statusCollapsed && ownershipStatus !== 'owned' && ownershipLabel}
        {takeoverPending ? (
          <span data-testid="takeover-pending" className="text-text-3">
            {t('grid.control.takeoverPending')}
          </span>
        ) : (
          ownershipStatus === 'spectating' && (
            <button
              className="pointer-events-auto text-accent hover:underline"
              onClick={() => {
                setTakeoverPending(true)
                setOwnershipLost(false)
              }}
            >
              {t('grid.control.takeover')}
            </button>
          )
        )}
        {currentPaneId && (
          <button
            data-testid="sync-pane-toggle"
            aria-pressed={currentSyncMember}
            className={`pointer-events-auto hover:underline ${currentSyncMember ? 'text-accent' : 'text-text-3'}`}
            onClick={toggleSyncPane}
          >
            {currentSyncMember ? t('sync.leave') : t('sync.join')}
          </button>
        )}
        {syncMembers.length > 0 && (
          <span data-testid="sync-pane-count" className="text-accent">
            {t('sync.active', { count: syncMembers.length })}
          </span>
        )}
        {linkDown && linkDownAlerted && retryConnection && (
          <button className="pointer-events-auto text-accent hover:underline" onClick={retryConnection}>
            {t('grid.input.retry')}
          </button>
        )}
        {pendingInputCount > 0 && (
          <>
            <span className="text-warn">{t('grid.input.pending', { count: pendingInputCount })}</span>
            <button className="pointer-events-auto text-accent hover:underline" onClick={clearPendingInput}>
              {t('grid.input.clear')}
            </button>
          </>
        )}
      </div>
      {/* 左上角小角标：HUD 在顶部居中且就绪态会收起，任务号得常驻可见，所以单独定位。
          有任务时点角标即改；没任务时给一个极淡的小旗子入口——桌面和触屏都常显，
          移动端因此也有一条可达路径（不依赖 hover）。
          拖拽把手与「⋯」菜单跟任务号同一行：pane 的标题/把手是拓扑手势的起点，
          右键这一条即 pane 菜单（终端正文里的右键留给浏览器原生菜单，复制粘贴不受影响） */}
      {currentPaneId && (
        <div
          style={{ top: 'calc(0.25rem + env(safe-area-inset-top, 0px))' }}
          // 整条不拦指针：只有把手/任务号/菜单按钮自己收事件，终端首行照常可点
          className="pointer-events-none absolute left-1.5 right-1.5 z-20 flex items-start justify-between gap-1"
        >
          <div
            data-testid="pane-chrome-handle"
            className="pointer-events-auto flex min-w-0 items-center gap-1"
            onContextMenu={(event) => {
              event.preventDefault()
              setPaneMenu({ ...zoomCssPoint(event.clientX, event.clientY) })
            }}
          >
            <button
              type="button"
              data-testid="pane-drag-handle"
              draggable={!isMobile}
              aria-label={t('pane.dragHint')}
              title={t('pane.dragHint')}
              onDragStart={(event) => {
                if (!currentPaneId) return
                const payload = { paneId: currentPaneId, windowId: activePane?.windowId, title: activePane?.title }
                event.dataTransfer.setData(PANE_DRAG_MIME, JSON.stringify(payload))
                event.dataTransfer.effectAllowed = 'move'
                startPaneDrag(payload)
                setPaneMenu(null)
              }}
              onDragEnd={() => endPaneDrag(currentPaneId)}
              className="pointer-events-auto rounded px-1 py-0.5 text-caption text-text-3/50 transition-colors hover:bg-bg-2/90 hover:text-text-3 focus:text-text-3"
            >
              ⣿
            </button>
            {currentPaneTask ? (
              <button
                type="button"
                data-testid="pane-task-chip"
                onClick={() => void handleEditTask()}
                title={t('pane.taskTitle', { task: currentPaneTask })}
                className="pointer-events-auto max-w-full truncate rounded border border-[var(--line)] bg-bg-2/90 px-1.5 py-0.5 text-caption text-text-3 transition-opacity hover:opacity-80"
              >
                {currentPaneTask}
              </button>
            ) : (
              <button
                type="button"
                data-testid="pane-task-add"
                onClick={() => void handleEditTask()}
                aria-label={t('pane.taskAdd')}
                title={t('pane.taskAdd')}
                // 不做 opacity-0 隐形入口：看不见却拦截点击会让人以为终端左上角坏了，
                // 改成极淡但可见的小旗子（hover 变亮），触屏同样可见
                className="pointer-events-auto rounded px-1 py-0.5 text-caption text-text-3/40 transition-colors hover:bg-bg-2/90 hover:text-text-3 focus:text-text-3"
              >
                ⚑
              </button>
            )}
          </div>
          <button
            type="button"
            data-testid="pane-menu-trigger"
            aria-label={t('pane.menu')}
            title={t('pane.menu')}
            onClick={(event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              setPaneMenu({ x: rect.left, y: rect.bottom + 4 })
            }}
            className="pointer-events-auto shrink-0 rounded px-1 py-0.5 text-caption text-text-3/50 transition-colors hover:bg-bg-2/90 hover:text-text-3 focus:text-text-3"
          >
            ⋯
          </button>
        </div>
      )}
      {dragPayload && !activeWindowZoomed && paneDropPanes.length > 1 && (
        <PaneMoveOverlay
          panes={paneDropPanes}
          dragPaneId={dragPayload.paneId}
          onMove={(paneId, targetPaneId, direction) => void handleMovePane(paneId, { targetPaneId }, direction)}
        />
      )}
      {paneMenu && (
        <EditorContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          title={activePane ? `${activePane.title || 'shell'} #${activePane.index}` : undefined}
          actions={[{ id: 'pane-break-out', label: t('pane.breakOut'), onSelect: () => void handleBreakPane() }]}
          onClose={() => setPaneMenu(null)}
        />
      )}

      {PromptElement}
      {displayPanes.active && <PaneNumberOverlay mode={displayPanes.mode} targets={displayPanes.targets} />}
      {isMobile && <SwitchHud payload={switchHud} />}
      <TerminalPane
        sessionName={renderedSessionName}
        onInput={handleInput}
        onResize={handleResize}
        onResizeActivity={handleResizeActivity}
        layoutSyncPendingRef={layoutSyncPendingRef}
        peekFitSizeRef={peekFitSizeRef}
        attachExclusive={exclusive}
        attachExclusiveRef={attachExclusiveRef}
        sizeState={sizeState}
        onReady={handleReady}
        subscribeOutput={subscribeOutput}
        send={send}
        onSwipeLeft={!isControlled ? handleSwipeLeft : undefined}
        onSwipeRight={!isControlled ? handleSwipeRight : undefined}
      />
    </div>
  )
}
