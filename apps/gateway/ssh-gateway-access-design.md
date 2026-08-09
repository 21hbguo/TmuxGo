# TmuxGo SSH 统一接入设计

## 1. 目标

让 SSH 客户端和 Web 客户端都通过 gateway 进入同一个 TmuxGo 工作会话。SSH 不直接连接目标主机，而是连接 gateway，由 gateway 根据 `hostId` 选择本机、远程 SSH 主机或 Agent 主机，并 attach 到对应的 tmux session。

目标链路：

```text
Web 客户端 -> gateway -> 目标 host -> tmux session
SSH 客户端 -> gateway -> 目标 host -> 同一个 tmux session
```

例如：

```bash
ssh tmuxgo@gateway attach --host hlsj --session dev
```

当 Web 端连接 `hlsj/dev` 时，SSH 端也进入 `hlsj/dev`。两端共享同一个 tmux session，命令、进程、pane 和终端输出保持一致。

## 2. 当前架构

当前系统不是远程桌面式的像素投影，而是把终端数据流转发给 Web：

```text
浏览器 -> WebSocket /api/stream -> gateway
                                 ├─ local：node-pty -> 本机 tmux attach
                                 ├─ remote：node-pty -> SSH -> 远程 tmux attach
                                 └─ agent：gateway -> Agent WebSocket -> Agent 本地 tmux attach
```

gateway 已经具备以下终端能力：

- 通过 `hostId` 选择不同主机。
- 通过 `sessionName` attach 到 tmux session。
- 转发终端输入和输出。
- 处理终端尺寸变化。
- 支持 shared 和 exclusive 两种 attach 模式。
- 支持普通 SSH 主机和 Agent 主机。
- Web 端断开时释放当前 attachment，不主动销毁 tmux session。

## 3. 与直接 SSH 的区别

### 3.1 直接 SSH 到目标主机

```text
SSH 客户端 -> 目标主机 -> tmux
Web 客户端 -> gateway -> 目标主机 -> tmux
```

直接 SSH 时，客户端需要自行处理目标主机地址、账号和凭据。它可以获得目标主机上的普通 shell、scp、端口转发等原生 SSH 能力，但不会自动复用 TmuxGo 的主机配置、权限、Agent 和审计体系。

### 3.2 SSH 到 gateway

```text
SSH 客户端 -> gateway
                    ├─ local -> tmux
                    ├─ remote -> SSH -> tmux
                    └─ agent -> Agent WebSocket -> tmux
```

SSH 客户端只需要访问 gateway。目标主机的连接凭据、主机类型和连接方式由 gateway 管理。这样 SSH 和 Web 可以使用同一套 host、session、权限和 Agent 能力。

### 3.3 功能对比

| 对比项 | 直接 SSH 到目标主机 | SSH 到 gateway |
| --- | --- | --- |
| 连接终点 | 目标主机 | gateway |
| 目标主机凭据 | 由 SSH 客户端持有 | 由 gateway 管理 |
| Web 与 SSH 共享 tmux | 可以 | 可以 |
| 支持 Agent 主机 | 通常不支持 | 支持 |
| TmuxGo 主机权限 | 不复用 | 复用 |
| TmuxGo 审计 | 不统一 | 可以统一记录 |
| 延迟 | 较低 | 多一层代理，略高 |
| 原生 shell、scp、端口转发 | 默认支持 | 默认不应开放 |
| 访问入口 | 需要知道目标主机 | 只需知道 gateway |
| 实现复杂度 | 无需改 gateway | 需要增加 SSH 终端入口 |

## 4. 会话和终端语义

Web 和 SSH 不是共享同一个 PTY，而是分别作为 tmux client attach 到同一个 tmux session：

```text
Web A ─┐
Web B ─┼─> 同一个 tmux session
SSH  ──┘
```

因此：

- SSH 中执行的命令，Web 端可以看到。
- Web 端输入的命令，SSH 端可以看到。
- tmux pane 中运行的进程不会因为某一个客户端断开而自动结束。
- 关闭 SSH 只断开当前 SSH client，不销毁 tmux session。
- Web 和 SSH 必须连接到同一个 host、同一个 Linux 用户对应的 tmux server，以及同一个 session。
- 同名但属于不同 Linux 用户或不同 tmux socket 的 session，不是同一个会话。

默认建议 SSH 使用 shared attach，避免 SSH 窗口大小改变 Web 端的整体布局。

## 5. SSH 接入方式

SSH 登录后不应获得 gateway 主机上的任意 shell。建议只允许受限命令：

```bash
ssh tmuxgo@gateway attach --host remote --session dev
```

gateway 应解析并校验：

- 当前 SSH 用户身份。
- `hostId` 是否存在且对当前用户可访问。
- `sessionName` 是否符合命名规则。
- 当前用户是否有权 attach 目标 session。
- 是否允许 shared、exclusive 或 readonly 模式。

不建议直接使用以下方式作为最终方案：

```bash
ForceCommand tmux attach
```

它只能方便地进入 gateway 本机的 tmux，无法自然支持 TmuxGo 配置的远程主机和 Agent 主机，也无法根据 `hostId` 统一执行权限校验。

## 6. 终端抽象

当前 Web attach 逻辑主要位于 `src/routes/stream.ts`，Agent 侧已经具备接近统一接口的终端对象。建议将三类终端连接统一抽象为 attachment：

```text
TerminalAttachment
  write(data)
  resize(cols, rows)
  kill()
  onData(listener)
  onExit(listener)
```

底层实现分别对应：

```text
local       -> node-pty + 本机 tmux attach
remote SSH  -> node-pty + 下游 ssh + 远程 tmux attach
agent       -> Agent WebSocket terminal attachment
```

上层只负责把 attachment 接到不同客户端：

```text
WebSocket -> TerminalAttachment
SSH PTY   -> TerminalAttachment
```

这样可以保证 Web 和 SSH 的输入、输出、resize、断开和错误处理保持一致。

## 7. 推荐实现方案

### 7.1 SSH 服务

优先使用系统 OpenSSH 提供 SSH 协议、PTY、密钥认证和连接生命周期，再通过 `ForceCommand` 启动 gateway 的受限终端 bridge。

优点：

- 不需要在 Node 中重新实现 SSH 协议。
- 兼容标准 SSH 客户端。
- 可以复用 OpenSSH 的公钥认证和安全配置。
- PTY、窗口尺寸变化和断开事件由系统 SSH 层处理。

Node gateway 负责：

- 解析受限命令。
- 认证后的用户身份映射。
- host/session 权限校验。
- 创建对应的 TerminalAttachment。
- 在 SSH stdin/stdout 与 attachment 之间转发数据。

### 7.2 入口命令

建议支持以下形式：

```bash
ssh tmuxgo@gateway attach --host local --session dev
ssh tmuxgo@gateway attach --host hlsj --session dev
ssh tmuxgo@gateway attach --host agent-local --session dev
```

可选参数：

```text
--readonly
--shared
--exclusive
```

默认建议为 `--shared`。

### 7.3 连接生命周期

```text
SSH 建立连接
  -> gateway 解析命令
  -> 校验用户、host 和 session
  -> 创建 TerminalAttachment
  -> 读取 SSH stdin，调用 attachment.write
  -> attachment.onData，写入 SSH stdout
  -> SSH 窗口变化，调用 attachment.resize
  -> SSH 断开，调用 attachment.kill
```

SSH 断开时只释放当前 attachment，不执行 `tmux kill-session`。

## 8. 权限和安全边界

SSH gateway 入口必须是受限终端入口，而不是 gateway 主机的 shell 代理。至少需要保证：

- 不允许用户通过参数注入执行任意 gateway shell 命令。
- `hostId` 只能引用已配置或已注册的主机。
- Agent 主机只能通过 AgentManager 的 terminal attachment 访问。
- `sessionName` 必须经过现有 session policy 校验。
- SSH 用户只能访问授权的 host 和 session。
- 远程主机密码、私钥和环境变量不能通过 SSH 参数回显。
- 记录 SSH 用户、host、session、连接时间、断开原因和错误信息。
- readonly attachment 不应转发输入、resize 或改变 tmux 状态。

## 9. 分阶段落地

### 第一阶段：统一 attachment

- 从 Web stream 路由中整理 local、remote SSH、Agent 的 attachment 生命周期。
- 保持现有 WebSocket 协议和前端行为不变。
- 为输入、输出、resize、退出和断开补充测试。

### 第二阶段：增加 SSH bridge

- 配置独立 SSH 入口或独立端口。
- 通过 OpenSSH `ForceCommand` 启动受限命令。
- 实现 `attach --host --session` 参数解析。
- 将 SSH PTY 接入统一 attachment。

### 第三阶段：补充权限和运维能力

- 增加 SSH 用户到 TmuxGo 用户的映射。
- 增加 host/session 级权限策略。
- 增加 readonly 模式。
- 增加 SSH 连接审计。
- 增加 Agent、普通远程主机、本机三类入口的集成测试。

## 10. 最终效果

```text
Web A ─┐
Web B ─┼── gateway ── hlsj/dev tmux session
SSH  ──┘
```

最终目标不是把 Web 画面转换成 SSH 画面，而是让 Web 和 SSH 成为同一个 tmux 工作会话的两种客户端。tmux session 是唯一的共享状态来源，gateway 负责统一的主机选择、权限控制、连接代理和审计。
