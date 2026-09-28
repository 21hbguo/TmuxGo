'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { useElementPickerStore } from '@/stores/useElementPickerStore'
import { elementLabel, resolvePickTarget, PICKER_UI_ATTR } from '@/lib/element-picker'
import { ElementPickerPanel } from './ElementPickerPanel'
import { useTranslation } from '@/i18n'

// 选择模式下冻结底层页面交互：dnd-kit 拖拽、xterm 聚焦、按钮激活全部由拾取器接管。
// 命中拾取器自身 UI（信息面板）时不拦截，保证复制/关闭按钮可用
const BLOCKED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'dragstart',
  'drop',
] as const

export function ElementPickerOverlay() {
  const active = useElementPickerStore((s) => s.active)
  const selected = useElementPickerStore((s) => s.selected)
  const { t } = useTranslation()
  const [hover, setHover] = useState<{ label: string; rect: DOMRect } | null>(null)

  // 非模态层：弹窗叠在拾取器之上时 Esc 先归弹窗，再按一次才退出选择模式
  useEscapeClose(active ? () => useElementPickerStore.getState().stop() : undefined, active)

  useEffect(() => {
    if (!active) return
    let frame = 0
    const ownUi = (target: EventTarget | null) => target instanceof Element && !!target.closest(`[${PICKER_UI_ATTR}]`)
    const onMove = (event: MouseEvent) => {
      if (frame || ownUi(event.target)) return
      frame = requestAnimationFrame(() => {
        frame = 0
        // mousemove 的 target 即命中元素（高亮层 pointer-events:none，不会遮蔽命中）
        const el = resolvePickTarget(event.target)
        setHover(el ? { label: elementLabel(el), rect: el.getBoundingClientRect() } : null)
      })
    }
    const onScroll = () => setHover(null)
    const block = (event: Event) => {
      if (ownUi(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'click') useElementPickerStore.getState().selectElement(event.target)
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('scroll', onScroll, true)
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, block, true)
    // crosshair 提示选择态；元素的自定义 cursor 无法强制覆盖，只兜底默认光标
    document.body.style.setProperty('cursor', 'crosshair', 'important')
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('scroll', onScroll, true)
      for (const type of BLOCKED_EVENTS) window.removeEventListener(type, block, true)
      document.body.style.removeProperty('cursor')
      setHover(null)
    }
  }, [active])

  if (!active) return null

  return createPortal(
    <>
      {hover && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[130] rounded-sm"
            style={{
              left: hover.rect.left,
              top: hover.rect.top,
              width: hover.rect.width,
              height: hover.rect.height,
              outline: '2px solid rgb(var(--accent))',
              background: 'rgb(var(--accent) / 0.12)',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[130] max-w-[80vw] truncate rounded-apple bg-bg-0 px-2 py-0.5 font-mono text-caption text-text-1 shadow"
            style={{
              left: Math.min(Math.max(hover.rect.left, 4), Math.max(window.innerWidth - 120, 4)),
              top: hover.rect.top > 24 ? hover.rect.top - 22 : hover.rect.bottom + 4,
            }}
          >
            {hover.label}
          </div>
        </>
      )}
      {selected && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[129] rounded-sm"
          style={{
            left: selected.rect.x,
            top: selected.rect.y,
            width: selected.rect.width,
            height: selected.rect.height,
            outline: '2px dashed rgb(var(--accent-2))',
          }}
        />
      )}
      {!selected && (
        <div
          aria-hidden="true"
          className="tmuxgo-glass pointer-events-none fixed bottom-4 left-1/2 z-[132] -translate-x-1/2 rounded-full border px-3 py-1.5 text-caption text-text-2"
        >
          {t('picker.hint')}
        </div>
      )}
      {selected && <ElementPickerPanel info={selected} />}
    </>,
    document.body,
  )
}
