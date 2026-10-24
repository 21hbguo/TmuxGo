import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiAlertCircle, FiCheckCircle, FiClock, FiRefreshCw, FiTrash2 } from 'react-icons/fi'
import { api, type AgentTodoItem, type AgentTodoQueue } from '@/lib/api'
import { markAgentNotificationsRead } from '@/lib/agent-push'
import { useConsoleStore } from '@/stores/useConsoleStore'
import type { useTranslation } from '@/i18n'
import { ConfirmDialog } from './ConfirmDialog'

type TranslateFn = ReturnType<typeof useTranslation>['t']

/**
 * 待办队列视图（agent v2 P2，docs/architecture/agent-observability-v2.md §4）。
 *
 * 与「消息」并列，不是给消息加过滤维度：消息问「我收到了什么」，
 * 待办问「哪件事还等着我」。所以这里按 todoState 分三段，
 * 同一 pane 只出现一行（聚合在 gateway 侧做，见 listAgentTodoQueue）。
 */
export interface InboxTasksViewProps {
  t: TranslateFn
  onJumpToPane?: (item: AgentTodoItem) => void
}

const EMPTY: AgentTodoQueue = {
  blocked: [],
  pending: [],
  done: [],
  counts: { blocked: 0, pending: 0, done: 0 },
}

function relative(timestamp: string, now: number) {
  const elapsed = Math.max(0, now - Date.parse(timestamp))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function taskLabel(item: AgentTodoItem) {
  // 任务号可能带「T-234:说明」，列表里只显示 id 段，title 给全文
  const raw = item.task?.trim()
  if (!raw) return null
  return { id: raw.split(':')[0].trim() || raw, full: raw }
}

export function InboxTasksView({ t, onJumpToPane }: InboxTasksViewProps) {
  const [queue, setQueue] = useState<AgentTodoQueue>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [confirmClear, setConfirmClear] = useState(false)
  const pushToast = useConsoleStore((state) => state.pushToast)

  const load = useCallback(async () => {
    try {
      const next = await api.agentNotifications.tasks()
      setQueue(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 破坏性动作（清 done）只删存储里推导为 done 的记录；确认后调后端，回来立刻重拉队列
  const clearDone = useCallback(async () => {
    try {
      const result = await api.agentNotifications.clearDoneTasks()
      // 队列是投影：清了 N 条不代表 done 段归零（同一 pane 可能还有更早的 pending 记录被顶上来），
      // 所以不本地瞎改，直接以服务端重算后的队列为准
      await load()
      pushToast({ type: 'success', message: t('inbox.tasksClearDoneResult', { count: result.removed }) })
    } catch (err) {
      pushToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setConfirmClear(false)
    }
  }, [load, pushToast, t])

  // 停留时长每分钟重算：纯本地计时，不触发网络（刷新策略见设计稿 §3.5）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const sections = useMemo(
    () => [
      {
        key: 'blocked',
        icon: FiAlertCircle,
        title: t('inbox.tasksBlocked'),
        hint: t('inbox.tasksBlockedHint'),
        tone: 'text-danger',
        items: queue.blocked,
      },
      {
        key: 'pending',
        icon: FiClock,
        title: t('inbox.tasksPending'),
        hint: t('inbox.tasksPendingHint'),
        tone: 'text-accent-2',
        items: queue.pending,
      },
      {
        key: 'done',
        icon: FiCheckCircle,
        title: t('inbox.tasksDone'),
        hint: t('inbox.tasksDoneHint'),
        tone: 'text-text-3',
        items: queue.done,
      },
    ],
    [queue, t],
  )

  if (loading) {
    return <div className="flex h-full items-center justify-center text-caption text-text-3">{t('common.loading')}</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-1.5 text-caption text-text-3">
        <span>
          {t('inbox.tasksSummary', {
            blocked: queue.counts.blocked,
            pending: queue.counts.pending,
          })}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          title={t('inbox.tasksRefresh')}
          aria-label={t('inbox.tasksRefresh')}
          className="ml-auto flex items-center gap-1 rounded-apple px-1.5 py-0.5 hover:text-text-1"
        >
          <FiRefreshCw aria-hidden="true" size={12} />
        </button>
      </div>
      {error && (
        <div className="shrink-0 border-b border-[var(--line)] px-3 py-1.5 text-caption text-danger">
          {t('inbox.tasksError', { message: error })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.map((section) => (
          <section key={section.key} className="border-b border-[var(--line)] last:border-b-0">
            <header className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
              <section.icon aria-hidden="true" size={13} className={section.tone} />
              <h3 className="text-caption font-medium text-text-2">{section.title}</h3>
              <span className="text-caption text-text-3">{section.items.length}</span>
              {section.key === 'done' && section.items.length > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  title={t('inbox.tasksClearDone')}
                  aria-label={t('inbox.tasksClearDone')}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded-apple px-1.5 py-0.5 text-caption text-text-3 hover:text-danger"
                >
                  <FiTrash2 aria-hidden="true" size={12} />
                  {t('inbox.tasksClearDone')}
                </button>
              )}
              <span
                className={`${section.key === 'done' && section.items.length > 0 ? '' : 'ml-auto'} truncate text-caption text-text-3`}
              >
                {section.hint}
              </span>
            </header>
            {section.items.length === 0 ? (
              <p className="px-3 pb-2.5 text-caption text-text-3">{t('inbox.tasksEmpty')}</p>
            ) : (
              <ul>
                {section.items.map((item) => {
                  const label = taskLabel(item)
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onJumpToPane?.(item)
                          // 与消息行对齐：点开即已读（按设备），失败静默——待办是否仍 blocked 由 agent 状态决定
                          void markAgentNotificationsRead([item.id])
                        }}
                        disabled={!onJumpToPane}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-1 disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        {label ? (
                          <span
                            title={label.full}
                            className="shrink-0 rounded-apple border border-[var(--line)] px-1.5 py-0.5 font-mono text-caption text-text-2"
                          >
                            {label.id}
                          </span>
                        ) : (
                          <span className="shrink-0 text-caption text-text-3">—</span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm text-text-1">{item.message}</span>
                        <span className="shrink-0 text-caption text-text-3">
                          {item.agent} · {item.sessionName}
                        </span>
                        <span className="w-8 shrink-0 text-right text-caption text-text-3">
                          {relative(item.timestamp, now)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
      <ConfirmDialog
        open={confirmClear}
        title={t('inbox.tasksClearDoneTitle')}
        message={t('inbox.tasksClearDoneMessage', { count: queue.counts.done })}
        confirmLabel={t('inbox.tasksClearDoneConfirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={clearDone}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}
