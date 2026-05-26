<div align="center">

# :zap: TmuxGo

### :round_pushpin: Pick up where you left off — anywhere, any device

> Your tmux sessions, one tap away.
> Start on your desktop, continue on your phone, review on your tablet.
> **Never lose a train of thought again.**

![TmuxGo cover](assets/cover_tmuxgo_vip.png)

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node"></a>
<a href="https://github.com/tmux/tmux"><img src="https://img.shields.io/badge/tmux-required-1BB91F?logo=tmux&logoColor=white" alt="tmux"></a>
</p>
<p>
<a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-14-black?logo=next.js" alt="Next.js"></a>
<a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
<a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-3.4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a>
</p>

</div>

---

## :fire: Why TmuxGo?

| :desktop_computer: **Desktop** | :iphone: **Mobile** | :ipad: **Tablet** |
|:---:|:---:|:---:|
| Full keyboard, multi-pane | Touch-friendly, virtual keys | Split-view, side-by-side |

:point_right: **One session, three screens, zero interruption.**

- :globe_with_meridians: **Access from anywhere** - Tailscale-powered secure remote access, no port forwarding needed
- :electric_plug: **Always-on sessions** - tmux keeps your work alive even when you close the browser
- :zap: **Instant resume** - Reconnect in seconds, your cursor is exactly where you left it
- :brain: **Context preserved** - Panes, layouts, history - all intact across devices
- :lock: **Exclusive attach by default** - desktop and mobile both open sessions in exclusive attach mode by default

## :sparkles: Features

| Feature | Description |
|:--------|:------------|
| :globe_with_meridians: **Terminal in Browser** | Full xterm.js terminal with tmux session management |
| :art: **Multi-Pane Grid** | Split, resize, and arrange terminal panes like native tmux |
| :satellite: **Tailscale Remote Access** | Access your sessions securely from anywhere via Tailscale |
| :iphone: **Mobile Friendly** | Responsive UI with touch support, mobile drawer, and virtual keyboard |
| :mag: **Command Palette** | Quick search for hosts, sessions, and windows (`Ctrl+K`) |
| :open_file_folder: **File Browser** | Browse project files, preview text, insert paths, and toggle dotfiles |
| :clipboard: **Text-Safe Clipboard** | Copy terminal selections and paste text without image/rich-content leaks |
| :bookmark_tabs: **Session Templates** | One-click session layouts: Dev, Monitoring, ML Training |
| :art: **Themes** | 6 built-in themes: Dark, Light, High Contrast, Dracula, Nord, Catppuccin |
| :clipboard: **Command Snippets** | Reusable command library with pre-built and custom snippets |
| :ledger: **Audit Log** | Track session activity and user actions |

## :rocket: Quick Start

```bash
git clone https://github.com/<your-username>/TmuxGo.git
cd TmuxGo
./bootstrap.sh && ./start.sh
```

Open `http://localhost:3000` in your browser. :tada:

## :shield: Production Deploy

For long-running usage on your own machine, use user-level `systemd`:

```bash
git clone https://github.com/<your-username>/TmuxGo.git
cd TmuxGo
./bootstrap.sh
./scripts/install-systemd-user.sh
systemctl --user enable --now tmuxgo.target
```

Stop all services:

```bash
systemctl --user disable --now tmuxgo.target
```

Remove all installed units:

```bash
./scripts/uninstall-systemd-user.sh
```

View service status:

```bash
systemctl --user status tmuxgo-gateway.service
systemctl --user status tmuxgo-frontend.service
systemctl --user status tmuxgo-agent.service
```

View logs:

```bash
journalctl --user -u tmuxgo-gateway.service -f
journalctl --user -u tmuxgo-frontend.service -f
journalctl --user -u tmuxgo-agent.service -f
```

## :package: Requirements

| Dependency | Version | Required | Notes |
|:-----------|:--------|:--------:|:------|
| :green_circle: Node.js | >= 20 | :white_check_mark: | Runtime |
| :green_circle: tmux | any | :white_check_mark: | Terminal multiplexer |
| :blue_circle: Tailscale | latest | :o: | Optional - for remote access |
| :desktop_computer: OS | Linux / macOS / WSL2 | - | |

```bash
node -v && npm -v && tmux -V
tailscale version
```

## :jigsaw: Architecture

```
┌──────────┐   WebSocket    ┌──────────┐   PTY   ┌──────────┐
│ Frontend │ ◄────────────► │ Gateway  │ ◄──────► │  Agent   │
│ (Next.js)│                │ (Fastify)│         │ (tmux)   │
└──────────┘                └──────────┘         └──────────┘
```

| Service | Port | Tech Stack |
|:--------|:-----|:-----------|
| :globe_with_meridians: Frontend (stable) | `3000` | Next.js 14, React 18, xterm.js, Tailwind |
| :electric_plug: Gateway | `3001` | Fastify, WebSocket, node-pty |
| :hammer_and_wrench: Frontend (dev) | `3002` | Next.js (hot reload) |
| :lock: Tailscale HTTPS | `443`, `8443` | Auto-configured by `start.sh` |

## :wrench: Development

```bash
npm run dev
npm run dev:frontend
npm run dev:gateway
npm run dev:agent
npm run build
```

Production local start without `systemd`:

```bash
./start-prod.sh
```

## :open_file_folder: Project Structure

```
TmuxGo/
├── apps/
│   ├── frontend/
│   ├── gateway/
│   └── agent/
├── deploy/systemd-user/
├── bootstrap.sh
├── start-prod.sh
├── start.sh
├── scripts/
└── package.json
```

## :art: Themes

| Theme | Preview Style |
|:------|:--------------|
| :crescent_moon: Dark (default) | Deep dark background, cyan accents |
| :sunny: Light | Clean white background |
| :black_circle: High Contrast | Maximum readability |
| :vampire: Dracula | Purple-pink palette |
| :snowflake: Nord | Arctic blue tones |
| :cat: Catppuccin | Warm pastel colors |

Themes are persisted in `localStorage` and can be switched from the preferences panel.

## :keyboard: Keyboard Shortcuts

| Shortcut | Action |
|:---------|:-------|
| `Ctrl+K` / `Cmd+K` | Toggle Command Palette |
| `Ctrl+B` / `Cmd+B` | Toggle Sidebar |
| :arrow_up: :arrow_down: :arrow_left: :arrow_right: | Navigate (with hold-repeat) |
| `Ctrl+B %` | Horizontal split |
| `Ctrl+B "` | Vertical split |
| `Esc` | Detach / Close |
| `Tab` / `Shift+Tab` | Cycle panes |
| `Ctrl+C` | Send interrupt |

> :bulb: Custom shortcuts can be defined from the Quick Actions sidebar and are saved to `localStorage`.

## :bookmark_tabs: Session Templates

| Template | Panes |
|:---------|:------|
| :page_facing_up: Default | Single pane |
| :hammer_and_wrench: Development | `vim` + terminal + `npm run dev` |
| :bar_chart: Monitoring | `htop` + `docker stats` |
| :brain: ML Training | `python train.py` + `nvidia-smi` + `tail -f logs/` |

## :clipboard: Command Snippets

Pre-built commands ready to use:

| Category | Snippets |
|:---------|:---------|
| :file_folder: File System | `ls -la`, `df -h`, `free -h` |
| :gear: Process | `ps aux`, `docker ps` |
| :octocat: Git | `git status`, `git log` |

> :bulb: Add custom snippets from the Command Snippets panel - they're saved to `localStorage`.

## :globe_with_meridians: Environment Variables

| Variable | Service | Default | Description |
|:---------|:--------|:--------|:------------|
| `PORT` | Gateway | `3001` | Gateway listen port |
| `GATEWAY_URL` | Agent | `ws://localhost:3001/api/stream` | Gateway WebSocket URL |
| `HOST_ID` | Agent | `agent-local` | Unique host identifier |
| `HOST_NAME` | Agent | `local-machine` | Display name for host |

## :beetle: Troubleshooting

Check service logs:

```bash
tail -f /tmp/tmuxgo-gateway.log
tail -f /tmp/tmuxgo-frontend-stable.log
tail -f /tmp/tmuxgo-frontend-dev.log
tail -f /tmp/tmuxgo-agent.log
```

For `systemd --user` deployments:

```bash
journalctl --user -u tmuxgo-gateway.service -n 100
journalctl --user -u tmuxgo-frontend.service -n 100
journalctl --user -u tmuxgo-agent.service -n 100
```

## :page_facing_up: License

MIT :copyright: 2026 Hongbin
