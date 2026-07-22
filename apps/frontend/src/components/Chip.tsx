'use client'
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react'
import { cn } from '@/lib/cn'

export type ChipTone = 'default' | 'accent' | 'danger'

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  tone?: ChipTone
  className?: string
  /** 自动阻止 mousedown/touchstart 抢焦点（modal 内常用） */
  preventFocus?: boolean
}

const TONE: Record<ChipTone, string> = {
  default: '',
  accent: 'tmuxgo-chip--accent',
  danger: 'tmuxgo-chip--danger',
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { tone = 'default', className, type = 'button', preventFocus, onMouseDown, onTouchStart, ...rest },
  ref,
) {
  const handleMouseDown = preventFocus
    ? (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.preventDefault()
        onMouseDown?.(e)
      }
    : onMouseDown
  const handleTouchStart = preventFocus
    ? (e: ReactTouchEvent<HTMLButtonElement>) => {
        e.preventDefault()
        onTouchStart?.(e)
      }
    : onTouchStart
  return (
    <button
      ref={ref}
      type={type}
      className={cn('tmuxgo-chip tmuxgo-icon-button', TONE[tone], className)}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      {...rest}
    />
  )
})
