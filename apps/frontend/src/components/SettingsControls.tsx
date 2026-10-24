'use client'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Settings 面板专用控件（design-brief-ui.md §2.2 末条：只在该文件消费的配置逻辑统一在局部，
 * 不升级成通用层）。别的面板不要 import 这里，需要开关请用各自的控件。
 */

export interface SettingsSwitchProps {
  checked: boolean
  /** 读屏文案：可见 label 在 SettingRow 里时也要传，保证每个开关都有可读名字 */
  label: string
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

/**
 * w-10 h-6 开关：aria-pressed 表达开关态，focus-visible 走共享焦点环。
 * 圆钮只用 transform 过渡（left/right 定位会触发 layout，不能用 transition-all）。
 */
export function SettingsSwitch({ checked, label, onChange, disabled = false, className }: SettingsSwitchProps) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'tmuxgo-focus-ring relative h-6 w-10 shrink-0 rounded-full border transition-colors',
        '[@media(hover:hover)]:enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45',
        // off 态在玻璃浮层上 bg-bg-2 几乎看不见，补 hairline 边框让轨道轮廓可见
        checked ? 'border-transparent bg-accent' : 'border-[var(--line)] bg-bg-2',
        className,
      )}
    >
      {/* 16px 钮在 40px 轨道上的行程是 16px，正好 translate-x-4 */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}

export interface SettingRowProps {
  label: ReactNode
  /** 说明放在 label 下方，长文案靠 min-w-0 截断/换行，不挤右侧操作 */
  description?: ReactNode
  /** 只读数值：text-1 + tabular-nums，数字列对齐 */
  value?: ReactNode
  valueClassName?: string
  /** 右侧控件（开关/Select/Chip 组），自动 shrink-0 */
  children?: ReactNode
  /** 有 description 或控件较高时用 start，避免上下错位 */
  align?: 'center' | 'start'
  className?: string
}

/** label / value / control 三段对齐：label 与说明左对齐占剩余宽度，右侧统一 shrink-0 */
export function SettingRow({
  label,
  description,
  value,
  valueClassName,
  children,
  align = 'center',
  className,
}: SettingRowProps) {
  return (
    <div className={cn('flex justify-between gap-3', align === 'start' ? 'items-start' : 'items-center', className)}>
      <div className="min-w-0">
        <div className="text-text-2 text-sm">{label}</div>
        {description !== undefined && <div className="mt-1 text-caption text-text-3">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {value !== undefined && <span className={cn('text-text-1 text-sm tabular-nums', valueClassName)}>{value}</span>}
        {children}
      </div>
    </div>
  )
}
