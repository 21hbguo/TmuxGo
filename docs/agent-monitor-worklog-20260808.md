# Agent 监控实施记录

## 2026-08-08 开工

- 确认当前分支：`autoresearch/jul24`。
- 初始工作树只有需求文档未跟踪，未发现已有实现补丁。
- 读取仓库规则、现有设计稿、Gateway/Frontend Agent 代码和测试。
- 完成官方资料核验，结果见 `agent-monitor-research-20260808.md`。
- 当前实施范围：Phase 1；Phase 2/3/4 的原生 Hook、协议和 Push 不提前伪实现。
- Phase 1 实现完成：新增 Host 级 AgentMonitor、状态事件协议、前端快照/移除/通知消费和 eventId 去重。
- 收尾审计确认：真实 tmux fallback 测试使用不含 Agent 名称的 `worker` 可执行文件，仅通过 pane 标题和输出识别 Codex；主机离线、长时间无输出、按事件/Host/Session 静音和免打扰不计入 Phase 1 已完成能力。

## 验证记录

| 时间 | 命令/检查 | 结果 |
|---|---|---|
| 2026-08-08 | `bash ~/.codex/skills/web-access/scripts/check-deps.sh` | Node 22 可用；Chrome CDP 未连接，静态公开资料路径可用 |
| 2026-08-08 | tmux 官方手册 curl + rg | 已核验 pane 生命周期、OSC 133 和相关 hooks/format variables |
| 2026-08-08 | OpenCode 官方源码 curl | 已核验 idle/busy/retry 状态模型 |
| 2026-08-08 | `node --import tsx --test src/lib/agent-state.test.ts src/lib/agent-monitor.test.ts` | Gateway Agent 相关测试 15/15 通过 |
| 2026-08-08 | `npm test` | Gateway 全量测试 52/52 通过 |
| 2026-08-08 | `npm run test --workspace=frontend` | Frontend 全量测试 391/391 通过 |
| 2026-08-08 | `npm run build --workspace=gateway` | Gateway TypeScript 构建通过 |
| 2026-08-08 | `npm run build --workspace=frontend` | Frontend Vite 构建通过；仅有既有 chunk size warning |
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
| Phase 1 范围边界 | 独立主机离线、长时间无输出、按事件/Host/Session 静音和免打扰留作后续增强 |
