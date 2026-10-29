'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { filterQuickPick, nextIndex, type QuickPickItem } from '@/lib/editor-quickpick'

export interface EditorQuickPickProps {
  title: string
  placeholder: string
  items: QuickPickItem[]
  emptyLabel: string
  hint?: string
  // 有值时 Enter 优先把输入框原文交给调用方（Ctrl+G 需要拿到 `12:5` 这种原始输入）
  onSubmitText?: (text: string) => boolean
  onSelect: (item: QuickPickItem) => void
  onClose: () => void
  initialQuery?: string
}

// VSCode 式 quick input：浮在编辑区顶部中央，输入即过滤，↑↓ 移动，Enter 确认，Esc 取消。
// 刻意做成非模态（不抢全站焦点、不渲染背景遮罩）：跳行/跳符号是高频轻操作，遮罩反而打断心流。
export function EditorQuickPick({
  title,
  placeholder,
  items,
  emptyLabel,
  hint,
  onSubmitText,
  onSelect,
  onClose,
  initialQuery = '',
}: EditorQuickPickProps) {
  const [query, setQuery] = useState(initialQuery)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filtered = useMemo(() => filterQuickPick(items, query, 200), [items, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, filtered.length])

  const commit = (index: number) => {
    if (onSubmitText?.(query)) return
    const item = filtered[index]
    if (!item) return
    onSelect(item)
  }

  return (
    <div
      data-testid="editor-quickpick"
      role="dialog"
      aria-label={title}
      className="absolute left-1/2 top-2 z-30 w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-hidden rounded-apple border border-[var(--line-strong)] bg-bg-1/98 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <span className="shrink-0 text-[11px] uppercase tracking-[0.14em] text-text-3">{title}</span>
        <input
          ref={inputRef}
          data-testid="editor-quickpick-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="editor-quickpick-list"
          aria-autocomplete="list"
          value={query}
          placeholder={placeholder}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onClose()
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((current) => nextIndex(current, filtered.length, event.key === 'ArrowDown' ? 1 : -1))
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              commit(activeIndex)
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-text-1 outline-none placeholder:text-text-3"
        />
      </div>
      <div
        ref={listRef}
        id="editor-quickpick-list"
        role="listbox"
        className="tmuxgo-scrollbar max-h-[min(22rem,50vh)] overflow-y-auto py-1"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-text-3">{emptyLabel}</div>
        ) : (
          filtered.map((item, index) => (
            <button
              key={item.id}
              data-testid={`editor-quickpick-item-${index}`}
              data-active={index === activeIndex}
              role="option"
              aria-selected={index === activeIndex}
              type="button"
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => onSelect(item)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                index === activeIndex ? 'bg-accent/15 text-text-1' : 'text-text-2 hover:bg-bg-2/60',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.detail && <span className="shrink-0 truncate font-mono text-[11px] text-text-3">{item.detail}</span>}
              {item.description && <span className="shrink-0 text-[11px] text-text-3">{item.description}</span>}
            </button>
          ))
        )}
      </div>
      {hint && (
        <div className="border-t border-[var(--line)] px-3 py-1 text-[11px] text-text-3">{hint}</div>
      )}
    </div>
  )
}
