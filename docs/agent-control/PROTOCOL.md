# TmuxGo Agent Control Plane (v1)

> Status: implemented

Versioned HTTP protocol that lets an AI coding agent operating inside a TmuxGo pane drive the workbench itself — split panes, read pane output, and wait for other agents to reach a state.

Also defines the display-metadata patch protocol for `/api/agent-events`: semantic state (status/phase) is kept separate from display-only metadata (title / state_label / tokens), which carries a `seq` for ordering and a `ttl_ms` for expiry — the UI consumes only display fields.

## Contract stability

- 协议版本：`v1`（base path `/api/v1/control`）。实现侧单一事实源是 `apps/gateway/src/lib/control-protocol.ts` 的 zod schema。
- 请求 envelope：每个端点的 body 是 JSON object；**未知字段被服务端剥离忽略**——client 端新增可选字段向后兼容，旧 client 不受新增字段影响。破坏性变更（改字段语义、删字段、改 code 值）必须 bump 版本并更新本文档。
- 成功响应：`{ "ok": true, ... }`（agent/wait 为 `{ ok, waitId, elapsedMs, pane }`）。
- 错误响应：非 2xx + `{ "ok": false|"undefined", "message": string, "code": string }`——`code` 是契约（见下表），`message` 仅供人读、不得依赖。
- 响应带 `cache-control: no-store`。

### Error codes

| HTTP | code                                                                                     | 含义                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 401  | `AGENT_CONTROL_AUTH_REQUIRED`                                                            | 缺少/错误 agent token                                                                 |
| 403  | `TMUXGO_ENV_GUARD`                                                                       | 缺少 `x-tmuxgo-env: 1` 守卫头                                                         |
| 400  | `AGENT_CONTROL_SPLIT_FAILED` / `AGENT_CONTROL_READ_FAILED` / `AGENT_CONTROL_WAIT_FAILED` | body zod 校验失败或下游执行失败（message 含原因）                                     |
| 409  | `OCCUPANT_CHANGED`                                                                       | wait 钉住的 pane 占用者（agent+agentSessionId）在条件满足前变更——替换进程不得满足等待 |
| 409  | `PANE_REMOVED`                                                                           | 目标 pane 在等待期间被移除                                                            |
| 409  | `TIMEOUT`                                                                                | `timeoutMs` 到期（默认 60s，范围 250ms–600s）                                         |
| 409  | `INVALID_TARGET`                                                                         | target paneId/sessionName+agent 解析失败                                              |

## Guard

- The gateway only accepts control requests when the pane env has `TMUXGO_ENV=1` (injected at session/pane creation) and the request carries `x-tmuxgo-env: 1`. client 侧薄客户端同样要求环境变量 `TMUXGO_ENV=1`，否则拒绝发起调用。
- Auth: `x-tmuxgo-agent-token` or `Authorization: Bearer <token>`, same token as `/api/agent-events` (`TMUXGO_AGENT_EVENT_TOKEN`).

## Endpoints

Base path: `/api/v1/control`

### POST /panes/split

Split a pane. Body:

```json
{ "paneId": "local:%0", "direction": "horizontal", "cwd": "~/project" }
```

- `direction`: `horizontal` (left/right) or `vertical` (top/bottom).
- `cwd` optional; restricted to `[A-Za-z0-9_./~-]`.

Response: `{ "ok": true, "paneId": "local:%3" }`

### POST /panes/read

Read pane output (capture-pane). Body:

```json
{ "paneId": "local:%0", "lines": 200 }
```

Response: `{ "ok": true, "paneId": "local:%0", "output": "..." }`

### POST /agent/wait

Server-held, event-driven wait for an agent pane to reach a condition. Body:

```json
{
  "target": { "paneId": "local:%1" },
  "condition": { "status": "blocked" },
  "timeoutMs": 60000
}
```

Target may be `{ paneId }` or `{ sessionName, agent }`. Condition supports `status` (`idle|working|blocked|done|unknown`), `phase`, `lastEvent`; at least one is required.

Semantics:

- The wait is held by the gateway and resolved by agent status events — no polling.
- The current pane occupant (`agent` + `agentSessionId`) is pinned when the wait starts. If the occupant changes before the condition is met (the pane was reused by another process), the wait fails with `OCCUPANT_CHANGED` so a replacement process cannot satisfy it.
- If the target pane is removed, the wait fails with `PANE_REMOVED`.
- Timeout (default 60s, max 600s) fails with `TIMEOUT`.

Response on success: `{ "ok": true, "waitId": "...", "elapsedMs": 123, "pane": { ...AgentPaneState } }`

Errors: HTTP 409 with `code` in `OCCUPANT_CHANGED | PANE_REMOVED | TIMEOUT | INVALID_TARGET`.

## Thin client: `tmuxgo-ctl`

随 `apps/cli` 一起发布的零依赖薄客户端（`bin/tmuxgo-ctl.mjs`），覆盖 initialize/panes split/panes read/agent wait：

```bash
tmuxgo-ctl initialize                 # 握手：探测 gateway /health + 上报本地 env
tmuxgo-ctl panes split --pane-id local:%0 --direction horizontal
tmuxgo-ctl panes read --pane-id local:%0 --lines 200
tmuxgo-ctl agent wait --session dev --agent codex --status blocked --timeout-ms 60000
```

契约（对脚本/第三方调用方稳定）：

- stdout 每命令恰好一行 JSON：成功 `{ok:true,...}`；远端/协议错误 `{ok:false,code,message}`（gateway error envelope 原样透出；gateway 不可达为 `GATEWAY_UNREACHABLE`）。诊断一律走 stderr。
- 退出码：`0` 成功，`1` 远端/协议错误（stdout 有错误 envelope），`2` 本地用法/环境错误（stderr）。
- 环境：`TMUXGO_ENV=1` 与 `TMUXGO_AGENT_EVENT_TOKEN` 必须（help 除外）；`TMUXGO_GATEWAY_URL` 默认 `http://127.0.0.1:3001`（结尾 `/api/stream` 自动剥离）。`agent wait` 的 client fetch 超时按 `timeoutMs + 10s` 放宽。

## Display metadata patches

Agent events sent to `/api/agent-events` (or the agent WebSocket `agent-event` message) may carry a `display` object alongside the semantic event. It is display-only metadata that does not affect wait/notification/attention semantics:

```json
{
  "type": "working",
  "display": { "title": "Refactor parser", "stateLabel": "Working · 2/5", "tokens": 1240, "seq": 3, "ttlMs": 45000 }
}
```

- `title` / `stateLabel`: short display strings (truncated to 160 chars).
- `tokens`: non-negative token count shown in the UI.
- `seq`: monotonic sequence for ordering; a patch with `seq <=` the current one is ignored (out-of-order protection).
- `ttlMs`: time-to-live in ms after which the display metadata expires and the UI drops it (default 60s).
- Flat aliases are also accepted: `displayTitle`, `display_title`, `stateLabel`, `state_label`, `tokens`, `displaySeq`, `display_seq`, `displayTtlMs`, `display_ttl_ms`.
