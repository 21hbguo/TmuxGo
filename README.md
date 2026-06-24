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
| :globe_with_meridians: **终端与 tmux** | 基于 `xterm.js` 的浏览器终端、tmux 会话附着、窗口/窗格拆分、缩放、共享/独占附着、命令面板与快捷操作 |
| :bookmark_tabs: **会话管理** | 新建、重命名、拖拽排序、批量删除、审计日志、自定义会话模板（窗口数、面板数、布局、初始命令） |
| :desktop_computer: **桌面工作区** | Activity Bar、Session Rail、可调整宽度的 Session/File/Git 面板、内嵌终端 Dock |
| :open_file_folder: **文件工作区** | `workspace` / `home` 根目录、文件名/内容搜索、收藏目录、点文件开关、文本/图片预览、新建/重命名/删除、路径插入终端、下载与上传队列 |
| :pencil2: **内置编辑器** | Monaco 编辑器、分栏编辑、拖拽打开到指定分屏、Markdown 预览、图片预览、Git Diff 查看、大文件/二进制只读保护 |
| :octocat: **Git 工作台** | 状态、历史图、分支、暂存/取消暂存、提交、丢弃改动、拉取/推送/合并、切换/新建/删除分支、固定仓库、跟随当前文件仓库、`gh` 设备登录辅助提示 |
| :satellite: **多主机** | 默认本地主机 + SSH 远端主机、连接测试、主机切换后终端/文件/Git 同步切换 |
| :iphone: **移动端 / PWA** | 抽屉导航、触控滚动、虚拟键盘、移动快捷条、剪贴板保护、添加到主屏幕安装横幅 |
| :brain: **持续化与同步** | 主题、快捷键、收藏、命令片段、会话顺序、Git 工作区状态、会话持续化会同步到浏览器本地与 `~/.tmuxgo/preferences` |
| :package: **版本与发布感知** | 稳定版/开发版前端分离、构建版本检查、发现新构建后前端提示刷新 |

## :rocket: 快速开始

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

安装完成后直接打开 `http://localhost:3000`。
Agent 默认不安装启动；需要本机 agent 时执行 `TMUXGO_ENABLE_AGENT=1 ./install.sh` 或 `TMUXGO_ENABLE_AGENT=1 ./start.sh --restart`。

> :bulb: 局域网可直接访问；远程访问建议先配置 [Tailscale](https://tailscale.com)。
> :lock: 若要稳定使用系统剪贴板复制，建议通过 HTTPS 域名访问，例如 Tailscale HTTPS。
> :desktop_computer: 部署端需要运行在支持 `tmux` 的环境中，推荐 Linux、macOS、WSL2；访问端只需要浏览器。

只安装依赖但不装常驻服务时，也可以手动启动：

```bash
./bootstrap.sh
./start.sh
```

## :traffic_light: 运行模式与重启规则

- `3000` 是稳定版前端，默认由 `.next-prod` 预构建产物提供服务，也是 `systemd`、`launchd`、Tailscale 对外暴露的地址
- `3001` 是 Gateway API 与 WebSocket 服务
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
launchctl print gui/$(id -u)/com.tmuxgo.frontend || launchctl print user/$(id -u)/com.tmuxgo.frontend
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
tail -f ~/Library/Logs/TmuxGo/frontend.log
tail -f ~/Library/Logs/TmuxGo/agent.log
```

## :package: 依赖要求

| 依赖 | 版本 | 必需 | 说明 |
|:-----|:-----|:----:|:-----|
| :green_circle: Node.js | >= 20 | :white_check_mark: | 运行时 |
| :green_circle: tmux | 任意 | :white_check_mark: | 终端复用器 |
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
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3001` | 前端访问 Gateway 的基地址 |
| `NEXT_DIST_DIR` | `.next` / `.next-prod` | 前端构建输出目录 |
| `TMUXGO_ENABLE_AGENT` | `0` | 设为 `1` 时启动或安装 Agent |
| `GATEWAY_URL` | `ws://localhost:3001/api/stream` | Agent 连接 Gateway 的 WebSocket 地址 |
| `HOST_ID` | `agent-local` | Agent 注册主机 ID |
| `HOST_NAME` | `local-machine` 或机器名 | Agent 注册显示名 |
| `TMUX_WEB_FILE_ROOTS` | `workspace=<repo>:home=<home>` | 文件树根目录列表，例如 `workspace=/srv/code:home=/home/guo` |
| `TMUXGO_PREFERENCES_DIR` | `~/.tmuxgo/preferences` | 偏好、收藏、会话持续化等同步存储目录 |
| `TMUXGO_CONFIG_DIR` | `~/.tmuxgo` | 主机配置目录，默认包含 `hosts.json` |
| `TMUX_WEB_ALLOWED_SESSIONS` | 空 | 逗号分隔的 tmux 会话白名单 |

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

## :page_facing_up: License

MIT :copyright: 2026 Hongbin
