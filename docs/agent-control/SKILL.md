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
