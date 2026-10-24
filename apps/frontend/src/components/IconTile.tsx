'use client'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface IconTileProps {
  /** 图标节点，尺寸由调用方给（既有面板统一 13px） */
  children: ReactNode
  className?: string
}

/**
 * 面板标题前的图标块：h-6 w-6 rounded-apple bg-bg-2 text-accent。
 * 纯装饰（aria-hidden），不做可点击控件；需要点击请用 Button size="icon-sm"。
 */
export function IconTile({ children, className }: IconTileProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-apple bg-bg-2 text-accent', className)}
    >
      {children}
    </span>
  )
}
