import type { SessionResumePoint } from '@/types'

// 「最近会话」按设备端连续性记录的 lastSeenAt 取当前主机维度下仍存在的会话；
// resumePoint 在会话删除后仍可能残留（无 removeResumePoint 调用方），
// 必须在候选集合里逐条校验存在性以排除失效目标
export function pickRecentSessionId(
  resumePoints: Pick<SessionResumePoint, 'hostId' | 'sessionId' | 'lastSeenAt'>[],
  hostId: string,
  sessionIds: string[],
): string | null {
  const alive = new Set(sessionIds)
  const candidates = resumePoints
    .filter((point) => point.hostId === hostId && alive.has(point.sessionId))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
  return candidates[0]?.sessionId ?? null
}
