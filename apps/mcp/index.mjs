#!/usr/bin/env node
// TmuxGo agent push MCP bridge（stdio JSON-RPC → gateway control-plane REST）。
// 零依赖：pane 内 agent 把它注册为 stdio MCP server 后，工具调用经 HTTP 落到
// /api/v1/control/*。鉴权从环境变量取（TmuxGo 创建 pane 时已注入）：
//   TMUXGO_AGENT_EVENT_TOKEN / TMUXGO_GATEWAY_URL(默认 http://127.0.0.1:3001)
// 无 token 时 tools/list 仍可用，tools/call 返回 isError 提示配置。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

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
    name: 'tmuxgo_control_initialize',
    description: 'Negotiate the TmuxGo control protocol and discover the gateway capabilities.',
    inputSchema: {
      type: 'object',
      properties: { protocolVersion: { type: 'string', minLength: 1, maxLength: 32 } },
    },
  },
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
  // pane 系列 inputSchema 的约束值与 control-protocol.ts 的 zod 定义一一对应
  // （tests/control-schema-contract.test.ts 断言两者相等，改协议侧须同步这里）
  {
    name: 'tmuxgo_pane_snapshot',
    description:
      'Structured non-sensitive snapshot of a tmux pane: command/title/cwd/dead/inMode/size plus a bounded recent-output tail. No env vars or unbounded history.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Host-scoped pane id like local:%3 (required)',
        },
        lines: { type: 'integer', minimum: 1, maximum: 100, description: 'Tail lines 1-100 (default 12)' },
      },
      required: ['paneId'],
    },
  },
  {
    name: 'tmuxgo_pane_wait_output',
    description:
      'Wait for a pane output change or a literal/regex match in its recent output. Server-held, bounded tail window; fails explicably with TIMEOUT, PANE_REMOVED or OCCUPANT_CHANGED.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Host-scoped pane id like local:%3 (required)',
        },
        match: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Literal substring or regex to match (omit = any output change)',
        },
        regex: { type: 'boolean', default: false, description: 'Treat match as a regular expression' },
        lines: { type: 'integer', minimum: 1, maximum: 200, description: 'Tail window 1-200 lines (default 50)' },
        timeoutMs: {
          type: 'integer',
          minimum: 250,
          maximum: 600000,
          description: 'Max wait 250-600000 ms (default 60000)',
        },
      },
      required: ['paneId'],
    },
  },
  {
    name: 'tmuxgo_pane_run',
    description:
      'Type literal text into a validated pane (send-keys literal + optional Enter). Non-shell occupants require allowOccupied:true; control characters are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Host-scoped pane id like local:%3 (required)',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: 'Literal text to send (1-4096 chars, no control codes/newlines)',
        },
        enter: { type: 'boolean', default: true, description: 'Send Enter after text (default true)' },
        allowOccupied: {
          type: 'boolean',
          default: false,
          description: 'Confirm typing into a non-shell occupant',
        },
      },
      required: ['paneId', 'text'],
    },
  },
  {
    name: 'tmuxgo_pane_send_keys',
    description:
      'Send logical key presses (not text) to a validated pane: Enter/Escape/BSpace/Tab/Space/Up/Down/Left/Right/Home/End/PPage/NPage/DC/IC/F1-F12 plus C-x / M-x / S-x. Key names are canonicalized server-side against a closed allowlist and the whole list is validated before any byte is written, so an invalid name fails the request with INVALID_KEY and nothing is sent. Non-shell occupants require allowOccupied:true. Use tmuxgo_pane_run for literal text.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Host-scoped pane id like local:%3 (required)',
        },
        keys: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', minLength: 1, maxLength: 32 },
          description: 'Key names 1-16, e.g. ["Escape"] or ["C-c","Up","Enter"]',
        },
        allowOccupied: {
          type: 'boolean',
          default: false,
          description: 'Confirm sending keys into a non-shell occupant',
        },
      },
      required: ['paneId', 'keys'],
    },
  },
  // agent 编排三件套：body 形状与 control-protocol.ts 的 controlAgent{Start,Prompt}BodySchema /
  // controlWaitBodySchema 一一对应（tests/control-schema-contract.test.ts 断言约束值相等）
  {
    name: 'tmuxgo_agent_start',
    description:
      'Start a coding agent in an existing shell pane (send-keys only; never creates, splits or moves layout). provider=claude|codex, args are single argv tokens checked against the action allowlist. Returns right after sending unless ackTimeoutMs is set, in which case it waits for the agent event ack and fails explicably with ACK_TIMEOUT / PANE_OCCUPIED / PANE_NOT_AGENT.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Host-scoped pane id like local:%3 (required)',
        },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Agent CLI to start (required)' },
        args: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', pattern: '^-{0,2}[A-Za-z0-9][A-Za-z0-9._:/=-]{0,126}$' },
          description: 'Single argv tokens, e.g. ["--resume","<id>"]; pattern-checked server-side (max 8)',
        },
        ackTimeoutMs: {
          type: 'integer',
          minimum: 250,
          maximum: 30000,
          description: 'Wait for the agent event ack instead of returning immediately (250-30000 ms)',
        },
        opId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$',
          description: 'Idempotency key for the ack wait; POST it to /v1/control/agent/cancel to cancel',
        },
      },
      required: ['paneId', 'provider'],
    },
  },
  {
    name: 'tmuxgo_agent_prompt',
    description:
      'Send a prompt to the agent occupying a pane. Same send-then-optional-ack contract as tmuxgo_agent_start; the prompt body is never written to the audit log. Use ackTimeoutMs to wait for the agent to acknowledge before returning.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: {
          type: 'string',
          minLength: 3,
          maxLength: 256,
          description: 'Host-scoped pane id like local:%3 (required)',
        },
        prompt: { type: 'string', minLength: 1, maxLength: 8192, description: 'Prompt text (1-8192 chars)' },
        ackTimeoutMs: {
          type: 'integer',
          minimum: 250,
          maximum: 30000,
          description: 'Wait for the agent event ack instead of returning immediately (250-30000 ms)',
        },
        opId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$',
          description: 'Idempotency key for the ack wait; POST it to /v1/control/agent/cancel to cancel',
        },
      },
      required: ['paneId', 'prompt'],
    },
  },
  {
    name: 'tmuxgo_agent_wait',
    description:
      'Long-blocking: wait until the agent in a pane (or the named agent of a session) reaches a status/phase/lastEvent condition. Server-held, bounded by timeoutMs (250-600000 ms, default 60000); fails explicably with TIMEOUT, OCCUPANT_CHANGED, PANE_REMOVED or INVALID_TARGET. Returns waitId, elapsedMs and the settled pane.',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', minLength: 1, maxLength: 128, description: 'Host id (default local)' },
        target: {
          description: 'Either {paneId} or {sessionName, agent}',
          anyOf: [
            {
              type: 'object',
              properties: {
                paneId: {
                  type: 'string',
                  minLength: 3,
                  maxLength: 256,
                  description: 'Host-scoped pane id like local:%3',
                },
              },
              required: ['paneId'],
            },
            {
              type: 'object',
              properties: {
                sessionName: { type: 'string', minLength: 1, maxLength: 64 },
                agent: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['sessionName', 'agent'],
            },
          ],
        },
        condition: {
          type: 'object',
          description: 'At least one of status/phase/lastEvent',
          properties: {
            status: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'unknown'] },
            phase: {
              type: 'string',
              enum: [
                'idle',
                'working',
                'needs_input',
                'permission_required',
                'retrying',
                'failed',
                'ended',
                'disconnected',
                'unknown',
              ],
            },
            lastEvent: {
              type: 'string',
              enum: [
                'started',
                'permission_required',
                'question_required',
                'completed',
                'failed',
                'retrying',
                'ended',
                'disconnected',
                'reconnected',
              ],
            },
          },
          anyOf: [{ required: ['status'] }, { required: ['phase'] }, { required: ['lastEvent'] }],
        },
        timeoutMs: {
          type: 'integer',
          minimum: 250,
          maximum: 600000,
          description: 'Max wait 250-600000 ms (default 60000)',
        },
      },
      required: ['target', 'condition'],
    },
  },
  {
    name: 'tmuxgo_control_schema',
    description:
      'Fetch the TmuxGo agent control protocol JSON Schema (versioned methods/params/results/error codes/security limits) from the gateway. Read-only; use it to validate or generate client requests.',
    inputSchema: { type: 'object', properties: {} },
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
// TMUX_PANE 缺失时的兜底：codex 走共享 app-server 时，MCP 子进程从 detached daemon
// 派生，进程树里断了 TMUX_PANE/tty 继承链；但它会注入 CODEX_THREAD_ID，该 thread 的标题
// 存在 session_index.jsonl，TUI 把标题写成 "<thread_name> | <workspace>" 塞进 pane_title。
// 据此反查不碰 cwd，所以同一目录开多个 codex 也不会误判；命中不唯一一律放弃。
function resolvePaneId() {
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE
  try {
    const tid = process.env.CODEX_THREAD_ID
    if (!tid) return ''
    const home = process.env.CODEX_HOME?.trim() || `${process.env.HOME}/.codex`
    const raw = readFileSync(`${home}/session_index.jsonl`, 'utf8')
    const line = raw.split('\n').find((l) => l.includes(tid))
    const name = line ? JSON.parse(line).thread_name : ''
    if (!name) return ''
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_title}'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const hit = out.split('\n').filter((l) => l.includes(name))
    return hit.length === 1 ? hit[0].split(' ')[0] : ''
  } catch {
    return ''
  }
}

function defaultRoute(args) {
  const route = {}
  if (typeof args.hostId === 'string') route.hostId = args.hostId
  if (typeof args.sessionName === 'string') route.sessionName = args.sessionName
  // pane 内运行时 tmux 自带 TMUX_PANE=%n，自动归属当前 pane
  const pane = args.tmuxPaneId || resolvePaneId()
  if (pane) route.tmuxPaneId = pane
  return route
}

// agent/start|prompt 的 ack 等待上限是 30s（control-protocol actionAckTimeout）：
// client fetch 比服务端晚放弃，才不会把「在等 ack」变成 transport error
function actionAckBudget(ackTimeoutMs) {
  const ack = Number(ackTimeoutMs) > 0 ? Number(ackTimeoutMs) : 30000
  return Math.min(ack + 10000, 40000)
}
// agent/wait 的 target 是 union：只透传合法形状，避免把无关字段送进协议校验
function normalizeWaitTarget(target) {
  if (!target || typeof target !== 'object') return null
  if (typeof target.paneId === 'string' && target.paneId) return { paneId: target.paneId }
  if (typeof target.sessionName === 'string' && target.sessionName && typeof target.agent === 'string' && target.agent)
    return { sessionName: target.sessionName, agent: target.agent }
  return null
}
// condition 的服务端 refine 要求至少一个键命中；这里先挑出已知键，其余一律丢弃
function normalizeWaitCondition(condition) {
  if (!condition || typeof condition !== 'object') return null
  const picked = {}
  for (const key of ['status', 'phase', 'lastEvent']) {
    if (typeof condition[key] === 'string' && condition[key]) picked[key] = condition[key]
  }
  return Object.keys(picked).length ? picked : null
}

async function callGateway(pathname, body, timeoutMs = 30000, method = 'POST') {
  if (!TOKEN) {
    return {
      ok: false,
      status: 0,
      body: 'TMUXGO_AGENT_EVENT_TOKEN is not set. Run this MCP server inside a TmuxGo pane (TMUXGO_ENV=1), or configure the token manually.',
    }
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/api${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-tmuxgo-env': '1',
        'x-tmuxgo-agent-token': TOKEN,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      // gateway 挂起时 client 侧 MCP 调用也要能超时返回
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
    // 只透传正式 envelope 的 code/message，避免把请求正文、token 或终端输出
    // 拼进 MCP 错误；成功响应仍完整返回给调用方。
    if (!res.ok && payload && typeof payload === 'object') {
      payload = {
        ok: false,
        code: typeof payload.code === 'string' ? payload.code : `HTTP_${res.status}`,
        message: typeof payload.message === 'string' ? payload.message : `HTTP ${res.status}`,
      }
    }
    return { ok: res.ok, status: res.status, body: payload }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: `Gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments || {}
  const route = defaultRoute(args)
  let result
  if (name === 'tmuxgo_control_initialize') {
    result = await callGateway(
      '/v1/control/initialize',
      {
        protocolVersion: typeof args.protocolVersion === 'string' ? args.protocolVersion : 'v1',
      },
      10000,
    )
  } else if (name === 'tmuxgo_push_text') {
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
  } else if (name === 'tmuxgo_pane_snapshot') {
    if (typeof args.paneId !== 'string' || !args.paneId) return toolResult(id, 'paneId is required', true)
    result = await callGateway('/v1/control/panes/snapshot', {
      paneId: args.paneId,
      lines: typeof args.lines === 'number' ? args.lines : undefined,
    })
  } else if (name === 'tmuxgo_pane_wait_output') {
    if (typeof args.paneId !== 'string' || !args.paneId) return toolResult(id, 'paneId is required', true)
    // 服务端挂起最长 600s：client fetch 超时按 timeoutMs + 10s 放宽
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 60000
    result = await callGateway(
      '/v1/control/panes/wait-output',
      {
        paneId: args.paneId,
        match: typeof args.match === 'string' && args.match ? args.match : undefined,
        regex: args.regex === true ? true : undefined,
        lines: typeof args.lines === 'number' ? args.lines : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      },
      Math.min(timeoutMs + 10000, 610000),
    )
  } else if (name === 'tmuxgo_pane_run') {
    if (typeof args.paneId !== 'string' || !args.paneId) return toolResult(id, 'paneId is required', true)
    if (typeof args.text !== 'string' || !args.text) return toolResult(id, 'text is required', true)
    result = await callGateway('/v1/control/panes/run', {
      paneId: args.paneId,
      text: args.text,
      enter: args.enter !== false,
      allowOccupied: args.allowOccupied === true ? true : undefined,
    })
  } else if (name === 'tmuxgo_pane_send_keys') {
    if (typeof args.paneId !== 'string' || !args.paneId) return toolResult(id, 'paneId is required', true)
    if (!Array.isArray(args.keys) || !args.keys.length) return toolResult(id, 'keys must be a non-empty array', true)
    result = await callGateway('/v1/control/panes/send-keys', {
      paneId: args.paneId,
      keys: args.keys,
      allowOccupied: args.allowOccupied === true ? true : undefined,
    })
  } else if (name === 'tmuxgo_agent_start' || name === 'tmuxgo_agent_prompt') {
    const isStart = name === 'tmuxgo_agent_start'
    if (typeof args.paneId !== 'string' || !args.paneId) return toolResult(id, 'paneId is required', true)
    // provider 在 MCP 侧先挡一层：enum 之外的值得不到可解释的服务端错误，只会得到 400 INVALID_ARGUMENT
    if (isStart && args.provider !== 'claude' && args.provider !== 'codex')
      return toolResult(id, 'provider must be "claude" or "codex"', true)
    if (!isStart && (typeof args.prompt !== 'string' || !args.prompt)) return toolResult(id, 'prompt is required', true)
    const body = isStart
      ? {
          paneId: args.paneId,
          provider: args.provider,
          args: Array.isArray(args.args) && args.args.length ? args.args : undefined,
          ackTimeoutMs: typeof args.ackTimeoutMs === 'number' ? args.ackTimeoutMs : undefined,
          opId: typeof args.opId === 'string' && args.opId ? args.opId : undefined,
        }
      : {
          paneId: args.paneId,
          prompt: args.prompt,
          ackTimeoutMs: typeof args.ackTimeoutMs === 'number' ? args.ackTimeoutMs : undefined,
          opId: typeof args.opId === 'string' && args.opId ? args.opId : undefined,
        }
    // 设了 ackTimeoutMs 时服务端最多挂起 30s 等 ack：client fetch 超时按 ack + 10s 放宽，
    // 否则会先于 gateway 返回，把「在等 ack」误报成网络失败
    result = await callGateway(
      isStart ? '/v1/control/agent/start' : '/v1/control/agent/prompt',
      body,
      actionAckBudget(args.ackTimeoutMs),
    )
  } else if (name === 'tmuxgo_agent_wait') {
    const target = normalizeWaitTarget(args.target)
    if (!target) return toolResult(id, 'target must be {paneId} or {sessionName, agent}', true)
    const condition = normalizeWaitCondition(args.condition)
    if (!condition) return toolResult(id, 'condition needs at least one of status/phase/lastEvent', true)
    // 服务端挂起最长 600s：client fetch 超时按 timeoutMs + 10s 放宽（与 pane_wait_output 同策略）
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 60000
    result = await callGateway(
      '/v1/control/agent/wait',
      {
        hostId: typeof args.hostId === 'string' && args.hostId ? args.hostId : undefined,
        target,
        condition,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      },
      Math.min(timeoutMs + 10000, 610000),
    )
  } else if (name === 'tmuxgo_control_schema') {
    result = await callGateway('/v1/control/schema', undefined, 10000, 'GET')
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
  if (!result.ok)
    return toolResult(
      id,
      `TmuxGo control request failed (${result.status}): ${typeof result.body === 'string' ? result.body : JSON.stringify(result.body)}`,
      true,
    )
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
