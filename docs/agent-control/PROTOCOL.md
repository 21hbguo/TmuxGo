# TmuxGo Agent Control Plane (v1)

Versioned HTTP protocol that lets an AI coding agent operating inside a TmuxGo pane drive the workbench itself — split panes, read pane output, and wait for other agents to reach a state.

## Guard

- The gateway only accepts control requests when the pane env has `TMUXGO_ENV=1` (injected at session/pane creation) and the request carries `x-tmuxgo-env: 1`.
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
