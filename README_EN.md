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
<a href="https://vite.dev"><img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" alt="Vite"></a>
<a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
<a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-3.4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS"></a>
</p>

</div>

---

## :bookmark_tabs: Table of Contents

- [Why TmuxGo?](#fire-why-tmuxgo)
- [Feature Overview](#sparkles-feature-overview)
- [Quick Start](#rocket-quick-start)
- [Runtime Modes and Restart Rules](#traffic_light-runtime-modes-and-restart-rules)
- [Multi-Host and Remote SSH](#satellite-multi-host-and-remote-ssh)
- [Production Deploy](#shield-production-deploy)
- [Secure Deployment](#lock-secure-deployment)
- [Requirements](#package-requirements)
- [Architecture](#jigsaw-architecture)
- [Development and Verification](#wrench-development-and-verification)
- [Common Shortcuts](#keyboard-common-shortcuts)
- [Configuration and Persistence](#gear-configuration-and-persistence)
- [Troubleshooting](#beetle-troubleshooting)
- [Contributing](#handshake-contributing)
- [License](#page_facing_up-license)

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
| :globe_with_meridians: **Terminal and tmux** | Browser terminal powered by `xterm.js`, tmux attach, pane/window split and zoom, shared/exclusive attach, split sessions, command palette, quick actions |
| :bookmark_tabs: **Session management** | Create, rename, drag-sort, batch delete, audit log, named workspaces, and custom session templates with window count, pane count, layout, and startup commands |
| :desktop_computer: **Desktop workspace** | Activity Bar, Session Rail, resizable Session/File/Git panels, embedded Terminal Dock |
| :open_file_folder: **File workspace** | `workspace` / `home` roots, filename and content search, favorite directories, dotfile toggle, text and image preview, create/rename/delete, insert path into terminal, downloads, upload queue |
| :pencil2: **Built-in editor** | Monaco editor, split editor groups, drag-to-open in a specific split, Markdown preview, image preview, Git diff viewer, read-only protection for large or binary files |
| :octocat: **Git workbench** | Status, history graph, branches, stage/unstage, commit, discard, fetch/pull/push/merge, checkout/create/delete branch, pinned repos, follow-current-file repo mode, `gh` device-login helper |
| :satellite: **Multi-host** | Built-in local host plus SSH remote hosts, connectivity test, host switching that propagates to terminal, files, and Git |
| :iphone: **Mobile / PWA** | Drawer navigation, touch scrolling, virtual keyboard, mobile shortcut bar, clipboard safety, install-to-home-screen banner |
| :brain: **Persistence and sync** | Theme, shortcuts, favorites, snippets, session order, Git workspace state, and session continuity sync between browser storage and `~/.tmuxgo/preferences` |
| :package: **Version and release awareness** | Vite build artifact vs dev hot-reload split, build version checks, refresh prompt when a newer build is deployed |

## :rocket: Quick Start

### One-command npm install

Run this directly on macOS or Linux:

```bash
npx --yes @21hbguo/tmuxgo install
```

The command installs production dependencies including `tmux`, `ripgrep`, `python3`, `git`, and `curl`, copies the prebuilt runtime to `~/.tmuxgo/runtime`, creates the `default` tmux session, and registers the Gateway user service. Node.js ^20.19 / ^22.12 / >=24 is required before running `npx`; on macOS, Homebrew is installed first when missing. Open `http://localhost:3001` when it completes.

### Source deployment (development or offline)

```bash
git clone https://github.com/21hbguo/TmuxGo.git
cd TmuxGo
./install.sh
```

`install.sh` will automatically:

- verify Node.js (^20.19 / ^22.12 / >=24), installing the latest LTS via nvm when unsupported
- install `tmux`, `ripgrep`, `lsof/ss`, `python3`, and native build tools
- run `npm install`
- build Gateway and the static Frontend (`apps/frontend/dist`, Vite), plus Agent when `TMUXGO_ENABLE_AGENT=1`
- install and start user-level `systemd` services on Linux
- install and start user-level `launchd` services on macOS
- fall back to the local startup script when a background service manager is unavailable
- verify `3001` (Gateway serves API and static frontend) and print local URLs plus Tailscale HTTPS URLs when available

After installation, open `http://localhost:3001` on macOS; use the address printed by the startup command for other deployment modes.
Agent is not installed or started by default; use `TMUXGO_ENABLE_AGENT=1 ./install.sh` or `TMUXGO_ENABLE_AGENT=1 ./start.sh --restart` when you need it.

> :lock: The Gateway binds to `127.0.0.1` by default and is not exposed directly to the LAN or Internet. Remote access must use Tailscale, WireGuard, an SSH tunnel, or an HTTPS reverse proxy.
> :warning: A terminal connection has full tmux input, file, and Git permissions; never expose an unauthenticated Gateway or unencrypted `ws://` endpoint to an untrusted network.
> :bulb: For reliable system clipboard access, prefer HTTPS such as Tailscale HTTPS.
> :desktop_computer: The deployment side must run in a `tmux`-capable environment, ideally Linux, macOS, or WSL2. The access side only needs a browser.

If you only want dependencies and manual startup:

```bash
./bootstrap.sh
./start.sh
```

Publish the npm package:

```bash
npm login
npm run pack:npx
npm run publish:npx
```

## :traffic_light: Runtime Modes and Restart Rules

- **The only production entry is `3001`**: the Gateway serves API, WebSocket, and the static frontend; `http://127.0.0.1:3001/` returns `200`
- There is no separate `3000` stable frontend process and no `3002` Next.js hot-reload port; the frontend is a Vite build artifact hosted by the Gateway
- Linux production uses the systemd user unit: after changing Gateway source, run `systemctl --user restart tmuxgo-gateway`
- After changing frontend source, run `npm run build` (or `npm run build:frontend`) to rebuild `apps/frontend/dist`; the Gateway reads dist per request, so no separate restart is needed for static assets
- The development stack is Gateway `3101` + Vite dev `5199` (hot reload), separate from the production entry
- Running only `build` or `test` does not load new Gateway code into a running process; Gateway changes require a restart
- For a scripted rebuild + restart, `./start.sh --restart` still works (add `--rebuild` to force a rebuild)
- For local production startup without `systemd` or `launchd`, use `./start-prod.sh`

## :satellite: Multi-Host and Remote SSH

- `local` is available by default, so sessions, files, and Git work out of the box on the host machine
- Add remote hosts from Settings with `id / address / user / port / password / passwordEnv`
- Once you switch host, session lists, file trees, editor targets, and Git state switch with it
- SSH keys are the preferred path; password or password-env hosts require `sshpass`
- Host `useAgent: true` means SSH-agent authentication and requires a working SSH Agent on the deploy host (`SSH_AUTH_SOCK`)
- The TmuxGo Agent component is not installed by default (`TMUXGO_ENABLE_AGENT` defaults to `0`); enable it explicitly when needed
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
systemctl --user status tmuxgo-agent.service
```

macOS:

```bash
launchctl print gui/$(id -u)/com.tmuxgo.gateway || launchctl print user/$(id -u)/com.tmuxgo.gateway
launchctl print gui/$(id -u)/com.tmuxgo.agent || launchctl print user/$(id -u)/com.tmuxgo.agent
```

View logs:

Linux:

```bash
journalctl --user -u tmuxgo-gateway.service -f
journalctl --user -u tmuxgo-agent.service -f
```

macOS:

```bash
tail -f ~/Library/Logs/TmuxGo/gateway.log
tail -f ~/Library/Logs/TmuxGo/agent.log
```

## :lock: Secure Deployment

### Default security model

- The Gateway binds to `127.0.0.1:3001` by default. Setting `TMUXGO_HOST=0.0.0.0` or another non-loopback address is an explicit network exposure.
- Built-in username/password authentication is enabled by default. The default username is `admin`; the first `admin/admin123` login must be followed by a password change. Authentication state and device sessions are stored in `~/.tmuxgo/auth.json` with owner-only permissions.
- API requests use short-lived access tokens and HttpOnly cookies. The terminal WebSocket requires a short-lived, single-use ticket. Explicit share links are the only anonymous exception and are scoped to one read-only session.
- The Gateway does not terminate TLS. `ws://` and `http://` do not encrypt transport; cross-device access must use HTTPS/WSS or an encrypted network such as Tailscale, WireGuard, or an SSH tunnel.
- Setting `TMUXGO_AUTH_USERNAME` or `TMUXGO_AUTH_PASSWORD` to an empty value disables authentication and is intended only for local development. A non-loopback unauthenticated Gateway refuses to start unless `TMUXGO_ALLOW_INSECURE=1` is explicitly set.

### Startup security checks

Every Gateway startup checks and logs whether authentication is enabled, whether the default password is still active, whether the bind address is loopback, whether an encrypted transport is configured, and whether `tmux -V` meets the security baseline.

- A non-loopback bind without `TMUXGO_PUBLIC_URL=https://...` / `wss://...`, `TMUXGO_TLS_TERMINATED=1`, or `TMUXGO_ENCRYPTED_TRANSPORT=1` produces a prominent unencrypted-transport warning.
- The default password produces a warning until it is changed; a non-loopback bind refuses to start until the password is changed on localhost.
- The recommended minimum `tmux` security version is [3.6b](https://github.com/tmux/tmux/releases/tag/3.6b), which includes the fix for [CVE-2026-11623](https://nvd.nist.gov/vuln/detail/CVE-2026-11623); the current upstream stable release is [3.7c](https://github.com/tmux/tmux/releases/tag/3.7c). A distro package with security backports may be acceptable, but keep the system packages updated.

Check the installed version:

```bash
tmux -V
```

Upgrade examples:

```bash
sudo apt update && sudo apt install --only-upgrade tmux
brew update && brew upgrade tmux
```

### HTTPS reverse proxy

Keep the Gateway on loopback:

```bash
export TMUXGO_HOST=127.0.0.1
export TMUXGO_PUBLIC_URL=https://tmuxgo.example.com
```

The Nginx template is [`deploy/nginx/tmuxgo.conf.example`](deploy/nginx/tmuxgo.conf.example); the Caddy template is [`deploy/caddy/Caddyfile.example`](deploy/caddy/Caddyfile.example). Both templates forward WebSocket Upgrade and `X-Forwarded-Proto: https`. Once the proxy terminates TLS, the browser automatically uses `wss://` for `/api/stream`.

After issuing a Let's Encrypt certificate with Nginx, put the certificate paths and hostname in the template. Caddy automatically obtains and renews certificates when started with a real domain. Restrict the proxy's 443 port with the firewall and keep port 3001 bound to localhost only.

### Tailscale, WireGuard, and SSH tunnels

Tailscale:

```bash
tailscale serve --yes --bg --https=443 http://127.0.0.1:3001
```

`./start.sh` also attempts to configure HTTPS when it detects a connected Tailscale client. Use the printed `https://...ts.net` address and do not share the plaintext `:3001` address.

An encrypted private network such as WireGuard can bind the Gateway to the VPN address with an encrypted-transport marker:

```bash
TMUXGO_HOST=10.8.0.1 TMUXGO_ENCRYPTED_TRANSPORT=1 ./start-prod.sh
```

For temporary administration, use an SSH tunnel:

```bash
ssh -N -L 3001:127.0.0.1:3001 user@gateway-host
```

Then open `http://127.0.0.1:3001` locally. For production, prefer an HTTPS reverse proxy or VPN and block public access to port 3001 with the firewall. For example, expose HTTPS only:

```bash
sudo ufw allow 443/tcp
sudo ufw deny 3001/tcp
```

### Docker

The Docker example publishes port 3001 on the host loopback address by default:

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

`deploy/docker-compose.yml` uses `127.0.0.1:3001:3001`. The container must listen on `0.0.0.0` for Docker forwarding, but the host-side exposure remains local-only. For remote access, put an HTTPS reverse proxy or VPN on the host; do not change the mapping to `3001:3001`.

## :package: Requirements

| Dependency | Version | Required | Notes |
|:-----------|:--------|:--------:|:------|
| :green_circle: Node.js | >= 20 | :white_check_mark: | Runtime |
| :green_circle: tmux | >= 3.6b (or a distro security backport) | :white_check_mark: | Terminal multiplexer; older versions produce a startup warning |
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
┌──────────────┐   HTTP / WS    ┌──────────────────────────────┐   PTY / SSH / Git / Files   ┌──────────┐
│ Vite static  │ ◄────────────► │ Gateway :3001                │ ◄──────────────────────────► │  Agent   │
│ assets       │  same-origin   │ API + WebSocket + static UI  │                               │ (tmux)   │
└──────────────┘                └──────────────────────────────┘                               └──────────┘
```

| Service | Port | Stack |
|:--------|:-----|:------|
| :globe_with_meridians: Frontend static assets (production) | Hosted by Gateway on `3001` | Vite 8 build output (`apps/frontend/dist`), React 18, xterm.js, Monaco, Tailwind |
| :electric_plug: Gateway (sole production entry) | `3001` | Fastify, WebSocket, node-pty, SSH, file and Git routes; same-origin static frontend |
| :hammer_and_wrench: Gateway + Vite (development) | `3101` + `5199` | dev Gateway + Vite dev hot reload (`npm run dev`) |
| :satellite: Agent (optional, off by default) | - | `tmux` attach, host registration, terminal stream forwarding; requires `TMUXGO_ENABLE_AGENT=1` |
| :lock: Tailscale HTTPS | `443`, `8443` | Auto-configured by `start.sh` to `3001` |

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
2. Rebuild the frontend with `npm run build` (updates `apps/frontend/dist`); restart Gateway with `systemctl --user restart tmuxgo-gateway` when Gateway code changed (scripted installs can use `./start.sh --restart`)
3. Verify only the production entry `http://127.0.0.1:3001/` or the Tailscale HTTPS URL is serving the new build; do not treat dev port `5199` as delivery evidence

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
| `TMUXGO_HOST` | `127.0.0.1` | Gateway bind address; configure encrypted transport or HTTPS before network exposure |
| `VITE_API_URL` | `http://127.0.0.1:3001` | Gateway base URL used at build/dev time |
| `TMUXGO_FRONTEND_DIST` | `apps/frontend/dist` | Frontend static assets directory served by Gateway |
| `TMUXGO_ENABLE_AGENT` | `0` | Set to `1` to start or install Agent |
| `GATEWAY_URL` | `ws://localhost:3001/api/stream` | Agent WebSocket URL for Gateway |
| `TMUXGO_AUTH_USERNAME` | `admin` | Gateway login username |
| `TMUXGO_AUTH_PASSWORD` | `admin123` | Gateway login password; it must be changed after the first default-password login |
| `TMUXGO_PUBLIC_URL` | empty | Public URL; an `https://` or `wss://` value signals TLS |
| `TMUXGO_TLS_TERMINATED` | `0` | Set to `1` when a reverse proxy terminates TLS |
| `TMUXGO_ENCRYPTED_TRANSPORT` | `0` | Set to `1` when Tailscale / WireGuard / an SSH tunnel provides outer encryption |
| `TMUXGO_ALLOW_INSECURE` | `0` | Allow a non-loopback unauthenticated Gateway; only for intentional temporary tests |
| `GATEWAY_USERNAME` | `admin` | Username used by Agent to connect to Gateway |
| `GATEWAY_PASSWORD` | empty | Password used by Agent to connect to Gateway; required explicitly when authentication is enabled |
| `HOST_ID` | `agent-local` | Agent registration host ID |
| `HOST_NAME` | `local-machine` or hostname | Agent display name |
| `TMUX_WEB_FILE_ROOTS` | `workspace=<repo>:home=<home>` | File tree roots, for example `workspace=/srv/code:home=/home/guo` |
| `TMUXGO_PREFERENCES_DIR` | `~/.tmuxgo/preferences` | Synced store for preferences, favorites, and session continuity |
| `TMUXGO_CONFIG_DIR` | `~/.tmuxgo` | Host configuration directory, including `hosts.json` |
| `TMUX_WEB_ALLOWED_SESSIONS` | empty | Comma-separated tmux session allowlist |

Gateway authentication is enabled by default. Unauthenticated access to protected APIs such as `/api/hosts` returns `401`. Authentication state and device sessions are stored in `~/.tmuxgo/auth.json`; browsers refresh their session automatically after the first login. The default `admin/admin123` password must be changed on first use, and changing the password revokes all device sessions. Password authentication does not replace TLS; production deployments still require HTTPS/WSS or an encrypted network.

### Where Data Lives

- Remote host definitions: `~/.tmuxgo/hosts.json`
- Preferences and synced metadata: `~/.tmuxgo/preferences`
- Browser-local cache: `localStorage` / `sessionStorage`

## :beetle: Troubleshooting

Local startup logs:

```bash
tail -f /tmp/tmuxgo-gateway.log
tail -f /tmp/tmuxgo-agent.log
# systemd production instance:
# journalctl --user -u tmuxgo-gateway.service -f
```

Common issues:

1. Frontend changed but `3001` still serves the old UI: run `npm run build` to rebuild dist; if Gateway code changed, `systemctl --user restart tmuxgo-gateway` (or `./start.sh --restart`); do not validate against dev port `5199`
2. System clipboard copy fails: prefer an HTTPS top-level tab and confirm clipboard permission in the browser
3. Remote host connection fails: verify SSH reachability and confirm the target has `tmux`, `git`, and `python3`; install `sshpass` for password-based auth
4. Git push or pull behaves unexpectedly: verify `git` and `gh` auth on the target host first, then retry from TmuxGo

### macOS arm64

1. Symptom: opening a terminal or creating a session reports `posix_spawnp failed`. Cause: `node-pty` launches `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` with `posix_spawnp`, and the helper lacks an execute bit. Fix:

```bash
chmod 755 node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
/usr/local/bin/node scripts/smoke-node-pty.mjs
```

`PTY_ENGINE_OK` confirms that the `/bin/bash` PTY is working.

2. Symptom: other native files such as `.node`, `esbuild`, or `swc` also lack an execute bit. Cause: installation or extraction stripped `+x` from native binaries. Fix: `postinstall` now runs the repair automatically. Repair an existing installation with:

```bash
bash scripts/fix-native-perms.sh
```

The script uses BSD `find` compatible `-perm -u+x`:

```bash
find node_modules -type f \( -name '*.node' -o -name 'spawn-helper' -o -name 'esbuild' -o -name 'swc' \) ! -perm -u+x -exec chmod 755 {} +
```

3. Symptom: `brew install ripgrep` reports `Operation not permitted @ apply2files`. Cause: a sandbox blocked Homebrew writes to `/opt/homebrew`. Fix: use a terminal with system-directory write access, then install the official prebuilt binary through the GitHub proxy:

```bash
RG_VERSION=14.1.1
RG_ARCHIVE="ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz"
curl --http1.1 -fL -o "/tmp/${RG_ARCHIVE}" "https://gh-proxy.com/https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_ARCHIVE}"
tar -xzf "/tmp/${RG_ARCHIVE}" -C /tmp
cp "/tmp/ripgrep-${RG_VERSION}-aarch64-apple-darwin/rg" /opt/homebrew/bin/rg
chmod 755 /opt/homebrew/bin/rg
xattr -dr com.apple.quarantine /opt/homebrew/bin/rg
```

4. Symptom: GitHub release downloads fail with `curl: (28)`, `curl: (16) HTTP2 framing`, or `curl: (22) 502`. Cause: the proxy blocks or resets release downloads from `github.com`. Fix: use `curl --http1.1` and `https://gh-proxy.com/https://github.com/...` as in the preceding command.

5. Symptom: the current shell cannot find `tmux`, `rg`, or `brew`. Cause: Homebrew is at `/opt/homebrew`, but its `PATH` has not been loaded. Fix:

```bash
export PATH="/opt/homebrew/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

6. Symptom: `tmux ls` reports `error connecting to /private/tmp/tmux-501/default (No such file)`. Cause: no tmux server or `default` session is running. Fix:

```bash
/opt/homebrew/bin/tmux new-session -d -s default
```

7. Symptom: `http://localhost:3000` from the old README is unavailable. Cause: production only has the Gateway entry `3001` (API + WebSocket + Vite static frontend); there is no `3000` stable frontend process. Fix: open `http://localhost:3001`.

8. Symptom: unauthenticated `/api/hosts` returns `401 AUTH_REQUIRED`. Cause: Gateway authentication is enabled by default. Fix: log in first (default `admin/admin123`; password change forced on first login).
9. Symptom: `/api/hosts` returns `403 PASSWORD_CHANGE_REQUIRED` after login. Cause: the default `admin/admin123` account is still in use and requires a first-login password change. Fix: change the password in the browser and retry.

10. Symptom: `ps`, `sudo`, or writes to `/opt/homebrew` report `operation not permitted`. Cause: the command is running in a sandbox that restricts process inspection or system-directory writes. Fix: run the command outside the sandbox with system-directory write access.

11. Symptom: `/usr/bin/node: no such file or directory`. Cause: Node is installed at `/usr/local/bin/node` or managed by WorkBuddy at `~/.workbuddy/binaries/node`. Fix: use the actual Node path, for example `/usr/local/bin/node scripts/smoke-node-pty.mjs`; do not assume `/usr/bin/node` exists.

12. Symptom: `find` reports `bad mode '+111'`. Cause: BSD `find` on macOS does not support GNU `find`'s `-perm +111` syntax. Fix: use `-perm -u+x`, as shown in item 2.

Troubleshooting order:

1. Run `launchctl print gui/$(id -u)/com.tmuxgo.gateway` and inspect `~/Library/Logs/TmuxGo/gateway.log`
2. Run `lsof -nP -iTCP:3001 -sTCP:LISTEN`
3. Confirm that `tmux`, `rg`, `lsof`, `node`, and `python3` are in `PATH`
4. Run `bash scripts/fix-native-perms.sh` and `/usr/local/bin/node scripts/smoke-node-pty.mjs`
5. Log in and change the default password
6. Create a terminal and confirm `Attach completed` in the gateway log

## :handshake: Contributing

Issues, pull requests, and usage feedback are welcome. For development and verification commands, see [Development and Verification](#wrench-development-and-verification).

## :page_facing_up: License

MIT :copyright: 2026 Hongbin
