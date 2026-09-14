<div align="center">

# :zap: TmuxGo

### :round_pushpin: 浏览器里的 tmux 工作台，桌面/手机/平板无缝接力

<p><strong>简体中文</strong> · <a href="README_EN.md">English</a></p>

> 不用装客户端，浏览器打开就是你的终端、文件区和 Git 工作台。  
> 在桌面开始，在手机继续，在平板查看。  
> **同一套会话，同一套上下文，不再断片。**

![TmuxGo cover](assets/cover_tmuxgo_cn_vip.png)

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

## :bookmark_tabs: 目录

- [为什么用 TmuxGo？](#fire-为什么用-tmuxgo)
- [功能总览](#sparkles-功能总览)
- [快速开始](#rocket-快速开始)
- [运行模式与重启规则](#traffic_light-运行模式与重启规则)
- [多主机与远程 SSH](#satellite-多主机与远程-ssh)
- [生产部署](#shield-生产部署)
- [安全部署](#lock-安全部署)
- [依赖要求](#package-依赖要求)
- [架构](#jigsaw-架构)
- [开发与验证](#wrench-开发与验证)
- [常用快捷键](#keyboard-常用快捷键)
- [配置与持久化](#gear-配置与持久化)
- [排障](#beetle-排障)
- [贡献](#handshake-贡献)
- [License](#page_facing_up-license)

## :fire: 为什么用 TmuxGo？

| :desktop_computer: **桌面** | :iphone: **手机** | 📟 **平板** |
|:---:|:---:|:---:|
| 多窗格、多编辑器、多侧栏并行工作 | 触控友好、虚拟按键、抽屉导航 | 分屏查看日志、代码、Git 历史 |

:point_right: **一个会话，三块屏幕，状态不丢、思路不断。**

- :globe_with_meridians: **随时访问** - 浏览器即可接入，本地、局域网、Tailscale 都可用
- :electric_plug: **会话常驻** - 浏览器关掉后，`tmux` 里的工作仍继续
- :repeat: **跨设备接力** - 会话、布局、活动窗格、恢复点都可延续
- :lock: **默认独占附着** - 桌面和移动端默认以独占模式恢复，避免误抢焦点

## :sparkles: 功能总览

| 模块 | 当前能力 |
|:-----|:---------|
| :globe_with_meridians: **终端与 tmux** | 基于 `xterm.js` 的浏览器终端、tmux 会话附着、窗口/窗格拆分、缩放、共享/独占附着、分屏会话、命令面板与快捷操作 |
| :bookmark_tabs: **会话管理** | 新建、重命名、拖拽排序、批量删除、审计日志、命名工作区、自定义会话模板（窗口数、面板数、布局、初始命令） |
| :desktop_computer: **桌面工作区** | Activity Bar、Session Rail、可调整宽度的 Session/File/Git 面板、内嵌终端 Dock |
| :open_file_folder: **文件工作区** | `workspace` / `home` 根目录、文件名/内容搜索、收藏目录、点文件开关、文本/图片预览、新建/重命名/删除、路径插入终端、下载与上传队列 |
| :pencil2: **内置编辑器** | Monaco 编辑器、分栏编辑、拖拽打开到指定分屏、Markdown 预览、图片预览、Git Diff 查看、大文件/二进制只读保护 |
| :octocat: **Git 工作台** | 状态、历史图、分支、暂存/取消暂存、提交、丢弃改动、拉取/推送/合并、切换/新建/删除分支、固定仓库、跟随当前文件仓库、`gh` 设备登录辅助提示 |
| :satellite: **多主机** | 默认本地主机 + SSH 远端主机、连接测试、主机切换后终端/文件/Git 同步切换 |
| :iphone: **移动端 / PWA** | 抽屉导航、触控滚动、虚拟键盘、移动快捷条、剪贴板保护、添加到主屏幕安装横幅 |
| :brain: **持续化与同步** | 主题、快捷键、收藏、命令片段、会话顺序、Git 工作区状态、会话持续化会同步到浏览器本地与 `~/.tmuxgo/preferences` |
| :package: **版本与发布感知** | 稳定版/开发版前端分离、构建版本检查、发现新构建后前端提示刷新 |

## :rocket: 快速开始

### npm 一键安装

macOS 或 Linux 直接执行：

```bash
npx --yes @21hbguo/tmuxgo install
```

该命令会安装 `tmux`、`ripgrep`、`python3`、`git`、`curl` 等生产依赖，复制预构建运行时到 `~/.tmuxgo/runtime`，创建 `default` tmux 会话并注册 Gateway 用户服务。它要求预先安装 Node.js 20 或更高版本；macOS 缺少 Homebrew 时会先安装 Homebrew。完成后打开 `http://localhost:3001`。

### 源码部署（开发或离线）

```bash
git clone https://github.com/21hbguo/TmuxGo.git
cd TmuxGo
./install.sh
```

`install.sh` 会自动完成这些事情：

- 安装或切换到 Node.js 20
- 安装 `tmux`、`ripgrep`、`lsof/ss`、`python3` 和原生构建工具链
- 执行 `npm install`
- 构建 Gateway 和稳定版 Frontend（`.next-prod`），设置 `TMUXGO_ENABLE_AGENT=1` 时同时构建 Agent
- 在 Linux 上安装并启动 `systemd --user` 服务
- 在 macOS 上安装并启动 `launchd` 服务
- 在没有常驻服务管理器的环境中回退到本地启动脚本
- 完成 `3000/3001` 健康检查，并输出本地地址与可用的 Tailscale HTTPS 地址

安装完成后，macOS 打开 `http://localhost:3001`；其他部署模式按启动输出打开对应地址。
Agent 默认不安装启动；需要本机 agent 时执行 `TMUXGO_ENABLE_AGENT=1 ./install.sh` 或 `TMUXGO_ENABLE_AGENT=1 ./start.sh --restart`。

> :lock: Gateway 默认只监听 `127.0.0.1`，不会直接暴露到局域网或公网。远程访问必须使用 Tailscale、WireGuard、SSH 隧道或 HTTPS 反向代理。
> :warning: 终端连接拥有完整的 tmux 输入、文件和 Git 操作权限；不要把未加密的 `ws://` 或未认证的 Gateway 暴露到不受信任网络。
> :bulb: 若要稳定使用系统剪贴板复制，建议通过 HTTPS 域名访问，例如 Tailscale HTTPS。
> :desktop_computer: 部署端需要运行在支持 `tmux` 的环境中，推荐 Linux、macOS、WSL2；访问端只需要浏览器。

只安装依赖但不装常驻服务时，也可以手动启动：

```bash
./bootstrap.sh
./start.sh
```

发布 npm 包：

```bash
npm login
npm run pack:npx
npm run publish:npx
```

## :traffic_light: 运行模式与重启规则

- `3000` 是 `start.sh` 启动的稳定版前端地址
- macOS 的 `launchd` 只启动 `com.tmuxgo.gateway`，Gateway 在 `3001` 同时提供前端、API 与 WebSocket 服务
- `3002` 是开发版前端地址，使用本地启动或 `npm run dev:frontend` 时启用热更新
- 只执行 `build` / `test` 不会让已经运行的稳定版 `3000/3001` 自动更新
- 改完源码要让稳定版立即生效，执行 `./start.sh --restart`
- 如果前端源码比 `.next-prod` 新，`./start.sh --restart` 会自动升级为重建稳定版
- 需要显式强制重建时执行 `./start.sh --restart --rebuild`
- 不使用 `systemd` / `launchd` 的本地生产启动可执行 `./start-prod.sh`

## :satellite: 多主机与远程 SSH

- 默认内置 `local` 主机，所有会话、文件和 Git 操作都先在本机可用
- 可以在设置面板里新增远端主机：`id / address / user / port / password / passwordEnv`
- 主机切换后，Session 列表、文件树、编辑器打开目标、Git 状态都会跟随切换
- 优先推荐 SSH Key；如果使用密码或密码环境变量，需要额外安装 `sshpass`
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
systemctl --user status tmuxgo-frontend.service
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
journalctl --user -u tmuxgo-frontend.service -f
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
┌──────────┐   WebSocket    ┌──────────┐   PTY / SSH / Git / Files   ┌──────────┐
│ Frontend │ ◄────────────► │ Gateway  │ ◄──────────────────────────► │  Agent   │
│ (Next.js)│                │ (Fastify)│                               │ (tmux)   │
└──────────┘                └──────────┘                               └──────────┘
```

| 服务 | 端口 | 技术栈 |
|:-----|:-----|:-------|
| :globe_with_meridians: Frontend（稳定版） | `3000` | Next.js 14、React 18、xterm.js、Monaco、Tailwind |
| :hammer_and_wrench: Frontend（开发版） | `3002` | Next.js 热更新 |
| :electric_plug: Gateway | `3001` | Fastify、WebSocket、node-pty、SSH、文件与 Git 路由 |
| :satellite: Agent（可选） | - | `tmux` 附着、主机注册、终端流转发 |
| :lock: Tailscale HTTPS | `443`、`8443` | `start.sh` 自动配置到前端与 Gateway |

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
2. `./start.sh --restart`
3. 检查 `3000` 或 Tailscale HTTPS 是否已经加载新构建，而不是只看 `3002`

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
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3001` | 前端访问 Gateway 的基地址 |
| `NEXT_DIST_DIR` | `.next` / `.next-prod` | 前端构建输出目录 |
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

Gateway 默认启用账号认证。认证状态与设备会话保存在 `~/.tmuxgo/auth.json`，浏览器首次登录后会自动续期；使用默认 `admin/admin123` 登录时必须修改密码，修改密码会撤销所有设备会话。认证是密码认证，不等同于 TLS；生产环境仍必须使用 HTTPS/WSS 或加密网络。

### 数据落点

- 远端主机配置：`~/.tmuxgo/hosts.json`
- 偏好与同步数据：`~/.tmuxgo/preferences`
- 浏览器本地缓存：`localStorage` / `sessionStorage`

## :beetle: 排障

本地启动日志：

```bash
tail -f /tmp/tmuxgo-gateway.log
tail -f /tmp/tmuxgo-frontend-stable.log
tail -f /tmp/tmuxgo-frontend-dev.log
tail -f /tmp/tmuxgo-agent.log
```

常见问题：

1. `3002` 看到了新页面，但 `3000` 还是旧版本：执行 `./start.sh --restart`，必要时加 `--rebuild`
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

7. 现象：按旧 README 打开 `http://localhost:3000` 无法访问。根因：macOS 仅注册 `com.tmuxgo.gateway`，前端由 Gateway 一并在 `3001` 提供。修法：打开 `http://localhost:3001`。

8. 现象：登录后请求 `/api/hosts` 返回 `403 PASSWORD_CHANGE_REQUIRED`。根因：仍在使用默认账号 `admin/admin123`，首次登录被强制修改密码。修法：按浏览器提示修改密码后重试。

9. 现象：`ps`、`sudo` 或写入 `/opt/homebrew` 报 `operation not permitted`。根因：命令仍在沙箱内，进程枚举或系统目录写入被限制。修法：关闭沙箱并使用带系统目录写权限的终端后，再执行权限修复、安装或复制命令。

10. 现象：`/usr/bin/node: no such file or directory`。根因：Node 实际安装在 `/usr/local/bin/node`，也可能由 WorkBuddy 在 `~/.workbuddy/binaries/node` 管理。修法：使用实际路径运行 PTY 冒烟测试，例如 `/usr/local/bin/node scripts/smoke-node-pty.mjs`，不要假设 `/usr/bin/node` 存在。

11. 现象：`find` 报 `bad mode '+111'`。根因：macOS 的 BSD `find` 不支持 GNU `find` 的 `-perm +111` 写法。修法：使用 `-perm -u+x`，见第 2 项命令。

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
