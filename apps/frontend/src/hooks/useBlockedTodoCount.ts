import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { STREAM_EVENT, subscribeStreamEvent } from '@/lib/stream-events'

/**
 * 待处理事项计数（agent v2 P2，设计稿 §4.3）。
 *
 * 与收件箱未读数分开：消息未读问「我漏看了什么」，待办问「谁卡着等我」。
 * 这里只拿 blocked 数（需要人处理的），pending/done 不参与角标。
 *
 * 刷新策略：挂载拉一次 + agent_notification 帧到达时防抖重拉。
 * 不轮询——通知帧本身就是变更信号；漏帧最坏情况是角标晚一拍，下次事件自动纠正。
 */
export function useBlockedTodoCount() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const load = async () => {
      try {
        const queue = await api.agentNotifications.tasks()
        if (active) setCount(queue.counts.blocked)
      } catch {
        // 计数是装饰信息，取不到就保持旧值：不把面板拖进错误态
      }
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void load()
      }, 500)
    }

    void load()
    const unsubscribe = subscribeStreamEvent(STREAM_EVENT.agentNotification, schedule)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return count
}
