'use client'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export type FilterToggleTone = 'accent' | 'danger'

export interface FilterToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> {
  /** 选中态 → 同时写入 aria-pressed，配色由 .tmuxgo-filter-toggle--*[aria-pressed='true'] 决定 */
  pressed: boolean
  /** 危险筛选（只看需处理）用 danger，其余用 accent */
  tone?: FilterToggleTone
}

/**
 * toolbar 双态筛选钮：h-7 rounded-apple border px-2 text-caption。
 * 内部不存状态、不读 store；aria-pressed 由 pressed 派生，onClick/onMouseDown 等原生属性原样透传。
 */
export const FilterToggle = forwardRef<HTMLButtonElement, FilterToggleProps>(function FilterToggle(
  { pressed, tone = 'accent', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={cn('tmuxgo-filter-toggle h-7 px-2 text-caption', `tmuxgo-filter-toggle--${tone}`, className)}
      {...rest}
    />
  )
})
