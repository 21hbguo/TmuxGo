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

### Wait for an agent

Block until another agent reaches a condition (server-held, event-driven; no polling loop needed):

```bash
curl -s -X POST "$BASE/agent/wait" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" -H "x-tmuxgo-env: 1" \
  -H "Content-Type: application/json" \
  -d '{"target":{"sessionName":"dev","agent":"codex"},"condition":{"status":"blocked"},"timeoutMs":60000}'
```

The wait pins the pane occupant: if the pane is reused by a different process before the condition is met, the call fails with `OCCUPANT_CHANGED` — do not treat a replacement process as satisfying the wait. On `TIMEOUT` / `PANE_REMOVED`, re-evaluate and retry if appropriate.

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

Push routing priority is `hostId + paneId` → `hostId + tmuxPaneId` → `hostId + sessionName` → the authenticated agent's global inbox. Use `dedupeKey` for retries; a duplicate returns the original message id. See [`docs/agent-inbox/PROTOCOL.md`](../agent-inbox/PROTOCOL.md) for the complete schema, read endpoints, events, limits, and errors.

### Open the pushed item in the UI

The optional `tmuxgo_open_target` MCP tool emits an `inbox_open_target` event. It only asks the frontend to navigate to a validated host/session/pane/message; it does not execute browser actions. A pane can use the ordinary control endpoint to select a pane when direct control is intended.
