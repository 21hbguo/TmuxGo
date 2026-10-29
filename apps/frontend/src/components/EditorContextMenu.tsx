'use client'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { ModalPortal } from './ModalPortal'

export interface EditorMenuAction {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

interface EditorContextMenuProps {
  x: number
  y: number
  title?: string
  actions: EditorMenuAction[]
  onClose: () => void
  // 状态栏菜单要往上长：锚点给的是按钮上沿，需要按菜单高度反推 top
  openUp?: boolean
}

const MENU_WIDTH = 232
const MENU_ITEM_HEIGHT = 26
const MENU_CHROME = 56

// 编辑区右键菜单（tab 菜单、缩进菜单共用）：
// - 视口边缘翻转：右下角触发时往左上展开，避免贴边被裁
// - 打开即关掉浏览器原生 contextmenu 的后续冒泡，Esc/外部点击/滚动都关闭
export function EditorContextMenu({ x, y, title, actions, onClose, openUp }: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const estimatedHeight = MENU_CHROME + actions.length * MENU_ITEM_HEIGHT
  const left = Math.max(8, Math.min(x, (typeof window === 'undefined' ? x : window.innerWidth) - MENU_WIDTH - 8))
  const desiredTop = openUp ? y - estimatedHeight - 6 : y
  const top = Math.max(
    8,
    Math.min(desiredTop, (typeof window === 'undefined' ? desiredTop : window.innerHeight) - estimatedHeight - 8),
  )

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    // capture：菜单开着时终端/编辑器自己的按键处理不能先跑
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <ModalPortal>
      <div
        ref={menuRef}
        data-testid="editor-context-menu"
        role="menu"
        style={{ left, top, width: MENU_WIDTH }}
        className="tmuxgo-menu fixed z-50 overflow-hidden rounded-apple border border-[var(--line-strong)] bg-bg-1/98 py-1 shadow-[0_18px_48px_rgba(0,0,0,0.5)] backdrop-blur"
      >
        {title && (
          <div className="truncate px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-text-3">{title}</div>
        )}
        {actions.map((action) => (
          <div key={action.id}>
            {action.separatorBefore && <div className="my-1 h-px bg-[var(--line)]" />}
            <button
              type="button"
              role="menuitem"
              disabled={action.disabled}
              aria-disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return
                onClose()
                action.onSelect()
              }}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-1 text-left text-xs',
                action.disabled
                  ? 'cursor-default text-text-3/60'
                  : action.danger
                    ? 'text-danger hover:bg-danger/15'
                    : 'text-text-1 hover:bg-accent/15',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.shortcut && <span className="shrink-0 font-mono text-[10px] text-text-3">{action.shortcut}</span>}
            </button>
          </div>
        ))}
      </div>
    </ModalPortal>
  )
}
