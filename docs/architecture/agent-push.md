# Agent 状态推送架构

agent 状态（`idle / working / blocked / done / unknown` + phase）不走 REST 主路径，而是
「网关算 → WS 帧推 → 前端缓存合并」一条链。REST 只在断线降级和结构数据（会话/pane 列表、
几何、标题）上兜底。

## 1. 状态源六路

`apps/gateway/src/lib/agent-state.ts` 把六类信号归一成同一个 `AgentPaneState`：

| source        | 来源                                                                    | 说明                                                   |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `protocol`    | `POST /api/v1/control/agent-events`（`routes/agent-events.ts`）         | agent 自己上报的事件，最权威，高置信度                 |
| `hook`        | tmux hook 事件队列（`lib/tmux-hooks.ts`）                               | 由 `installTmuxAgentHooks` 装到 tmux，落文件后按需消费 |
| `tmux`        | `list-panes` 的 `pane_current_command` / 进程名（`detectProcessAgent`） | 无 hook 时的基线识别                                   |
| `osc133`      | 终端输出里的 OSC 133 语义标记（`parseOsc133Events`）                    | shell integration 场景                                 |
| `process`     | 子进程树扫描（`findChildProcessAgents`）                                | 兜底                                                   |
| `pane_output` | 屏幕规则匹配（`lib/agent-screen-rules.ts`）                             | 认不出来的 CLI 用屏幕文本兜底                          |

统一语义在 `resolveAgentStatus`：例如协议侧 `idle` 不把已 `done` 降级（`agent-state.ts:349`
附近），避免"刚做完立刻变空闲"的抖动。`shouldSkipCapture` 决定哪些 pane 不值得抓屏。

## 2. AgentMonitor：三档节拍

`apps/gateway/src/lib/agent-monitor.ts`(755 行)

- 对每个 host 定时 `scan()`（默认 `getHostAgentPanes`）→ 与上一轮 diff → 递增 `revision`，
  发事件：`agent_status_snapshot`（首帧基线）/ `agent_status_changed` / `agent_status_removed` /
  `agent_notification` / `agent_monitor_error`。
- **节拍分三档**（`currentPollMs()`）：
  | 条件                                 | 周期      | 配置                                               |
  | ------------------------------------ | --------- | -------------------------------------------------- |
  | 有 WS 监听者（`listeners.size > 0`） | 1.5s 快档 | `intervalMs`（下限 250ms）                         |
  | 无监听者但有 web-push 订阅者         | 5s        | `pushPollMs`                                       |
  | 都没有                               | 30s 怠速  | `TMUXGO_AGENT_IDLE_POLL_MS`（远端多/链路贵时调大） |
- host 列表自身每 5s 刷新（`hostRefreshMs`），新增 host 会自动纳入。
- `subscribe(listener)` 会对新监听者补发当前 `agent_status_snapshot`，所以前端订阅即可拿到基线，
  不需要先 REST 拉一次。

## 3. AgentFeed：帧协议

`apps/gateway/src/lib/agent-stream.ts`(373 行)，接在现有 stream WS 上（**没有新 endpoint**）。

客户端 → 服务端：

```jsonc
{ "type": "agent_subscribe", "agentProtoVersion": 1, "hostId": "local",
  "sessions": ["可选 session 白名单"], "needFull": true, "wantNotifications": true }
{ "type": "agent_resync", "subId": "as_xxx" }
{ "type": "agent_unsubscribe", "subId": "as_xxx" }
```

服务端 → 客户端 `agent_state` 帧：

```jsonc
{
  "type": "agent_state",
  "agentProtoVersion": 1,
  "subId": "as_xxx",
  "hostId": "local",
  "seq": 12, // 本订阅内单调递增，用于判连续/断号
  "mode": "full", // full=整 host 替换 | delta=按 pane 合并 | pulse=只推水位
  "stateSeq": 34, // 状态水位，消费侧取 max，旧帧不覆盖新状态
  "revision": 34, // 与 monitor 的 revision 对齐
  "changed": [/* AgentPaneState[] */],
  "removed": [{ "paneId": "...", "reason": "..." }],
  "timestamp": "...",
}
```

要点：

- 100ms 合并窗：窗口内的多 pane 变化合成一个 delta，避免逐 pane 刷帧（`sendFrame` 里 `recordStreamMetric('agentFramesSent' / 'agentFrameBytes')` 有体积指标）。
- `full` 的首帧是订阅基线；`agent_resync` 触发重放，重放帧 seq 会跳号，客户端对 `full` 不做连续性要求。
- 体积与频次都记 `streamMetric`，`GET /api/system` 响应的 `stream` 段可查（`agentFramesSent` / `agentFrameBytes`）。

## 4. 前端消费：AgentFeedClient + 缓存

`apps/frontend/src/lib/agent-feed.ts` — 客户端状态机（每 host 一个订阅，`hostId` 是稳定键，`subId` 会随重连变）：

- `seq` 连续 → 应用；断号 → `agent_resync`；重同步超过 `AGENT_FEED_RESYNC_MAX`(3) 次 →
  `onDegraded`：`invalidateQueries(['sessions'])`/`['session-snapshot']` 回落 REST，并按指数退避
  （5s→60s 上限）重订。
- 连接级 `reset()`：socket 重连后服务端订阅已消失，本地 seq 基线必须清零再重订。

接线在 `apps/frontend/src/components/PaneNotifications.tsx`(798 行)：

- `updateSnapshotCache(hostId, changed)`：`full` = 整 host 替换，未出现的 pane 视为无 agent 状态；
- `updateAgentCache`：写 `['sessions', hostId]` 的 `agents[] + agentSummary`，UI（StatusBar /
  SessionRail / SessionPanel / MobileDrawer / ConsoleLayout）只读缓存，不自己发请求。
- 能力协商失败：`agent-feed-unsupported` → 永久走 legacy 帧 + REST，不再重试、不刷错。

### 推送健康度 → REST 省流

`isAgentFeedFresh(hostId)`（`agent-feed.ts`）标识"该 host 的订阅活着且未降级"：
订阅帧发出即置位，`unsubscribe`/`reset`/重同步耗尽清位，任何被接受的帧恢复。

`useSessions`（`hooks/useApi.ts`）据此请求 `GET /api/hosts/:hostId/sessions?agents=0`，
网关侧跳过 `summarizeAgentPanes` 并省略 `agents`/`agentSummary` 字段；前端用
`withCarriedAgents` 把上一份缓存里的 agent 字段按 session id 搬回来，避免整帧替换冲掉推送结果。

**缺省行为不变**：不带 `agents=0` 的请求（老前端、未订阅端、降级期）照旧返回 agents 全量。
降级期间 `isAgentFeedFresh` 为 false，自动回到带 agents 的 REST，不会出现"推送断了界面还停在旧状态"。

## 5. 权限：scope 双闸

受限身份（只读/分享链接/allowlist token）在**两处**过滤，缺一不可：

1. **扇出前**（`routes/stream.ts` monitor listener）：先过 host 闸；对 `agent_status_snapshot`
   逐 pane 过 session 白名单，`changed`/`removed`/`notification` 按顶层 `sessionName` 闸；
   `agent_monitor_error` 无 session 维度只过 host 闸。share-ticket 观众**根本不挂** monitor listener。
2. **订阅时 + 扇出时**（`lib/agent-stream.ts`）：`subscribe()` 校验 host 与 session 白名单
   （越权项静默剔除，不报错也不泄露存在性），`fanout` 时再过一次 scope，防止订阅建立后
   scope 被运维改小。

改动这条链时不得放宽上述任一闸；`lib/access-scope.ts` 是唯一判定入口。

## 6. 仍然存在的轮询（不是 agent 状态）

| 位置                 | 周期 | 用途                                                                        |
| -------------------- | ---- | --------------------------------------------------------------------------- |
| `useSessionSnapshot` | 5s   | 窗口/pane 几何、标题、active pane；agent 字段只有 active pane 顺带清 `done` |
| `useSessions`        | 10s  | 会话列表成员、窗口数、lastActiveAt；agents 已按上文走 `agents=0`            |
| `useHosts`           | 15s  | 宿主列表                                                                    |
| `AgentRecovery`      | 15s  | 恢复候选列表（**仍靠轮询**，转推送见 backlog）                              |

## 7. 相关开关

| 变量                         | 默认           | 作用                                         |
| ---------------------------- | -------------- | -------------------------------------------- |
| `TMUXGO_AGENT_IDLE_POLL_MS`  | 30000          | 无监听者/无推送订阅时的怠速节拍              |
| `TMUXGO_AGENT_LEGACY_FRAMES` | 开（`!= '0'`） | 双发期开关：同时发 legacy 帧，老前端行为不变 |

## 8. 改动指引

- 新增状态来源：在 `agent-state.ts` 归一出一路，补 `AgentSource` 联集与 `resolveAgentStatus` 语义，
  测试放 `lib/agent-state.test.ts`。
- 新增帧字段：`agent-stream.ts` 组装处 + 前端 `AgentStateFrame` 类型 + `agent-feed.test.ts`，
  并保持 `full/delta/pulse` 三种 mode 的语义。
- 调频：先量 `streamMetric('agentFramesSent' / 'agentFrameBytes')`（`GET /api/system` 的 `stream` 段），
  再决定动 `intervalMs`/合并窗，不要直接改常量。
