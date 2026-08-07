# TmuxGo Agent 状态监控与通知需求分析

- 日期：2026-08-08
- 范围：Claude Code、Codex、OpenCode 等运行在 tmux pane 中的编码 Agent
- 状态：Phase 1 已实现，Phase 2 以后待实施

## 1. 结论

需求 1 值得开发，但不应继续单纯增加终端输出正则。当前 TmuxGo 已经具备 Agent 状态识别和通知的 MVP，下一阶段应将其升级为“协议和 Hook 优先、tmux 元数据辅助、终端画面启发式兜底”的监控系统。

需要区分两类 Agent：

- TmuxGo Agent：负责远端主机连接、SSH、tmux、文件和 Git 转发。
- 编码 Agent：Claude Code、Codex、OpenCode 等运行在 tmux pane 中的任务进程。

两者的连接状态和任务状态不能共用同一个模型。

## 2. 产品目标

用户不需要打开每个终端，也能知道所有主机和 Session 中的编码 Agent：

- 当前是否正在工作。
- 是否等待权限确认或用户回答。
- 是否已经完成。
- 是否执行失败或异常退出。
- 哪个 Session 需要用户处理。
- 点击通知后能直接定位到对应 Host、Session、Window 和 Pane。
- 切换设备、刷新页面、Gateway 重启后不会重复弹出旧通知。

第一阶段目标是可靠地回答“哪里需要我处理”，而不是展示完整的 Agent 内部执行过程。

## 3. 当前实现

### 3.1 已有能力

当前 Gateway 已经能够：

- 通过 tmux list-panes 发现 pane。
- 通过 pane_current_command、pane 标题、子进程和终端输出识别多个编码 Agent。
- 识别 idle、working、blocked、done、unknown。
- 通过 WebSocket 发送 agent_status_changed。
- 更新 Session、Window 和 Pane 的 Agent 状态。
- 在 Agent 进入 blocked 或 done 时生成前端通知。
- 页面隐藏时使用浏览器 Notification。
- 支持单个 pane 静音和通知历史。

### 3.2 现有实现位置

- Gateway 状态检测：[apps/gateway/src/lib/agent-state.ts](../apps/gateway/src/lib/agent-state.ts)
- Gateway WebSocket 轮询：[apps/gateway/src/routes/stream.ts](../apps/gateway/src/routes/stream.ts)
- 前端 WebSocket 分发：[apps/frontend/src/hooks/useWebSocket.ts](../apps/frontend/src/hooks/useWebSocket.ts)
- 前端通知处理：[apps/frontend/src/components/PaneNotifications.tsx](../apps/frontend/src/components/PaneNotifications.tsx)
- 前端 Agent 类型：[apps/frontend/src/types/index.ts](../apps/frontend/src/types/index.ts)
- Agent 状态测试：[apps/gateway/src/lib/agent-state.test.ts](../apps/gateway/src/lib/agent-state.test.ts)

## 4. 当前问题

### 4.1 状态过度依赖终端文本

agent-state.ts 目前主要读取最近的终端可见内容，并通过 spinner、esc to interrupt、Allow command?、[y/n] 等文本判断状态。终端内容是历史画面，不是结构化事件，容易出现：

- 旧的确认提示残留，导致 Agent 被持续判断为阻塞。
- 一次捕获失败被误判为回到空闲。
- 终端主题、Agent 版本或语言变化导致正则失效。
- Agent 输出相似文本时产生误识别。

当前代码会把 idle 与之前的 working、blocked 或 done 组合成 done。这适合作为 MVP，但不能作为高置信度完成事件。

### 4.2 监控绑定在 WebSocket 附着连接上

当前 stream.ts 为每个终端 WebSocket 启动 Agent 状态轮询，只有存在 attachedSessionName 时才执行。由此产生：

- 没有打开终端时，Session 列表无法获得实时状态。
- 未被当前客户端附着的主机不会持续监控。
- 多个浏览器客户端可能重复执行相同的 tmux 扫描。
- 监控生命周期和终端连接生命周期耦合。

应改为每个 Host 一个监控循环，WebSocket 只订阅状态事件。

### 4.3 Agent 消失时缺少删除事件

当 pane 不再被识别为 Agent 时，当前实现会删除 Gateway 内存中的记录，但没有向前端发送删除事件。Agent 退出、pane 被关闭、Session 删除或切回 shell 后，前端可能继续显示旧的 Agent 状态。

需要增加：

~~~text
agent_status_snapshot
agent_status_changed
agent_status_removed
~~~

### 4.4 状态粒度不足

现有 blocked 同时覆盖等待权限、等待问题回答和其它阻塞原因，现有 done 更接近一次状态变化而不是长期状态。至少需要补充：

- needs_input：等待用户回答问题。
- permission_required：等待权限确认。
- failed：Agent 或当前回合失败。
- disconnected：进程、pane 或远端连接异常断开。
- retrying：Agent 正在重试。
- ended：Agent 进程已结束。

### 4.5 通知范围不足

当前前端只对 blocked 和 done 通知，没有覆盖：

- 权限请求。
- 用户问题。
- 执行失败。
- Agent 进程退出。
- Session 断开。
- 主机离线。
- 长时间没有输出。

### 4.6 初始快照和状态变化没有完全分离

重连或首次加载时收到的 done 目前可能被当成新通知。状态快照只应恢复 UI，不应触发通知；只有确认发生了新的状态变化，才应生成通知。

事件去重不能只依赖进程内 revision，还需要稳定的 eventId，并区分：

- hostId
- paneId
- Agent 会话 ID
- 事件类型
- 来源版本或时间戳

## 5. 外部资料结论

### 5.1 tmux 官方能力

来源：[tmux 官方手册](https://raw.githubusercontent.com/tmux/tmux/master/tmux.1)

tmux 已提供比当前实现更可靠的基础信号：

- pane_current_command
- pane_pid
- pane_dead
- pane_dead_status
- pane_last_output_time
- pane_command_running
- pane_command_status
- pane_command_duration
- pane_title

同时支持：

- pane-command-started
- pane-command-finished
- pane-exited
- pane-died
- pane-bell
- pane-activity

tmux 还支持 OSC 133 命令区间。OSC 133 能帮助识别 Shell 命令的开始、输出和结束，但它不等于完整的 AI 回合状态，应作为辅助信号。

### 5.2 Claude Code

来源：[Claude Code Hooks 文档](https://code.claude.com/docs/en/hooks)

Claude Code 提供结构化生命周期 Hook：

- SessionStart
- SessionEnd
- Notification
- PermissionRequest
- Stop
- StopFailure
- SubagentStart
- SubagentStop

Notification 支持：

- permission_prompt
- idle_prompt
- agent_needs_input
- agent_completed

Hook 输入包含 session_id、transcript_path、cwd、hook_event_name 等字段。Claude Hook 适合把高置信度事件转发给 TmuxGo，而不适合继续向终端直接注入文本。

### 5.3 Codex

来源：[Codex App Server 文档](https://developers.openai.com/codex/app-server)、[OpenAI Codex GitHub](https://github.com/openai/codex)

Codex App Server 的公开 schema 是面向富客户端的结构化协议，覆盖会话、审批、用户输入和流式事件。当前从 OpenAI Codex 官方仓库 `main` 分支 schema 直接核验到：

- `ItemStartedNotification`、`ItemCompletedNotification`。
- `ThreadStatusChangedNotification` 的 active、waitingOnApproval、waitingOnUserInput。
- `ProcessExitedNotification`。
- Agent 消息和命令执行输出 delta 通知。
- 命令审批、权限审批和用户输入请求定义。

开发者页面当前返回 403，因此启动方式、部署方式和具体版本承诺不作为已核验事实。

建议：

- 对 TmuxGo 自己创建和管理的 Codex Session，可以考虑 App Server 或 wrapper。
- 对用户已经在 tmux 中启动的普通 Codex，不应强制迁移运行方式，继续使用 tmux 和进程信息作为降级方案。

### 5.4 OpenCode

来源：[OpenCode Session Status](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)、[OpenCode Status Schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts)

OpenCode 的结构化 Session 状态包含：

- idle
- busy
- retry

retry 还携带 attempt、message、action 和 next 等信息。说明状态模型不应只有一个简单枚举，还应保留原因、重试次数和可执行动作。

### 5.5 cmux

来源：[cmux GitHub](https://github.com/manaflow-ai/cmux)

cmux 的核心做法是：

- 使用 OSC 9/99/777、CLI 和 Agent Hook 接收通知。
- 在 pane 上显示提醒圈。
- 在 Tab 上显示未读标记。
- 提供独立通知面板。
- 支持跳转到最近未读项。
- 通过 Agent Hook 保存原生 Session ID，支持恢复。

这套产品设计适合借鉴到 TmuxGo：状态点、Session 标记、通知中心三层并存。

### 5.6 Happy

来源：[Happy GitHub](https://github.com/slopus/happy)

Happy 的目标与 TmuxGo 的跨设备方向相近：

- 通过 Claude/Codex wrapper 获取结构化事件。
- 支持手机和 Web 端查看。
- 支持 Push 通知。
- 支持权限请求和错误通知。
- 支持设备间接管。

Happy 的状态模型包含 idle、working、needsInput、ended 等更接近用户任务的状态。

### 5.7 Claude Squad

来源：[Claude Squad GitHub](https://github.com/smtg-ai/claude-squad)

Claude Squad 使用 tmux 和 Git worktree 管理多个编码 Agent Session，适合参考 Session 编排和生命周期管理，但其主要价值不是 Agent 状态识别。

## 6. 推荐状态模型

不要把 done 作为长期状态，建议拆分为当前阶段、最近事件和证据来源：

~~~ts
type AgentPhase =
  | 'idle'
  | 'working'
  | 'needs_input'
  | 'permission_required'
  | 'retrying'
  | 'failed'
  | 'ended'
  | 'disconnected'
  | 'unknown'

type AgentEvent =
  | 'started'
  | 'permission_required'
  | 'question_required'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'reconnected'

type AgentSource =
  | 'protocol'
  | 'hook'
  | 'tmux'
  | 'osc133'
  | 'process'
  | 'pane_output'

interface AgentObservation {
  hostId: string
  paneId: string
  sessionName: string
  agent: string
  phase: AgentPhase
  lastEvent?: AgentEvent
  source: AgentSource
  confidence: 'high' | 'medium' | 'low'
  since: string
  updatedAt: string
  eventId: string
  message?: string
}
~~~

状态含义：

- phase：当前持续状态。
- lastEvent：最近一次重要状态变化。
- source：事件来源。
- confidence：判断可信度。
- since：当前状态开始时间。
- eventId：用于去重和恢复。

例如：

~~~text
phase = idle
lastEvent = completed
~~~

比长期保持 phase = done 更适合持续运行的 Session。

## 7. 数据来源优先级

~~~text
Agent 原生协议或 Hook
        ↓
tmux 元数据、Hook 和 OSC 133
        ↓
进程树和 pane 生命周期
        ↓
终端画面启发式识别
~~~

各来源职责：

### 7.1 原生协议和 Hook

用于高置信度事件：

- 回合开始。
- 回合完成。
- 权限请求。
- 用户问题。
- 执行失败。
- 重试。
- Session 结束。

### 7.2 tmux 元数据

用于通用进程和 pane 生命周期：

- Agent 进程是否仍存在。
- pane 是否退出。
- 是否有新输出。
- Shell 命令是否运行中。
- 最近一次命令是否失败。

### 7.3 终端画面

用于兼容未知 Agent 或没有 Hook 的旧版本：

- 识别 Agent 类型。
- 判断可能的等待权限。
- 判断可能的工作中状态。

这类结果必须标记为 source: pane_output 和较低 confidence，不能直接触发高影响动作。

## 8. 推荐架构

~~~text
每个 Host 一个 AgentMonitor
        ↓
维护 pane、Agent Session 和事件去重状态
        ↓
合并协议、Hook、tmux、进程和画面信号
        ↓
只在状态变化时发布事件
        ↓
所有 WebSocket 客户端订阅
        ↓
前端更新状态点和通知中心
~~~

建议新增一个轻量的集中式监控模块，不引入复杂注册器或通用插件框架。已有 agent-state.ts 的检测函数可以逐步迁移或复用。

Gateway 侧需要提供：

- Host 级监控生命周期。
- 首次连接时的状态快照。
- 状态变化事件。
- Agent/Pane 消失事件。
- Hook 事件接收和关联。
- 事件去重。
- 监控失败和降级信息。

WebSocket 侧建议保留现有 agent_status_changed，并增加：

~~~text
agent_status_snapshot
agent_status_removed
agent_notification
~~~

初始快照必须带 initial: true，前端不得因此生成完成、失败或权限通知。

## 9. 通知需求

### 9.1 第一阶段通知规则

| 场景 | 是否通知 | 说明 |
|---|---:|---|
| Agent 开始工作 | 否 | 只更新状态点 |
| Agent 持续工作 | 否 | 避免高频通知 |
| 等待权限 | 是 | 需要用户处理 |
| 等待问题回答 | 是 | 需要用户输入 |
| 正常完成 | 是 | 当前回合结束 |
| 执行失败 | 是 | 附带简短错误原因 |
| Pane 异常退出 | 是 | 标记 Agent 已断开 |
| Gateway 初始快照 | 否 | 只恢复 UI |
| 状态未变化重复事件 | 否 | 按 eventId 去重 |

### 9.2 三层展示

1. Pane 状态点：显示当前阶段。
2. Session 和 Host 标记：显示是否存在需要处理的 Agent。
3. Notification Center：保留未读通知，点击后跳转到目标 Pane。

已有 PaneNotifications.tsx 的跳转逻辑可以复用。

### 9.3 通知偏好边界

Phase 1 保留现有单个 Pane 静音、通知历史和浏览器后台通知能力。以下能力不列为本轮已完成范围：

- 独立的主机离线通知。
- 长时间没有输出告警。
- 按事件类型开关。
- 按 Host、Session 静音。
- 免打扰时间。

这些能力作为后续增强评估，不影响 Phase 1 的 Agent 状态变化通知。

后续如果需要关闭浏览器后仍收到通知，再增加 PWA Service Worker、Web Push、VAPID 和设备订阅管理。Push 内容只应包含脱敏的 Host、Session、Agent 和状态，不应包含完整命令、Prompt、路径或终端输出。

## 10. 分阶段实施

### Phase 1：修正现有 MVP

- 将监控从每个 WebSocket 的轮询中抽离为每个 Host 一个监控循环。
- 增加 needs_input、permission_required、failed、disconnected。
- 增加 agent_status_removed。
- 防止一次扫描失败直接产生 done。
- 分离初始快照和状态变化。
- 增加稳定的 eventId、source、confidence、updatedAt。
- 补充多客户端、重连、Gateway 重启、Session 删除测试。

### Phase 2：接入可靠终端信号

- 使用 tmux pane 生命周期和命令状态字段。
- 接入 pane-exited、pane-command-started、pane-command-finished 等 Hook。
- 解析 OSC 133。
- 统一进程树检测，并处理 Linux、macOS 的差异。
- 保留终端输出正则作为未知 Agent 的 fallback。

### Phase 3：Agent 原生集成

- 增加 Claude Code Hook Adapter。
- 让远端 Agent 通过现有 Agent WebSocket 转发状态事件。
- 对 TmuxGo 创建的 Codex Session 评估 App Server 接入。
- 对 OpenCode Server 接入 Session Status。
- 增加结构化错误、重试和审批信息。

### Phase 4：跨设备通知

- 增加 Web Push。
- 增加设备订阅管理和撤销。
- 支持跨设备未读状态同步。
- 支持 Agent Session 恢复和原生 Session ID 绑定。

## 11. API 和事件建议

### 11.1 快照事件

~~~json
{
  "type": "agent_status_snapshot",
  "initial": true,
  "hostId": "local",
  "revision": 42,
  "agents": []
}
~~~

### 11.2 状态变化事件

~~~json
{
  "type": "agent_status_changed",
  "eventId": "local:local:%1:completed:20260808T120000Z",
  "hostId": "local",
  "sessionName": "dev",
  "pane": {
    "paneId": "local:%1",
    "tmuxPaneId": "%1",
    "sessionName": "dev",
    "agent": "codex",
    "phase": "idle",
    "lastEvent": "completed",
    "source": "hook",
    "confidence": "high",
    "since": "2026-08-08T12:00:00.000Z",
    "updatedAt": "2026-08-08T12:00:01.000Z",
    "revision": 43
  },
  "initial": false
}
~~~

### 11.3 Agent 消失事件

~~~json
{
  "type": "agent_status_removed",
  "eventId": "local:local:%1:removed:20260808T120100Z",
  "hostId": "local",
  "paneId": "local:%1",
  "sessionName": "dev",
  "reason": "pane_exited"
}
~~~

## 12. 安全和隐私要求

- Hook 事件只保留必要字段。
- 不把完整 Prompt、命令、终端输出写入通知。
- 不把 transcript 原文同步给前端。
- 事件接收接口必须复用现有认证和 Origin 校验。
- 远端 Agent 回传事件时校验 hostId 和连接身份。
- Web Push 只发送脱敏摘要。
- 事件日志和通知历史需要遵循现有文件权限策略。
- tmux Hook 中引用 pane 标题、路径等内容时必须正确转义，避免 run-shell 命令注入。

## 13. 验收标准

- 没有打开终端时，Session 列表仍能看到 Agent 状态。
- 一个 Host 上同时运行多个 Agent 时，状态不会互相覆盖。
- 多个浏览器客户端不会导致重复的完整 tmux 扫描。
- 权限请求、用户问题、完成、失败和异常退出能够区分。
- Gateway 重启或 WebSocket 重连不会重复弹出旧完成通知。
- Agent 退出或 Pane 被删除后，前端状态会被移除。
- 任意一次扫描失败不会直接产生完成事件。
- 本地、SSH、Agent 远端三种模式至少都有一套可用的降级状态。
- 通知点击后能准确跳转到对应 Pane。
- 通知不会泄漏完整命令、Prompt、敏感路径和终端输出。
- 状态判断包含来源和置信度，便于排查误报。

## 14. 参考资料

- [tmux 官方手册](https://raw.githubusercontent.com/tmux/tmux/master/tmux.1)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [OpenAI Codex](https://github.com/openai/codex)
- [OpenCode Session Status](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts)
- [OpenCode Status Schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-status-event.ts)
- [cmux](https://github.com/manaflow-ai/cmux)
- [Happy](https://github.com/slopus/happy)
- [Claude Squad](https://github.com/smtg-ai/claude-squad)
- [现有 Agent 监控设计](./agent-monitor-design.md)

## 15. Phase 1 实现验收

Phase 1 已完成以下范围：

- Gateway 启动后按 Host 运行独立 AgentMonitor；WebSocket 客户端只订阅事件，多客户端共享扫描。
- 状态包含 phase、lastEvent、source、confidence、since、updatedAt、eventId 和脱敏 message。
- WebSocket 支持 snapshot、changed、removed、notification 和 monitor_error；初始 snapshot 不触发通知。
- 前端按 eventId 去重，removed 只清理 Agent 元数据并保留终端 Pane，通知点击继续定位 Host、Session、Window、Pane。
- 扫描失败进入 disconnected/error 路径，恢复时发布 reconnected；不会把失败直接转换为 completed。
- 本地、SSH、Agent Host 通过同一 Host key 和现有 execTmux/execHostShell 路由监控。

验证命令和结果见 `docs/agent-monitor-worklog-20260808.md`。tmux Hook、OSC 133、Claude Hook Adapter、Codex/OpenCode 原生协议和 Web Push 保留在后续 Phase，未在本轮伪实现。
