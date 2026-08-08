# herdr 设计对照（TmuxGo 借鉴参考）

分析对象：`herdrdev/herdr`（Rust 终端级 AI coding agent 工作台）
分析版本：`10974c8`（2026-08，主分支 HEAD）
分析日期：2026-08-08
用途：TmuxGo P0（Agent 控制面 + 语义状态/展示元数据分离）的对照参考，后续 P1/P2 开发对齐依据。

## 1. CLI 与 socket API 同一套接口

herdr 的协议是 Unix domain socket 上的 NDJSON，请求形如 `{"id":"cli:agent:wait","method":"agent.wait","params":{...}}`：

- CLI 的 `send_request` 就是 `ApiClient::local().request_value(request)`（`src/cli.rs:744-750`、`src/api/client.rs:55-61`），与 TUI、hook 脚本、外部客户端共用 `connect_local_stream`（`src/ipc.rs:35-52`）。
- 服务端每个连接一个线程 `handle_connection`（`src/api/server.rs:139-285`）；普通方法经 mpsc 转发给 app 线程（`dispatch_to_app_with_timeout`，`src/api/server.rs:747`），wait 类方法在连接线程内执行（断开即取消）。
- 版本协商：发请求前 ping 比对 `PROTOCOL_VERSION`（`src/cli.rs:759-779`、`src/cli/protocol_guard.rs:16-43`），不匹配报 `protocol_mismatch`。
- CLI 每个命令就是构造 `Request{id,method}` 再 `send_request`，与 socket 客户端完全同构；`herdr api schema` 可导出完整 JSON Schema（`src/cli/api.rs:1`）。
- agent 命令全集（`src/cli/agent.rs:15-35`）：list/get/read/send-keys/prompt/rename/focus/wait/attach/start/explain。

TmuxGo 现状：agent 通过 `/api/stream` WebSocket 注册为 host（`agent-manager.ts`），HTTP 控制面 `/api/v1/control/*`（`routes/agent-control.ts`）已实现 pane split/read + agent wait。未做：CLI 薄客户端、socket/HTTP 同构、协议版本协商、JSON Schema 导出。

## 2. wait 原语：连接作用域事件驱动 + 探测确认

`agent.wait`（`pane.wait_output`、`events.wait`）语义是"连接作用域内的事件驱动 + 探测确认"，不是服务端持久状态：

- `wait_for_agent`（`src/api/wait.rs:132-175`）：先记 `last_event_sequence = event_hub.current_sequence()`（事件总线单调序列），再 `agent_get` 快查（已有状态可立即匹配）。
- `wait_for_resolved_agent`（`src/api/wait.rs:348-498`）循环消费 `event_hub.events_after(last_event_sequence)` 中目标 pane 的事件（`PaneAgentDetected/PaneAgentStatusChanged/PaneUpdated/PaneMoved/PaneClosed/PaneExited`），置 `should_probe` 后重新 `agent_get` 确认，再 `agent_wait_matches`（状态 ∈ until 且 `state_change_seq > 基线`，`wait.rs:540-547`）。
- **钉住占用者**：开始时快照 `expected_terminal_id/name/agent`（`wait.rs:359-367`），每次探测校验身份；agent 被释放/替换/移动/关闭 → 立即 `agent_not_running`（`wait.rs:643-652`）。客户端断开即取消，记 `client_disconnected`（`src/api/server.rs:287-314`）。
- **state_change_seq 基线**：`prompt --wait` 记录提交前的 `state_change_seq`（`wait.rs:227-230`），settled 匹配要求 seq 增大，防止旧状态满足等待；另有 5 秒活动门限（`wait.rs:20, 232-248, 611-641`）——prompt 从非 working 状态发出后必须观察到状态变化，否则报 `agent_prompt_stalled`。
- 无 `--until` 时默认等 idle/done/blocked（`wait.rs:511-523`）。`state_change_seq` 是全局单调计数器，状态切换时 +1 写入 terminal（`src/app/state.rs:1454`、`src/app/actions.rs:2979-2982`）。
- `pane.wait_output` 是简单轮询（先查快照可立即匹配，`wait.rs:22-130`）。

TmuxGo 现状（`lib/agent-control.ts`）：wait 注册表已实现事件驱动（订阅 agentMonitor）+ 钉住占用者（OCCUPANT_CHANGED/PANE_REMOVED/TIMEOUT）+ 初始快查。未做：state_change_seq 基线（防旧状态满足等待）、活动门限（stalled 检测）、连接断开取消（HTTP 场景需 AbortSignal 或 timeout 兜底，目前靠 timeout）。

## 3. 环境守卫：HERDR_ENV=1 全家桶

- `HERDR_ENV=1` 注入每个受管 pane（`src/pane.rs:117`、`src/pty/backend/unix.rs:77`）。
- 配套 `HERDR_SOCKET_PATH`（`src/api/mod.rs:20`）、`HERDR_BIN_PATH`（`src/integration/env.rs:30`）、`HERDR_WORKSPACE_ID/HERDR_TAB_ID/HERDR_PANE_ID`（`src/integration/env.rs:8-10`，注入于 `src/pane.rs:127-129`）。
- 服务器端：HERDR_ENV=1 且未开 `allow_nested` 时拒绝嵌套启动 TUI（`src/main.rs:443-449`）。插件运行时同样注入（`src/app/api/plugins/runtime.rs:40-48`）。

TmuxGo 现状：`TMUXGO_ENV=1` 已在 new-session/split-window 注入（`routes/sessions.ts`、`routes/panes.ts`、`apps/agent/src/tmux.ts`）。未做：`TMUXGO_PANE_ID/TMUXGO_SESSION_NAME/TMUXGO_SOCKET_PATH` 等上下文变量注入（agent 目前用 `TMUX_PANE` 自省）。

## 4. semantic state 与 display metadata 彻底分离

**Semantic state**（idle/working/blocked/done/unknown）由服务器从屏幕内容/前台进程推断（`src/pane/agent_detection.rs`，含防抖：working→idle 需 3 次确认 + 700ms cap，`agent_detection.rs:5-9, 39-77`），影响三类消费方：

- **wait**：`agent_wait_matches` 按状态匹配（`wait.rs:540-547`）。
- **notification**：Blocked→NeedsAttention、Idle 完成转换→Finished toast+声音（`src/app/actions.rs:161-216`）。
- **attention**：`tab_attention_priority`：Blocked=4 > Idle+unseen=3 > Working=2 > Idle+seen=1 > Unknown=0（`src/app/api_helpers.rs:1-9`），驱动 agent view 排序（`src/app/agent_view.rs:70-75, 374-375`）。
- `AgentStatus` 由 state+seen 组合：Idle+unseen=Done（`src/app/api_helpers.rs:99-110`）——skill 里"done 是 unseen 的 idle"。

**Display metadata**（title/display_agent/state_labels/tokens）由外部（agent hook/插件）上报，与状态解耦：

- 通道：hook 脚本直接连 socket 发 `pane.report_metadata`（`Method::PaneReportMetadata`，`src/api/schema.rs:199`；params 见 `src/api/schema/panes.rs:368-396`），hook 内嵌 python 用 AF_UNIX socket 发 NDJSON（`src/integration/assets/claude/herdr-agent-state.sh:89+`），需先过 `HERDR_ENV=1` 守卫（`...:20`）。
- 服务端处理（`src/app/api/panes.rs:1360-1460`）：**source-scoped seq 去乱序**——`accept_metadata_report`（`src/terminal/metadata.rs:96-127`）按 source 记录单调 seq，乱序丢弃，最多 32 个 source（`src/metadata_tokens.rs:15-41`）；**TTL**——`ttl_ms` 上限 86,400,000（`src/app/api_helpers.rs:205`），`expire_agent_metadata_at` 按 deadline 调度删除并重算状态（`src/terminal/metadata.rs:326-377`，过期可触发状态回退 → 新事件）；**进程退出守卫**——agent 退出后拒绝迟到上报（`src/terminal/metadata.rs:79-94`）。
- tokens 是独立通道：patch 语义（Some 设/None 删）+ TTL（`src/metadata_tokens.rs:44-67`），限每请求 16 key、每资源 32 key、key≤32 字符、value≤80 字符、source≤80 字符（`src/app/api_helpers.rs:205-282`）。
- 展示汇总：`pane_info` 中 title/display_agent/state_labels 取 `terminal.effective_presentation()`（跨 source 按 reported_at 取最新，`src/terminal/metadata.rs:395-430`），tokens 取 `metadata_tokens.values()`（`src/app/creation.rs:421-470`）。presentation 变化也发 `PaneAgentStatusChanged` 事件（`src/app/api.rs:621-637`）。

TmuxGo 现状（P0-2 已实现）：`AgentPaneState.display`（title/stateLabel/tokens/seq/ttlMs/updatedAt），`agent-events.ts` normalizeDisplay 解析补丁（seq 去乱序 + TTL 过期 + 负数拒绝），`agent-monitor.ts` applyDisplayPatch（seq 单调、TTL 基于接收时间、scan 重放不刷新 TTL）。未做：source-scoped 多来源（目前 display 单通道，无 source 维度）、tokens 独立 patch 通道（合并进 display）、进程退出后拒绝迟到上报、attention priority 排序（前端 blocked/done 计数有，但没有 tab_attention_priority 排序）。

## 5. 官方 skill 文件

`skills/herdr/SKILL.md`（构建时 `include_str!` 内嵌进二进制，`src/main.rs:441`）：

- **守卫**：第 10-16 行要求所有控制命令前 `test "${HERDR_ENV:-}" = 1`，失败即停止——正是 TmuxGo `TMUXGO_ENV=1` 的对标物。
- 教的内容：用 `herdr --help` + 命令组学 CLI；区分 pane（普通终端）vs agent（受管 agent，`agent start` 从不创建布局）；命名规则 `[a-z][a-z0-9_-]{0,31}` 且跟随 pane 占用者；生命周期语义（58 行：idle 需 UI 已 seen，done=unseen idle，blocked=审批 UI，unknown 不可信）；ID 体系 `w1/w1:t1/w1:p1` 且移动后旧 ID 失效；`pane split --current --direction right --cwd "$PWD" --no-focus`、`agent start ... -- <args>`、`agent prompt --wait --timeout`、`agent wait --until blocked`、`pane run/wait-output/read --source recent-unwrapped`、alternate-screen 读取陷阱、安全规则（不关他人创建的窗格、禁 `server stop`、禁杀主进程）。

TmuxGo 现状：`docs/agent-control/SKILL.md` 已实现 TMUXGO_ENV=1 守卫、curl 示例、wait 语义（OCCUPANT_CHANGED 说明）。未做：idle/done/blocked 生命周期语义详解（done=unseen idle）、alternate-screen 读取陷阱、`--current`/`--no-focus` 焦点语义、JSON Schema 导出。

## 6. 对后续开发的启示（P1/P2 候选）

1. **wait 补强**：state_change_seq 基线防旧状态满足等待；活动门限（prompt 发出后必须观察状态变化）；连接断开取消。
2. **环境守卫全家桶**：`TMUXGO_ENV=1` + `TMUXGO_PANE_ID/TMUXGO_SESSION_NAME/TMUXGO_SOCKET_PATH` 注入。
3. **display 多 source**：`source` 维度 + source-scoped seq 去乱序（目前单通道）。
4. **attention priority**：`tab_attention_priority`（Blocked=4 > Unseen=3 > Working=2 > Seen=1）驱动 workspace/tab 排序。
5. **CLI 薄客户端 + 协议版本协商 + JSON Schema 导出**（P2 协议工程纪律）。
6. **skill 生命周期语义**：idle/done/blocked 解释、alternate-screen 读取陷阱、安全规则。
