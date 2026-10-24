'use client'
import { useEffect } from 'react'
import { useConsoleStore } from '@/stores/useConsoleStore'
import { useHosts, useSessionSnapshot } from '@/hooks/useApi'
import { DEFAULT_DOCUMENT_TITLE, formatDocumentTitle } from '@/lib/document-title'

// 浏览器标签标题跟随当前 attach：{host} - {session}: {window}。
// 数据全部复用现成链路——activeHostId/activeSessionId 来自 console store，
// session/window 名来自 ConsoleLayout 已在轮询的同一份 session-snapshot 查询
// （query key 相同，React Query 去重，不额外发请求、不新增轮询）。
// 窗口名优先用 snapshot.activeWindowId 指向的那个，退回 active 标记，都没有就不带窗口段。
export function useDocumentTitle() {
  const activeHostId = useConsoleStore((state) => state.activeHostId)
  const activeSessionId = useConsoleStore((state) => state.activeSessionId)
  const { data: hosts } = useHosts()
  const { data: snapshot } = useSessionSnapshot(activeHostId || '', activeSessionId || '')

  const hostLabel = hosts?.find((host) => host.id === activeHostId)?.name || activeHostId || ''
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : []
  const activeWindow =
    windows.find((item) => item.id === snapshot?.activeWindowId) || windows.find((item) => item.active) || null
  const title = formatDocumentTitle({
    hostLabel,
    sessionName: snapshot?.sessionName,
    windowName: activeWindow?.name,
  })

  useEffect(() => {
    document.title = title
  }, [title])
  // 卸载时回默认标题：标题是全局副作用，别把它留给下一个挂载者猜
  useEffect(
    () => () => {
      document.title = DEFAULT_DOCUMENT_TITLE
    },
    [],
  )
}
