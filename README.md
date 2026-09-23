<div align="center">

<br />

# ⚡ TmuxGo

### 把 `tmux` 变成一个随处可开的浏览器工作台

**Terminal · Files · Editor · Git · Multi-host · PWA**

<p>
  <a href="README_EN.md">English</a>
  ·
  <strong>简体中文</strong>
</p>

<p>
  <a href="https://github.com/21hbguo/TmuxGo/actions/workflows/ci.yml">
    <img src="https://github.com/21hbguo/TmuxGo/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI">
  </a>
  <a href="https://github.com/21hbguo/TmuxGo/stargazers">
    <img src="https://img.shields.io/github/stars/21hbguo/TmuxGo?style=flat-square&logo=github" alt="GitHub stars">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/21hbguo/TmuxGo?style=flat-square" alt="License">
  </a>
  <a href="https://nodejs.org">
    <img src="https://img.shields.io/badge/Node.js-%5E20.19%20%7C%20%5E22.12%20%7C%20%3E%3D24-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  </a>
</p>

<p>
  <a href="#rocket-快速开始"><strong>快速开始</strong></a>
  ·
  <a href="#sparkles-功能亮点"><strong>功能亮点</strong></a>
  ·
  <a href="#lock-安全部署"><strong>安全部署</strong></a>
  ·
  <a href="#wrench-开发与验证"><strong>开发</strong></a>
</p>

<br />

<img src="assets/cover_tmuxgo_cn_vip.png" alt="TmuxGo browser tmux workspace" width="100%" />

<br />

<p>
  <strong>让终端继续活着，让工作区跟着你走。</strong><br />
  浏览器关掉，tmux 会话仍在；换到手机、平板或另一台电脑，继续同一个上下文。
</p>

</div>

---

## :rocket: 一条命令开始

在 macOS 或 Linux 上：

```bash
npx --yes @21hbguo/tmuxgo install
```

安装完成后打开：

```text
http://localhost:3001
```

> 部署端运行 TmuxGo，访问端只需要浏览器。Gateway 默认绑定 `127.0.0.1`，远程访问建议使用 Tailscale / WireGuard / SSH Tunnel / HTTPS 反向代理。

## :fire: 为什么是 TmuxGo？

<table>
<tr>
<td width="50%" valign="top">

### 🌐 Browser-first

不用额外安装桌面客户端。终端、文件、编辑器和 Git 都在浏览器里，适合本机、服务器与远程开发环境。

</td>
<td width="50%" valign="top">

### 🧠 Context stays alive

浏览器可以关，`tmux` 不会停。长时间训练、编译、日志和交互式任务可以持续运行，再回来继续。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧰 IDE-like workspace

不只是 Web Terminal。TmuxGo 把 Session、Files、Monaco Editor、Git Workbench 和 Terminal Dock 放进同一个工作区。

</td>
<td width="50%" valign="top">

### 📱 Cross-device handoff

桌面开始，手机看状态，平板继续处理。会话、布局和活动上下文可以持续衔接。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🖥️ Multi-host

本地主机和 SSH 远端主机统一管理。切换主机时，会话、文件和 Git 上下文一起切换。

</td>
<td width="50%" valign="top">

### 🔐 Security-aware

默认仅监听本机，内置认证，并明确区分 HTTP/WS 与 HTTPS/WSS 场景，适合通过私有网络或反向代理安全暴露。

</td>
</tr>
</table>

> **适合这些场景：** 远程开发 · 长时间训练/实验 · Homelab/服务器运维 · 多仓库 Git 工作流 · 移动端查看任务状态

## :sparkles: 功能亮点

| 能力 | 你能做什么 |
|:--|:--|
| **Terminal + tmux** | 浏览器终端、tmux attach、窗口/窗格拆分、缩放、共享/独占附着、分屏会话、快捷操作 |
| **Workspace + Sessions** | 命名工作区、会话模板、拖拽排序、批量管理、跨工作区组织 tmux session |
| **Files + Editor** | 文件树、搜索、上传下载、Monaco 编辑器、Markdown / 图片预览、分栏编辑 |
| **Git Workbench** | Status、History、Branch、Stage/Unstage、Commit、Pull/Push/Merge、Diff |
| **Remote Hosts** | 本地主机 + SSH 远程主机、连接测试、主机级 Session / Files / Git 切换 |
| **Mobile / PWA** | 触控导航、虚拟按键、快捷条、剪贴板保护、添加到主屏幕 |
| **Persistence** | 主题、快捷键、收藏、会话顺序、工作区状态和恢复信息持久化 |
| **Security** | 本地监听默认值、账号认证、一次性 WebSocket ticket、HTTPS/Tailscale 部署路径 |

<details>
<summary><strong>完整功能说明</strong></summary>

<br />

- **会话管理**：新建、重命名、拖拽排序、批量删除、审计日志、命名工作区、自定义 Session Template
- **桌面布局**：Activity Bar、Session Rail、可调整宽度的 Session / File / Git 面板、Terminal Dock
- **文件能力**：`workspace` / `home` 根目录、文件名/内容搜索、收藏、点文件、文本/图片预览、上传下载
- **编辑器**：Monaco、分栏编辑、拖拽到指定分屏、Markdown 预览、Git Diff、大文件/二进制保护
- **Git**：状态、历史图、分支、暂存、提交、丢弃、拉取、推送、合并、固定仓库
- **多主机**：Local + SSH Remote；切换主机后 Session / Files / Git 同步切换
- **移动端**：Drawer、触控滚动、虚拟键盘、移动快捷条、PWA 安装
- **同步**：浏览器本地状态 + `~/.tmuxgo/preferences` 持久化

</details>

## :rocket: 快速开始

### 推荐：npm 一键安装

```bash
npx --yes @21hbguo/tmuxgo install
```

该命令会准备运行依赖、复制预构建运行时到 `~/.tmuxgo/runtime`、创建默认 tmux 会话并注册 Gateway 用户服务。Node.js 需要满足 `^20.19 || ^22.12 || >=24`。

### 从源码部署

```bash
git clone https://github.com/21hbguo/TmuxGo.git
cd TmuxGo
./install.sh
```

安装脚本会处理 Node.js、tmux、ripgrep、原生构建工具链、Frontend/Gateway 构建，以及 Linux `systemd --user` / macOS `launchd` 服务。

需要本机 Agent 时：

```bash
TMUXGO_ENABLE_AGENT=1 ./install.sh
```

### 手动启动

```bash
./bootstrap.sh
./start.sh
```

> [!IMPORTANT]
> TmuxGo 的终端连接拥有实际的 shell、文件与 Git 操作能力。不要把未认证或未加密的 Gateway 暴露到不受信任网络。

## :compass: 文档导航

| 想了解 | 入口 |
|:--|:--|
| TmuxGo 在生产和开发模式下如何运行 | [运行模式与重启规则](#traffic_light-运行模式与重启规则) |
| 如何管理本地与 SSH 远端机器 | [多主机与远程 SSH](#satellite-多主机与远程-ssh) |
| 如何部署到 Linux / macOS / Docker | [生产部署](#shield-生产部署) |
| 如何使用 HTTPS、Tailscale、WireGuard | [安全部署](#lock-安全部署) |
| 系统和依赖要求 | [依赖要求](#package-依赖要求) |
| 前后端 / Gateway / Agent 结构 | [架构](#jigsaw-架构) |
| 开发、测试、CI | [开发与验证](#wrench-开发与验证) |
| 快捷键 | [常用快捷键](#keyboard-常用快捷键) |
| 环境变量和持久化 | [配置与持久化](#gear-配置与持久化) |
| 常见错误 | [排障](#beetle-排障) |

## :traffic_light: 运行模式与重启规则

- **生产入口只有 `3001`**：Gateway 同时提供 API、WebSocket 与静态前端；`http://127.0.0.1:3001/` 返回 `200`
- 生产环境没有独立的 `3000` 稳定前端进程，也没有 `3002` Next.js 热更端口；前端是 Vite 构建产物，由 Gateway 托管
- Linux 生产实例用 systemd user service：改 Gateway 源码后执行 `systemctl --user restart tmuxgo-gateway`
- 改前端源码后执行 `npm run build`（或 `npm run build:frontend`）重建 `apps/frontend/dist`；Gateway 按请求读取 dist，无需为静态资源单独重启
- 开发实例为 `3101` Gateway + `5199` Vite dev（热更新），与生产入口分离
- 只执行 `build` / `test` 不会让已经在跑的 Gateway 进程加载新的 Gateway 代码；Gateway 代码变更必须 restart
- 需要脚本方式重建并重启时仍可使用 `./start.sh --restart`（可加 `--rebuild` 强制重建）
- 不使用 `systemd` / `launchd` 的本地生产启动可执行 `./start-prod.sh`

## :satellite: 多主机与远程 SSH

- 默认内置 `local` 主机，所有会话、文件和 Git 操作都先在本机可用
- 可以在设置面板里新增远端主机：`id / address / user / port / password / passwordEnv`
- 主机切换后，Session 列表、文件树、编辑器打开目标、Git 状态都会跟随切换
- 优先推荐 SSH Key；如果使用密码或密码环境变量，需要额外安装 `sshpass`
- 主机 `useAgent: true` 表示用 SSH Agent 认证，要求部署端已有可用的 SSH Agent（`SSH_AUTH_SOCK`）
- TmuxGo Agent 组件默认不安装（`TMUXGO_ENABLE_AGENT` 默认 `0`）；需要 Agent 能力时显式启用
- 主机配置默认保存在 `~/.tmuxgo/hosts.json`，也可以通过 `TMUXGO_CONFIG_DIR` 改位置

## :shield: 生产部署

新机器推荐直接执行：

```bash
git clone https://github.com/21hbguo/TmuxGo.git
cd TmuxGo
./install.sh
```

如果依赖已经装好，只想重装常驻服务：

Linux:

```bash
./scripts/install-systemd-user-linux.sh
```

macOS:

```bash
./scripts/install-launchd-user-mac.sh
```

需要同时安装并启动 Agent 时，在安装命令前加 `TMUXGO_ENABLE_AGENT=1`。

停止全部服务：

Linux:

```bash
./scripts/stop-systemd-user-linux.sh
```

macOS:

```bash
./scripts/stop-launchd-user-mac.sh
```

卸载全部单元：

Linux:

```bash
./scripts/uninstall-systemd-user-linux.sh
```

macOS:

```bash
./scripts/uninstall-launchd-user-mac.sh
```

查看服务状态：

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

查看日志：

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

## :lock: 安全部署

### 默认安全模型

- Gateway 默认绑定 `127.0.0.1:3001`，只允许本机访问；设置 `TMUXGO_HOST=0.0.0.0` 或其他非回环地址才会对网络开放。
- Gateway 默认启用内置账号密码认证，默认账号为 `admin`，首次使用 `admin/admin123` 登录后必须修改密码。认证状态和设备会话保存在 `~/.tmuxgo/auth.json`，文件权限会限制为仅当前用户可读写。
- API 使用短期 access token 和 HttpOnly cookie；终端 WebSocket 必须先获取一次性短期 ticket。显式创建的共享链接是唯一的匿名例外，并且只允许指定会话的只读附着。
- Gateway 本身不负责 TLS 终止。`ws://` 和 `http://` 不提供传输加密；跨设备访问必须让浏览器使用 HTTPS/WSS，或先通过 Tailscale、WireGuard、SSH 隧道等加密网络接入。
- 将 `TMUXGO_AUTH_USERNAME` 或 `TMUXGO_AUTH_PASSWORD` 设为空会关闭认证，仅适合本机开发。非回环地址下关闭认证时 Gateway 默认拒绝启动，只有显式设置 `TMUXGO_ALLOW_INSECURE=1` 才会继续。

### 启动安全检查

每次 Gateway 启动都会检查并在日志中输出：认证是否启用、默认密码是否仍在使用、监听地址是否为回环地址、是否配置了加密传输信号，以及 `tmux -V` 是否达到安全基线。

- 非回环监听且没有 `TMUXGO_PUBLIC_URL=https://...` / `wss://...`、`TMUXGO_TLS_TERMINATED=1` 或 `TMUXGO_ENCRYPTED_TRANSPORT=1` 时，会输出明显的未加密传输警告。
- 默认密码仍在使用时，会输出修改密码提示；非回环监听会直接拒绝启动，先绑定到 localhost 修改密码。
- 推荐最低 `tmux` 安全版本为 [3.6b](https://github.com/tmux/tmux/releases/tag/3.6b)，该版本包含 [CVE-2026-11623](https://nvd.nist.gov/vuln/detail/CVE-2026-11623) 修复；当前上游稳定版为 [3.7c](https://github.com/tmux/tmux/releases/tag/3.7c)。发行版如果提供了安全回补版本可以继续使用，但仍应定期更新系统包。

检查版本：

```bash
tmux -V
```

升级示例：

```bash
sudo apt update && sudo apt install --only-upgrade tmux
brew update && brew upgrade tmux
```

### HTTPS 反向代理

先保持 Gateway 只监听本机：

```bash
export TMUXGO_HOST=127.0.0.1
export TMUXGO_PUBLIC_URL=https://tmuxgo.example.com
```

Nginx 配置模板见 [`deploy/nginx/tmuxgo.conf.example`](deploy/nginx/tmuxgo.conf.example)，Caddy 配置模板见 [`deploy/caddy/Caddyfile.example`](deploy/caddy/Caddyfile.example)。两者都必须转发 WebSocket Upgrade，并向 Gateway 传递 `X-Forwarded-Proto: https`。代理完成 TLS 后，浏览器会自动使用 `wss://` 连接 `/api/stream`。

Nginx 申请 Let's Encrypt 证书后，将证书路径和域名写入模板；Caddy 使用域名启动后会自动申请和续期证书。反向代理的 443 端口应通过防火墙限制来源，3001 只保留本机监听。

### Tailscale、WireGuard 与 SSH 隧道

Tailscale：

```bash
tailscale serve --yes --bg --https=443 http://127.0.0.1:3001
```

`./start.sh` 检测到已连接的 Tailscale 后也会尝试配置 HTTPS。访问输出的 `https://...ts.net` 地址，不要把 `:3001` 的明文地址分享给其他设备。

WireGuard 等已经提供加密的私有网络可以让 Gateway 绑定 VPN 地址，并设置加密传输标记：

```bash
TMUXGO_HOST=10.8.0.1 TMUXGO_ENCRYPTED_TRANSPORT=1 ./start-prod.sh
```

SSH 隧道适合临时管理：

```bash
ssh -N -L 3001:127.0.0.1:3001 user@gateway-host
```

然后在本机打开 `http://127.0.0.1:3001`。生产环境仍建议使用 HTTPS 反向代理或 VPN，并在防火墙中拒绝来自公网的 3001 端口。例如仅开放 HTTPS：

```bash
sudo ufw allow 443/tcp
sudo ufw deny 3001/tcp
```

### Docker

Docker 示例默认只把宿主机的 3001 端口发布到回环地址：

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

`deploy/docker-compose.yml` 使用 `127.0.0.1:3001:3001`，容器内部必须监听 `0.0.0.0` 才能接收 Docker 转发；这不会改变宿主机只允许本机访问的边界。需要远程访问时，在宿主机上配置 HTTPS 反向代理或 VPN，不要直接改成 `3001:3001`。

## :package: 依赖要求

| 依赖 | 版本 | 必需 | 说明 |
|:-----|:-----|:----:|:-----|
| :green_circle: Node.js | >= 20 | :white_check_mark: | 运行时 |
| :green_circle: tmux | >= 3.6b（或发行版安全回补） | :white_check_mark: | 终端复用器；旧版本启动时会告警 |
| :green_circle: 构建工具链 | `make` / `g++` / `pkg-config` | :white_check_mark: | `node-pty` 原生依赖 |
| :green_circle: 基础工具 | `git` / `curl` / `python3` / `ripgrep` / `lsof` 或 `ss` | :white_check_mark: | 安装、文件搜索、启动脚本依赖 |
| :blue_circle: Tailscale | 最新版 | :o: | 远程访问、HTTPS 暴露 |
| :blue_circle: sshpass | 最新版 | :o: | 仅密码式 SSH 远端主机需要 |
| :blue_circle: GitHub CLI (`gh`) | 最新版 | :o: | GitHub 设备登录辅助与认证状态检测 |
| :desktop_computer: 系统 | Linux / macOS / WSL2 | - | 部署端运行环境 |

```bash
node -v && npm -v && tmux -V
tailscale version
```

## :jigsaw: 架构

```text
┌──────────────┐   HTTP / WS    ┌──────────────────────────────┐   PTY / SSH / Git / Files   ┌──────────┐
│ Vite 静态资源 │ ◄────────────► │ Gateway :3001                │ ◄──────────────────────────► │  Agent   │
│ (dist 托管)   │  同源托管于 3001 │ API + WebSocket + 静态前端    │                               │ (tmux)   │
└──────────────┘                └──────────────────────────────┘                               └──────────┘
```

| 服务 | 端口 | 技术栈 |
|:-----|:-----|:-------|
| :globe_with_meridians: Frontend 静态资源（生产） | 由 Gateway `3001` 托管 | Vite 8 构建的 `apps/frontend/dist`，React 18、xterm.js、Monaco、Tailwind |
| :electric_plug: Gateway（生产唯一入口） | `3001` | Fastify、WebSocket、node-pty、SSH、文件与 Git 路由；同源托管静态前端 |
| :hammer_and_wrench: Gateway + Vite（开发） | `3101` + `5199` | dev Gateway + Vite dev 热更新（`npm run dev`） |
| :satellite: Agent（可选，默认不装） | - | `tmux` 附着、主机注册、终端流转发；需 `TMUXGO_ENABLE_AGENT=1` |
| :lock: Tailscale HTTPS | `443`、`8443` | `start.sh` 自动配置到 `3001` |

## :wrench: 开发与验证

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

真实 SSH 集成验证不会纳入默认测试。它会在指定远端创建并删除临时 tmux 会话，覆盖严格 known-hosts 校验、密钥或 SSH Agent 认证、可选 ProxyJump、终端附着/缩放/输入回显和 Gateway 重启后的再次附着。

```bash
TMUXGO_SSH_E2E_HOST=203.0.113.10 \
TMUXGO_SSH_E2E_USER=deploy \
TMUXGO_SSH_E2E_AUTH=agent \
npm run test:ssh-e2e
```

密钥认证时设置 `TMUXGO_SSH_E2E_AUTH=key` 和 `TMUXGO_SSH_E2E_PRIVATE_KEY_PATH`；跳板机设置 `TMUXGO_SSH_E2E_JUMP_HOST`。测试固定使用严格的 `known_hosts` 校验。

交付时建议按这个顺序验证：

1. `npm test` / `npm run test:frontend` / 必要时 `npm run test:e2e`
2. 改了前端就 `npm run build` 重建 `apps/frontend/dist`；改了 Gateway 就 `systemctl --user restart tmuxgo-gateway`（脚本部署可用 `./start.sh --restart`）
3. 只检查生产入口 `http://127.0.0.1:3001/` 或 Tailscale HTTPS 是否已经加载新构建；不要用开发端口 `5199` 当交付依据

## :keyboard: 常用快捷键

| 快捷键 | 作用 |
|:-------|:-----|
| `Ctrl+K` / `Cmd+K` | 打开或关闭命令面板 |
| `Ctrl+B` / `Cmd+B` | 打开或关闭会话侧栏 |
| `Ctrl+E` / `Cmd+E` | 打开或关闭文件资源管理器 |
| Quick Actions / 移动快捷条 | 发送回车、删词、清行、分屏、聚焦、关闭面板 |

> :bulb: `tmux` 原生快捷键仍然可以在终端内继续使用；自定义快捷键会同步保存到偏好存储。

## :gear: 配置与持久化

### 环境变量

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `PORT` | `3001` | Gateway 监听端口 |
| `TMUXGO_HOST` | `127.0.0.1` | Gateway 监听地址；远程部署前必须配置加密网络或 HTTPS |
| `VITE_API_URL` | `http://127.0.0.1:3001` | 构建/开发时代理或访问 Gateway 的基地址 |
| `TMUXGO_FRONTEND_DIST` | `apps/frontend/dist` | Gateway 托管的前端静态资源目录 |
| `TMUXGO_ENABLE_AGENT` | `0` | 设为 `1` 时启动或安装 Agent |
| `GATEWAY_URL` | `ws://localhost:3001/api/stream` | Agent 连接 Gateway 的 WebSocket 地址 |
| `TMUXGO_AUTH_USERNAME` | `admin` | Gateway 登录账号 |
| `TMUXGO_AUTH_PASSWORD` | `admin123` | Gateway 登录密码；首次以默认密码登录时必须修改 |
| `TMUXGO_PUBLIC_URL` | 空 | 对外访问地址；使用 `https://` 或 `wss://` 表示已配置 TLS |
| `TMUXGO_TLS_TERMINATED` | `0` | 反向代理已完成 TLS 终止时设为 `1` |
| `TMUXGO_ENCRYPTED_TRANSPORT` | `0` | Tailscale / WireGuard / SSH 隧道等外层加密已启用时设为 `1` |
| `TMUXGO_ALLOW_INSECURE` | `0` | 允许非回环未认证 Gateway 启动；仅用于明确的临时测试 |
| `GATEWAY_USERNAME` | `admin` | Agent 连接 Gateway 使用的账号 |
| `GATEWAY_PASSWORD` | 空 | Agent 连接 Gateway 使用的密码，启用认证时必须显式设置 |
| `HOST_ID` | `agent-local` | Agent 注册主机 ID |
| `HOST_NAME` | `local-machine` 或机器名 | Agent 注册显示名 |
| `TMUX_WEB_FILE_ROOTS` | `workspace=<repo>:home=<home>` | 文件树根目录列表，例如 `workspace=/srv/code:home=/home/guo` |
| `TMUXGO_PREFERENCES_DIR` | `~/.tmuxgo/preferences` | 偏好、收藏、会话持续化等同步存储目录 |
| `TMUXGO_CONFIG_DIR` | `~/.tmuxgo` | 主机配置目录，默认包含 `hosts.json` |
| `TMUXGO_ALLOWED_ORIGINS` | 空 | 额外允许访问 Gateway 的浏览器 Origin，多个值用逗号分隔 |
| `TMUX_WEB_ALLOWED_SESSIONS` | 空 | 逗号分隔的 tmux 会话白名单 |

Gateway 默认启用账号认证。未登录访问受保护 API（如 `/api/hosts`）返回 `401`。认证状态与设备会话保存在 `~/.tmuxgo/auth.json`，浏览器首次登录后会自动续期；使用默认 `admin/admin123` 登录时必须修改密码，修改密码会撤销所有设备会话。认证是密码认证，不等同于 TLS；生产环境仍必须使用 HTTPS/WSS 或加密网络。

### 数据落点

- 远端主机配置：`~/.tmuxgo/hosts.json`
- 偏好与同步数据：`~/.tmuxgo/preferences`
- 浏览器本地缓存：`localStorage` / `sessionStorage`

## :beetle: 排障

本地启动日志：

```bash
tail -f /tmp/tmuxgo-gateway.log
tail -f /tmp/tmuxgo-agent.log
# systemd 生产实例：
# journalctl --user -u tmuxgo-gateway.service -f
```

常见问题：

1. 改了前端但 `3001` 仍是旧页面：先 `npm run build` 重建 dist；Gateway 代码有变时 `systemctl --user restart tmuxgo-gateway`（或 `./start.sh --restart`），不要去盯开发端口 `5199`
2. 系统剪贴板复制失败：优先使用 HTTPS 顶层标签页，确认浏览器站点权限允许剪贴板访问
3. 远端主机连接失败：检查 SSH 连通性、目标机是否安装 `tmux` / `git` / `python3`，密码式连接确认 `sshpass` 已安装
4. Git 推送/拉取异常：先在目标主机确认 `git` 与 `gh` 认证状态，再回到 TmuxGo 操作

### macOS arm64

1. 现象：开终端或新建会话报 `posix_spawnp failed`，与使用 `bash` 或 `zsh` 无关。根因：`node-pty` 通过 `posix_spawnp` 执行 `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`，该文件缺少执行位。修法：

```bash
chmod 755 node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
/usr/local/bin/node scripts/smoke-node-pty.mjs
```

输出 `PTY_ENGINE_OK` 表示 `/bin/bash` PTY 可用。

2. 现象：`spawn-helper` 之外，`.node`、`esbuild` 或 `swc` 等原生文件也没有执行位。根因：安装或解压时整批原生二进制丢失 `+x`。修法：项目已通过 `postinstall` 自动执行下列脚本；修复现有安装时直接运行：

```bash
bash scripts/fix-native-perms.sh
```

脚本使用 macOS BSD `find` 兼容的 `-perm -u+x`，等价于：

```bash
find node_modules -type f \( -name '*.node' -o -name 'spawn-helper' -o -name 'esbuild' -o -name 'swc' \) ! -perm -u+x -exec chmod 755 {} +
```

3. 现象：`brew install ripgrep` 报 `Operation not permitted @ apply2files`。根因：沙箱拦截了 Homebrew 对 `/opt/homebrew` 的写入。修法：在带系统目录写权限的终端中绕过 Homebrew，下载官方预编译包：

```bash
RG_VERSION=14.1.1
RG_ARCHIVE="ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz"
curl --http1.1 -fL -o "/tmp/${RG_ARCHIVE}" "https://gh-proxy.com/https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_ARCHIVE}"
tar -xzf "/tmp/${RG_ARCHIVE}" -C /tmp
cp "/tmp/ripgrep-${RG_VERSION}-aarch64-apple-darwin/rg" /opt/homebrew/bin/rg
chmod 755 /opt/homebrew/bin/rg
xattr -dr com.apple.quarantine /opt/homebrew/bin/rg
```

4. 现象：GitHub release 下载报 `curl: (28)`、`curl: (16) HTTP2 framing` 或 `curl: (22) 502`。根因：代理阻断或重置了直连 `github.com` 的发布文件请求。修法：强制 HTTP/1.1，并通过 `https://gh-proxy.com/https://github.com/...` 下载，如上例。

5. 现象：当前 shell 找不到 `tmux`、`rg` 或 `brew`。根因：Homebrew 位于 `/opt/homebrew`，但未加载到 `PATH`。修法：

```bash
export PATH="/opt/homebrew/bin:$PATH"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

6. 现象：`tmux ls` 报 `error connecting to /private/tmp/tmux-501/default (No such file)`。根因：没有正在运行的 tmux server，`default` 会话也不存在。修法：

```bash
/opt/homebrew/bin/tmux new-session -d -s default
```

7. 现象：按旧 README 打开 `http://localhost:3000` 无法访问。根因：生产只有 Gateway 入口 `3001`（API + WebSocket + Vite 静态前端），不存在 `3000` 稳定前端进程。修法：打开 `http://localhost:3001`。

8. 现象：未登录请求 `/api/hosts` 返回 `401 AUTH_REQUIRED`。根因：Gateway 默认启用账号认证。修法：先登录（默认 `admin/admin123`，首次强制改密）。
9. 现象：登录后请求 `/api/hosts` 返回 `403 PASSWORD_CHANGE_REQUIRED`。根因：仍在使用默认账号 `admin/admin123`，首次登录被强制修改密码。修法：按浏览器提示修改密码后重试。

10. 现象：`ps`、`sudo` 或写入 `/opt/homebrew` 报 `operation not permitted`。根因：命令仍在沙箱内，进程枚举或系统目录写入被限制。修法：关闭沙箱并使用带系统目录写权限的终端后，再执行权限修复、安装或复制命令。

11. 现象：`/usr/bin/node: no such file or directory`。根因：Node 实际安装在 `/usr/local/bin/node`，也可能由 WorkBuddy 在 `~/.workbuddy/binaries/node` 管理。修法：使用实际路径运行 PTY 冒烟测试，例如 `/usr/local/bin/node scripts/smoke-node-pty.mjs`，不要假设 `/usr/bin/node` 存在。

12. 现象：`find` 报 `bad mode '+111'`。根因：macOS 的 BSD `find` 不支持 GNU `find` 的 `-perm +111` 写法。修法：使用 `-perm -u+x`，见第 2 项命令。

排障顺序：

1. `launchctl print gui/$(id -u)/com.tmuxgo.gateway`，并检查 `~/Library/Logs/TmuxGo/gateway.log`
2. `lsof -nP -iTCP:3001 -sTCP:LISTEN`
3. 确认 `tmux`、`rg`、`lsof`、`node`、`python3` 都在 `PATH`
4. 运行 `bash scripts/fix-native-perms.sh` 和 `/usr/local/bin/node scripts/smoke-node-pty.mjs`
5. 登录并修改默认密码
6. 新建终端，确认 gateway 日志出现 `Attach completed`

## :handshake: 贡献

欢迎提交 Issue、PR 或使用反馈。开发与验证命令见 [开发与验证](#wrench-开发与验证)。

## :page_facing_up: License

MIT :copyright: 2026 Hongbin
