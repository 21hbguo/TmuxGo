# TmuxGo Agent Inbox / Push Protocol (v1)

> Status: planned for R2 implementation. This document freezes the v1 wire contract used by the stdio MCP bridge and `POST /api/v1/control/push`.

## Transport and guard

The first release deliberately uses the existing control-plane guard rather than introducing a second MCP credential:

- HTTP endpoint: `POST /api/v1/control/push`.
- Required request header: `x-tmuxgo-env: 1`.
- Required credential: `x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN` (Bearer is accepted where the existing control-plane guard accepts it).
- The pane environment must contain `TMUXGO_ENV=1`, `TMUXGO_AGENT_EVENT_TOKEN`, `TMUXGO_GATEWAY_URL`, and `TMUXGO_PANE_ID`. These are injected when the pane is created.
- The stdio bridge is a thin JSON-RPC process. It reads MCP JSON-RPC from stdin, calls this endpoint, and writes JSON-RPC responses to stdout. It must write diagnostics only to stderr.
- Remote-host agents call the gateway URL reachable from that host. v1 does not proxy push through the agent WebSocket.

The future Streamable HTTP `/mcp` endpoint is R3 stretch; it must not be used as the v1 implementation or configuration prerequisite.

## Route and message schema

`POST /api/v1/control/push` accepts JSON for text or small payloads and multipart for a file/media upload. Every push has a route. If no route is supplied, it goes to the authenticated agent's global inbox.

```ts
interface AgentInboxMessage {
  id: string
  type: 'text' | 'image' | 'video' | 'file'
  title?: string
  text?: string
  assetId?: string
  mime?: string
  size?: number
  sha256?: string
  source: {
    provider?: string
    agent?: string
    agentSessionId?: string
  }
  route: {
    hostId?: string
    sessionName?: string
    paneId?: string
    tmuxPaneId?: string
  }
  createdAt: string
  readBy: string[]
  expiresAt?: string
  dedupeKey?: string
  metadata?: Record<string, unknown>
}
```

Route matching is deterministic: `hostId + paneId` → `hostId + tmuxPaneId` → `hostId + sessionName` → authenticated user's global inbox. `paneId` must have the matching host prefix; `tmuxPaneId` must match `%[0-9]+`; `sessionName` uses the existing `[A-Za-z0-9._-]{1,64}` constraint. An unknown or stale route is retained in the global inbox with route metadata and a warning, not discarded.

### Text request

```json
{
  "type": "text",
  "title": "Build result",
  "text": "All tests passed.",
  "route": {
    "hostId": "local",
    "sessionName": "dev",
    "tmuxPaneId": "%4"
  },
  "source": {
    "provider": "codex",
    "agent": "codex",
    "agentSessionId": "thread-123"
  },
  "dedupeKey": "build-result-123",
  "metadata": { "severity": "info" }
}
```

`text` is limited to 256 KiB. `metadata` and all identifiers have bounded lengths. `dedupeKey` is scoped to the authenticated token and route; a duplicate returns the original `messageId` rather than creating another record.

### File/media request

Use multipart for normal files and media. The JSON part contains the message metadata; the file part is streamed directly to the gateway. v1 also accepts `contentBase64` for small payloads up to 32 MiB. A local `path` reference is accepted only when the path is inside an allowed workspace and passes `realpath` and size checks; denylist includes `~/.ssh`, `~/.gnupg`, `~/.aws`, and `.env` files.

The existing multipart limit is 200 MiB per file and 20 files per request. v1 does not implement resumable chunks; reserve `uploadId`, `partNo`, and `totalParts` for R3.

```json
{
  "type": "image",
  "title": "Screenshot",
  "mime": "image/png",
  "path": "/workspace/tmp/screenshot.png",
  "route": { "hostId": "local", "paneId": "local:%4" }
}
```

The response contains `messageId`, `assetId` (when applicable), `createdAt`, normalized `route`, and `deduplicated`. Assets are stored under the configured TmuxGo data directory in SHA-256 sharded paths. The server writes a temporary file, verifies size/hash, and renames atomically. Asset downloads are authenticated and support HTTP Range for video.

## Read/acknowledge endpoints

The v1 REST read side is:

- `GET /api/inbox?cursor=&limit=&unread=&hostId=&sessionName=&paneId=` — paged metadata, newest first.
- `GET /api/inbox/:messageId` — one message and metadata; no large blob in the list response.
- `GET /api/inbox/assets/:assetId` — authenticated asset download/preview; supports Range.
- `POST /api/inbox/:messageId/read` with `{ "deviceId": "..." }` — idempotently adds the device to `readBy`.
- `POST /api/inbox/read` with `{ "deviceId": "...", "ids": ["..."] }` — batch acknowledgement.

The frontend stores only message ids/tab order locally. After refresh it hydrates metadata through REST. `deviceId` is a viewer/device key, not part of the agent route.

## Realtime events

The existing authenticated agent stream sends metadata-only events:

- `inbox_message_created`
- `inbox_message_updated`
- `inbox_asset_ready`
- `inbox_open_target` (navigation request for the UI)

No binary data or base64 media is sent over WebSocket. The frontend invalidates/merges the inbox cursor and fetches content through REST. After reconnect, it uses the last cursor to fill gaps.

`inbox_open_target` contains only a validated route and optional `messageId`; the UI performs `setActiveSession`/`setActivePane` and never lets the MCP server directly control the browser.

## Error codes

| HTTP | code | Meaning |
|---:|---|---|
| 400 | `INVALID_PUSH` | Schema, route, mime, metadata, or size field is invalid. |
| 401 | `AGENT_EVENT_AUTH_REQUIRED` | Missing or invalid agent token. |
| 403 | `CONTROL_ENV_REQUIRED` | Missing `TMUXGO_ENV=1` / `x-tmuxgo-env: 1`, or token is not allowed for the host. |
| 404 | `INBOX_MESSAGE_NOT_FOUND` / `ASSET_NOT_FOUND` | Message or asset does not exist or has expired. |
| 409 | `PUSH_DEDUPLICATED` | Optional response code when a client asks for explicit duplicate reporting; response still includes original id. |
| 413 | `PUSH_TOO_LARGE` | Text/base64/request/file exceeds its limit. |
| 422 | `PUSH_PATH_DENIED` | Local path is outside the allowed workspace or hits the sensitive-path denylist. |
| 429 | `PUSH_QUOTA_EXCEEDED` | Per-token rate or storage quota exceeded. |
| 500 | `INBOX_STORE_ERROR` / `ASSET_STORE_ERROR` | Server could not persist the message or asset. |

## MCP stdio registration snippets

The bridge command below is intentionally a placeholder until the implementation lands. Replace it with the installed command/path from `apps/mcp`; do not put a token in config because the bridge reads the injected pane environment.

```text
TMUXGO_MCP_COMMAND=tmuxgo-mcp
```

### Codex

Config path: `~/.codex/config.toml` (or the project-scoped Codex config used by the installation). Add:

```toml
[mcp_servers.tmuxgo]
type = "stdio"
command = "tmuxgo-mcp"
args = []
```

Equivalent CLI registration: `codex mcp add tmuxgo -- tmuxgo-mcp`.

### Claude Code

Config path: project `.mcp.json` (recommended for this repository) or user `~/.claude.json`. Merge this object into the existing `mcpServers` map:

```json
{
  "mcpServers": {
    "tmuxgo": {
      "type": "stdio",
      "command": "tmuxgo-mcp",
      "args": []
    }
  }
}
```

Equivalent command: `claude mcp add --transport stdio tmuxgo -- tmuxgo-mcp`.

### DeepSeek harness / dsh

DSH registers MCP through the `@deepseek-ai/dsh-mcp-client` preset entry, not through a Claude-style global JSON file. The active profile is normally `~/.dsh/cordis.patch.yml` (profile-specific patches may live under `~/.dsh/profiles/<profile>/cordis.patch.yml`). Add a row in the mounted preset's `entries` list:

```yaml
- id: mcp-tmuxgo
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: tmuxgo
    transport: stdio
    command: tmuxgo-mcp
    args: []
```

Keep it in the desired preset/scope (for example `aris`) rather than profile-global if only selected DSH sessions should see it. The stdio child inherits the pane environment; do not copy `TMUXGO_AGENT_EVENT_TOKEN` into YAML.

### Hermes

Config path: `~/.hermes/config.yaml`. Merge under the top-level `mcp_servers` map:

```yaml
mcp_servers:
  tmuxgo:
    command: tmuxgo-mcp
    args: []
```

The Hermes CLI equivalent is `hermes mcp add tmuxgo --command tmuxgo-mcp`. Existing `mcp_servers` entries must be preserved.

## Environment contract and examples

Pane creation must inject values before launching the agent:

```bash
export TMUXGO_ENV=1
export TMUXGO_GATEWAY_URL="http://127.0.0.1:3001"
export TMUXGO_AGENT_EVENT_TOKEN="<injected-secret>"
export TMUXGO_PANE_ID="local:${TMUX_PANE}"
```

Manual smoke test without MCP:

```bash
curl -sS -X POST "$TMUXGO_GATEWAY_URL/api/v1/control/push" \
  -H "x-tmuxgo-env: 1" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"text","title":"smoke","text":"hello from pane","route":{"paneId":"'"$TMUXGO_PANE_ID"'"}}'
```
