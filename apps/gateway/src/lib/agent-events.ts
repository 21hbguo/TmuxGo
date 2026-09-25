import { createHash, timingSafeEqual } from 'crypto'
import { resolveAgentEventToken } from './agent-token.js'
import type { AgentEvent, AgentPhase } from './agent-state.js'

export type AgentProtocolEventType =
  | 'session_started'
  | 'session_ended'
  | 'working'
  | 'permission_required'
  | 'question_required'
  | 'retrying'
  | 'idle'
  | 'failed'
  | 'process_exited'
export interface AgentProtocolEvent {
  hostId: string
  agent: string
  agentSessionId?: string
  paneId?: string
  tmuxPaneId?: string
  sessionName?: string
  type: AgentProtocolEventType
  phase: AgentPhase
  lastEvent?: AgentEvent
  source: 'protocol' | 'hook'
  confidence: 'high'
  eventId: string
  timestamp: string
  message?: string
  attempt?: number
  action?: string
  next?: string
  display?: { title?: string; stateLabel?: string; tokens?: number; seq?: number; ttlMs?: number }
}
export interface AgentEventContext {
  hostId: string
  provider?: string
  agent?: string
  source?: 'protocol' | 'hook'
  paneId?: string
  tmuxPaneId?: string
  sessionName?: string
  agentSessionId?: string
}
const protocolEvents = new Map<string, AgentProtocolEvent>()
function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
function firstText(...values: unknown[]) {
  for (const value of values) {
    const result = text(value)
    if (result) return result
  }
  return ''
}
function normalizeAgentName(value: string) {
  const name = value.toLowerCase().replace(/\\/g, '/').split('/').pop()?.replace(/\s+/g, '-') || ''
  if (name === 'claude-code') return 'claude'
  if (name === 'codex-cli') return 'codex'
  return name || 'agent'
}
function sanitizeMessage(value: unknown) {
  const message = text(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:~|\/)[^\s,;)]{2,}/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
  return message ? message.slice(0, 240) : undefined
}
function nestedData(raw: Record<string, unknown>) {
  return { ...object(raw.payload), ...object(raw.data), ...raw }
}
function eventSeed(
  raw: Record<string, unknown>,
  base: { hostId: string; agent: string; agentSessionId?: string; paneId?: string; type: string; timestamp: string },
) {
  const nativeId = firstText(
    raw.eventId,
    raw.event_id,
    raw.notificationId,
    raw.notification_id,
    raw.requestId,
    raw.request_id,
    raw.id,
  )
  const value =
    nativeId ||
    [
      base.hostId,
      base.agent,
      base.agentSessionId || base.paneId || '',
      base.type,
      firstText(raw.timestamp, raw.createdAt, raw.created_at),
      firstText(raw.status, raw.notification_type, raw.hook_event_name),
      JSON.stringify(raw),
    ].join('|')
  return `${base.hostId}:${base.agent}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}
function normalizeDisplay(raw: Record<string, unknown>) {
  const data = nestedData(raw)
  const displayRaw = object(data.display)
  const title = firstText(displayRaw.title, raw.displayTitle, raw.display_title, data.displayTitle, data.display_title)
  const stateLabel = firstText(displayRaw.stateLabel, displayRaw.state_label, raw.stateLabel, raw.state_label)
  const tokensValue = displayRaw.tokens ?? raw.tokens ?? data.tokens
  const seqValue = displayRaw.seq ?? displayRaw.seqNum ?? displayRaw.seq_num ?? raw.displaySeq ?? raw.display_seq
  const ttlValue = displayRaw.ttlMs ?? displayRaw.ttl_ms ?? raw.displayTtlMs ?? raw.display_ttl_ms
  const tokens =
    typeof tokensValue === 'number' && Number.isFinite(tokensValue)
      ? tokensValue
      : firstText(tokensValue)
        ? Number(firstText(tokensValue))
        : undefined
  const seq =
    typeof seqValue === 'number' && Number.isFinite(seqValue)
      ? seqValue
      : firstText(seqValue)
        ? Number(firstText(seqValue))
        : undefined
  const ttlMs =
    typeof ttlValue === 'number' && Number.isFinite(ttlValue)
      ? ttlValue
      : firstText(ttlValue)
        ? Number(firstText(ttlValue))
        : undefined
  const display: AgentProtocolEvent['display'] = {}
  if (title) display.title = title.slice(0, 160)
  if (stateLabel) display.stateLabel = stateLabel.slice(0, 160)
  if (Number.isFinite(tokens) && tokens! >= 0) display.tokens = Math.floor(tokens!)
  if (Number.isFinite(seq) && seq! >= 0) display.seq = Math.floor(seq!)
  if (Number.isFinite(ttlMs) && ttlMs! > 0) display.ttlMs = Math.floor(ttlMs!)
  return Object.keys(display).length ? display : undefined
}
function baseEvent(
  raw: Record<string, unknown>,
  context: AgentEventContext,
  agent: string,
  type: AgentProtocolEventType,
  phase: AgentPhase,
  lastEvent?: AgentEvent,
  source?: 'protocol' | 'hook',
  extra: Partial<AgentProtocolEvent> = {},
) {
  const data = nestedData(raw)
  const agentSessionId =
    firstText(
      context.agentSessionId,
      raw.agentSessionId,
      raw.agent_session_id,
      data.sessionId,
      data.session_id,
      data.threadId,
      data.thread_id,
    ) || undefined
  const paneId = firstText(context.paneId, raw.paneId, raw.pane_id) || undefined
  const tmuxPaneId = firstText(context.tmuxPaneId, raw.tmuxPaneId, raw.tmux_pane_id) || undefined
  const sessionName =
    firstText(context.sessionName, raw.sessionName, raw.session_name, data.sessionName, data.session_name) || undefined
  const timestamp = firstText(raw.timestamp, raw.createdAt, raw.created_at, data.timestamp) || new Date().toISOString()
  const display = normalizeDisplay(raw)
  const event: AgentProtocolEvent = {
    hostId: context.hostId,
    agent,
    agentSessionId,
    paneId,
    tmuxPaneId,
    sessionName,
    type,
    phase,
    lastEvent,
    source: source || context.source || 'protocol',
    confidence: 'high',
    eventId: eventSeed(raw, { hostId: context.hostId, agent, agentSessionId, paneId, type, timestamp }),
    timestamp,
    ...(display ? { display } : {}),
    ...extra,
  }
  return event
}
function normalizeClaude(raw: Record<string, unknown>, context: AgentEventContext, agent: string) {
  const data = nestedData(raw)
  const hookEvent = firstText(
    raw.hook_event_name,
    raw.hookEventName,
    data.hook_event_name,
    data.hookEventName,
    raw.event,
    raw.type,
  ).toLowerCase()
  const notification = firstText(
    raw.notification_type,
    raw.notificationType,
    data.notification_type,
    data.notificationType,
  ).toLowerCase()
  const message = sanitizeMessage(raw.message || data.message)
  const title =
    sanitizeMessage(raw.title || data.title) ||
    sanitizeMessage(raw.last_assistant_message || data.last_assistant_message)
  const display = title ? { title, ttlMs: 60000 } : undefined
  if (hookEvent === 'sessionstart' || hookEvent === 'session_start')
    return baseEvent(raw, context, agent, 'session_started', 'working', 'started', 'hook')
  if (hookEvent === 'sessionend' || hookEvent === 'session_end')
    return baseEvent(raw, context, agent, 'session_ended', 'ended', 'ended', 'hook')
  if (hookEvent === 'permissionrequest' || hookEvent === 'permission_request' || notification === 'permission_prompt')
    return baseEvent(raw, context, agent, 'permission_required', 'permission_required', 'permission_required', 'hook', {
      message,
      ...(display ? { display } : {}),
    })
  if (
    notification === 'idle_prompt' ||
    notification === 'agent_needs_input' ||
    notification === 'elicitation_dialog' ||
    hookEvent === 'userinputrequest' ||
    hookEvent === 'user_input_request'
  )
    return baseEvent(raw, context, agent, 'question_required', 'needs_input', 'question_required', 'hook', {
      message,
      ...(display ? { display } : {}),
    })
  if (hookEvent === 'stopfailure' || hookEvent === 'stop_failure')
    return baseEvent(raw, context, agent, 'failed', 'failed', 'failed', 'hook', {
      message: sanitizeMessage(raw.error || raw.message || data.error || data.message),
    })
  if (
    notification === 'agent_completed' ||
    notification === 'elicitation_complete' ||
    notification === 'elicitation_response' ||
    hookEvent === 'stop' ||
    hookEvent === 'completed'
  )
    return baseEvent(raw, context, agent, 'idle', 'idle', 'completed', 'hook', display ? { display } : {})
  if (hookEvent === 'subagentstart' || hookEvent === 'subagent_start')
    return baseEvent(raw, context, agent, 'working', 'working', 'started', 'hook')
  if (hookEvent === 'subagentstop' || hookEvent === 'subagent_stop')
    return baseEvent(raw, context, agent, 'working', 'working', 'started', 'hook', display ? { display } : {})
  return null
}
function normalizeCodex(raw: Record<string, unknown>, context: AgentEventContext, agent: string) {
  const data = nestedData(raw)
  const eventName = firstText(raw.type, raw.event, raw.method, data.type, data.event)
    .toLowerCase()
    .replace(/[.:/ -]+/g, '_')
  const statusValue =
    object(raw.status).type ||
    object(data.status).type ||
    raw.status ||
    data.status ||
    raw.threadStatus ||
    data.threadStatus
  const status = text(statusValue)
    .toLowerCase()
    .replace(/[.:/ -]+/g, '_')
  const flagsValue =
    object(raw.status).activeFlags || object(data.status).activeFlags || raw.activeFlags || data.activeFlags
  const activeFlags = Array.isArray(flagsValue) ? flagsValue.map((flag) => text(flag).toLowerCase()) : []
  const waitingApproval = activeFlags.includes('waitingonapproval') || status.includes('waitingonapproval')
  const waitingInput = activeFlags.includes('waitingonuserinput') || status.includes('waitingonuserinput')
  const waitingApprovalEvent =
    eventName.includes('permission') || (eventName.includes('approval') && !eventName.includes('autoapproval'))
  const waitingInputEvent = eventName.includes('user_input') || eventName.includes('userinput')
  if (
    eventName.includes('process_exited') ||
    eventName.includes('processexited') ||
    eventName === 'process_exit' ||
    eventName === 'thread_closed'
  )
    return baseEvent(raw, context, agent, 'process_exited', 'ended', 'ended')
  if (waitingApproval || waitingApprovalEvent)
    return baseEvent(raw, context, agent, 'permission_required', 'permission_required', 'permission_required')
  if (waitingInput || waitingInputEvent)
    return baseEvent(raw, context, agent, 'question_required', 'needs_input', 'question_required')
  if (
    status === 'systemerror' ||
    status === 'system_error' ||
    eventName.includes('failure') ||
    eventName.includes('error')
  )
    return baseEvent(raw, context, agent, 'failed', 'failed', 'failed', undefined, {
      message: sanitizeMessage(raw.message || data.message),
    })
  if (status === 'active' || status === 'working' || eventName.endsWith('_started'))
    return baseEvent(raw, context, agent, 'working', 'working', 'started')
  if (
    status === 'idle' ||
    status === 'notloaded' ||
    eventName.includes('item_completed') ||
    eventName.includes('turn_completed') ||
    eventName.includes('hook_completed')
  )
    return baseEvent(raw, context, agent, 'idle', 'idle', 'completed')
  return null
}
function normalizeOpenCode(raw: Record<string, unknown>, context: AgentEventContext, agent: string) {
  const data = nestedData(raw)
  const eventName = firstText(raw.type, raw.event, data.type, data.event).toLowerCase()
  const statusValue = firstText(
    raw.status,
    data.status,
    object(raw.properties).status,
    object(data.properties).status,
  ).toLowerCase()
  if (statusValue === 'busy' || statusValue === 'working' || eventName.includes('busy'))
    return baseEvent(raw, context, agent, 'working', 'working', 'started')
  if (statusValue === 'retry' || statusValue === 'retrying' || eventName.includes('retry'))
    return baseEvent(raw, context, agent, 'retrying', 'retrying', 'retrying', undefined, {
      attempt: Number(raw.attempt || data.attempt) || undefined,
      action: sanitizeMessage(raw.action || data.action),
      next: sanitizeMessage(raw.next || data.next),
      message: sanitizeMessage(raw.message || data.message),
    })
  if (eventName.includes('permission') || eventName.includes('approval'))
    return baseEvent(raw, context, agent, 'permission_required', 'permission_required', 'permission_required')
  if (eventName.includes('question') || eventName.includes('input'))
    return baseEvent(raw, context, agent, 'question_required', 'needs_input', 'question_required')
  if (eventName.includes('error') || eventName.includes('failed') || eventName.includes('fail'))
    return baseEvent(raw, context, agent, 'failed', 'failed', 'failed', undefined, {
      message: sanitizeMessage(raw.message || data.message),
    })
  if (eventName === 'session.next.text.ended' || eventName === 'session.next.reasoning.ended') {
    const text = sanitizeMessage(data.text || raw.text)
    return baseEvent(
      raw,
      context,
      agent,
      'working',
      'working',
      'started',
      undefined,
      text ? { display: { title: text.slice(0, 160), ttlMs: 60000 } } : {},
    )
  }
  if (statusValue === 'idle' || eventName.includes('idle'))
    return baseEvent(raw, context, agent, 'idle', 'idle', 'completed')
  return null
}
function normalizeReasonix(raw: Record<string, unknown>, context: AgentEventContext, agent: string) {
  const data = nestedData(raw)
  const eventName = firstText(raw.event, raw.type, data.event, data.type).toLowerCase()
  const message = sanitizeMessage(raw.message || data.message)
  const lastText = sanitizeMessage(raw.lastAssistantText || data.lastAssistantText)
  const display = lastText ? { title: lastText, ttlMs: 60000 } : undefined
  if (eventName === 'sessionstart')
    return baseEvent(raw, context, agent, 'session_started', 'working', 'started', 'hook')
  if (eventName === 'sessionend') return baseEvent(raw, context, agent, 'session_ended', 'ended', 'ended', 'hook')
  if (eventName === 'subagentstop')
    return baseEvent(raw, context, agent, 'working', 'working', 'started', 'hook', display ? { display } : {})
  if (eventName === 'stop')
    return baseEvent(raw, context, agent, 'idle', 'idle', 'completed', 'hook', display ? { display } : {})
  if (eventName === 'notification') {
    if (message && /question|input|answer|respond/i.test(message))
      return baseEvent(raw, context, agent, 'question_required', 'needs_input', 'question_required', 'hook', {
        message,
      })
    return baseEvent(raw, context, agent, 'permission_required', 'permission_required', 'permission_required', 'hook', {
      message,
    })
  }
  if (
    eventName === 'pretooluse' ||
    eventName === 'posttooluse' ||
    eventName === 'userpromptsubmit' ||
    eventName === 'postllmcall' ||
    eventName === 'precompact'
  )
    return baseEvent(raw, context, agent, 'working', 'working', 'started', 'hook')
  return null
}
function normalizeGeneric(raw: Record<string, unknown>, context: AgentEventContext, agent: string) {
  const data = nestedData(raw)
  const eventName = firstText(raw.type, raw.event, data.type, data.event)
    .toLowerCase()
    .replace(/[.:/ -]+/g, '_')
  if (eventName.includes('permission') || eventName.includes('approval'))
    return baseEvent(raw, context, agent, 'permission_required', 'permission_required', 'permission_required')
  if (eventName.includes('question') || eventName.includes('input'))
    return baseEvent(raw, context, agent, 'question_required', 'needs_input', 'question_required')
  if (eventName.includes('retry'))
    return baseEvent(raw, context, agent, 'retrying', 'retrying', 'retrying', undefined, {
      message: sanitizeMessage(raw.message || data.message),
    })
  if (eventName.includes('exit') || eventName.includes('ended') || eventName.includes('stop'))
    return baseEvent(raw, context, agent, 'process_exited', 'ended', 'ended')
  if (eventName.includes('fail') || eventName.includes('error'))
    return baseEvent(raw, context, agent, 'failed', 'failed', 'failed', undefined, {
      message: sanitizeMessage(raw.message || data.message),
    })
  if (eventName.includes('start') || eventName.includes('busy') || eventName.includes('working'))
    return baseEvent(raw, context, agent, 'working', 'working', 'started')
  if (eventName.includes('idle') || eventName.includes('complete') || eventName.includes('done'))
    return baseEvent(raw, context, agent, 'idle', 'idle', 'completed')
  return null
}
export function normalizeAgentEvent(input: unknown, context: AgentEventContext) {
  const raw = object(input)
  const data = nestedData(raw)
  const provider = normalizeAgentName(firstText(context.provider, raw.provider, raw.agent, data.provider, data.agent))
  if (!context.hostId.trim()) return null
  const agent = normalizeAgentName(firstText(context.agent, provider))
  const normalized =
    provider === 'claude'
      ? normalizeClaude(raw, context, agent)
      : provider === 'codex'
        ? normalizeCodex(raw, context, agent)
        : provider === 'opencode'
          ? normalizeOpenCode(raw, context, agent)
          : provider === 'reasonix'
            ? normalizeReasonix(raw, context, agent)
            : normalizeGeneric(raw, context, agent)
  return normalized &&
    (normalized.paneId || normalized.tmuxPaneId || normalized.sessionName || normalized.agentSessionId)
    ? normalized
    : null
}
export function ingestAgentEvent(input: unknown, context: AgentEventContext) {
  const event = normalizeAgentEvent(input, context)
  if (!event) return null
  const key = `${event.hostId}:${event.eventId}`
  if (protocolEvents.has(key)) return protocolEvents.get(key)!
  protocolEvents.set(key, event)
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [eventKey, value] of protocolEvents)
    if (Date.parse(value.timestamp) < cutoff) protocolEvents.delete(eventKey)
  return event
}
export function listAgentEvents(hostId: string) {
  return [...protocolEvents.values()]
    .filter((event) => event.hostId === hostId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}
export function forgetAgentEvent(event: AgentProtocolEvent) {
  protocolEvents.delete(`${event.hostId}:${event.eventId}`)
}
export function getAgentEventToken(headers: { authorization?: unknown; 'x-tmuxgo-agent-token'?: unknown }) {
  const header = headers['x-tmuxgo-agent-token']
  if (typeof header === 'string' && header.trim()) return header.trim()
  const authorization = headers.authorization
  return typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}
export function isAgentEventToken(value: unknown) {
  const expected = resolveAgentEventToken()
  if (!expected || typeof value !== 'string') return false
  const actual = value.trim()
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
}
