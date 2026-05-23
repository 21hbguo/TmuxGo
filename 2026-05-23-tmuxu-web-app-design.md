# tmuxU Web 版方案设计

日期：2026-05-23
状态：Final

## 1. 目标与定位

tmuxU Web 版的核心目标是：
在任意设备浏览器中，快速连接并操作远端 tmux，会话不断线、状态可恢复、操作足够快。

一句话定位：
**"面向 tmux 重度用户的 Web 控制台与会话导航器"**，重点不是替代本地终端，而是提供随时随地的会话访问和高效管理。

## 2. 关键使用场景

1. 在手机/平板/临时电脑上，通过浏览器快速接入已有 tmux 会话继续工作。
2. 在多个服务器之间快速切换会话、窗口、pane，不依赖记忆 host + session 名称。
3. 一键新建 session/window/pane，最少点击完成常见操作。
4. 网络中断后恢复连接，仍能回到原有 tmux 状态。
5. 基于 Tailscale 或 SSH 内网访问，不直接暴露公网 SSH。

## 3. 设计原则

1. **tmux-first**：持久性、会话管理完全依托 tmux，不重复造"终端状态持久化"轮子。
2. **低延迟优先**：操作路径尽量短（WebSocket 长连接 + agent 本地执行 tmux）。
3. **安全默认收敛**：默认仅 tailnet 可访问；不做公网裸露入口。
4. **可扩展多主机**：单机架构不阻碍后续多主机与权限模型升级。

## 4. 功能范围

### 4.1 核心功能

1. 登录与连接
   - 基于 Tailscale 内网可达（推荐）或现有 SSH 网络可达。
   - 浏览器登录后进入主机列表与会话总览。
2. 会话管理
   - 列表：session 名称、创建时间、最后活动时间、window 数。
   - 操作：新建、附着、重命名、删除。
   - 并发控制：同一 session 被多端操作时，采用乐观锁 + 最后写入胜出策略；冲突时前端提示刷新。
3. window/pane 管理
   - 新建 window、水平/垂直 split pane、切换 pane、关闭 pane/window。
   - Window 拖拽排序：拖拽调整 window 顺序。
4. Web 终端
   - 每个 pane 可打开独立终端视图（xterm.js）。
   - 支持复制粘贴、调整大小、滚动历史。
5. 快速选择器（核心体验）
   - 全局搜索：`host/session/window/pane` 模糊匹配并跳转。
6. 断线重连
   - 浏览器断开后自动重连，并恢复到上次打开的目标 pane。
   - 输出回放：重连后拉取断线期间的 pane 输出（Gateway 缓存最近 N 条），避免信息丢失。
   - 降级策略：连续重连失败 3 次后展示手动重连按钮，提示用户检查网络。

### 4.2 增强功能

1. 快捷键系统（类似命令面板）。
2. 收藏与最近访问（Recent/Favorites）。
3. 会话模板（新建 session 时自动创建初始窗口布局）。
4. 基础审计日志（谁在何时做了什么管理操作）。
5. Pane 输出通知：用户关注的 pane 有新输出时，浏览器推送通知（适合盯编译、训练等长任务）。
6. Pane 全屏聚焦：单 pane 临时全屏，适合长输出阅读。
7. 终端内容搜索：在 pane 输出中搜索关键词并高亮定位。
8. 剪贴板桥接：浏览器与远程 pane 剪贴板同步，首次使用时请求剪贴板权限。
9. 连接状态指示：显示当前 WebSocket 延迟、Agent 可用状态。
10. 用户偏好：主题、字体、字号、快捷键映射，存储在前端 localStorage，可选同步到后端。
11. 命令片段：保存常用命令，一键发送到当前 pane。

### 4.3 扩展功能

1. 角色权限（只读/可操作）。
2. 协作场景（分享只读观察链接）。
3. 指标监控（连接数、会话活跃度、失败率、延迟）。

## 5. 总体架构

### 5.1 组件划分

1. **Web Frontend**
   - 技术：Next.js + React + xterm.js。
   - 职责：UI、快捷交互、终端渲染、状态展示。
2. **Gateway API**
   - 职责：鉴权、会话目录查询、命令路由、WebSocket 中转、权限校验。
3. **Host Agent（每台主机一个）**
   - 职责：本机执行 tmux 命令，维护 tmux control mode 连接，推送状态事件。
4. **tmux**
   - 真实计算与持久层（session/window/pane 生命周期与进程持久化）。

### 5.2 数据与控制流

1. 前端通过 HTTPS 调用 Gateway 获取 host/session 树。
2. 前端通过 WebSocket 连接 Gateway 打开终端流。
3. Gateway 将终端输入输出转发给对应 Host Agent。
4. Agent 使用 tmux control mode 执行命令并接收异步事件（窗口变化、焦点变化）。
5. Agent 将事件回推 Gateway，再实时同步到前端 UI。

## 6. 实现方式

### 6.1 与 tmux 的交互策略

1. **命令执行层**：标准 tmux CLI 命令（`new-session`, `split-window`, `select-pane` 等）。
2. **状态订阅层**：tmux control mode 持久连接，接收 `%...` 异步事件。
3. **一致性策略**：
   - 命令成功后立即做一次局部状态刷新（避免事件丢失导致 UI 漂移）。
   - 每隔固定时间全量校准一次（轻量心跳校准）。

### 6.2 终端流方案

1. 单 pane = 单终端流通道（logical channel）。
2. 通道通过 Gateway 复用同一 WebSocket 连接（多路复用），减少连接数。
3. 终端尺寸变化（cols/rows）实时回传 Agent 执行 resize。
4. 输入输出全双工流式转发，避免轮询。
5. 输出缓存：Gateway 为每个 pane 缓存最近 1000 行输出（环形缓冲），供断线重连后回放。

### 6.3 多主机接入方案

1. 每台目标机部署一个 Agent（systemd 管理）。
2. Agent 启动后向 Gateway 注册（带 host metadata）。
3. Gateway 按 host id 路由命令和终端流。
4. 不把 tmux socket 暴露到网络，只在主机本地访问。
5. Agent 可用性：
   - Agent 与 Gateway 之间保持心跳（每 10 秒），超时 30 秒标记为离线。
   - Agent 掉线后前端展示主机状态为"不可达"，已打开的终端显示连接中断提示。
   - Agent 重启后自动重连 Gateway 并重新注册，无需人工干预。

## 7. 安全与访问控制

1. 默认只允许 Tailnet 内访问（Tailscale）。
2. Gateway 仅监听内网地址或通过 Tailscale Serve 暴露至 tailnet。
3. Host Agent 与 Gateway 之间使用短期 token + 主机白名单。
4. 前端会话采用短时 JWT + 刷新机制。
5. WebSocket 认证：连接握手阶段通过 query token 验证身份，连接后不再逐条校验；token 过期则断开。
6. 敏感操作（删除 session 等）做二次确认。
7. 审计记录至少包含：用户、主机、目标对象、动作、时间、结果。

## 8. 关键数据模型

1. `User`
   - `id`, `username`, `displayName`, `role`, `lastLoginAt`
2. `Host`
   - `id`, `name`, `address`, `status`, `tags`
3. `Session`
   - `id`, `hostId`, `name`, `createdAt`, `lastActiveAt`
4. `Window`
   - `id`, `sessionId`, `index`, `name`, `active`
5. `Pane`
   - `id`, `windowId`, `index`, `title`, `active`, `size(cols,rows)`
6. `TerminalChannel`
   - `id`, `paneId`, `state`, `connectedAt`

## 9. API 设计

### 9.1 端点列表

1. `GET /api/hosts`
2. `GET /api/hosts/:id/sessions?limit=&offset=`（支持分页）
3. `POST /api/hosts/:id/sessions`（新建 session）
4. `POST /api/hosts/:id/sessions/:sid/windows`
5. `POST /api/hosts/:id/panes/:pid/split`
6. `POST /api/hosts/:id/panes/:pid/select`
7. `DELETE /api/hosts/:id/sessions/:sid`
8. `WS /api/stream`（终端流 + 事件流，多路复用）

### 9.2 错误响应规范

统一格式：`{ "error": { "code": "ERROR_CODE", "message": "描述" } }`

| 错误码 | HTTP 状态码 | 含义 |
|--------|-------------|------|
| `UNAUTHORIZED` | 401 | 未登录或 token 过期 |
| `FORBIDDEN` | 403 | 无权限执行该操作 |
| `NOT_FOUND` | 404 | 主机/会话/pane 不存在 |
| `CONFLICT` | 409 | 并发冲突，需刷新重试 |
| `AGENT_UNREACHABLE` | 502 | 目标主机 Agent 不可达 |
| `INTERNAL_ERROR` | 500 | 服务端内部错误 |

## 10. 非目标

1. 不做 shell 历史或命令智能分析平台。
2. 不做 tmux 替代协议，不重写终端多路复用器。
3. 不做公网匿名访问，不做复杂 SSO（先保留接口）。

## 11. 验收标准

1. 30 秒内从登录到进入目标 pane 并可输入命令。
2. 常用操作（新建 session/window/pane）均可在 2 步内完成。
3. 浏览器刷新后 5 秒内恢复到上次活动 pane。
4. 100 次连续会话切换无状态错乱（session/window/pane 一致）。
5. 在 tailnet 内稳定访问，无需暴露公网 SSH 端口。

## 12. 部署与环境

### 12.1 环境要求

| 组件 | 要求 |
|------|------|
| Gateway | Docker，内存 >= 256MB |
| Host Agent | Docker 或 systemd，需访问本机 tmux socket |
| tmux | >= 2.1（control mode 支持） |
| 浏览器 | Chrome 90+、Firefox 90+、Safari 15+、Edge 90+ |
| 网络 | Gateway 与 Agent 之间需 TCP 可达（建议 Tailscale） |

### 12.2 Docker 部署

Gateway 容器：
```bash
docker run -d \
  --name tmuxu-gateway \
  -p 3000:3000 \
  -v tmuxu-data:/data \
  -e JWT_SECRET=<secret> \
  tmuxu/gateway:latest
```

Agent 容器（每台主机）：
```bash
docker run -d \
  --name tmuxu-agent \
  -v /tmp/tmux-$(id -u):/tmp/tmux-$(id -u) \
  -e GATEWAY_URL=<gateway-url> \
  -e AGENT_TOKEN=<token> \
  --network host \
  tmuxu/agent:latest
```

Agent 需挂载宿主机 tmux socket 目录（`/tmp/tmux-<uid>`），使用 `--network host` 以便访问宿主机 tmux。

### 12.3 升级策略

1. Gateway：滚动升级，新容器启动后接管连接，旧容器等待现有连接排空后关闭。
2. Agent：systemd 管理时使用 `systemctl restart`；Docker 时 `docker pull` + `docker compose up -d`。
3. 升级期间前端展示"服务维护中"提示，已建立的终端流不受影响。

## 13. 技术选型决策记录（ADR）

### ADR-001 终端渲染内核选择

结论：采用 `xterm.js` 作为 Web 终端渲染层。

决策原因：
1. 截至 2026-05-23，Ghostty 没有官方成熟的浏览器端成品方案。
2. `libghostty` 当前仍未作为稳定独立 API 发布，直接依赖存在演进风险。
3. `xterm.js` 生态成熟，和 WebSocket + PTY/tmux 流模型契合，能快速落地。

实施约束：
1. 前端终端渲染抽象为 `TerminalRenderer` 适配层，避免业务逻辑与 `xterm.js` 强耦合。
2. tmuxU 的核心能力（会话管理、控制模式事件、路由、权限）不得依赖特定渲染器特性。
3. 后续若 Ghostty 提供稳定 Web/嵌入方案，可在不改后端协议的前提下替换渲染器实现。

## 14. 关联文档

1. 前端视觉与交互专项方案：`docs/plans/2026-05-23-tmuxu-frontend-design.md`
