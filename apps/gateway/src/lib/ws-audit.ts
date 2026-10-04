import { appendAuditEvent, type AuditEvent } from './audit-log.js'
import type { AuditSource } from './principal.js'

// WS 消息级审计：在连接级审计（ws-*-connect）之上，对每条已调度的控制消息记一行。
// 只落 action/target/result/错误类别 + actor + hostId + 时间戳——消息正文、击键
// 数据、agent-event payload、粘贴内容、URL、token 一律不落盘（target 仅从已解析
// 消息取 session/host/pane 标识字段，data/payload/event/text/url 绝不进入）。
// 鉴权失败与协议错误同样落盘，但 message 只写类别词不回显下游错误细节，
// 避免借审计泄漏资源存在性。keepalive（ping/heartbeat）与 agent 通道内部
// RPC 回复、批量数据帧（vnc-data/terminal-output）不产生审计行，由调用方
// 按类型跳过，防日志淹没。

export type WsMessageErrorKind = 'denied' | 'invalid' | 'error'

const FAILURE_STATUS: Record<WsMessageErrorKind, number> = {
  denied: 403, // 策略/权限拒绝（share 只读、ticket 失效）
  invalid: 400, // 协议错误（JSON/zod 解析失败、未知 type）
  error: 500, // 下游执行异常
}

// 与 audit-log safeValue 同约束：只取字符串并截断
const safeField = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 128) : '')

// 从已解析消息提取安全 target：只取路由级标识字段（正文字段绝不取）
export function wsMessageTarget(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const body = data as Record<string, unknown>
  return [body.sessionName, body.paneId, body.tmuxPaneId, body.hostId, body.targetId]
    .map(safeField)
    .filter(Boolean)
    .join(' · ')
}

export function appendWsMessageAudit(params: {
  actor: string
  source: AuditSource
  channel: 'stream' | 'browser'
  type?: unknown // 已解析消息 type；不可解析时缺省 → 'message'
  data?: unknown // 已解析消息对象（仅提取标识字段）
  target?: string // 显式 target（如当前 attach 的 session），优先于 data 提取
  result: 'success' | 'failure'
  error?: WsMessageErrorKind
  hostId?: string
}) {
  const type = typeof params.type === 'string' && params.type.trim() ? params.type.trim().slice(0, 64) : 'message'
  const event: AuditEvent = {
    id: `${Date.now().toString(36)}-wsm`,
    timestamp: new Date().toISOString(),
    user: params.actor,
    actor: params.actor,
    source: params.source,
    action: `ws-${params.channel}-${type}`,
    target:
      safeField(params.target) ||
      wsMessageTarget(params.data) ||
      (params.channel === 'stream' ? '/api/stream' : '/api/browser/stream'),
    result: params.result,
    method: 'WS',
    statusCode: params.result === 'success' ? 200 : FAILURE_STATUS[params.error || 'error'],
  }
  if (params.result === 'failure') event.message = params.error || 'error'
  if (params.hostId) event.hostId = safeField(params.hostId)
  void appendAuditEvent(event).catch(() => {})
}
