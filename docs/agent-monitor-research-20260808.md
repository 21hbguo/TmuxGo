# Agent 监控资料调研总结

- 调研日期：2026-08-08
- 对应需求：`docs/agent-monitor-requirements-20260808.md`
- 调研方式：优先读取官方手册、官方源码和项目原始仓库；搜索摘要只用于定位，不作为最终证据。

## 结论

Phase 1 的核心不是继续堆终端正则，而是把扫描生命周期、事件语义和前端去重先固定下来。tmux 能提供 pane 和命令生命周期元数据；未知 Agent 仍需要终端画面作为低置信度 fallback。原生 Agent Hook/协议应作为后续高置信度来源。

## 已直接核验的一手资料

### tmux 手册

来源：<https://raw.githubusercontent.com/tmux/tmux/master/tmux.1>

读取日期：2026-08-08；通过 HTTP 200 获取 master 分支手册，并定位到以下原文条目：

- `pane_current_command`：当前命令。
- `pane_pid`：pane 首个进程 PID。
- `pane_dead`、`pane_dead_status`：pane/进程退出状态。
- `pane_last_output_time`：最近输出时间。
- `pane_command_running`、`pane_command_status`、`pane_command_duration`：OSC 133 命令运行、退出状态和耗时。
- `pane-command-started`、`pane-command-finished`、`pane-exited`、`pane-died`、`pane-shell-prompt`：tmux hook 事件。
- 手册明确说明 OSC 133 的命令区间依赖 shell/application 发出相应 escape sequence；未发出时对应能力不生效。

工程结论：tmux 元数据适合判断进程/pane 生命周期和 shell 命令阶段，但不能单独证明一次 AI 回合已完成；OSC 133 需要作为辅助信号并标记来源。

### OpenCode Session Status

来源：<https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts>

源码读取日期：2026-08-08。`SessionStatus` 服务维护每个 Session 的状态 Map；`idle` 会删除持久状态，非 idle 状态保留。状态变化同时发布事件。

配套 schema：<https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts>

源码定义：

- `idle`
- `busy`
- `retry`，带 `attempt`、`message`、可选 `action` 和 `next`

工程结论：状态和事件应分开；重试需要保留次数、原因和下一步，而不是压缩成普通 working。

### cmux

来源：<https://github.com/manaflow-ai/cmux>

README 读取日期：2026-08-08。README 描述其通过 OSC 9/99/777、CLI 和 Agent Hook 接收通知，并同时提供 pane 提醒圈、侧栏未读标记、通知面板和跳转最近未读项；还描述了 hook 保存原生 Session ID 以支持恢复。

工程结论：TmxGo 的状态点、Session/Host 标记和 Notification Center 三层展示有明确产品参照；这不是 tmux 或 Agent 协议规范。

### Happy

来源：<https://github.com/slopus/happy>

README 读取日期：2026-08-08。README 描述 wrapper、手机/Web 访问、Push 通知、权限和错误提醒，以及跨设备接管。

工程结论：跨设备方向与 TmuxGo 目标相近，但 wrapper/Push 属于后续 Phase，不应在 Phase 1 混入。

### Claude Squad

来源：<https://github.com/smtg-ai/claude-squad>

README 读取日期：2026-08-08。README 描述使用 tmux 创建隔离 Agent Session，使用 Git worktree 隔离代码分支。

工程结论：可参考 Session 编排和生命周期，但不能把其编排模型当作状态识别协议。

## 未直接核验的来源与原因

### Claude Code Hooks

目标来源：<https://code.claude.com/docs/en/hooks>

当前网络路径在 30 秒内超时，未取得正文，因此本总结不把需求稿列出的 Hook 名称和输入字段作为本轮已核验事实。实现中保留 source/hook 类型，为后续 Adapter 留接口空间。

### Codex App Server

目标来源：<https://developers.openai.com/codex/app-server>

当前网络路径返回 403，未取得正文。通过 OpenAI Codex GitHub API 确认仓库存在公开 docs 目录，但未把未读取的 App Server 协议细节写入结论。后续接入前应重新读取官方文档或源码并固定版本。

## 资料到实现的映射

| 资料事实 | 实现决策 |
|---|---|
| tmux pane/进程有生命周期字段 | scan 读取 pane dead、command running/status、last output time |
| OSC 133 依赖应用发出序列 | source 单独保留 osc133，未收到时不推断高置信度完成 |
| OpenCode 区分 busy/retry/idle | Agent phase 增加 retrying，事件保留失败/重试原因位置 |
| cmux 分离状态点和通知中心 | changed 更新状态，notification 单独驱动提醒 |
| 初始状态不等于新事件 | snapshot 带 initial=true，前端只恢复缓存不弹通知 |
| 跨客户端需要稳定关联 | eventId 包含 host、pane、事件、revision；前端按 eventId 去重 |

## 安全边界

- 通知只发送脱敏的 Agent、Session、事件和通用 message。
- 不把 Prompt、完整命令、transcript、终端输出或敏感路径写入事件通知。
- tmux 执行继续复用现有 `execTmux`、认证和 Agent 连接身份校验。
- Hook/Push/原生协议接入不在本轮伪造，也不绕过现有 Origin/认证链路。
