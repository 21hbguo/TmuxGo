# Agent 监控实施 TODO

状态：已实施

对应需求：`docs/agent-monitor-requirements-20260808.md`

状态约定：`TODO`、`DOING`、`DONE`、`BLOCKED`、`SKIPPED`

## Phase 1

| ID | 状态 | 任务 | 验证证据 |
|---|---|---|---|
| P1-01 | DONE | 核对现有 Agent 状态、WebSocket、Session API 和前端通知链路 | 代码审查记录、现有测试 |
| P1-02 | DONE | 核验 tmux、OpenCode 及可访问的 Agent/通知资料 | `docs/agent-monitor-research-20260808.md` |
| P1-03 | DONE | 增加来源、置信度、phase、lastEvent、eventId 等状态字段 | Gateway 类型检查、Agent 单测 |
| P1-04 | DONE | 将扫描生命周期从 WebSocket 轮询抽到每 Host 一个监控循环 | Monitor 单测、WS 单测 |
| P1-05 | DONE | 增加 snapshot、changed、removed、notification 和降级事件 | Monitor 单测、协议检查 |
| P1-06 | DONE | 完成前端快照恢复、移除清理和事件去重 | Frontend 单测 |
| P1-07 | DONE | 覆盖本地、SSH、Agent 三种执行模式和扫描失败行为 | Gateway 测试、构建 |
| P1-08 | DONE | 运行全量相关测试、构建并更新验收矩阵 | `docs/agent-monitor-worklog-20260808.md` |

## Phase 2

| ID | 状态 | 任务 | 验证证据 |
|---|---|---|---|
| P2-01 | DONE | 接入 tmux hook、pane 生命周期、OSC 133 和进程树 | `agent-signals.test.ts`、`tmux-hooks.test.ts`、真实 tmux 3.4 降级检查 |

## Phase 3

| ID | 状态 | 任务 | 验证证据 |
|---|---|---|---|
| P3-01 | DONE | 统一 Claude、Codex、OpenCode 结构化事件和稳定 eventId | `agent-events.test.ts`、Gateway 构建 |
| P3-02 | DONE | 通过 Agent WebSocket 转发事件并绑定连接 Host 身份 | `stream.ts`、Gateway 构建 |
| P3-03 | DONE | 增加 token 保护的 HTTP Agent event 接口和 Host/pane 校验 | `routes/agent-events.test.ts` |
| P3-04 | BLOCKED | 直接启动/部署 Codex App Server、OpenCode Server 和自动安装 Claude Hook | Claude 官方 Hook 页面超时；Codex App Server 开发者页 HTTP 403；需版本化官方运行时资料 |

## Phase 4

| ID | 状态 | 任务 | 验证证据 |
|---|---|---|---|
| P4-01 | DONE | 增加 Web Push、持久化 VAPID key 和脱敏 Push payload | `agent-notifications.test.ts`、`web-push` 依赖 |
| P4-02 | DONE | 增加设备订阅、撤销和失效订阅清理 | `agent-notifications.test.ts`、404/410 清理代码路径 |
| P4-03 | DONE | 支持跨设备未读查询和按设备标记已读 | `agent-notifications.test.ts` |
| P4-04 | DONE | 接入 Service Worker、通知点击定位和前端通知中心合并 | `sw.js`、`agent-push.ts`、`PaneNotifications.tsx`、Frontend 测试/构建 |
