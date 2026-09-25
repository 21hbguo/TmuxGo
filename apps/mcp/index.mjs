#!/usr/bin/env node
// TmuxGo agent push MCP bridge（stdio JSON-RPC → gateway control-plane REST）。
// 零依赖：pane 内 agent 把它注册为 stdio MCP server 后，工具调用经 HTTP 落到
// /api/v1/control/*。鉴权从环境变量取（TmuxGo 创建 pane 时已注入）：
//   TMUXGO_AGENT_EVENT_TOKEN / TMUXGO_GATEWAY_URL(默认 http://127.0.0.1:3001)
// 无 token 时 tools/list 仍可用，tools/call 返回 isError 提示配置。

const GATEWAY_URL = (process.env.TMUXGO_GATEWAY_URL || 'http://127.0.0.1:3001')
  .replace(/\/api\/stream\/?$/, '')
  .replace(/\/$/, '')
const TOKEN = process.env.TMUXGO_AGENT_EVENT_TOKEN || ''
const PROTOCOL_VERSION = '2025-06-18'

const TOOLS = [
  {
    name: 'tmuxgo_push_text',
    description: 'Push a text/markdown message to the TmuxGo inbox (visible on PC and mobile UI).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body (markdown supported, max 256KiB)' },
        title: { type: 'string', description: 'Short title (max 160 chars)' },
        open: { type: 'boolean', description: 'Ask the UI to open/focus this message immediately' },
        dedupeKey: {
          type: 'string',
          description: 'Idempotency key; repeated pushes with the same key return the same message',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'tmuxgo_push_file',
    description: 'Push a local file (image/video/any file) to the TmuxGo inbox for preview or download in the UI.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or ~ path of the local file to push' },
        title: { type: 'string' },
        open: { type: 'boolean', description: 'Ask the UI to open a preview immediately' },
        dedupeKey: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'tmuxgo_push_link',
    description: 'Push an http(s) link to the TmuxGo inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL' },
        title: { type: 'string' },
        open: { type: 'boolean' },
        dedupeKey: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tmuxgo_open_target',
    description: 'Ask the TmuxGo UI to focus a session or pane (navigation only; does not control the browser).',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: 'Host id (default local)' },
        sessionName: { type: 'string' },
        tmuxPaneId: { type: 'string', description: 'tmux pane id like %3' },
        messageId: { type: 'string' },
      },
    },
  },
]

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}
function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}
function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}
function toolResult(id, payload, isError = false) {
  reply(id, {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  })
}

function sourceInfo() {
  return {
    provider: 'mcp',
    agent: process.env.TMUXGO_AGENT_NAME || undefined,
    agentSessionId: process.env.TMUXGO_AGENT_SESSION_ID || undefined,
  }
}
function defaultRoute(args) {
  const route = {}
  if (typeof args.hostId === 'string') route.hostId = args.hostId
  if (typeof args.sessionName === 'string') route.sessionName = args.sessionName
  // pane 内运行时 tmux 自带 TMUX_PANE=%n，自动归属当前 pane
  const pane = args.tmuxPaneId || process.env.TMUX_PANE
  if (pane) route.tmuxPaneId = pane
  return route
}

async function callGateway(pathname, body) {
  if (!TOKEN) {
    return {
      ok: false,
      status: 0,
      body: 'TMUXGO_AGENT_EVENT_TOKEN is not set. Run this MCP server inside a TmuxGo pane (TMUXGO_ENV=1), or configure the token manually.',
    }
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/api${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tmuxgo-env': '1',
        'x-tmuxgo-agent-token': TOKEN,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, body: text }
  } catch (error) {
    return { ok: false, status: 0, body: `Gateway request failed: ${error?.message || error}` }
  }
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments || {}
  const route = defaultRoute(args)
  let result
  if (name === 'tmuxgo_push_text') {
    result = await callGateway('/v1/control/push', {
      type: 'text',
      title: args.title,
      text: args.text,
      open: args.open === true,
      dedupeKey: args.dedupeKey,
      route,
      source: sourceInfo(),
    })
  } else if (name === 'tmuxgo_push_file') {
    if (typeof args.path !== 'string' || !args.path.trim()) return toolResult(id, 'path is required', true)
    result = await callGateway('/v1/control/push', {
      type: 'file',
      title: args.title,
      path: args.path,
      name: args.name,
      open: args.open === true,
      dedupeKey: args.dedupeKey,
      route,
      source: sourceInfo(),
    })
  } else if (name === 'tmuxgo_push_link') {
    result = await callGateway('/v1/control/push', {
      type: 'link',
      title: args.title,
      linkUrl: args.url,
      open: args.open === true,
      dedupeKey: args.dedupeKey,
      route,
      source: sourceInfo(),
    })
  } else if (name === 'tmuxgo_open_target') {
    result = await callGateway('/v1/control/open-target', { route, messageId: args.messageId })
  } else {
    return toolResult(id, `Unknown tool: ${name}`, true)
  }
  if (!result.ok) return toolResult(id, `TmuxGo push failed (${result.status}): ${result.body}`, true)
  toolResult(id, result.body)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  // MCP stdio 传输：每行一个 JSON-RPC 消息
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handleMessage(message).catch(() => {})
  }
})
process.stdin.resume()

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message && 'id' in message) replyError(message.id, -32600, 'Invalid request')
    return
  }
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tmuxgo-mcp', version: '0.1.0' },
      })
      return
    case 'notifications/initialized':
    case 'initialized':
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call':
      await handleToolCall(id, params)
      return
    default:
      if ('id' in message) replyError(id, -32601, `Method not found: ${method}`)
  }
}
