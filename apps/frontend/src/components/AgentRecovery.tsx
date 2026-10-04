'use client'
import { useEffect, useMemo, useState } from 'react'
import { FiRefreshCw } from 'react-icons/fi'
import { api } from '@/lib/api'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useTranslation } from '@/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { ModalPortal } from './ModalPortal'
import { Button } from './Button'
import type { AgentRecoveryCandidate } from '@/types'

// 自管轮询而非 react-query：SessionPanel 的测试/挂载上下文不保证有
// QueryClientProvider；每 host 一份 15s 轮询足够轻（manifest ≤100 条）
export function useAgentRecoveryList(hostId: string | null) {
  const [candidates, setCandidates] = useState<AgentRecoveryCandidate[]>([])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!hostId) {
      setCandidates([])
      return
    }
    let cancelled = false
    const load = () => {
      api.agentRecovery
        .list(hostId)
        .then((result) => {
          if (!cancelled) setCandidates(Array.isArray(result?.candidates) ? result.candidates : [])
        })
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [hostId, tick])
  const bySession = useMemo(() => {
    const grouped = new Map<string, AgentRecoveryCandidate[]>()
    for (const candidate of candidates) {
      if (candidate.status !== 'pending') continue
      const list = grouped.get(candidate.sessionName) || []
      list.push(candidate)
      grouped.set(candidate.sessionName, list)
    }
    return grouped
  }, [candidates])
  return { bySession, refetch: () => setTick((value) => value + 1) }
}

export function AgentRecoveryBadge({
  hostId,
  candidates,
  onResumed,
}: {
  hostId: string
  candidates: AgentRecoveryCandidate[] | undefined
  onResumed: () => void
}) {
  const { t } = useTranslation()
  const pushToast = useConsoleStore((state) => state.pushToast)
  const [open, setOpen] = useState(false)
  const [pendingCandidate, setPendingCandidate] = useState<AgentRecoveryCandidate | null>(null)
  if (!candidates?.length) return null
  const resume = async (candidate: AgentRecoveryCandidate) => {
    await api.agentRecovery.resume(hostId, candidate.id, {
      paneId: candidate.paneId,
      agentSessionId: candidate.agentSessionId || '',
    })
    pushToast({ type: 'success', message: t('agent.recovery.resumed', { agent: candidate.agent }) })
    setPendingCandidate(null)
    if (candidates.length <= 1) setOpen(false)
    onResumed()
  }
  const confirmResume = async () => {
    if (!pendingCandidate) return
    try {
      await resume(pendingCandidate)
    } catch (error) {
      pushToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('agent.recovery.failed'),
      })
    }
  }
  const reasonLabel = (reason: string) => {
    const key = `agent.recovery.reason.${reason}` as never
    const label = t(key)
    return label === key ? reason : label
  }
  const blockLabel = (code?: string) => {
    if (!code) return ''
    const key = `agent.recovery.block.${code}` as never
    const label = t(key)
    return label === key ? code : label
  }
  return (
    <>
      <button
        type="button"
        // 嵌在 session 行 button 内：阻止冒泡避免误激活 session 切换
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
        title={t('agent.recovery.badgeTitle')}
        aria-label={t('agent.recovery.badgeTitle')}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-accent-2/30 bg-accent-2/10 px-1.5 text-caption font-medium text-accent-2 transition-opacity hover:opacity-80"
      >
        <FiRefreshCw aria-hidden="true" size={10} />
        <span>
          {candidates.length} {t('agent.recovery.badge')}
        </span>
      </button>
      {open && (
        <ModalPortal modal onEscape={() => setOpen(false)}>
          <div
            className="fixed inset-0 z-[115] flex items-center justify-center tmuxgo-scrim p-4"
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('agent.recovery.title')}
              className="tmuxgo-glass tmuxgo-glass-dialog w-full max-w-md rounded-apple border p-5 outline-none"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="text-lg text-text-1">{t('agent.recovery.title')}</div>
              <div className="mt-2 text-sm text-text-3">{t('agent.recovery.hint')}</div>
              <div className="tmuxgo-scrollbar mt-3 max-h-60 overflow-y-auto rounded border border-[var(--line)]">
                {candidates.map((candidate) => (
                  <div
                    key={candidate.id}
                    className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text-1">
                        {candidate.agent} · {candidate.tmuxPaneId}
                      </div>
                      <div className="mt-0.5 truncate text-caption text-text-3">
                        {reasonLabel(candidate.reason)}
                        {candidate.cwd ? ` · ${candidate.cwd}` : ''}
                        {candidate.blockReason ? ` · ${blockLabel(candidate.blockReason)}` : ''}
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!candidate.resumable}
                      title={candidate.blockReason ? blockLabel(candidate.blockReason) : undefined}
                      onClick={() => setPendingCandidate(candidate)}
                    >
                      {t('agent.recovery.resume')}
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  {t('common.close')}
                </Button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
      <ConfirmDialog
        open={!!pendingCandidate}
        title={t('agent.recovery.confirmTitle')}
        message={t('agent.recovery.confirmMessage', {
          agent: pendingCandidate?.agent || '',
          pane: pendingCandidate?.tmuxPaneId || '',
        })}
        confirmLabel={t('agent.recovery.resume')}
        cancelLabel={t('common.cancel')}
        onConfirm={confirmResume}
        onCancel={() => setPendingCandidate(null)}
      />
    </>
  )
}
