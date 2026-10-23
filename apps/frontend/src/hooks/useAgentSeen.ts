'use client'
import { useEffect, useRef, useState } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useSessionSnapshot } from './useApi'
import { useWebSocket } from './useWebSocket'

// done 徽标停驻多久才认账：走马观花式的切换不该清掉别处的提醒，
// 但真读完了要能消；800ms 是"视线停留"与"误触"的分界，也是 lead 拍的值
export const AGENT_SEEN_DWELL_MS = 800
// ack key 去重集合上限：pane 数是有限的，但 eventId 每次 done 都换，超限后整体清空重来
const SEEN_KEY_LIMIT = 200

// 显式 ack：活动 pane 在可见状态下持续 done 满 AGENT_SEEN_DWELL_MS 才发 agent_seen。
// 服务端把它当幂等操作（清 done 徽标），不依赖这次 ack 必然到达
export function useAgentSeen() {
  const { send, isSocketReady } = useWebSocket()
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const [pageVisible, setPageVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  )
  const { data: snapshot } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const sentRef = useRef(new Set<string>())
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  const activePane = snapshot?.panes?.find((pane) => pane.id === activePaneId)
  // 一次 done 的标识：同一状态反复渲染不该重复计时，换了 agent 事件才算新的一轮
  const ackKey =
    activePane?.agentStatus === 'done' && activePaneId
      ? `${activePaneId}:${activePane.eventId || activePane.stateSeq || activePane.revision}`
      : ''
  useEffect(() => {
    if (!ackKey || !isSocketReady || !pageVisible) return
    if (sentRef.current.has(ackKey)) return
    const timer = window.setTimeout(() => {
      // 计时途中切到后台就当没看见：回来重新计满
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (sentRef.current.size >= SEEN_KEY_LIMIT) sentRef.current.clear()
      sentRef.current.add(ackKey)
      send({ type: 'agent_seen', paneId: activePaneId })
    }, AGENT_SEEN_DWELL_MS)
    return () => window.clearTimeout(timer)
  }, [ackKey, activePaneId, isSocketReady, pageVisible, send])
}
