'use client'

import { useEffect, useState, type ReactNode } from 'react'

interface MobileBottomSheetProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  heightClass?: string
  closeOnBackdrop?: boolean
  zClass?: string
  ariaLabel?: string
}

export function MobileBottomSheet({
  open,
  onClose,
  children,
  heightClass = 'flex flex-col max-h-[75%]',
  closeOnBackdrop = true,
  zClass = 'z-50',
  ariaLabel,
}: MobileBottomSheetProps) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setVisible(true)
      setClosing(false)
      return undefined
    }
    if (!visible) return undefined
    setClosing(true)
    const timer = window.setTimeout(() => {
      setVisible(false)
      setClosing(false)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [open, visible])

  if (!visible) return null

  return (
    <div
      className={`fixed left-0 right-0 top-0 ${zClass}`}
      style={{ height: 'var(--app-height,100dvh)' }}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`tmuxgo-glass tmuxgo-glass-dialog absolute bottom-0 left-0 right-0 overflow-hidden border-t transition-transform duration-200 ease-out ${heightClass} ${closing ? 'translate-y-full' : ''}`}
        onClick={closeOnBackdrop ? (event) => event.stopPropagation() : undefined}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {children}
      </div>
    </div>
  )
}
