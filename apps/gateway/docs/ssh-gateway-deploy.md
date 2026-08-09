# TmuxGo SSH Gateway 部署

## 概述

SSH 客户端通过 gateway 进入与 Web 端相同的 tmux 工作会话。SSH 连接到达 gateway 后由 sshd 的 `ForceCommand` 启动受限 CLI（`node dist/ssh-bridge.js`），CLI 与 Web gateway 运行在同一 Linux 用户下，进程内直接复用统一 attachment、权限与审计模块。

```text
SSH 客户端 -> gateway
                    ├─ local -> tmux
                    ├─ remote -> SSH -> tmux
                    └─ agent -> Agent WebSocket -> tmux
```

终端统一抽象：

```text
WebSocket -> TerminalAttachment
SSH PTY   -> TerminalAttachment
```

```text
TerminalAttachment
  write(data)
  resize(cols, rows)
  kill()
  onData(listener)
  onExit(listener)
```

## 前置条件

- gateway 与 sshd 运行在同一主机、同一 Linux 用户下，保证 `~/.tmuxgo`、tmux server 与 Web gateway 一致。
- 已安装 Node.js 并完成项目依赖安装（`npm install`）。
- `~/.tmuxgo` 配置存在且包含 `hosts.json`（Web gateway 正常使用时即已存在）。
- 已执行 `npm run build`，产物为 `apps/gateway/dist/ssh-bridge.js`。

## 创建系统用户

SSH 登录用户与 gateway 运行用户需要能访问同一份 `~/.tmuxgo` 与 tmux server，推荐直接以 gateway 运行用户作为 SSH 登录用户，避免复制配置与权限同步：

```bash
useradd -m -s /bin/bash tmuxgo
usermod -aG <gateway-运行用户组> tmuxgo
chmod g+rX ~<gateway-运行用户>/.tmuxgo
```

或者使用独立系统用户 `tmuxgo`，通过 `TMUXGO_SSH_USER_MAP` 把 SSH 用户映射为 gateway 运行用户。

## sshd_config 配置

在 `/etc/ssh/sshd_config`（或 `/etc/ssh/sshd_config.d/`）中追加：

```
Match User tmuxgo
  ForceCommand /usr/bin/env node /path/to/tmuxgo/apps/gateway/dist/ssh-bridge.js
  PermitTTY yes
  X11Forwarding no
  AllowTcpForwarding no
```

- `ssh tmuxgo@gateway attach --host hlsj --session dev` 中 `attach --host ... --session ...` 会被 sshd 追加到 `ForceCommand` 之后，CLI 通过 `process.argv.slice(2)` 收到。
- CLI 默认从 `LOGNAME`/`USER` 取真实 SSH 用户，`TMUXGO_SSH_USER_MAP` 可再映射为 TmuxGo 内部用户；如需强制固定身份（如共享系统用户）可加 `TMUXGO_SSH_USER=<user>` 前缀。
- 修改后重启 sshd：`systemctl restart sshd`。

## 使用示例

```bash
ssh tmuxgo@gateway attach --host hlsj --session dev
ssh tmuxgo@gateway attach --host local --session dev --readonly
ssh tmuxgo@gateway attach --host hlsj --session dev --shared
ssh tmuxgo@gateway attach --host agent-local --session dev --exclusive
```

默认模式为 `--shared`。SSH 断开只释放当前 attachment，不销毁 tmux session。

## 权限配置

在 `ForceCommand` 的环境或用户级环境文件中配置：

```
TMUXGO_SSH_ALLOWED_HOSTS=hlsj,remote,alice@devhost
TMUXGO_SSH_USER_MAP=admin=tmuxgo,alice=research
```

- `TMUXGO_SSH_ALLOWED_HOSTS`：允许的 hostId 列表，支持 `user@hostId` 粒度；留空表示全部允许。
- `TMUXGO_SSH_USER_MAP`：SSH 用户到 TmuxGo 用户映射，逗号分隔的 `sshuser=tmuxuser`。
- session 白名单复用 `TMUX_WEB_ALLOWED_SESSIONS`。

## 审计

每次 SSH attach 连接写入 `~/.tmuxgo/audit.ndjson`：

```json
{"id":"...-ssh","action":"ssh-attach","user":"tmuxgo","target":"hlsj/dev","result":"success","method":"SSH","statusCode":200,"hostId":"hlsj","message":"mode=shared"}
```

校验或 attachment 失败会记录 `result: "failure"` 及错误信息。

## 安全边界

- 只允许受限命令 `attach --host --session`，不开放任意 shell、scp 或端口转发（`AllowTcpForwarding no`）。
- `hostId` 只能引用已配置主机或已注册 Agent，其余一律拒绝。
- `sessionName` 必须通过现有 session policy 校验。
- readonly 模式不转发输入与 resize，不改变 tmux 状态。
- 远程主机密码、私钥和环境变量不通过 SSH 参数回显。
- SSH 断开不销毁 tmux session，Web 端与 SSH 端共享同一会话。

## 验证步骤

1. 在 gateway 目录构建：`npm run build`。
2. 从另一终端执行：`ssh tmuxgo@gateway attach --host hlsj --session dev`。
3. 在 Web 端打开同一 `hlsj/dev` session，两端应看到同一 tmux 输出，任一端输入的命令另一端可见。
4. 检查 `~/.tmuxgo/audit.ndjson` 存在 `action=ssh-attach` 记录。
