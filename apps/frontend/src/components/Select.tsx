import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { FiCheck, FiChevronDown } from 'react-icons/fi'

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
  const [flipUp, setFlipUp] = useState(false)
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
  const commit = (index: number) => {
    const option = options[index]
    if (!option) return
    if (option.value !== value) onChange(option.value)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // 空间不足向上翻：以 max-h-64 估算，开合瞬间量一次 trigger 位置即可
  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimated = Math.min(options.length * 30 + 8, LIST_MAX_HEIGHT)
    setFlipUp(rect.bottom + estimated > window.innerHeight && rect.top > estimated)
    const item =
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]') ||
      listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    item?.scrollIntoView?.({ block: 'nearest' })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

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
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`tmuxgo-menu tmuxgo-scrollbar absolute z-50 max-h-64 min-w-full w-max max-w-72 overflow-y-auto p-1 ${flipUp ? 'bottom-full mb-1' : 'top-full mt-1'} left-0`}
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
        </div>
      )}
    </div>
  )
}
