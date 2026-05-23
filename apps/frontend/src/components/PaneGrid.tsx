'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { TerminalPane } from './TerminalPane'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useTranslation } from '@/i18n'

export function PaneGrid() {
  const { activeSessionId, sessions } = useConsoleStore()
  const { send } = useWebSocket()
  const { t } = useTranslation()
  const attachedRef = useRef<string | null>(null)

  const sessionName = activeSessionId?.replace('session-', '') || ''

  useEffect(() => {
    if (!sessionName || attachedRef.current === sessionName) return
    attachedRef.current = sessionName
    send({ type: 'attach', sessionName })
  }, [sessionName, send])

  const handleInput = useCallback((data: string) => {
    send({ type: 'input', data })
  }, [send])

  if (!activeSessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-3 gap-4">
        <div className="text-6xl">⊞</div>
        <div className="text-lg">{t('grid.noWindows')}</div>
        <div className="text-sm">{t('grid.selectSession')}</div>
      </div>
    )
  }

  return <TerminalPane onInput={handleInput} />
}
