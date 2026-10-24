'use client'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface SectionHeaderProps {
  title: ReactNode
  /** 分组内条目数，右对齐、tabular-nums */
  count?: number
  /** 标题前状态点/图标 */
  leading?: ReactNode
  className?: string
}

/**
 * 列表分组头：hairline 底边 + 主标签 + 右侧计数。
 * 吸顶（sticky）和折叠按钮由调用方通过 className/结构负责，原语不改折叠与键盘语义。
 */
export function SectionHeader({ title, count, leading, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-center gap-1.5 border-b border-[var(--line)] px-3 py-1.5', className)}>
      {leading}
      <span className="min-w-0 truncate text-caption font-medium text-text-1">{title}</span>
      {count !== undefined && (
        <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-text-3">{count}</span>
      )}
    </div>
  )
}
