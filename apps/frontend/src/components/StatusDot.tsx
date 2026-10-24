'use client'
import { cn } from '@/lib/cn'

/** 语义色，不绑定业务枚举：主机在线、agent 状态、同步状态各自在消费点映射 */
export type StatusTone = 'muted' | 'accent' | 'success' | 'warning' | 'danger'
/** sm = 6px（列表/分组），md = 8px（连接徽标等大圆点） */
export type StatusDotSize = 'sm' | 'md'

const TONE: Record<StatusTone, string> = {
  muted: 'bg-text-3',
  accent: 'bg-accent',
  success: 'bg-accent-2',
  warning: 'bg-warn',
  danger: 'bg-danger',
}

const SIZE: Record<StatusDotSize, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
}

export interface StatusDotProps {
  tone?: StatusTone
  size?: StatusDotSize
  /** 仅 working/syncing 这类进行中状态呼吸；reduced-motion 由 globals.css 统一降级 */
  pulse?: boolean
  /** 传了才暴露给读屏（role=status），否则当装饰隐藏 */
  label?: string
  className?: string
}

/** 纯展示状态圆点：不读 store、不吃业务类型，颜色只走 token */
export function StatusDot({ tone = 'muted', size = 'sm', pulse = false, label, className }: StatusDotProps) {
  return (
    <span
      className={cn('shrink-0 rounded-full', SIZE[size], TONE[tone], pulse && 'animate-pulse', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    />
  )
}
