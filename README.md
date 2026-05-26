<div align="center">

# :zap: TmuxGo

### :round_pushpin: 浏览器打开即用，任意设备无缝接力

> 不用装客户端，浏览器打开就是你的终端。
> 在桌面开始，在手机继续，在平板查看。
> **思路不中断，现场不丢失。**

![TmuxGo cover](assets/cover_tmuxgo_cn_vip.png)

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

## :fire: 为什么用 TmuxGo？

| :desktop_computer: **桌面** | :iphone: **手机** | 📟 **平板** |
|:---:|:---:|:---:|
| 全键盘、多窗格高效操作 | 触控友好、虚拟按键补全输入 | 分屏并排，适合查看与跟进 |

:point_right: **一个会话，三块屏幕，过程不中断。**

- :globe_with_meridians: **随时访问** - 基于 Tailscale 的安全远程访问，无需手动做端口映射
- :electric_plug: **会话常驻** - 即使关闭浏览器，tmux 里的工作仍然持续存在
- :zap: **秒级恢复** - 重新连接后立刻回到上次停下的位置
- :brain: **上下文保留** - 窗格、布局、历史记录都完整保留
- :lock: **默认独占附着** - 桌面端和移动端默认都以独占模式打开会话

## :sparkles: 功能特性

| 功能 | 说明 |
|:--------|:------------|
| :globe_with_meridians: **浏览器终端** | 基于 xterm.js 的完整终端体验，直接管理 tmux 会话 |
| :art: **多窗格网格** | 像原生 tmux 一样拆分、缩放、编排终端窗格 |
| :satellite: **Tailscale 远程访问** | 通过 Tailscale 从任意地点安全接入你的会话 |
| :iphone: **移动端友好** | 响应式界面、抽屉导航、触控支持、虚拟键盘 |
| :mag: **命令面板** | 使用 `Ctrl+K` 快速搜索主机、会话和窗口 |
| :open_file_folder: **文件浏览器** | 浏览项目文件、预览文本、插入路径、切换隐藏文件显示 |
| :clipboard: **安全文本剪贴板** | 复制终端选区、纯文本粘贴，避免图片和富文本泄漏 |
| :bookmark_tabs: **会话模板** | 一键创建开发、监控、训练等常用布局 |
| :art: **主题系统** | 内置 6 套主题：Dark、Light、High Contrast、Dracula、Nord、Catppuccin |
| :clipboard: **命令片段** | 复用常用命令，支持内置片段和自定义片段 |
| :ledger: **审计日志** | 跟踪会话活动和关键用户操作 |

## :rocket: 快速开始

```bash
git clone https://github.com/<your-username>/TmuxGo.git
cd TmuxGo
./bootstrap.sh && ./start.sh
```

浏览器打开 `http://localhost:3000`。:tada:

> :bulb: 局域网内可直接访问；远程访问请先配置 [Tailscale](https://tailscale.com)。

## :shield: 生产部署

如果要长期在自己的机器上运行，推荐使用用户级 `systemd`：

```bash
git clone https://github.com/<your-username>/TmuxGo.git
cd TmuxGo
./bootstrap.sh
./scripts/install-systemd-user.sh
systemctl --user enable --now tmuxgo.target
```

停止全部服务：

```bash
systemctl --user disable --now tmuxgo.target
```

卸载全部单元：

```bash
./scripts/uninstall-systemd-user.sh
```

查看服务状态：

```bash
systemctl --user status tmuxgo-gateway.service
systemctl --user status tmuxgo-frontend.service
systemctl --user status tmuxgo-agent.service
```

查看日志：

```bash
journalctl --user -u tmuxgo-gateway.service -f
journalctl --user -u tmuxgo-frontend.service -f
journalctl --user -u tmuxgo-agent.service -f
```

## :package: 依赖要求

| 依赖 | 版本 | 必需 | 说明 |
|:-----------|:--------|:--------:|:------|
| :green_circle: Node.js | >= 20 | :white_check_mark: | 运行时 |
| :green_circle: tmux | 任意 | :white_check_mark: | 终端复用器 |
| 🔵 Tailscale | 最新版 | :o: | 可选，用于远程访问 |
| :desktop_computer: 系统 | Linux / macOS / WSL2 | - | 运行环境 |

```bash
node -v && npm -v && tmux -V
tailscale version
```

## :jigsaw: 架构

```
┌──────────┐   WebSocket    ┌──────────┐   PTY   ┌──────────┐
│ Frontend │ ◄────────────► │ Gateway  │ ◄──────► │  Agent   │
│ (Next.js)│                │ (Fastify)│         │ (tmux)   │
└──────────┘                └──────────┘         └──────────┘
```

| 服务 | 端口 | 技术栈 |
|:--------|:-----|:-----------|
| :globe_with_meridians: Frontend（稳定版） | `3000` | Next.js 14、React 18、xterm.js、Tailwind |
| :electric_plug: Gateway | `3001` | Fastify、WebSocket、node-pty |
| :hammer_and_wrench: Frontend（开发版） | `3002` | Next.js 热更新 |
| :lock: Tailscale HTTPS | `443`、`8443` | 由 `start.sh` 自动配置 |

## :wrench: 开发

```bash
npm run dev
npm run dev:frontend
npm run dev:gateway
npm run dev:agent
npm run build
```

不使用 `systemd` 的本地生产启动：

```bash
./start-prod.sh
```

## :open_file_folder: 项目结构

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

## :art: 主题

| 主题 | 预览风格 |
|:------|:--------------|
| :crescent_moon: Dark（默认） | 深色背景，青色点缀 |
| :sunny: Light | 简洁浅色背景 |
| :black_circle: High Contrast | 最大化可读性 |
| :vampire: Dracula | 紫粉色系 |
| :snowflake: Nord | 冷调蓝色系 |
| :cat: Catppuccin | 柔和暖色系 |

主题会持久化保存到 `localStorage`，可在偏好设置面板中切换。

## :keyboard: 快捷键

| 快捷键 | 操作 |
|:---------|:-------|
| `Ctrl+K` / `Cmd+K` | 打开或关闭命令面板 |
| `Ctrl+B` / `Cmd+B` | 打开或关闭侧边栏 |
| :arrow_up: :arrow_down: :arrow_left: :arrow_right: | 导航移动（支持按住连续触发） |
| `Ctrl+B %` | 横向分屏 |
| `Ctrl+B "` | 纵向分屏 |
| `Esc` | 断开附着或关闭 |
| `Tab` / `Shift+Tab` | 循环切换窗格 |
| `Ctrl+C` | 发送中断 |

> :bulb: 可在 Quick Actions 侧栏中定义自定义快捷操作，并保存到 `localStorage`。

## :bookmark_tabs: 会话模板

| 模板 | 窗格布局 |
|:---------|:------|
| :page_facing_up: Default | 单窗格 |
| :hammer_and_wrench: Development | `vim` + 终端 + `npm run dev` |
| :bar_chart: Monitoring | `htop` + `docker stats` |
| :brain: ML Training | `python train.py` + `nvidia-smi` + `tail -f logs/` |

## :clipboard: 命令片段

内置常用命令可直接使用：

| 分类 | 示例 |
|:---------|:---------|
| :file_folder: 文件系统 | `ls -la`、`df -h`、`free -h` |
| :gear: 进程 | `ps aux`、`docker ps` |
| :octocat: Git | `git status`、`git log` |

> :bulb: 可在 Command Snippets 面板中新增自定义片段，数据会保存到 `localStorage`。

## :globe_with_meridians: 环境变量

| 变量 | 服务 | 默认值 | 说明 |
|:---------|:--------|:--------|:------------|
| `PORT` | Gateway | `3001` | Gateway 监听端口 |
| `GATEWAY_URL` | Agent | `ws://localhost:3001/api/stream` | Gateway WebSocket 地址 |
| `HOST_ID` | Agent | `agent-local` | 主机唯一标识 |
| `HOST_NAME` | Agent | `local-machine` | 主机显示名称 |

## :beetle: 排障

查看服务日志：

```bash
tail -f /tmp/tmuxgo-gateway.log
tail -f /tmp/tmuxgo-frontend-stable.log
tail -f /tmp/tmuxgo-frontend-dev.log
tail -f /tmp/tmuxgo-agent.log
```

对于 `systemd --user` 部署：

```bash
journalctl --user -u tmuxgo-gateway.service -n 100
journalctl --user -u tmuxgo-frontend.service -n 100
journalctl --user -u tmuxgo-agent.service -n 100
```

## :page_facing_up: License

MIT :copyright: 2026 Hongbin
