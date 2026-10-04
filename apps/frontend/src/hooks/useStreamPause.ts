'use client'
import { useCallback, useEffect, useRef } from 'react'

export interface UseStreamPauseOptions {
  /** 外部暂停源（如面板最小化）；与 document.hidden 任一为真即暂停 */
  paused: boolean
  /** 传输层是否可写（如 ws.readyState === OPEN） */
  isOpen: () => boolean
  /** 目标态变化且传输可写时下发 */
  send: (paused: boolean) => void
  /** 文档重新可见时回调（此时传输若不可用，由调用方决定是否补连） */
  onVisible?: () => void
}

// 共享画面流暂停生命周期：目标态 = paused || document.hidden。want 记目标、sent 记已下发态，
// 传输未 OPEN 时只记不发；notifyOpen 在新连接建立后归零 sent 并补发目标态（服务端新 client
// 默认非暂停，"暂停期间重连/隐藏中连上"的竞态由这步覆盖）。resume 仅当两个暂停源都为 false
export function useStreamPause({ paused, isOpen, send, onVisible }: UseStreamPauseOptions) {
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const sentRef = useRef(false)
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  const sendRef = useRef(send)
  sendRef.current = send
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible

  const push = useCallback(() => {
    const want = pausedRef.current || (typeof document !== 'undefined' && document.hidden)
    if (sentRef.current === want) return
    if (!isOpenRef.current()) return
    sentRef.current = want
    sendRef.current(want)
  }, [])

  const notifyOpen = useCallback(() => {
    sentRef.current = false
    push()
  }, [push])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => {
      push()
      if (!document.hidden) onVisibleRef.current?.()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [push])

  useEffect(() => {
    push()
  }, [paused, push])

  return { notifyOpen }
}
