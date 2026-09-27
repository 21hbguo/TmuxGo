'use client'
import { QuickActions } from './QuickActions'

interface ShortcutBarProps {
  mode?: 'dock' | 'panel'
  onOpenFiles?: () => void
  onOpenUpload?: () => void
}

export function ShortcutBar({ mode = 'dock', onOpenFiles, onOpenUpload }: ShortcutBarProps) {
  return <QuickActions mode={mode} onOpenFiles={onOpenFiles} onOpenUpload={onOpenUpload} />
}
