'use client'
import { useEffect, useMemo, useState } from 'react'
import type { Session } from '@/types'
import { useSessions } from './useApi'

const SESSION_ORDER_KEY_PREFIX = 'tmuxgo-session-order:'

function getSessionOrderKey(hostId: string) {
  return `${SESSION_ORDER_KEY_PREFIX}${hostId}`
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
function writeSessionOrder(hostId: string, orderedSessionIds: string[]) {
  if (typeof window === 'undefined' || !hostId) return
  localStorage.setItem(getSessionOrderKey(hostId), JSON.stringify(orderedSessionIds))
}
function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
function orderSessions(sessions: Session[], orderedSessionIds: string[]) {
  if (!orderedSessionIds.length) return sessions
  const rank = new Map(orderedSessionIds.map((id, index) => [id, index]))
  return [...sessions].sort((a, b) => {
    const rankA = rank.get(a.id)
    const rankB = rank.get(b.id)
    if (rankA == null && rankB == null) return 0
    if (rankA == null) return 1
    if (rankB == null) return -1
    return rankA - rankB
  })
}

export function useOrderedSessions(hostId: string) {
  const query = useSessions(hostId)
  const sessions = query.data || []
  const [sessionOrder, setSessionOrder] = useState<string[]>([])
  useEffect(() => {
    setSessionOrder(readSessionOrder(hostId))
  }, [hostId])
  const orderedSessions = useMemo(() => orderSessions(sessions, sessionOrder), [sessionOrder, sessions])
  const normalizedOrder = useMemo(() => orderedSessions.map((session) => session.id), [orderedSessions])
  useEffect(() => {
    if (!hostId) return
    if (arraysEqual(sessionOrder, normalizedOrder)) return
    setSessionOrder(normalizedOrder)
    writeSessionOrder(hostId, normalizedOrder)
  }, [hostId, normalizedOrder, sessionOrder])
  const moveSession = (dragSessionId: string, dropSessionId: string) => {
    if (!dragSessionId || !dropSessionId || dragSessionId === dropSessionId) return
    const nextSessions = orderSessions(sessions, sessionOrder)
    const dragIndex = nextSessions.findIndex((session) => session.id === dragSessionId)
    const dropIndex = nextSessions.findIndex((session) => session.id === dropSessionId)
    if (dragIndex === -1 || dropIndex === -1) return
    const reordered = [...nextSessions]
    const [removed] = reordered.splice(dragIndex, 1)
    reordered.splice(dropIndex, 0, removed)
    const nextOrder = reordered.map((session) => session.id)
    setSessionOrder(nextOrder)
    writeSessionOrder(hostId, nextOrder)
  }
  return { ...query, data: orderedSessions, moveSession }
}
