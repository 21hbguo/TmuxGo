// 浏览器标签标题的格式化：定长格式（不做模板 DSL，可配置化收益不抵复杂度）。
// 形如 `{host} - {session}: {window}`，缺哪一段就退到上一级，没有 attach 时回默认标题。
// 抽成纯函数是为了能单测边界（空串、缺 window、host 未解析），hook 只负责取数据。
export const DEFAULT_DOCUMENT_TITLE = 'TmuxGo'

export interface DocumentTitleInput {
  hostLabel?: string | null
  sessionName?: string | null
  windowName?: string | null
}

function clean(value: string | null | undefined): string {
  return (value || '').trim()
}

export function formatDocumentTitle({ hostLabel, sessionName, windowName }: DocumentTitleInput): string {
  const session = clean(sessionName)
  // 没有 attach 的会话：标题不带任何会话信息，避免显示上一个会话的残留
  if (!session) return DEFAULT_DOCUMENT_TITLE
  const host = clean(hostLabel)
  const window = clean(windowName)
  const base = host && host !== session ? `${host} - ${session}` : session
  return window ? `${base}: ${window}` : base
}
