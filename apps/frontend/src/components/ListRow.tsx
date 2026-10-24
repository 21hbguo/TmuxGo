'use client'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/**
 * 紧凑列表行：透传原生 div 属性，只负责统一 .tmuxgo-list-row 过渡、py-1.5 行高和细分隔线。
 * 行内结构和点击目标仍由各面板自己写（含按钮的整行不要包成按钮）；hover 用 .tmuxgo-list-row--hover，
 * 选中/批量用 --active/--batch，均在 globals.css。
 */
export function ListRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'tmuxgo-list-row flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-1.5 last:border-b-0',
        className,
      )}
      {...rest}
    />
  )
}
