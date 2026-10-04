# TmuxGo Agent Control Plane (v1)

> Status: implemented

Versioned HTTP protocol that lets an AI coding agent operating inside a TmuxGo pane drive the workbench itself — split panes, read pane output, and wait for other agents to reach a state.

Also defines the display-metadata patch protocol for `/api/agent-events`: semantic state (status/phase) is kept separate from display-only metadata (title / state_label / tokens), which carries a `seq` for ordering and a `ttl_ms` for expiry — the UI consumes only display fields.

## Contract stability

- 协议版本：`v1`（base path `/api/v1/control`）。实现侧单一事实源是 `apps/gateway/src/lib/control-protocol.ts` 的 zod schema；对外正式 JSON Schema 由 `apps/gateway/src/lib/control-schema.ts` 从这些 zod 定义生成（同一事实源，非第二套请求模型）。
- 请求 envelope：每个端点的 body 是 JSON object；**未知字段被服务端剥离忽略**——client 端新增可选字段向后兼容，旧 client 不受新增字段影响。破坏性变更（改字段语义、删字段、改 code 值）必须 bump 版本并更新本文档。
- 成功响应：`{ "ok": true, ... }`（agent/wait 为 `{ ok, waitId, elapsedMs, pane }`）。
- 错误响应：非 2xx + `{ "ok": false|"undefined", "message": string, "code": string }`——`code` 是契约（见下表），`message` 仅供人读、不得依赖。
- 响应带 `cache-control: no-store`。

### Version negotiation

`POST /v1/control/initialize` 是握手端点：client 可声明 `protocolVersion`，gateway 返回协商结果 `{ ok, protocolVersion, supportedVersions, capabilities }`。

| client `protocolVersion` | gateway 行为                                                   |
| ------------------------ | -------------------------------------------------------------- |
| 缺省（旧客户端）         | 200，按当前默认版本 `v1` 应答                                  |
| `v1`                     | 200，协商为 `v1`                                               |
| 其他值                   | 400 `UNSUPPORTED_PROTOCOL_VERSION`，响应附 `supportedVersions` |

capability = 方法名（`initialize`/`schema`/`panes.*`/`agent.*`）。旧 client 不调用 initialize 也不受影响——协商是可选握手，其余端点行为不变。

### JSON Schema export

正式 versioned JSON Schema（draft 2020-12，覆盖 method/params/result/错误码/版本/安全限制）三个等价入口：

- `GET /api/v1/control/schema`（同双守卫，只读）
- `tmuxgo-ctl schema`（stdout 单行 JSON）
- 静态文件 `docs/agent-control/control-protocol.v1.schema.json`（`npx tsx scripts/generate-control-schema.ts` 重新生成；contract 测试断言三者一致）

文档不含 token 值、环境变量名与终端输出样例；`security.headers` 只描述头部名称与来源。

### Error codes

| HTTP | code                                                                                                                                                                                         | 含义                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 401  | `AGENT_CONTROL_AUTH_REQUIRED`                                                                                                                                                                | 缺少/错误 agent token                                                                                                |
| 403  | `TMUXGO_ENV_GUARD`                                                                                                                                                                           | 缺少 `x-tmuxgo-env: 1` 守卫头                                                                                        |
| 400  | `AGENT_CONTROL_SPLIT_FAILED` / `AGENT_CONTROL_READ_FAILED` / `AGENT_CONTROL_WAIT_FAILED` / `AGENT_CONTROL_SNAPSHOT_FAILED` / `AGENT_CONTROL_WAIT_OUTPUT_FAILED` / `AGENT_CONTROL_RUN_FAILED` | body zod 校验失败或下游执行失败（message 含原因）                                                                    |
| 400  | `INVALID_INPUT`                                                                                                                                                                              | `panes/run` 文本含控制字符/换行或超 4096 字符                                                                        |
| 400  | `INVALID_PATTERN`                                                                                                                                                                            | `panes/wait-output` 的 `regex:true` 正则不合法                                                                       |
| 409  | `OCCUPANT_CHANGED`                                                                                                                                                                           | wait 钉住的 pane 占用者（agent+agentSessionId 或 pane_current_command）在条件满足前变更——替换进程不得满足等待        |
| 409  | `PANE_REMOVED`                                                                                                                                                                               | 目标 pane 在等待期间被移除                                                                                           |
| 409  | `TIMEOUT`                                                                                                                                                                                    | `timeoutMs` 到期（默认 60s，范围 250ms–600s）                                                                        |
| 409  | `INVALID_TARGET`                                                                                                                                                                             | target paneId/sessionName+agent 解析失败                                                                             |
| 409  | `PANE_MISSING` / `PANE_DEAD` / `PANE_IN_MODE` / `PANE_OCCUPIED`                                                                                                                              | pane 请求时状态不可执行：不存在/已 dead/处于 tmux mode/被非 shell 进程占用（`run` 需 `allowOccupied:true` 显式确认） |
| 409  | `PANE_NOT_AGENT`                                                                                                                                                                             | `agent/prompt` 目标 pane 未登记为 agent 占用（含 scan 无 agent、`start` 非 idle-shell 前置）                         |
| 409  | `PANE_UNKNOWN`                                                                                                                                                                               | pane 状态探测失败（host 不可达等），语义未知一律拒绝                                                                 |
| 409  | `ACK_TIMEOUT`                                                                                                                                                                                | `ackTimeoutMs` 到期未观察到确认（agent 未出现 / 状态未变化）                                                         |
| 409  | `OPERATION_CANCELLED`                                                                                                                                                                        | ack 等待中的 op 被 `agent/cancel` 取消，原 start/prompt 请求以此错误返回                                             |
| 429  | `AGENT_CONTROL_QUOTA_EXCEEDED`                                                                                                                                                               | 同 host 在途 start/prompt op 超过 8                                                                                  |
| 400  | `INVALID_ARGUMENT`                                                                                                                                                                           | `args` 含 shell 元字符/超限、`prompt` 含控制字符、opId 非法或与在途/已结算 id 冲突                                   |
| 400  | `PROVIDER_NOT_SUPPORTED`                                                                                                                                                                     | `provider` 不在 allowlist（仅 `claude`/`codex`）                                                                     |
| 400  | `AGENT_CONTROL_SEND_FAILED`                                                                                                                                                                  | `send-keys` 下发失败（tmux 错误透传于 message）                                                                      |
| 400  | `AGENT_CONTROL_START_FAILED` / `AGENT_CONTROL_PROMPT_FAILED` / `AGENT_CONTROL_CANCEL_FAILED`                                                                                                 | 对应端点 body zod 校验失败或未归类下游失败                                                                           |
| 400  | `AGENT_CONTROL_INITIALIZE_FAILED`                                                                                                                                                            | `initialize` body zod 校验失败（如 protocolVersion 非字符串）                                                        |
| 400  | `UNSUPPORTED_PROTOCOL_VERSION`                                                                                                                                                               | `initialize` 声明了不在支持列表的协议版本（响应附 `supportedVersions`）                                              |

## Guard

- The gateway only accepts control requests when the pane env has `TMUXGO_ENV=1` (injected at session/pane creation) and the request carries `x-tmuxgo-env: 1`. client 侧薄客户端同样要求环境变量 `TMUXGO_ENV=1`，否则拒绝发起调用。
- Auth: `x-tmuxgo-agent-token` or `Authorization: Bearer <token>`, same token as `/api/agent-events` (`TMUXGO_AGENT_EVENT_TOKEN`).

## Endpoints

Base path: `/api/v1/control`

### POST /initialize

协议握手（可选）：版本协商 + capability 发现。Body:

```json
{ "protocolVersion": "v1" }
```

Response: `{ "ok": true, "protocolVersion": "v1", "supportedVersions": ["v1"], "capabilities": [...] }`

- `protocolVersion` 可省略（旧客户端按默认版本兼容）；未知版本 → 400 `UNSUPPORTED_PROTOCOL_VERSION` + `supportedVersions`。
- 不影响其他端点：不握手直接调用其余端点行为不变。

### GET /schema

只读导出正式 JSON Schema 文档（同双守卫）。Response 见「JSON Schema export」一节。

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

### POST /panes/snapshot

Structured non-sensitive pane state. Body:

```json
{ "paneId": "local:%0", "lines": 12 }
```

- `lines`: tail 行数 1-100（默认 12）。

Response: `{ "ok": true, "paneId": "local:%0", "snapshot": { ... } }`

`snapshot` 字段：`paneId`/`tmuxPaneId`/`sessionName`/`windowIndex`/`paneIndex`/`command`（≤120 字符）/`title`（≤160，单行化）/`cwd`（≤512）/`dead`/`inMode`/`active`/`size {cols,rows}`/`tail[]`（每行 ≤200 字符，整体 ≤8KiB）。**不返回环境变量、token 或无界历史**——tail 只取 pane 当前可见末尾 N 行。

### POST /panes/wait-output

Server-held wait for pane output. Body:

```json
{ "paneId": "local:%0", "match": "build complete", "regex": false, "lines": 50, "timeoutMs": 60000 }
```

- `match` 缺省：等待 tail 相对请求基线的任意变化。
- `match` + `regex:false`（默认）：字面 substring；`regex:true`：JS 正则（≤512 字符，非法 pattern → 400 `INVALID_PATTERN`）。基线已含匹配立即返回 `elapsedMs:0`。
- `lines`: 轮询 tail 窗口 1-200 行（默认 50）；`timeoutMs` 250ms-600s（默认 60s）。
- 服务端持有 + 固定间隔轮询（约 300ms），无无限等待、无无界缓冲。

Semantics:

- 等待期间 pane 消失 → 409 `PANE_REMOVED`；基线即不存在/已 dead → `PANE_MISSING`/`PANE_DEAD`。
- `pane_current_command` 相对基线变更或 pane dead → 409 `OCCUPANT_CHANGED`（替代进程不得满足等待）；match 判定先于 occupant 判定，先到的匹配仍算成功。

Response on success: `{ "ok": true, "waitId": "...", "elapsedMs": 123, "matched": true|false, "changed": true|false, "output": "<capped tail>" }`

### POST /panes/run

Type literal text into a pane. Body:

```json
{ "paneId": "local:%0", "text": "make test", "enter": true, "allowOccupied": false }
```

- `text`: 1-4096 可打印字符（允许 tab）；**拒绝 \n/\r/控制字符/转义序列**——违规 → 400 `INVALID_INPUT`，按键不发生。
- `enter`（默认 true）：文本后以独立 `send-keys Enter` 回车；`false` 只送字面文本。
- 文本经 `send-keys -l` 字面模式 + 坐标 target 下发（杜绝 key-name 解析与 shell 注入）；**gateway 侧零 shell 拼接，无 kill-server/kill-session/任意 host shell**。
- occupant 非 shell（运行中程序）→ 409 `PANE_OCCUPIED`，需 `allowOccupied:true` 显式确认（往运行中程序打字=知情操作）；`PANE_MISSING`/`PANE_DEAD`/`PANE_IN_MODE` 同理 409。
- Response: `{ "ok": true, "paneId": "local:%0", "target": "dev:0.1" }`

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

### POST /agent/start

在指定 pane 启动 allowlist provider（`claude` / `codex`）。Body:

```json
{
  "paneId": "local:%2",
  "provider": "claude",
  "args": ["--resume", "abc-123"],
  "ackTimeoutMs": 30000,
  "opId": "client-key-1"
}
```

- `provider`：仅 `claude` / `codex`（zod enum 拒绝其他 → 400 `AGENT_CONTROL_START_FAILED`；lib 层 allowlist 兜底 → 400 `PROVIDER_NOT_SUPPORTED`）。
- `args`（可选，≤8 项）：逐项白名单校验 `^-{0,2}[A-Za-z0-9][A-Za-z0-9._:/=-]{0,126}$`——空格、`$` `;` `|` `&` 反引号、换行一律拒绝。启动命令只允许 `provider + args` 拼成的单条命令，经 `send-keys -l` 字面量入 pane + 独立 `Enter`；**无任意 shell 拼接面**。
- pane 前置：必须是存活 idle shell（五态探测：missing/dead/in_mode/occupied(shell 以外)/unknown 全拒，409 语义码）。
- `ackTimeoutMs`（可选，250–30000）：缺省即发即返 `{ok,opId,acked:false}`；提供时等 agent 出现在 pane 状态列表（= started）再返 `{ok,opId,acked:true,pane}`，超时 → 409 `ACK_TIMEOUT`。
- `opId`（可选）：客户端幂等键 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`，缺省服务端生成 UUID。ack 等待期间响应未返回，客户端凭已知 opId 仍可 `agent/cancel`；与在途/已结算 opId 冲突 → 400 `INVALID_ARGUMENT`。

### POST /agent/prompt

向 agent 占用中的 pane 发送提示词。Body:

```json
{ "paneId": "local:%1", "prompt": "refactor the parser", "ackTimeoutMs": 10000 }
```

- `prompt`：1–8192 字节，允许 `\n` `\t`；其他控制字符/NUL → 400 `INVALID_ARGUMENT`。经 `send-keys -l` 字面量 + 独立 `Enter`，无 shell 解释。
- pane 前置：占用中且 agent scan 登记为 agent，否则 409 `PANE_NOT_AGENT`（missing/dead/in_mode/unknown 同 start）。
- `ackTimeoutMs`：ack = pane 状态变化（stateSeq/revision）或进入 `working`；超时 → 409 `ACK_TIMEOUT`。
- **prompt 正文永不进审计日志**（audit 只记 action/paneId/结果码）。

### POST /agent/cancel

取消本任务引入的、ack 等待中的 `agent/start` / `agent/prompt` op（**不触碰 agent/wait 等待**）。Body:

```json
{ "opId": "client-key-1" }
```

- 幂等语义（永远 200）：`{ok,opId,state}`，`state` ∈ `cancelled`（在途已取消，原请求将以 409 `OPERATION_CANCELLED` 返回）/ `already_settled`（已完成或已被取消）/ `not_found`（未知 opId）。重复 cancel 安全。
- 取消同时释放该 host 的在途配额。

### Quota / Audit

- 每 host 在途（pending ack）start/prompt 上界为 **8**；超限 → 429 `AGENT_CONTROL_QUOTA_EXCEEDED`。配额在 ack 成功、ACK_TIMEOUT、发送失败、cancel 时释放（ack 等待上限 30s，防慢确认堆积打满控制面）。
- 三个动作均写审计 NDJSON（action=`agent.start`/`agent.prompt`/`agent.cancel` + paneId/opId + provider/结果码 + actor/source）；**prompt 正文、token、完整命令串不落盘**。
- 协议版本仍为 `v1`：新增端点与错误码是兼容追加，未知字段剥离规则不变。

## Thin client: `tmuxgo-ctl`

随 `apps/cli` 一起发布的零依赖薄客户端（`bin/tmuxgo-ctl.mjs`），覆盖 initialize/schema/panes split·read·snapshot·wait-output·run/agent wait（MCP bridge 暴露 `tmuxgo_pane_snapshot`/`tmuxgo_pane_wait_output`/`tmuxgo_pane_run`/`tmuxgo_control_schema` 同名语义工具）：

```bash
tmuxgo-ctl initialize                 # 握手：协商协议版本（旧 gateway 退回 /health 探测）
tmuxgo-ctl schema                     # 打印协议 JSON Schema（单行 JSON）
tmuxgo-ctl panes split --pane-id local:%0 --direction horizontal
tmuxgo-ctl panes read --pane-id local:%0 --lines 200
tmuxgo-ctl panes snapshot --pane-id local:%0 --lines 20
tmuxgo-ctl panes wait-output --pane-id local:%0 --match 'build complete' --timeout-ms 120000
tmuxgo-ctl panes run --pane-id local:%0 --text 'make test'   # [--no-enter] [--allow-occupied]
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
