# Agent 监控实施记录

状态：归档（实施记录）

## 2026-08-08 开工

- 确认当前分支：`autoresearch/jul24`。
- 初始工作树只有需求文档未跟踪，未发现已有实现补丁。
- 读取仓库规则、现有设计稿、Gateway/Frontend Agent 代码和测试。
- 完成官方资料核验，结果见 `agent-monitor-research-20260808.md`。
- 当前实施范围扩展为完成 Phase 1/2/3/4 的可验证定义范围；未核验的官方运行时启动方式不伪造为已完成。
- Phase 1 实现完成：新增 Host 级 AgentMonitor、状态事件协议、前端快照/移除/通知消费和 eventId 去重。
- 收尾审计确认：真实 tmux fallback 测试使用不含 Agent 名称的 `worker` 可执行文件，仅通过 pane 标题和输出识别 Codex；主机离线、长时间无输出、按事件/Host/Session 静音和免打扰不计入 Phase 1 已完成能力。
- Phase 2 实现完成：接入 tmux pane 字段、`pane-exited`/`pane-died` 等 Hook 队列、OSC 133、完整进程树和扫描失败保留。Hook 按 Host 隔离，消费先移动队列文件，只清理 TmuxGo marker。
- Phase 3 实现完成本轮适配范围：统一 Claude/Codex/OpenCode 事件，支持 Agent WebSocket 和 token 保护 HTTP 接收；事件绑定 Host、pane/session，重复 eventId 不重复应用。未实现直接启动 Codex App Server/OpenCode Server 或自动写入 Claude 配置。
- Phase 4 实现完成：持久化 VAPID key 和订阅，提供订阅撤销、跨设备 unread/read，清理 404/410 失效订阅；前端 Service Worker 只接收脱敏 payload，点击后定位 Host/Session/Pane。

## 验证记录

| 时间 | 命令/检查 | 结果 |
|---|---|---|
| 2026-08-08 | `bash ~/.codex/skills/web-access/scripts/check-deps.sh` | Node 22 可用；Chrome CDP 未连接，静态公开资料路径可用 |
| 2026-08-08 | tmux 官方手册 curl + rg | 已核验 pane 生命周期、OSC 133 和相关 hooks/format variables |
| 2026-08-08 | OpenCode 官方源码 curl | 已核验 idle/busy/retry 状态模型 |
| 2026-08-08 | `node .../tsx/dist/cli.mjs --test src/**/*.test.ts` | Gateway 全量测试 63/63 通过，含 Agent event/notification routes |
| 2026-08-08 | `npm run test:frontend` | Frontend 全量测试 392/392 通过；新增 Push 接入保持既有 PaneNotifications 测试兼容 |
| 2026-08-08 | `npm run build:gateway` | Gateway TypeScript 构建通过 |
| 2026-08-08 | `npm run build:frontend` | Frontend Vite 构建通过；仅有既有 chunk size warning，`sw.js` 作为 public asset 发布 |
| 2026-08-08 | `git diff --check` | 通过，无空白错误 |

## 验收矩阵

| 需求 | 证据 |
|---|---|
| 无终端附着仍有 Agent 状态 | Gateway 启动的 Host 级 monitor 测试；monitor 生命周期独立于 WebSocket attach |
| 多 Agent 不互相覆盖 | 多 pane/多 host monitor 测试 |
| 多客户端不重复扫描 | 单 Host monitor subscriber 测试 |
| 权限/问题/完成/失败/退出区分 | 状态检测和 notification 测试 |
| 重连/重启初始快照不重复通知 | snapshot initial 与前端通知测试 |
| pane 删除有 removed 事件 | monitor removed 测试 |
| 扫描失败不产生完成 | monitor failure 测试 |
| local/ssh/agent 降级 | `execTmux`/`execHostShell` 既有路由；monitor 以 local/ssh-host/agent-host 独立 key 测试 |
| 通知不泄漏输出 | 通用脱敏 message 与事件断言；通知不携带终端输出/Prompt |
| 来源/置信度可排查 | AgentPaneState 字段断言；真实 tmux fallback 确认 `pane_output`/`low` |
| Agent 原生事件边界 | Claude/Codex/OpenCode 规范化与 HTTP/WS 接收测试；未核验页面和原生 Server 启动方式明确保留边界 |
| Web Push 跨设备 | VAPID/订阅/未读/已读/撤销路由测试，Store 目录 0700、文件 0600 |
| Phase 4 范围边界 | Agent Session 原生进程恢复、Host/Session/事件级静音、免打扰和直接 Server 启动器留作后续增强 |
