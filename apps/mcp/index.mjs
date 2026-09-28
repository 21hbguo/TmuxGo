#!/usr/bin/env node
// TmuxGo agent push MCP bridge（stdio JSON-RPC → gateway control-plane REST）。
// 零依赖：pane 内 agent 把它注册为 stdio MCP server 后，工具调用经 HTTP 落到
// /api/v1/control/*。鉴权从环境变量取（TmuxGo 创建 pane 时已注入）：
//   TMUXGO_AGENT_EVENT_TOKEN / TMUXGO_GATEWAY_URL(默认 http://127.0.0.1:3001)
// 无 token 时 tools/list 仍可用，tools/call 返回 isError 提示配置。
import { readFileSync } from 'node:fs'

const GATEWAY_URL = (process.env.TMUXGO_GATEWAY_URL || 'http://127.0.0.1:3001')
  .replace(/\/api\/stream\/?$/, '')
  .replace(/\/$/, '')
// token 来源：pane env（TmuxGo 注入）→ ~/.tmuxgo/agent-event-token（gateway 自管理落盘），
// 旧 pane 无 env 注入也能本地自取
function resolveToken() {
  if (process.env.TMUXGO_AGENT_EVENT_TOKEN) return process.env.TMUXGO_AGENT_EVENT_TOKEN
  try {
    const file = `${process.env.TMUXGO_CONFIG_DIR?.trim() || `${process.env.HOME}/.tmuxgo`}/agent-event-token`
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}
const TOKEN = resolveToken()
const PROTOCOL_VERSION = '2025-06-18'

const TOOLS = [
  {
    name: 'tmuxgo_push_text',
    description:
      'Push a text/markdown message to the TmuxGo inbox. The UI shows it in a searchable list and a preview tab with copy/forward/share actions. Returns messageId (usable with tmuxgo_inbox_list for delivery/read receipts).',
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
    description:
      'Push a local file to the TmuxGo inbox. Images get a zoomable preview, audio/video use the native player, PDFs open inline, text/code/markdown render readably, other types get a download card. Returns messageId, assetId, name, mime, size and sha256. Errors name the cause: missing file, permission denied, sensitive path, or size limit.',
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
    description: 'Push an http(s) link to the TmuxGo inbox (opens in a preview card; copyable/shareable).',
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
  {
    name: 'tmuxgo_browser_status',
    description:
      'Get the embedded browser status (state, engine, pages/tabs, active tab). The embedded browser is a Chromium instance displayed in the TmuxGo sidebar and shared between you and the user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tmuxgo_browser_launch',
    description:
      'Launch the embedded browser if not running (Chromium headless-shell with persistent profile). Returns status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tmuxgo_browser_navigate',
    description:
      'Navigate the embedded browser (current or given tab) to a URL. The sidebar view updates live so the user sees what you are doing.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (https:// added when missing)' },
        targetId: { type: 'string', description: 'Tab target id (default: active tab)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tmuxgo_browser_snapshot',
    description:
      'Read the page as structured data: {url,title,text,elements[]}. Interactive elements carry numbered refs (e1,e2,...) usable with tmuxgo_browser_click/type — address elements by ref, not coordinates.',
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string', description: 'Tab target id (default: active tab)' } },
    },
  },
  {
    name: 'tmuxgo_browser_click',
    description:
      'Click an element by its ref from tmuxgo_browser_snapshot (e.g. "e5"). Dispatches real mouse events at the element center.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        targetId: { type: 'string', description: 'Tab target id (default: active tab)' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'tmuxgo_browser_type',
    description: 'Focus an element by ref and insert text (fires real input events, works with controlled inputs).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        targetId: { type: 'string' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'tmuxgo_browser_press',
    description:
      'Press a key on the active tab (Enter, Tab, Escape, Backspace, Delete, Arrow*, Home, End, PageUp, PageDown).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, targetId: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'tmuxgo_browser_scroll',
    description: 'Scroll the page (mouse wheel at viewport center). dy>0 scrolls down.',
    inputSchema: {
      type: 'object',
      properties: {
        dx: { type: 'number' },
        dy: { type: 'number' },
        targetId: { type: 'string' },
      },
    },
  },
  {
    name: 'tmuxgo_browser_screenshot',
    description: 'Capture the active tab as JPEG (base64 in result.jpeg).',
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string' } },
    },
  },
  {
    name: 'tmuxgo_browser_tab',
    description:
      'Manage browser tabs. action=list: show tabs {id,url,title} plus activeTargetId. action=open: open a new tab with url and make it active. action=close/activate: close or make a tab active by targetId (agents read/act on the active tab by default).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'close', 'activate'] },
        url: { type: 'string', description: 'Required when action=open' },
        targetId: { type: 'string', description: 'Required when action=close/activate' },
      },
      required: ['action'],
    },
  },
  {
    name: 'tmuxgo_browser_nav',
    description: 'History navigation on the active/given tab: back | forward | reload.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
        targetId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'tmuxgo_browser_eval',
    description:
      'Evaluate a JS expression in the page (awaitPromise on, result JSON-stringified, capped 64KB). Powerful — prefer snapshot/click/type first.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        targetId: { type: 'string' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'tmuxgo_browser_pick',
    description:
      'Let the user pick an element on the page with the mouse: a highlight box follows the hover, primary click selects, Esc cancels. Blocks until the user acts or timeoutMs elapses; resolves with {selector,ref,tag,text,rect,url,title} or {cancelled:true}. The returned ref works directly with tmuxgo_browser_click/type.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Tab target id (default: active tab)' },
        timeoutMs: { type: 'number', description: 'Max wait for the user, ms (default 60000, max 120000)' },
      },
    },
  },
  {
    name: 'tmuxgo_browser_pick_cancel',
    description:
      'Cancel an in-progress tmuxgo_browser_pick on the active/given tab; the pending pick resolves with {cancelled:true}.',
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string', description: 'Tab target id (default: active tab)' } },
    },
  },
  {
    name: 'tmuxgo_inbox_list',
    description:
      'Query the TmuxGo inbox for pushed messages. Use messageId to confirm a specific push was delivered; without it returns recent messages (metadata only: id, type, title, name, size, mime, createdAt, route, readBy). A non-empty readBy means a user device has opened it — absent readBy means delivered but not yet read.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Fetch a single message by id (404 when gone/expired)' },
        limit: { type: 'number', description: 'Page size 1-200 (default 50)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response (older messages)' },
        sessionName: { type: 'string', description: 'Filter by route sessionName' },
        paneId: { type: 'string', description: 'Filter by route paneId or tmuxPaneId' },
      },
    },
  },
]

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}
function reply(id, result) {
  // 通知（无 id）不产出响应——id undefined 时静默丢弃
  if (id === undefined) return
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

async function callGateway(pathname, body, timeoutMs = 30000) {
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
      // gateway 挂起时 client 侧 MCP 调用也要能超时返回
      signal: AbortSignal.timeout(timeoutMs),
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
  } else if (name.startsWith('tmuxgo_browser_')) {
    // browser 系列统一走 /v1/control/browser 单端点 + op 分发（端点侧有 token+env guard）
    const opMap = {
      tmuxgo_browser_status: 'status',
      tmuxgo_browser_launch: 'launch',
      tmuxgo_browser_navigate: 'navigate',
      tmuxgo_browser_snapshot: 'snapshot',
      tmuxgo_browser_click: 'click',
      tmuxgo_browser_type: 'type',
      tmuxgo_browser_press: 'press',
      tmuxgo_browser_scroll: 'scroll',
      tmuxgo_browser_screenshot: 'screenshot',
      tmuxgo_browser_tab: null, // action 参数映射 op，list→tabs
      tmuxgo_browser_nav: null, // action 参数映射 op
      tmuxgo_browser_eval: 'eval',
      tmuxgo_browser_pick: 'pick',
      tmuxgo_browser_pick_cancel: 'pickCancel',
    }
    const op = opMap[name] ?? (args.action === 'list' ? 'tabs' : args.action)
    if (!op) return toolResult(id, `Unknown tool: ${name}`, true)
    // pick 是长阻塞 op（等用户操作）：client 侧 fetch 超时要按 timeoutMs 放宽，否则会先于 gateway 返回
    const reqTimeout =
      op === 'pick' ? Math.min((Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 60000) + 10000, 130000) : 30000
    result = await callGateway('/v1/control/browser', { op, ...args }, reqTimeout)
  } else if (name === 'tmuxgo_inbox_list') {
    result = await callGateway('/v1/control/inbox', {
      id: typeof args.messageId === 'string' ? args.messageId : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
      sessionName: typeof args.sessionName === 'string' ? args.sessionName : undefined,
      paneId: typeof args.paneId === 'string' ? args.paneId : undefined,
    })
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
    handleMessage(message).catch((err) => {
      // 异步异常不能吞——带 id 的请求必须回 JSON-RPC error，否则 client 挂死
      try {
        if (message && 'id' in message) replyError(message.id, -32603, String(err?.message || err))
      } catch {
        /* best-effort，失败静默 */
      }
    })
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
      // 通知式调用（无 id）按 JSON-RPC 不回结果，直接执行但不产出响应
      if ('id' in message) await handleToolCall(id, params)
      else await handleToolCall(undefined, params).catch(() => {})
      return
    default:
      if ('id' in message) replyError(id, -32601, `Method not found: ${method}`)
  }
}
