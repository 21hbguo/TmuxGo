'use client'
import { QuickActions } from './QuickActions'

interface ShortcutBarProps {
  mode?: 'dock' | 'panel'
  compact?: boolean
  onOpenFiles?: () => void
  onOpenUpload?: () => void
}

export function ShortcutBar({ mode = 'dock', compact, onOpenFiles, onOpenUpload }: ShortcutBarProps) {
  return <QuickActions mode={mode} compact={compact} onOpenFiles={onOpenFiles} onOpenUpload={onOpenUpload} />
}
