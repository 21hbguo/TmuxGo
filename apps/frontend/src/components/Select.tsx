import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { FiCheck, FiChevronDown } from 'react-icons/fi'
import { useEscapeClose } from '@/hooks/useEscapeClose'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}
interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  variant?: 'default' | 'inline'
  title?: string
  'aria-label'?: string
}

const LIST_MAX_HEIGHT = 256
const LIST_MAX_WIDTH = 288 // max-w-72
const MENU_GAP = 4 // mt-1 / mb-1
const VIEWPORT_GAP = 8

export function Select({
  value,
  options,
  onChange,
  disabled,
  className = '',
  variant = 'default',
  title,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [listPos, setListPos] = useState<CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeAheadRef = useRef({ buffer: '', at: 0 })
  const listId = useId()
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = (focusTrigger: boolean) => {
    setOpen(false)
    if (focusTrigger) triggerRef.current?.focus()
  }
  // 下拉开着时占住 ESC 顶层，防止把底下的弹窗一起关掉
  useEscapeClose(() => close(true), open)
  const commit = (index: number) => {
    const option = options[index]
    if (!option) return
    if (option.value !== value) onChange(option.value)
    close(true)
  }

  // 菜单 portal 到 body + fixed 定位：脱离 overflow 祖先裁剪，也跳出局部层叠上下文。
  // 以 trigger 视口坐标对齐；下方放不下且上方够高时上翻；左边距钳进视口防溢出
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimated = Math.min(options.length * 30 + 8, LIST_MAX_HEIGHT)
    const listW = Math.min(listRef.current?.offsetWidth ?? LIST_MAX_WIDTH, window.innerWidth - VIEWPORT_GAP * 2)
    const left = Math.min(
      Math.max(rect.left, VIEWPORT_GAP),
      Math.max(VIEWPORT_GAP, window.innerWidth - listW - VIEWPORT_GAP),
    )
    const next: CSSProperties =
      rect.bottom + estimated > window.innerHeight && rect.top > estimated
        ? { bottom: window.innerHeight - rect.top + MENU_GAP, left, minWidth: rect.width }
        : { top: rect.bottom + MENU_GAP, left, minWidth: rect.width }
    // 相等短路返回 prev：下面每次提交后都量一次，不短路会渲染-测量成环
    setListPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.bottom === next.bottom &&
      prev.left === next.left &&
      prev.minWidth === next.minWidth
        ? prev
        : next,
    )
  }, [options.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false)
    }
    // 捕获阶段监听任意祖先滚动：trigger 随内容移动时菜单跟着重定位；忽略菜单自身滚动
    const onScroll = (event: Event) => {
      if (!listRef.current?.contains(event.target as Node)) measure()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, measure])

  // 打开期间每次提交后重对齐：兄弟布局变化推动 trigger 时菜单跟得上
  useLayoutEffect(() => {
    if (open) measure()
  })

  useLayoutEffect(() => {
    if (!open) return
    const item =
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]') ||
      listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    item?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  const moveActive = (index: number) => {
    if (!options.length) return
    const clamped = (index + options.length) % options.length
    setActiveIndex(clamped)
    ;(listRef.current?.children[clamped] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' })
  }

  const openList = (index?: number) => {
    setActiveIndex(index ?? (selectedIndex >= 0 ? selectedIndex : 0))
    setOpen(true)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (disabled) return
    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        openList()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        openList(options.length - 1)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openList()
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(activeIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(activeIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveActive(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      commit(activeIndex)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') setOpen(false)
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // type-ahead：连续敲同一字母在同字母项间循环，否则按前缀缓冲跳项
      const now = Date.now()
      const state = typeAheadRef.current
      state.buffer = now - state.at > 600 ? event.key.toLowerCase() : state.buffer + event.key.toLowerCase()
      state.at = now
      const labels = options.map((option) => option.label.toLowerCase())
      let index = labels.findIndex((label, i) => i > activeIndex && label.startsWith(state.buffer))
      if (index === -1) index = labels.findIndex((label) => label.startsWith(state.buffer))
      if (index === -1 && state.buffer.length > 1) {
        const ch = state.buffer.slice(-1)
        index = labels.findIndex((label, i) => i > activeIndex && label.startsWith(ch))
        if (index === -1) index = labels.findIndex((label) => label.startsWith(ch))
      }
      if (index !== -1) moveActive(index)
    }
  }

  const triggerBase =
    variant === 'inline'
      ? 'tmuxgo-select-inline flex items-center gap-1 text-left'
      : 'tmuxgo-control flex items-center justify-between gap-2 text-left'

  return (
    <div ref={rootRef} className={`relative ${variant === 'inline' ? 'inline-flex min-w-0' : 'min-w-0'}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-value={value}
        className={`${triggerBase} ${className}`}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
        <FiChevronDown
          aria-hidden="true"
          size={13}
          className={`shrink-0 text-text-3 transition-transform duration-160 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            // z-[125]：盖过全部 scrim/弹窗（≤z-120），仍低于元素选择器（≥z-129）
            style={listPos ?? { visibility: 'hidden' }}
            className="tmuxgo-menu tmuxgo-scrollbar fixed z-[125] max-h-64 w-max max-w-72 overflow-y-auto p-1"
          >
            {options.map((option, index) => {
              const active = index === activeIndex
              const isSelected = option.value === value
              return (
                <div
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  data-active={active}
                  data-value={option.value}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${active ? 'bg-bg-2 text-text-1' : 'text-text-2'}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                >
                  <FiCheck
                    aria-hidden="true"
                    size={13}
                    className={`shrink-0 ${isSelected ? 'text-accent' : 'opacity-0'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && <span className="shrink-0 text-caption text-text-3">{option.hint}</span>}
                </div>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}
