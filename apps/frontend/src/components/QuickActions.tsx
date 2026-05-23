'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useWebSocket } from '@/hooks/useWebSocket'

export function QuickActions() {
  const { activePaneId } = useConsoleStore()
  const { send } = useWebSocket()

  const actions = [
    {
      label: 'New Session',
      shortcut: '⌘N',
      action: () => send({ type: 'create-session', name: `session-${Date.now()}` }),
    },
    {
      label: 'Split H',
      shortcut: '⌘-',
      action: () => activePaneId && send({ type: 'split', paneId: activePaneId, direction: 'horizontal' }),
    },
    {
      label: 'Split V',
      shortcut: '⌘\\',
      action: () => activePaneId && send({ type: 'split', paneId: activePaneId, direction: 'vertical' }),
    },
    {
      label: 'Close Pane',
      shortcut: '⌘W',
      action: () => activePaneId && send({ type: 'close-pane', paneId: activePaneId }),
    },
  ]

  return (
    <div className="flex items-center gap-1">
      {actions.map((action) => (
        <button
          key={action.label}
          onClick={action.action}
          className="px-2 py-1 hover:bg-bg-2 rounded text-text-3 text-xs flex items-center gap-1"
          title={`${action.label} (${action.shortcut})`}
        >
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  )
}
