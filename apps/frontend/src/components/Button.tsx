'use client'
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react'
import { cn } from '@/lib/cn'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'md' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  /** 自动阻止 mousedown/touchstart 抢焦点（modal 内常用） */
  preventFocus?: boolean
}

const VARIANT: Record<ButtonVariant, string> = {
  default: '',
  primary: 'tmuxgo-button--primary',
  danger: 'tmuxgo-button--danger',
  ghost: 'tmuxgo-button--ghost',
}

const SIZE: Record<ButtonSize, string> = {
  md: '',
  sm: 'tmuxgo-button--sm',
  lg: 'tmuxgo-button--lg',
  icon: 'tmuxgo-button--icon',
  'icon-sm': 'tmuxgo-button--icon-sm',
  'icon-lg': 'tmuxgo-button--icon-lg',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', preventFocus, onMouseDown, onTouchStart, ...rest },
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
      className={cn('tmuxgo-button tmuxgo-icon-button', VARIANT[variant], SIZE[size], className)}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      {...rest}
    />
  )
})
