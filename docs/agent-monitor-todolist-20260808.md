# Agent 监控实施 TODO

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

## Phase 2 以后

| ID | 状态 | 任务 |
|---|---|---|
| P2-01 | TODO | 接入 tmux hook、pane 生命周期和 OSC 133 |
| P2-02 | TODO | 增加 Claude Code Hook Adapter |
| P2-03 | TODO | 评估 Codex App Server 及 OpenCode Server 原生接入 |
| P2-04 | TODO | 增加 Web Push、设备订阅和跨设备未读同步 |
