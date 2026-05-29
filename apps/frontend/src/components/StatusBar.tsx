'use client'

import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { useSystemInfo } from '@/hooks/useSystemInfo'
import { useHosts, useSessionSnapshot } from '@/hooks/useApi'

const gb = (mb: number) => (mb / 1024).toFixed(1)

export function StatusBar() {
  const activePaneId = useConsoleStore((state) => state.activePaneId)
  const connection = useConsoleStore((state) => state.connection)
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const terminalPerf = useConsoleStore((state) => state.terminalPerf)
  const { t } = useTranslation()
  const sys = useSystemInfo(2000)
  const { data: hosts = [] } = useHosts()
  const { data: snapshotData } = useSessionSnapshot(activeHostId || '', activeSessionId || '')
  const panes = snapshotData?.panes || []

  const activePane = panes.find((p: any) => p.id === activePaneId)
  const activeHost = hosts.find((h: any) => h.id === activeHostId)

  const statusColor = {
    connected: 'text-accent-2',
    attaching: 'text-warn',
    reconnecting: 'text-warn',
    disconnected: 'text-danger',
  }[connection.status]

  return (
    <footer className="h-7 bg-bg-1 border-t border-[var(--line)] flex items-center px-4 text-xs shrink-0">
      <div className="flex-1 flex items-center gap-3 overflow-hidden">
        <span className="text-accent-2">RW</span>
        <span className="text-text-3">UTF-8</span>
        {activePane && (
          <span className="text-text-3">{activePane.size.cols}×{activePane.size.rows}</span>
        )}
        {activeHost && (
          <span className="text-text-3">{activeHost.name}</span>
        )}
        {sys && (
          <span className="text-text-3 flex items-center gap-3">
            {sys.gpu && <span>GPU {gb(sys.gpu.used)}/{gb(sys.gpu.total)}G</span>}
            <span>CPU {sys.cpu}%</span>
            <span>MEM {gb(sys.mem.used)}/{gb(sys.mem.total)}G</span>
            {sys.disks.map((d) => (
              <span key={d.mount}>{d.mount} {gb(d.used)}/{gb(d.total)}G</span>
            ))}
            <span>WS {sys.stream.activeProfile}/{sys.stream.activeFlushInterval}ms/{sys.stream.activeMaxChars}</span>
            <span>FL {sys.stream.outputFlushes}</span>
            <span>BP {sys.stream.backpressureSignals}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${statusColor.replace('text-', 'bg-')}`} />
          <span className={statusColor}>{t(`status.${connection.status}`)}</span>
        </div>
        <span className="text-text-3">ATT {terminalPerf.attachLatency}ms</span>
      </div>
    </footer>
  )
}
