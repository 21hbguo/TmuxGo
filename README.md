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
- **Gateway**: Fastify, WebSocket, JWT
- **Agent**: Node.js, tmux control mode

## Environment Variables

### Gateway
- `PORT` - Server port (default: 3001)
- `JWT_SECRET` - JWT signing secret

### Agent
- `GATEWAY_URL` - Gateway WebSocket URL
- `AGENT_TOKEN` - Authentication token
- `HOST_ID` - Unique host identifier
- `HOST_NAME` - Display name for this host
