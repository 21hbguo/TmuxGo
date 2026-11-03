'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionOrderPreference } from '@/types'
import { api } from '@/lib/api'
import { useSessions } from './useApi'
import { useSessionChangeFeed } from './useSessionChangeFeed'
import { orderSessions } from '@/lib/session-order'

const SESSION_ORDER_KEY_PREFIX = 'tmuxgo-session-order:'
const SESSION_ORDER_UPDATED_AT_KEY_PREFIX = 'tmuxgo-session-order-updated-at:'
const PROFILE = 'default'
// loading 期 query.data 为 undefined，`|| []` 每次 render 产生新数组会让下游 memo/effect 空跑
const EMPTY_SESSIONS: never[] = []

function getSessionOrderKey(hostId: string) {
  return `${SESSION_ORDER_KEY_PREFIX}${hostId}`
}
function getSessionOrderUpdatedAtKey(hostId: string) {
  return `${SESSION_ORDER_UPDATED_AT_KEY_PREFIX}${hostId}`
}
function readSessionOrder(hostId: string) {
  if (typeof window === 'undefined' || !hostId) return []
  try {
    const raw = JSON.parse(localStorage.getItem(getSessionOrderKey(hostId)) || '[]')
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  } catch {
    return []
  }
}
function readSessionOrderUpdatedAt(hostId: string) {
  if (typeof window === 'undefined' || !hostId) return ''
  return localStorage.getItem(getSessionOrderUpdatedAtKey(hostId)) || ''
}
function writeSessionOrder(hostId: string, orderedSessionIds: string[], updatedAt?: string) {
  if (typeof window === 'undefined' || !hostId) return
  localStorage.setItem(getSessionOrderKey(hostId), JSON.stringify(orderedSessionIds))
  localStorage.setItem(getSessionOrderUpdatedAtKey(hostId), updatedAt || new Date().toISOString())
}
function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
function sanitizeSessionOrder(orderedSessionIds: string[], sessions: { id: string }[]) {
  const sessionIds = new Set(sessions.map((session) => session.id))
  const nextOrder: string[] = []
  for (const sessionId of orderedSessionIds) {
    if (!sessionIds.has(sessionId) || nextOrder.includes(sessionId)) continue
    nextOrder.push(sessionId)
  }
  for (const session of sessions) {
    if (!nextOrder.includes(session.id)) nextOrder.push(session.id)
  }
  return nextOrder
}
function mergeRemoteSessionOrders(
  sessionOrders: SessionOrderPreference[],
  hostId: string,
  orderedSessionIds: string[],
) {
  const next = sessionOrders.filter((entry) => entry.hostId !== hostId)
  next.push({ hostId, orderedSessionIds })
  return next
}

export function useOrderedSessions(hostId: string) {
  const query = useSessions(hostId, { keepPrevious: true })
  // 会话区的主观察者在这里挂变更订阅：列表被网关推脏时重取，不用等兜底轮询。
  // 占位数据阶段（刚切 host）先不订阅——那段时间会话列表显示的是上一个 host 的缓存。
  useSessionChangeFeed(hostId, !query.isPlaceholderData)
  const sessions = query.data ?? EMPTY_SESSIONS
  // 占位数据属于别的 host：下面所有「按 host 落盘/对齐远端顺序」的动作都必须跳过，
  // 否则会把上一个 host 的 session id 写成这个 host 的排序偏好
  const isPlaceholderData = query.isPlaceholderData === true
  const [sessionOrder, setSessionOrder] = useState<string[]>([])
  const syncHostRef = useRef('')
  const hydratedHostRef = useRef('')
  const persistRemoteOrder = useCallback(
    (orderedSessionIds: string[], updatedAt?: string, remoteSessionOrders?: SessionOrderPreference[]) => {
      if (!hostId) return
      const nextUpdatedAt = updatedAt || new Date().toISOString()
      const push = async () => {
        try {
          const sessionOrders = remoteSessionOrders || (await api.preferences.get(PROFILE)).sessionOrders || []
          await api.preferences.update(
            {
              sessionOrders: mergeRemoteSessionOrders(sessionOrders, hostId, orderedSessionIds),
              sessionOrdersUpdatedAt: nextUpdatedAt,
            },
            PROFILE,
          )
        } catch {}
      }
      void push()
    },
    [hostId],
  )
  useEffect(() => {
    setSessionOrder(readSessionOrder(hostId))
    syncHostRef.current = ''
    hydratedHostRef.current = ''
  }, [hostId])
  const orderedSessions = useMemo(() => orderSessions(sessions, sessionOrder), [sessionOrder, sessions])
  const normalizedOrder = useMemo(() => orderedSessions.map((session) => session.id), [orderedSessions])
  useEffect(() => {
    if (!hostId || isPlaceholderData) return
    if (arraysEqual(sessionOrder, normalizedOrder)) return
    const nextUpdatedAt = new Date().toISOString()
    setSessionOrder(normalizedOrder)
    writeSessionOrder(hostId, normalizedOrder, nextUpdatedAt)
    if (syncHostRef.current === hostId && hydratedHostRef.current === hostId)
      persistRemoteOrder(normalizedOrder, nextUpdatedAt)
  }, [hostId, isPlaceholderData, normalizedOrder, persistRemoteOrder, sessionOrder])
  useEffect(() => {
    if (!hostId || isPlaceholderData || !sessions.length || syncHostRef.current === hostId) return
    const localOrder = sanitizeSessionOrder(readSessionOrder(hostId), sessions)
    const localUpdatedAt = readSessionOrderUpdatedAt(hostId)
    void (async () => {
      try {
        const remote = await api.preferences.get(PROFILE)
        const remoteEntries = Array.isArray(remote.sessionOrders) ? remote.sessionOrders : []
        const remoteOrderRaw = remoteEntries.find((entry) => entry.hostId === hostId)?.orderedSessionIds || []
        const remoteOrder = sanitizeSessionOrder(remoteOrderRaw, sessions)
        const remoteUpdatedAt = remote.sessionOrdersUpdatedAt || ''
        const localMs = Date.parse(localUpdatedAt || '')
        const remoteMs = Date.parse(remoteUpdatedAt || '')
        syncHostRef.current = hostId
        hydratedHostRef.current = hostId
        if (!remoteOrderRaw.length && localOrder.length) {
          const nextUpdatedAt = localUpdatedAt || new Date().toISOString()
          setSessionOrder(localOrder)
          writeSessionOrder(hostId, localOrder, nextUpdatedAt)
          return
        }
        if (!Number.isNaN(remoteMs) && (Number.isNaN(localMs) || remoteMs >= localMs)) {
          const nextUpdatedAt = remoteUpdatedAt || new Date().toISOString()
          setSessionOrder(remoteOrder)
          writeSessionOrder(hostId, remoteOrder, nextUpdatedAt)
          if (!arraysEqual(remoteOrderRaw, remoteOrder)) persistRemoteOrder(remoteOrder, nextUpdatedAt, remoteEntries)
          return
        }
        const nextUpdatedAt = localUpdatedAt || new Date().toISOString()
        setSessionOrder(localOrder)
        writeSessionOrder(hostId, localOrder, nextUpdatedAt)
        if (!Number.isNaN(localMs) && (Number.isNaN(remoteMs) || localMs > remoteMs))
          persistRemoteOrder(localOrder, nextUpdatedAt, remoteEntries)
      } catch {
        syncHostRef.current = hostId
        hydratedHostRef.current = hostId
        writeSessionOrder(hostId, localOrder, localUpdatedAt || new Date().toISOString())
        setSessionOrder(localOrder)
      }
    })()
  }, [hostId, isPlaceholderData, persistRemoteOrder, sessions])
  const moveSession = (orderedSessionIds: string[]) => {
    const nextOrder = sanitizeSessionOrder(orderedSessionIds, sessions)
    if (arraysEqual(nextOrder, normalizedOrder)) return
    const nextUpdatedAt = new Date().toISOString()
    syncHostRef.current = hostId
    setSessionOrder(nextOrder)
    writeSessionOrder(hostId, nextOrder, nextUpdatedAt)
    persistRemoteOrder(nextOrder, nextUpdatedAt)
  }
  return { ...query, data: orderedSessions, moveSession }
}
