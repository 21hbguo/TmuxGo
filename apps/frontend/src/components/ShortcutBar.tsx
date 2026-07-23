'use client'
import { QuickActions } from './QuickActions'

interface ShortcutBarProps {
  mode?: 'dock' | 'panel'
  onOpenFiles?: () => void
}

export function ShortcutBar({ mode='dock', onOpenFiles }: ShortcutBarProps) {
  return <QuickActions mode={mode} onOpenFiles={onOpenFiles} />
}
