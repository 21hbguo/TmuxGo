# tmuxU

Web-based tmux session manager.

## Project Structure

```
tmuxU_20260523/
├── apps/
│   ├── frontend/    # Next.js + React + xterm.js
│   ├── gateway/     # Fastify API + WebSocket
│   └── agent/       # tmux host agent
├── package.json     # Monorepo root
└── docs/            # Design documents
```

## Quick Start
### Prerequisites
```bash
node -v
npm -v
tmux -V
tailscale version
```
Supported runtime: Linux/macOS.
Windows: use WSL2.
Required Node version: `>=20` (recommended: `.nvmrc` -> `20`).
`tmux` is required.
Recommended for remote access: install and login Tailscale.
If using remote access, run `tailscale up` first and ensure this host is online in your tailnet.
### Fast Setup
```bash
./bootstrap.sh && ./start.sh
```
If Tailscale is available and logged in, `start.sh` will auto-enable:
- `https://<your-tailnet-dns>`
- `https://<your-tailnet-dns>:8443`
Default ports:
- Frontend stable: `3000`
- Frontend dev: `3002`
- Gateway: `3001`
Extra ports for Tailscale HTTPS serve:
- `443`
- `8443`
If startup fails, check logs:
- `/tmp/tmuxu-gateway.log`
- `/tmp/tmuxu-frontend-stable.log`
- `/tmp/tmuxu-frontend-dev.log`
- `/tmp/tmuxu-agent.log`

### Install Dependencies

```bash
npm install
```

### Development

Run all services:
```bash
npm run dev
```

Or run individually:
```bash
npm run dev:frontend  # Frontend on http://localhost:3000
npm run dev:gateway   # Gateway on http://localhost:3001
npm run dev:agent     # Agent (connects to gateway)
```

### Build

```bash
npm run build
```

## Tech Stack

- **Frontend**: Next.js 14, React 18, Tailwind CSS, xterm.js, Zustand
- **Gateway**: Fastify, WebSocket
- **Agent**: Node.js, tmux control mode

## Environment Variables

### Gateway
- `PORT` - Server port (default: 3001)

### Agent
- `GATEWAY_URL` - Gateway WebSocket URL
- `HOST_ID` - Unique host identifier
- `HOST_NAME` - Display name for this host
