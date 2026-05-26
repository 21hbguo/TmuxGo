'use client'
import { QuickActions } from './QuickActions'

interface ShortcutBarProps {
  mode?: 'dock' | 'panel'
}

export function ShortcutBar({ mode='dock' }: ShortcutBarProps) {
  return <QuickActions mode={mode} />
}
