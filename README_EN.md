<div align="center">

# :zap: TmuxGo

### :round_pushpin: A browser-native tmux workspace with seamless handoff across desktop, phone, and tablet

<p><a href="README.md">简体中文</a> · <strong>English</strong></p>

> No client required. Open a browser and get your terminal, file workspace, and Git tools in one place.  
> Start on desktop, continue on phone, review on tablet.  
> **Same session, same context, no broken flow.**

![TmuxGo cover](assets/cover_tmuxgo_vip.png)

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node"></a>
<a href="https://github.com/tmux/tmux"><img src="https://img.shields.io/badge/tmux-required-1BB91F?logo=tmux&logoColor=white" alt="tmux"></a>
</p>
<p>
<a href="https://nextjs.org"><img src="https://img.shields.io/badge/Next.js-14-black?logo=next.js" alt="Next.js"></a>
<a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
<a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-3.4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a>
</p>

</div>

---

## :fire: Why TmuxGo?

| :desktop_computer: **Desktop** | :iphone: **Mobile** | 📟 **Tablet** |
|:---:|:---:|:---:|
| Multiple panes, editors, and side panels | Touch-friendly navigation, virtual keys, drawer UI | Side-by-side logs, code, and Git history |

:point_right: **One session, three screens, no interruption.**

- :globe_with_meridians: **Reach it anywhere** - browser access over localhost, LAN, or Tailscale
- :electric_plug: **Sessions stay alive** - your `tmux` work continues after the browser closes
- :repeat: **Cross-device continuity** - sessions, layouts, active panes, and resume points carry over
- :lock: **Exclusive attach by default** - desktop and mobile restore in exclusive mode to avoid focus conflicts

## :sparkles: Feature Overview

| Area | Current capabilities |
|:-----|:---------------------|
| :globe_with_meridians: **Terminal and tmux** | Browser terminal powered by `xterm.js`, tmux attach, pane/window split and zoom, shared/exclusive attach, command palette, quick actions |
| :bookmark_tabs: **Session management** | Create, rename, drag-sort, batch delete, audit log, and custom session templates with window count, pane count, layout, and startup commands |
| :desktop_computer: **Desktop workspace** | Activity Bar, Session Rail, resizable Session/File/Git panels, embedded Terminal Dock |
| :open_file_folder: **File workspace** | `workspace` / `home` roots, filename and content search, favorite directories, dotfile toggle, text and image preview, create/rename/delete, insert path into terminal, downloads, upload queue |
| :pencil2: **Built-in editor** | Monaco editor, split editor groups, drag-to-open in a specific split, Markdown preview, image preview, Git diff viewer, read-only protection for large or binary files |
| :octocat: **Git workbench** | Status, history graph, branches, stage/unstage, commit, discard, fetch/pull/push/merge, checkout/create/delete branch, pinned repos, follow-current-file repo mode, `gh` device-login helper |
| :satellite: **Multi-host** | Built-in local host plus SSH remote hosts, connectivity test, host switching that propagates to terminal, files, and Git |
| :iphone: **Mobile / PWA** | Drawer navigation, touch scrolling, virtual keyboard, mobile shortcut bar, clipboard safety, install-to-home-screen banner |
| :brain: **Persistence and sync** | Theme, shortcuts, favorites, snippets, session order, Git workspace state, and session continuity sync between browser storage and `~/.tmuxgo/preferences` |
| :package: **Version and release awareness** | Stable/dev frontend split, build version checks, refresh prompt when a newer build is deployed |

## :rocket: Quick Start

```bash
git clone https://github.com/21hbguo/TmuxGo.git
cd TmuxGo
./install.sh
```

`install.sh` will automatically:

- install or switch to Node.js 20
- install `tmux`, `ripgrep`, `lsof/ss`, `python3`, and native build tools
- run `npm install`
- build Gateway and the stable Frontend (`.next-prod`), plus Agent when `TMUXGO_ENABLE_AGENT=1`
- install and start user-level `systemd` services on Linux
- install and start user-level `launchd` services on macOS
- fall back to the local startup script when a background service manager is unavailable
- verify `3000/3001` and print local URLs plus Tailscale HTTPS URLs when available

After installation, open `http://localhost:3000`.
Agent is not installed or started by default; use `TMUXGO_ENABLE_AGENT=1 ./install.sh` or `TMUXGO_ENABLE_AGENT=1 ./start.sh --restart` when you need it.

> :bulb: LAN access works directly; for remote access, configure [Tailscale](https://tailscale.com) first.
> :lock: For reliable copy to the system clipboard, prefer HTTPS access such as Tailscale HTTPS.
> :desktop_computer: The deployment side must run in a `tmux`-capable environment, ideally Linux, macOS, or WSL2. The access side only needs a browser.

If you only want dependencies and manual startup:

```bash
./bootstrap.sh
./start.sh
```

## :traffic_light: Runtime Modes and Restart Rules

- `3000` is the stable frontend, served from the prebuilt `.next-prod` output and exposed by `systemd`, `launchd`, and Tailscale
- `3001` is the Gateway API and WebSocket service
- `3002` is the development frontend with hot reload when you run local startup or `npm run dev:frontend`
- Running only `build` or `test` does not refresh an already running stable `3000/3001`
- To apply source changes to the stable stack, run `./start.sh --restart`
- If frontend sources are newer than `.next-prod`, `./start.sh --restart` auto-upgrades to a stable rebuild
- To force a rebuild explicitly, run `./start.sh --restart --rebuild`
- For local production startup without `systemd` or `launchd`, use `./start-prod.sh`

## :satellite: Multi-Host and Remote SSH

- `local` is available by default, so sessions, files, and Git work out of the box on the host machine
- Add remote hosts from Settings with `id / address / user / port / password / passwordEnv`
- Once you switch host, session lists, file trees, editor targets, and Git state switch with it
- SSH keys are the preferred path; password or password-env hosts require `sshpass`
- Host definitions are stored in `~/.tmuxgo/hosts.json` by default, or under `TMUXGO_CONFIG_DIR`

## :shield: Production Deploy

For a new machine, the recommended path is:

```bash
git clone https://github.com/21hbguo/TmuxGo.git
cd TmuxGo
./install.sh
```

If dependencies are already installed and you only want to reinstall background services:

Linux:

```bash
./scripts/install-systemd-user-linux.sh
```

macOS:

```bash
./scripts/install-launchd-user-mac.sh
```

Prefix the install command with `TMUXGO_ENABLE_AGENT=1` to install and start Agent as well.

Stop all services:

Linux:

```bash
./scripts/stop-systemd-user-linux.sh
```

macOS:

```bash
./scripts/stop-launchd-user-mac.sh
```

Remove all installed units:

Linux:

```bash
./scripts/uninstall-systemd-user-linux.sh
```

macOS:

```bash
./scripts/uninstall-launchd-user-mac.sh
```

View service status:

Linux:

```bash
systemctl --user status tmuxgo-gateway.service
systemctl --user status tmuxgo-frontend.service
systemctl --user status tmuxgo-agent.service
```

macOS:

```bash
launchctl print gui/$(id -u)/com.tmuxgo.gateway || launchctl print user/$(id -u)/com.tmuxgo.gateway
launchctl print gui/$(id -u)/com.tmuxgo.frontend || launchctl print user/$(id -u)/com.tmuxgo.frontend
launchctl print gui/$(id -u)/com.tmuxgo.agent || launchctl print user/$(id -u)/com.tmuxgo.agent
```

View logs:

Linux:

```bash
journalctl --user -u tmuxgo-gateway.service -f
journalctl --user -u tmuxgo-frontend.service -f
journalctl --user -u tmuxgo-agent.service -f
```

macOS:

```bash
tail -f ~/Library/Logs/TmuxGo/gateway.log
tail -f ~/Library/Logs/TmuxGo/frontend.log
tail -f ~/Library/Logs/TmuxGo/agent.log
```

## :package: Requirements

| Dependency | Version | Required | Notes |
|:-----------|:--------|:--------:|:------|
| :green_circle: Node.js | >= 20 | :white_check_mark: | Runtime |
| :green_circle: tmux | any | :white_check_mark: | Terminal multiplexer |
| :green_circle: Build toolchain | `make` / `g++` / `pkg-config` | :white_check_mark: | Required by `node-pty` |
| :green_circle: Base tools | `git` / `curl` / `python3` / `ripgrep` / `lsof` or `ss` | :white_check_mark: | Needed by install, file search, and startup scripts |
| :blue_circle: Tailscale | latest | :o: | Remote access and HTTPS exposure |
| :blue_circle: sshpass | latest | :o: | Only required for password-based SSH hosts |
| :blue_circle: GitHub CLI (`gh`) | latest | :o: | GitHub device-login helper and auth-state detection |
| :desktop_computer: OS | Linux / macOS / WSL2 | - | Deployment-side runtime environment |

```bash
node -v && npm -v && tmux -V
tailscale version
```

## :jigsaw: Architecture

```text
┌──────────┐   WebSocket    ┌──────────┐   PTY / SSH / Git / Files   ┌──────────┐
│ Frontend │ ◄────────────► │ Gateway  │ ◄──────────────────────────► │  Agent   │
│ (Next.js)│                │ (Fastify)│                               │ (tmux)   │
└──────────┘                └──────────┘                               └──────────┘
```

| Service | Port | Stack |
|:--------|:-----|:------|
| :globe_with_meridians: Frontend (stable) | `3000` | Next.js 14, React 18, xterm.js, Monaco, Tailwind |
| :hammer_and_wrench: Frontend (dev) | `3002` | Next.js hot reload |
| :electric_plug: Gateway | `3001` | Fastify, WebSocket, node-pty, SSH, file and Git routes |
| :satellite: Agent (optional) | - | `tmux` attach, host registration, terminal stream forwarding |
| :lock: Tailscale HTTPS | `443`, `8443` | Auto-configured by `start.sh` for frontend and Gateway |

## :wrench: Development and Verification

```bash
npm run dev
npm run dev:frontend
npm run dev:gateway
npm run dev:agent
npm run build
npm test
npm run test:frontend
npm run test:e2e
npm run verify
```

Recommended delivery checklist:

1. `npm test` / `npm run test:frontend` / `npm run test:e2e` when relevant
2. `./start.sh --restart`
3. Verify that `3000` or the Tailscale HTTPS URL is serving the new build, not just `3002`

## :keyboard: Common Shortcuts

| Shortcut | Action |
|:---------|:-------|
| `Ctrl+K` / `Cmd+K` | Open or close the command palette |
| `Ctrl+B` / `Cmd+B` | Toggle the session sidebar |
| `Ctrl+E` / `Cmd+E` | Toggle the file explorer |
| Quick Actions / Mobile Shortcut Bar | Send Enter, delete word, clear line, split pane, zoom, kill pane |

> :bulb: Native `tmux` shortcuts still work inside the terminal. Custom shortcuts are persisted through the preference store.

## :gear: Configuration and Persistence

### Environment Variables

| Variable | Default | Description |
|:---------|:--------|:------------|
| `PORT` | `3001` | Gateway listen port |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3001` | Frontend base URL for Gateway |
| `NEXT_DIST_DIR` | `.next` / `.next-prod` | Frontend build output directory |
| `TMUXGO_ENABLE_AGENT` | `0` | Set to `1` to start or install Agent |
| `GATEWAY_URL` | `ws://localhost:3001/api/stream` | Agent WebSocket URL for Gateway |
| `HOST_ID` | `agent-local` | Agent registration host ID |
| `HOST_NAME` | `local-machine` or hostname | Agent display name |
| `TMUX_WEB_FILE_ROOTS` | `workspace=<repo>:home=<home>` | File tree roots, for example `workspace=/srv/code:home=/home/guo` |
| `TMUXGO_PREFERENCES_DIR` | `~/.tmuxgo/preferences` | Synced store for preferences, favorites, and session continuity |
| `TMUXGO_CONFIG_DIR` | `~/.tmuxgo` | Host configuration directory, including `hosts.json` |
| `TMUX_WEB_ALLOWED_SESSIONS` | empty | Comma-separated tmux session allowlist |

### Where Data Lives

- Remote host definitions: `~/.tmuxgo/hosts.json`
- Preferences and synced metadata: `~/.tmuxgo/preferences`
- Browser-local cache: `localStorage` / `sessionStorage`

## :beetle: Troubleshooting

Local startup logs:

```bash
tail -f /tmp/tmuxgo-gateway.log
tail -f /tmp/tmuxgo-frontend-stable.log
tail -f /tmp/tmuxgo-frontend-dev.log
tail -f /tmp/tmuxgo-agent.log
```

Common issues:

1. `3002` shows the new UI but `3000` is still old: run `./start.sh --restart`, add `--rebuild` if needed
2. System clipboard copy fails: prefer an HTTPS top-level tab and confirm clipboard permission in the browser
3. Remote host connection fails: verify SSH reachability and confirm the target has `tmux`, `git`, and `python3`; install `sshpass` for password-based auth
4. Git push or pull behaves unexpectedly: verify `git` and `gh` auth on the target host first, then retry from TmuxGo

## :page_facing_up: License

MIT :copyright: 2026 Hongbin
