---
name: tmuxgo-control
description: 在 TmuxGo pane 内使用控制面：读机队（谁 blocked/done、卡了多久）、给 pane 绑任务号、分屏读屏、事件驱动等待其他 agent、推送 Inbox、驱动内嵌浏览器。当你在 TmuxGo 的 pane 里编排多个 agent、想知道谁需要人介入、或需要按任务号寻址一个 pane 时使用；协议细节见同目录 PROTOCOL.md。
---

# TmuxGo Agent Control

> Status: reference（agent 使用手册）

Give the coding agent the ability to operate the TmuxGo workbench from inside its own pane: split panes, read other panes' output, and wait for other agents to reach a state.

## Guard (read first)

Only use these tools when running inside a TmuxGo pane:

- `TMUXGO_ENV=1` must be set in the environment. If it is not set, you are not inside TmuxGo — do not attempt any control-plane call.
- The gateway URL defaults to `http://127.0.0.1:3001`. If `GATEWAY_URL` is set, derive the base by stripping a trailing `/api/stream`.
- The token comes from `TMUXGO_AGENT_EVENT_TOKEN`; send it as `x-tmuxgo-agent-token`.
- Every request must include header `x-tmuxgo-env: 1`.

## Operations

Base: `${GATEWAY_URL%/}/api/v1/control`

薄客户端 `tmuxgo-ctl`（`apps/cli` 自带 bin）已封装以下操作：stdout 单行 JSON、退出码 0/1/2，适合脚本拼装；直接 curl 亦可，契约见 [PROTOCOL.md](PROTOCOL.md)。`tmuxgo-ctl initialize` 做协议版本协商握手，`tmuxgo-ctl schema` 打印正式 JSON Schema（方法/参数/结果/错误码/版本/安全限制，与 `GET /api/v1/control/schema` 一致）。

```bash
tmuxgo-ctl panes split --pane-id "local:${TMUX_PANE}" --direction horizontal
tmuxgo-ctl panes read --pane-id local:%1 --lines 200
tmuxgo-ctl agent wait --session dev --agent codex --status blocked --timeout-ms 60000
tmuxgo-ctl panes send-keys local:%1 Escape C-c
tmuxgo-ctl agent explain --pane-id local:%1   # 判定链解释：stdout 单行 JSON，摘要走 stderr
```

### Split a pane

```bash
curl -s -X POST "$BASE/panes/split" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"paneId":"'"$TMUX_PANE_HOSTED"'","direction":"horizontal"}'
```

`paneId` is `hostId:tmuxPaneId`. Inside a pane, `TMUX_PANE` gives the tmux pane id; if you know the host (usually `local`), use `local:${TMUX_PANE}`.

### Read a pane

```bash
curl -s -X POST "$BASE/panes/read" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"paneId":"local:%1","lines":200}'
```

### Send keys to a pane

Key names are actions, not text: `Enter` / `Escape` / `BSpace` / `Tab` / `Space` / `Up` / `Down` / `Left` / `Right` / `Home` / `End` / `PPage` / `NPage` / `DC` / `IC` / `F1`-`F12` plus `C-x` / `M-x` / `S-x` (single letter or digit). The whole list is validated before any byte is written, so one bad name fails the request with `INVALID_KEY` and nothing is sent. Use `panes/run` for literal text.

```bash
curl -s -X POST "$BASE/panes/send-keys" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"paneId":"local:%1","keys":["Escape"]}'
```

### Wait for an agent

Block until another agent reaches a condition (server-held, event-driven; no polling loop needed):

```bash
curl -s -X POST "$BASE/agent/wait" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"target":{"sessionName":"dev","agent":"codex"},"condition":{"status":"blocked"},"timeoutMs":60000}'
```

The wait pins the pane occupant: if the pane is reused by a different process before the condition is met, the call fails with `OCCUPANT_CHANGED` — do not treat a replacement process as satisfying the wait. On `TIMEOUT` / `PANE_REMOVED`, re-evaluate and retry if appropriate.

### See the fleet and bind tasks

Before splitting panes or prompting anyone, read the fleet instead of guessing pane ids. `fleet/list` reads the cached monitor projection (no scan triggered) and returns one row per agent pane: task id, semantic status/phase, last event, how long it has been in that state, and `needsHuman`.

```bash
curl -s -X POST "$BASE/fleet/list" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"statuses":["blocked","done"],"selfPaneId":"'"$TMUX_PANE"'"}'
```

Rows are sorted `blocked → failed → done → working → idle`, longest-waiting first — the same order the human Fleet panel shows, so you and the operator agree on who is most urgent. `needsHuman: true` means a human decision is pending: escalate with `push` instead of answering on their behalf.

Bind a task id so work stays addressable across reloads, device switches and handoffs (it is stored on the pane as `@tmuxgo_task`, the same field the UI shows):

```bash
curl -s -X POST "$BASE/panes/task" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"paneId":"local:%3","task":"T-234"}'
```

Send `"task": ""` to clear the binding. Prefer the MCP tools `tmuxgo_fleet_list` and `tmuxgo_task_set` when available; they fill `selfPaneId` from `TMUX_PANE` for you.

## Orchestration playbook

编排不是「多调几个 API」，而是让状态留在 pane 上、让判断来自统一投影。按这个顺序做：

1. **先读机队，别猜 paneId**：`fleet list` 一次拿到谁在跑、绑了什么任务、谁卡住多久。
   排序是 `blocked → failed → done → working → idle`，同档最久优先——第一行就是最该处理的。
2. **认领先落字**：接到活先 `panes task --pane-id <self> --task <id>`。任务号写在 pane 上，
   刷新、换设备、重启 gateway 都还在；不写，等于把编排状态存在自己内存里。
3. **派活再动手**：`panes run`（shell 命令）或 `agent prompt`（已运行的 agent）下发；
   跨 pane 操作前用 `agent explain` 确认 occupant，别把命令打进别人正在跑的 TUI。
4. **等待用事件，不用 sleep**：单 pane 用 `agent wait`；等一批时逐个 wait 再 `fleet list` 复查，
   别用「睡 30 秒再看一眼」——那既慢又会漏掉瞬时状态。
5. **该叫人就叫人**：`needsHuman: true` 表示 blocked/failed，用 `push` 把「卡在哪、要什么决定」
   发给人，不要替人批准权限、也不要替人改需求。
6. **收尾留痕**：done 后把结论推到 Inbox；任务号留着方便追溯，确认验收完再 `--task ""` 解绑。

反模式（都会让编排退回人肉）：

- 抓屏猜状态：`panes read` 拿的是字节，`fleet list` 给的是语义状态 + 判定来源。
- 在提示词里塞 paneId 列表：pane 会关、会重排，任务号才是稳定地址。
- `sleep` 轮询代替 `agent wait`：浪费上下文，且窗口内的状态变化会被吞掉。
- 一个 agent 同时改多个 pane 的同一份文件：先分派任务号，再各自在自己 pane 里做。

## Rules

- Never run these operations outside a TmuxGo environment (guard above).
- Prefer `agent/wait` over shell `sleep` polling — it is event-driven and occupant-pinned.
- Keep `lines` small (≤ 200) when reading panes; output can be large.

## Push content to TmuxGo Inbox (v1)

The push operation uses the same guard and token as the control plane. The gateway injects `TMUXGO_ENV=1`, `TMUXGO_AGENT_EVENT_TOKEN`, `TMUXGO_GATEWAY_URL`, and `TMUXGO_PANE_ID` into agent panes. Do not hard-code or print the token.

```bash
BASE="${TMUXGO_GATEWAY_URL%/}/api/v1/control"
curl -sS -X POST "$BASE/push" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" \
  -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"type":"text","title":"Build result","text":"All tests passed.","route":{"paneId":"'"$TMUXGO_PANE_ID"'"}}'
```

For images, video, or files, use the same endpoint with multipart. v1 supports a single streamed multipart upload (existing file limit: 200 MiB); small payloads may use `contentBase64` up to 32 MiB. A local `path` is accepted only after gateway workspace/realpath and sensitive-path checks. Binary content never goes through the WebSocket.

Push routing priority is `hostId + paneId` → `hostId + tmuxPaneId` → `hostId + sessionName` → the authenticated agent's global inbox. Use `dedupeKey` for retries; a duplicate returns the original message id. See [`agent-inbox-protocol.md`](agent-inbox-protocol.md) for the complete schema, read endpoints, events, limits, and errors.

### Open the pushed item in the UI

The optional `tmuxgo_open_target` MCP tool emits an `inbox_open_target` event. It only asks the frontend to navigate to a validated host/session/pane/message; it does not execute browser actions. A pane can use the ordinary control endpoint to select a pane when direct control is intended.
