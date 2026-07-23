'use client'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useRef } from 'react'

export type KeyCapTone = 'default' | 'accent' | 'danger' | 'arrow'
export type KeyCapVariant = 'panel' | 'dock' | 'plain'
export type KeyCapSize = 'sm' | 'md' | 'freq' | 'pill'

export interface KeyCapProps {
  tone?: KeyCapTone
  variant?: KeyCapVariant
  size?: KeyCapSize
  disabled?: boolean
  /** simple 模式：单击触发（panel / 通用场景） */
  onPress?: () => void | Promise<void>
  /** repeat 模式：onPointerDown 启动，按住持续触发（panel 场景） */
  repeat?: boolean
  /** repeat 模式下初始间隔，默认 420ms */
  repeatDelay?: number
  /** repeat 模式下持续间隔，默认 54ms */
  repeatInterval?: number
  /** gesture 模式：透传 pointer 事件，由消费者接管（dock 场景）。一旦传入，所有 pointer 事件由消费者负责 */
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerLeave?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  className?: string
  title?: string
  type?: 'button'
  tabIndex?: number
  'aria-label'?: string
  children: ReactNode
}

const VARIANT_CLASS: Record<KeyCapVariant, string> = {
  panel: '',
  dock: 'tmuxgo-keycap--dock',
  plain: '',
}
const TONE_CLASS: Record<KeyCapTone, string> = {
  default: '',
  accent: 'tmuxgo-keycap--accent',
  danger: 'tmuxgo-keycap--danger',
  arrow: 'tmuxgo-keycap--arrow',
}
const SIZE_CLASS: Record<KeyCapSize, string> = {
  sm: 'tmuxgo-keycap--sm',
  md: '',
  freq: 'tmuxgo-keycap--freq',
  pill: 'tmuxgo-keycap--pill',
}

export function KeyCap(props: KeyCapProps) {
  const {
    tone = 'default',
    variant = 'plain',
    size = 'md',
    disabled,
    onPress,
    repeat,
    repeatDelay = 420,
    repeatInterval = 54,
    onPointerDown,
    onPointerUp,
    onPointerMove,
    onPointerLeave,
    onPointerCancel,
    onClick,
    className,
    title,
    type = 'button',
    tabIndex,
    'aria-label': ariaLabel,
    children,
  } = props

  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopRepeat = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])

  useEffect(() => stopRepeat, [stopRepeat])

  const startRepeat = useCallback(() => {
    if (!onPress) return
    stopRepeat()
    void onPress()
    repeatTimerRef.current = setTimeout(() => {
      void onPress()
      repeatIntervalRef.current = setInterval(() => { void onPress() }, repeatInterval)
    }, repeatDelay)
  }, [onPress, repeatDelay, repeatInterval, stopRepeat])

  const preventFocus = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
  }, [])

  const isGestureMode = !!onPointerDown

  const handlePointerDown = isGestureMode
    ? onPointerDown
    : (e: ReactPointerEvent<HTMLButtonElement>) => {
        preventFocus(e)
        if (disabled) return
        if (repeat) startRepeat()
      }
  const handlePointerUp = isGestureMode
    ? onPointerUp
    : repeat ? stopRepeat : undefined
  const handlePointerLeave = isGestureMode
    ? onPointerLeave
    : repeat ? stopRepeat : undefined
  const handlePointerCancel = isGestureMode
    ? onPointerCancel
    : repeat ? stopRepeat : undefined

  const handleClick = isGestureMode
    ? onClick
    : (e: ReactMouseEvent<HTMLButtonElement>) => {
        if (onClick) return onClick(e)
        if (disabled) return
        if (onPress) void onPress()
      }

  const classes = [
    'tmuxgo-keycap',
    VARIANT_CLASS[variant],
    TONE_CLASS[tone],
    SIZE_CLASS[size],
    disabled ? 'tmuxgo-keycap--disabled' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <button
      type={type}
      tabIndex={tabIndex}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      className={classes}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onPointerMove={onPointerMove}
      onClick={handleClick}
    >
      {children}
    </button>
  )
}
