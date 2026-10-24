'use client'
import type { ReactNode } from 'react'
import { FiX } from 'react-icons/fi'
import { cn } from '@/lib/cn'
import { Button } from './Button'
import { IconTile } from './IconTile'

interface PanelHeaderBase {
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** 右侧动作区（Button/工具栏），复杂 tabs 放这里，不得挤压标题 */
  actions?: ReactNode
  className?: string
}

export interface PanelHeaderProps extends PanelHeaderBase {
  /** 传了才渲染关闭钮；此时必须同时给 closeLabel（原语不带文案表，i18n 只在面板侧） */
  onClose?: () => void
  closeLabel?: string
}

/**
 * 面板标题栏：默认 h-11 px-3 gap-2，24px 图标块 + text-xs 主标题 + caption 副标题 + 右侧动作/关闭。
 * 高度是产品特征（紧凑密度），需要别的（如 Inbox 的 h-10）用 className 覆盖，不在原语里加尺寸档。
 */
export function PanelHeader({ icon, title, subtitle, actions, onClose, closeLabel, className }: PanelHeaderProps) {
  return (
    <header className={cn('flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3', className)}>
      {icon !== undefined && <IconTile>{icon}</IconTile>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-text-1">{title}</div>
        {subtitle !== undefined && <div className="truncate text-caption text-text-3">{subtitle}</div>}
      </div>
      {actions}
      {onClose && (
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
          <FiX size={15} />
        </Button>
      )}
    </header>
  )
}
