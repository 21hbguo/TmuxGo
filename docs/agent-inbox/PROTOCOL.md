# TmuxGo Agent Inbox / Push Protocol (v1)

> Status: implemented (v1). This document is the wire contract used by the stdio MCP bridge and `POST /api/v1/control/push`.

## Transport and guard

The first release deliberately uses the existing control-plane guard rather than introducing a second MCP credential:

- HTTP endpoint: `POST /api/v1/control/push`.
- Required request header: `x-tmuxgo-env: 1`.
- Required credential: `x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN` (Bearer is accepted where the existing control-plane guard accepts it).
- The pane environment must contain `TMUXGO_ENV=1`, `TMUXGO_AGENT_EVENT_TOKEN`, and `TMUXGO_GATEWAY_URL`. These are injected into the tmux global environment by the gateway (and re-applied on every pane/session creation), so new panes inherit them. The pane id comes from tmux's own `TMUX_PANE` (`%n`); the bridge composes `local:$TMUX_PANE` when it needs a host-prefixed `paneId`.
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
- `inbox_message_updated` (also emitted per-message on mark-read)
- `inbox_message_deleted` `{ ids: string[] }` (REST/UI deletion fan-out)
- `inbox_open_target` (navigation request for the UI)

No binary data or base64 media is sent over WebSocket. The frontend invalidates/merges the inbox cursor and fetches content through REST. After reconnect, it uses the last cursor to fill gaps.

`inbox_open_target` contains only a validated route and optional `messageId`; the UI performs `setActiveSession`/`setActivePane` and never lets the MCP server directly control the browser.

## Error codes

| HTTP | code | Meaning |
|---:|---|---|
| 400 | `AGENT_PUSH_FAILED` / `AGENT_PUSH_INVALID` | Schema, route, mime, metadata, size, sha256 mismatch, sensitive-path denylist, or missing content carrier. |
| 400 | `AGENT_OPEN_TARGET_FAILED` | Invalid open-target request. |
| 400 | `INVALID_REQUEST` / `INVALID_DEVICE_ID` | Read-side validation failure. |
| 401 | `AGENT_CONTROL_AUTH_REQUIRED` | Missing or invalid agent token (same as the rest of the control plane). |
| 403 | `TMUXGO_ENV_GUARD` | Missing `TMUXGO_ENV=1` / `x-tmuxgo-env: 1`. |
| 404 | `INBOX_MESSAGE_NOT_FOUND` / `INBOX_ASSET_NOT_FOUND` | Message or asset does not exist or has expired. |
| 416 | `RANGE_NOT_SATISFIABLE` | Bad Range header on asset download. |
| 500 | `INBOX_ASSET_PATH_INVALID` | Stored asset path resolves outside the asset root (store tamper guard). |

Duplicates are not errors: a repeated `dedupeKey` returns `200` with `deduplicated: true` and the original `messageId`.

## MCP stdio registration snippets

The bridge is `apps/mcp/index.mjs` (zero-dependency Node ≥18 script). Exposed tools: `tmuxgo_push_text`, `tmuxgo_push_file` (image/video/any file by path), `tmuxgo_push_link`, `tmuxgo_open_target`. Token resolution order: `TMUXGO_AGENT_EVENT_TOKEN` env → `~/.tmuxgo/agent-event-token` (0600, gateway-managed). Gateway URL: `TMUXGO_GATEWAY_URL` → default `http://127.0.0.1:3001`. Do not put a token in config.

```text
TMUXGO_MCP_COMMAND="node <repo>/apps/mcp/index.mjs"
```

### Codex

Config path: `~/.codex/config.toml` (or the project-scoped Codex config used by the installation). Add:

```toml
[mcp_servers.tmuxgo]
type = "stdio"
command = "node"
args = ["/home/guo/project/other/TmuxGo/apps/mcp/index.mjs"]
```

Equivalent CLI registration: `codex mcp add tmuxgo -- node <repo>/apps/mcp/index.mjs`. (Already applied to `~/.codex/config.toml`.)

### Claude Code

Config path: project `.mcp.json` (recommended for this repository) or user `~/.claude.json`. Merge this object into the existing `mcpServers` map:

```json
{
  "mcpServers": {
    "tmuxgo": {
      "type": "stdio",
      "command": "node",
      "args": ["apps/mcp/index.mjs"]
    }
  }
}
```

Already applied both ways: repo `.mcp.json` (relative args above) and user scope via `claude mcp add tmuxgo --scope user -- node <repo>/apps/mcp/index.mjs`.

### DeepSeek harness / dsh

DSH registers MCP through the `@deepseek-ai/dsh-mcp-client` preset entry, not through a Claude-style global JSON file. The active profile is normally `~/.dsh/cordis.patch.yml` (profile-specific patches may live under `~/.dsh/profiles/<profile>/cordis.patch.yml`). Add a row in the mounted preset's `entries` list:

```yaml
- id: mcp-tmuxgo
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: tmuxgo
    transport: stdio
    command: node
    args: [<repo>/apps/mcp/index.mjs]
```

Keep it in the desired preset/scope (for example `aris`) rather than profile-global if only selected DSH sessions should see it. The stdio child inherits the pane environment; do not copy `TMUXGO_AGENT_EVENT_TOKEN` into YAML.

### Hermes

Config path: `~/.hermes/config.yaml`. Merge under the top-level `mcp_servers` map:

```yaml
mcp_servers:
  tmuxgo:
    command: node
    args: [<repo>/apps/mcp/index.mjs]
```

The Hermes CLI equivalent is `hermes mcp add tmuxgo --command node --args <repo>/apps/mcp/index.mjs`. Existing `mcp_servers` entries must be preserved.

## Environment contract and examples

Pane creation must inject values before launching the agent:

```bash
export TMUXGO_ENV=1
export TMUXGO_GATEWAY_URL="http://127.0.0.1:3001"
export TMUXGO_AGENT_EVENT_TOKEN="<injected-secret>"
# TMUX_PANE is provided by tmux itself inside every pane ("%n").
```

Manual smoke test without MCP:

```bash
curl -sS -X POST "$TMUXGO_GATEWAY_URL/api/v1/control/push" \
  -H "x-tmuxgo-env: 1" \
  -H "x-tmuxgo-agent-token: $TMUXGO_AGENT_EVENT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"text","title":"smoke","text":"hello from pane","route":{"paneId":"local:'"$TMUX_PANE"'"}}'
```
