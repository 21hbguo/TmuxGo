'use client'

import { useCallback, useContext, useEffect, useState } from 'react'
// 用 context 而不是 useQueryClient：没有 provider 的宿主（组件测试、嵌入式挂载）里
// useQueryClient 会直接抛错，而这个入口必须在任何布局下都能安静降级
import { QueryClientContext } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTranslation } from '@/i18n'
import { SessionSnapshotsDialog } from './SessionSnapshotsDialog'

// 启动页/空态的「有快照可恢复」入口：只提示恢复路径，不做功能推销。
// 计数直接复用列表接口（快照总量就是这个 host 的可恢复集合），没有新端点。
export function SnapshotResumeHint({ hostId }: { hostId: string }) {
  const { t } = useTranslation()
  const queryClient = useContext(QueryClientContext)
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    if (!hostId) return
    // 空态是「安静」的地方：取不到就悄悄不显示，不弹 toast 干扰（快照入口不是主流程）。
    // fetch 在缺 provider/无网环境可能同步抛（测试宿主、嵌入式挂载都见过），try 兜住，
    // 否则 effect 里抛错会让宿主反复重挂直到内存打爆
    try {
      api.sessionSnapshots
        .list(hostId)
        .then((data) => setCount(data.snapshots.length))
        .catch(() => setCount(0))
    } catch {
      setCount(0)
    }
  }, [hostId])

  useEffect(() => {
    load()
  }, [load])

  // 弹层里删/恢复后计数要跟着变：关掉时重取一次，避免入口显示过期数量
  const close = () => {
    setOpen(false)
    load()
  }

  if (!count) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-apple border border-text-1/10 px-3 py-1.5 text-xs whitespace-nowrap text-text-2 hover:border-accent/40 hover:text-accent"
        data-testid="snapshot-resume-hint"
      >
        {t('grid.snapshotResume', { count })}
      </button>
      <SessionSnapshotsDialog
        open={open}
        onClose={close}
        hostId={hostId}
        // 恢复后会话列表立刻刷新，否则新会话要等下一次轮询才出现
        onRestored={() => void queryClient?.invalidateQueries({ queryKey: ['sessions', hostId] })}
      />
    </>
  )
}
