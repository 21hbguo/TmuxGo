'use client'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  /** 图标约 20–24px；空态不做大插画 */
  icon?: ReactNode
  /** 主文案，由调用方传入已翻译文本 */
  title: ReactNode
  /** 说明：为什么空 / 下一步做什么（真空与筛选无匹配的语义差异由调用方给文案） */
  description?: ReactNode
  /** 可选动作，直接组合 Button；原语不提供回调配置 */
  action?: ReactNode
  className?: string
}

/**
 * 列表/面板空态：flex 列居中，py-8 px-3。仅布局，不判空、不取数。
 * 预览区需要垂直居中时用 className="flex-1 justify-center"。
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('tmuxgo-empty-state', className)}>
      {icon !== undefined && (
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-apple bg-bg-2/60 text-text-3"
        >
          {icon}
        </span>
      )}
      <div className="text-xs text-text-2">{title}</div>
      {description !== undefined && <div className="max-w-[42ch] text-caption text-text-3">{description}</div>}
      {action !== undefined && <div className="mt-0.5">{action}</div>}
    </div>
  )
}
