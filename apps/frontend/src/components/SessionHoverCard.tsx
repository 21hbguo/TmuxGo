'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { summarizeAgentByWindow } from '@/lib/agent-status'
import { useTranslation } from '@/i18n'
import type { Pane } from '@/types'
import { AgentStatusBadge } from './AgentStatusBadge'
import { ModalPortal } from './ModalPortal'

/** hover 停留多久才弹：划过列表时不触发 */
const SHOW_DELAY_MS = 450
/** 指针离开行后的宽限：留时间跨过行与卡片之间的间隙，移入卡片即取消 */
const HIDE_GRACE_MS = 160
const GAP = 8
const EDGE = 8

export interface SessionHoverCardProps {
  hostId: string
  sessionId: string
  /** 完整 session 名（列表行里是 truncate 的），卡头展示 */
  sessionName: string
  /** 行 hover 时传该行 getBoundingClientRect()；指针离开行传 null（卡片自行宽限关闭） */
  anchorRect: DOMRect | null
  /** 卡片自行关闭（Esc / 滚动 / 点击外部 / 指针移出卡片）时通知；父不需要回写状态，可忽略 */
  onClose?: () => void
}

/**
 * 侧栏 session 行悬浮预览卡：完整名字 + window → pane 树 + agent 状态。
 * 只负责展示与自身开关；拖拽/batch 模式等"不该弹"的判断由调用方不给 anchorRect 完成。
 */
export function SessionHoverCard({ hostId, sessionId, sessionName, anchorRect, onClose }: SessionHoverCardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // 懒加载闸门：首次弹出后才发请求（之后命中 react-query 缓存）
  const [armed, setArmed] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const anchorRef = useRef<DOMRect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
  }, [])
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])
  const close = useCallback(() => {
    clearShowTimer()
    clearHideTimer()
    setOpen(false)
    setPos(null)
    onCloseRef.current?.()
  }, [clearShowTimer, clearHideTimer])
  const scheduleHide = useCallback(() => {
    clearHideTimer()
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      close()
    }, HIDE_GRACE_MS)
  }, [clearHideTimer, close])

  useEffect(() => {
    if (anchorRect) {
      anchorRef.current = anchorRect
      clearHideTimer()
      if (!open) {
        clearShowTimer()
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null
          setOpen(true)
          setArmed(true)
        }, SHOW_DELAY_MS)
      }
      return
    }
    // 指针离开行：还没弹出就直接取消；已弹出则宽限一段再关
    clearShowTimer()
    if (open) scheduleHide()
  }, [anchorRect, open, clearShowTimer, clearHideTimer, scheduleHide])

  useEffect(
    () => () => {
      clearShowTimer()
      clearHideTimer()
    },
    [clearShowTimer, clearHideTimer],
  )

  const {
    data: snapshot,
    isLoading,
    isError,
  } = useQuery({
    // key 与 useSessionSnapshot 一致：能直接复用 SessionPanel/WindowTabs 已拉的缓存
    queryKey: ['session-snapshot', hostId, sessionId],
    queryFn: () => api.snapshot.get(hostId, sessionId),
    enabled: armed && !!hostId && !!sessionId,
    staleTime: 1200,
    // 卡片展开时跟随现网刷新，收起就停，避免给每个划过的 session 常驻轮询
    refetchInterval: open ? 5000 : false,
    refetchOnWindowFocus: false,
  })

  const place = useCallback(() => {
    const el = cardRef.current
    const rect = anchorRef.current
    if (!el || !rect) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const fitsRight = rect.right + GAP + width <= vw - EDGE
    const fitsLeft = rect.left - GAP - width >= EDGE
    let left: number
    let top: number
    if (fitsRight) {
      left = rect.right + GAP
      top = rect.top
    } else if (fitsLeft) {
      left = rect.left - GAP - width
      top = rect.top
    } else {
      // 左右都放不下（窄屏）：改成行下方、水平夹进视口；下方也放不下再翻到上方
      left = Math.min(Math.max(EDGE, rect.left), Math.max(EDGE, vw - EDGE - width))
      top = rect.bottom + GAP
      if (top + height > vh - EDGE) top = rect.top - GAP - height
    }
    if (top + height > vh - EDGE) top = vh - EDGE - height
    if (top < EDGE) top = EDGE
    setPos((current) => (current && current.top === top && current.left === left ? current : { top, left }))
  }, [])

  useLayoutEffect(() => {
    if (anchorRect) anchorRef.current = anchorRect
  }, [anchorRect])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place, snapshot, anchorRect])

  // 内容异步填充/状态徽标增减会改高度，量到就重新定位
  useEffect(() => {
    if (!open) return
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place())
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onScroll = (event: Event) => {
      // 卡片自身内容滚动不关；侧栏/页面滚动手上的锚点已失效，直接关
      // target 可能是 window/document 等非 Node（jsdom 会抛 TypeError），先收窄
      if (event.target instanceof Node && cardRef.current?.contains(event.target)) return
      close()
    }
    const onResize = () => close()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !cardRef.current?.contains(event.target)) close()
    }
    // 滚动用 capture：侧栏滚动容器的 scroll 不冒泡到 window
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown, true)
    }
  }, [open, close])

  const windows = snapshot?.windows
  const panesByWindow = useMemo(() => {
    const map = new Map<string, Pane[]>()
    for (const pane of snapshot?.panes ?? []) {
      const list = map.get(pane.windowId)
      if (list) list.push(pane)
      else map.set(pane.windowId, [pane])
    }
    return map
  }, [snapshot?.panes])
  const rollups = useMemo(
    () => new Map(summarizeAgentByWindow(snapshot?.panes ?? []).map((rollup) => [rollup.windowId, rollup])),
    [snapshot?.panes],
  )

  if (!open) return null

  const windowList = windows ?? []
  const paneCount = snapshot?.panes?.length ?? 0

  return (
    <ModalPortal>
      {/* 组头有 backdrop-blur（会成 fixed 包含块）且列表容器 overflow 裁剪——必须 portal 到 body 用 fixed 定位 */}
      <div
        ref={cardRef}
        role="tooltip"
        data-testid="session-hover-card"
        className="tmuxgo-menu fixed z-[90] w-72 max-w-[calc(100vw-1rem)] text-xs"
        style={{
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          // 首次测量完成前先藏起来，避免在 (0,0) 闪一下
          visibility: pos ? 'visible' : 'hidden',
        }}
        onMouseEnter={clearHideTimer}
        onMouseLeave={scheduleHide}
      >
        <div className="border-b border-[var(--line)] px-3 py-2">
          <div className="break-all text-sm font-medium text-text-1" data-testid="session-hover-card-name">
            {sessionName}
          </div>
          <div className="mt-0.5 text-meta tabular-nums text-text-3">
            {t('sessionHover.summary', { windows: windowList.length, panes: paneCount })}
          </div>
        </div>
        <div className="max-h-[min(60vh,24rem)] overflow-y-auto py-1">
          {isLoading && !snapshot && <div className="px-3 py-2 text-meta text-text-3">{t('sessionHover.loading')}</div>}
          {isError && !snapshot && <div className="px-3 py-2 text-meta text-danger">{t('sessionHover.error')}</div>}
          {snapshot && windowList.length === 0 && (
            <div className="px-3 py-2 text-meta text-text-3">{t('sessionHover.noWindows')}</div>
          )}
          {windowList.map((win) => {
            const windowPanes = panesByWindow.get(win.id) ?? []
            return (
              <div key={win.id} className="px-2 py-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn('shrink-0 tabular-nums', win.active ? 'text-accent' : 'text-text-3')}>
                    {win.index}
                  </span>
                  <span
                    className={cn('min-w-0 flex-1 truncate', win.active ? 'text-text-1' : 'text-text-2')}
                    title={win.name || t('sessionHover.untitledWindow')}
                  >
                    {win.name || t('sessionHover.untitledWindow')}
                  </span>
                  {win.zoomed && (
                    <span className="shrink-0 rounded-full border border-[var(--line)] px-1 text-caption text-text-3">
                      {t('sessionHover.zoomed')}
                    </span>
                  )}
                  <AgentStatusBadge summary={rollups.get(win.id)?.summary} compact />
                </div>
                <div className="mt-0.5 space-y-0.5 border-l border-[var(--line)] pl-2">
                  {windowPanes.map((pane) => (
                    <div key={pane.id} className="flex items-center gap-1.5">
                      {/* pane.index 即 tmux pane_index，受 pane-base-index 影响，原样显示不 +1 */}
                      <span className={cn('shrink-0 tabular-nums', pane.active ? 'text-accent' : 'text-text-3')}>
                        {pane.index}
                      </span>
                      <span
                        className={cn('min-w-0 flex-1 truncate', pane.active ? 'text-text-1' : 'text-text-2')}
                        title={pane.title || pane.tmuxPaneId || pane.id}
                      >
                        {pane.title || t('sessionHover.untitledPane')}
                      </span>
                      {pane.task && (
                        <span className="shrink-0 rounded-full bg-bg-2/70 px-1 text-caption tabular-nums text-text-3">
                          {pane.task}
                        </span>
                      )}
                      <AgentStatusBadge status={pane.agentStatus} compact />
                    </div>
                  ))}
                  {windowPanes.length === 0 && <div className="text-meta text-text-3">{t('sessionHover.noPanes')}</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </ModalPortal>
  )
}
