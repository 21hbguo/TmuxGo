# 主攻点诊断：从「看板」到「指挥台」

> 状态：**A/B 已实施**（未提交）；C–F 仍为待办
> 基线：master `686d6d8`
> 读者：决定加什么功能的人。本文所有断言带 `file:line`，可逐条核对。

## 0. 一句话结论

TmuxGo 的主攻点不是「浏览器终端」，而是**让多个长跑 agent 与一个人共享同一块可寻址、可恢复的工作面**。
人这一侧（看板）已经基本做完；agent 这一侧（指挥）只做了单 pane 原语，缺「机队」这一层。
所以下一步的杠杆不在 UI，而在控制面：**先让 agent 能看见并指认整支机队，编排才可能发生**。

## 1. 主攻点是三层，不是一堆功能

| 层         | 内容                                                        | 是否可被抄       | 现状       |
| ---------- | ----------------------------------------------------------- | ---------------- | ---------- |
| 底座       | tmux 会话拓扑、持久化、断线续传、终端保真                   | 难抄（工程深度） | 已扎实     |
| 触达       | 浏览器/PWA/多端/多 host（local + SSH + agent）              | 可抄但成本高     | 已扎实     |
| **控制面** | agent 能操作工作台（读屏/分屏/等待/推送/MCP）、人能看见机队 | **别人没有**     | **半成品** |

前两层决定「能不能用」，第三层决定「为什么非它不可」。
`docs/ROADMAP.md` 把「agent 可观测」列为核心，方向是对的；但它只写了「可观测」，没写「可指挥」——
而真正稀缺的是后者：一个能被人和 agent 共同寻址的工作面。

## 2. 证据：人这一侧做完了，agent 这一侧没有

### 2.1 人能看到什么

- 跨 host 机队总览：`FleetPanel.tsx:27` ——「谁在跑、谁卡住、卡了多久、我要不要介入」，含树形 host/session/window 层级、注意力排序、任务号筛选。
- 待办队列：`InboxTasksView.tsx`、`routes/agent-notifications.ts:149` 的 `tasksBlocked` 计数。
- 任务号绑定入口：`PaneGrid.tsx:137` → `POST /api/panes/task`（`routes/panes.ts:237`）。
- 状态语义机：`agent-state.ts` 的 status/phase/lastEvent 三层 + 置信度 + 判定链解释（`agent.explain`）。

### 2.2 agent 能做什么

控制面（`/api/v1/control`）能力全集 = `control-protocol.ts:25-43`：

```
initialize, schema, panes.split, panes.read, panes.snapshot, panes.wait-output,
panes.run, panes.send-keys, agent.wait, agent.explain, agent.start, agent.prompt,
agent.cancel, push, open-target, inbox, browser
```

MCP 工具面（`apps/mcp/index.mjs`，27 个工具）与之一一对应，同样**没有任何一个工具能回答「现在有哪些 agent、各自在干什么活」**。

### 2.3 这条不对称意味着什么

一个编排者（DSH / Claude Code / Codex / 自研脚本）要在 TmuxGo 里带 5 个工人，今天必须：

1. 先 `panes.split` 拿到 5 个 paneId（能拿到）；
2. 自己维护「paneId → 任务 → 状态」的映射表（**TmuxGo 里已经有这张表，但 agent 读不到**）；
3. 想给 pane 挂任务号 → `POST /panes/task` 走的是**人类会话认证**，agent token 打不进去；
4. 想知道「3 号工人是不是卡在审批」→ 只能 `panes.read` 抓屏自己判（贵、且重复实现了 `agent-state.ts` 的判定链）；
5. 想等「所有工人都跑完」→ 只有单 pane/单 session 的 `agent.wait`，没有集合语义。

结论：**控制面是 pane 级 API，编排发生在 agent 的私有内存里。** 这正是「主攻点没发挥出来」的机制性原因。

## 3. 杠杆缺口（冻结清单）

编号后不再插队；新想法记入 `docs/ROADMAP.md` backlog。

| 编号  | 缺口                                                                                                 | 为什么是杠杆                                                   | 成本 | 本批   |
| ----- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---- | ------ |
| **A** | 控制面没有机队读接口：agent 无法列出跨 host 的 agent pane、任务号、语义状态、注意力                  | 一切编排的前提。没有它，agent 只能靠外部注入的 paneId 列表工作 | 中   | **P0** |
| **B** | 任务号只能由人类会话写：agent token 无法 `@tmuxgo_task`                                              | 任务归属是「工作可寻址」的最小单位；不补，编排者只能自建映射   | 小   | **P0** |
| C     | 等待只有单体语义：`agent.wait` 支持 `{paneId}` 或 `{sessionName, agent}`，没有「等这批任务全部稳定」 | 并行 fan-out 的收口动作；缺它只能轮询，违背事件驱动            | 中   | P1     |
| D     | 结果回传是自由文本：`push text/file` 没有「结论 + 产物 + 状态」结构，人侧无法批量裁决                | 人机交接的关键一跳（done → 验收 → 合并）                       | 中   | P1     |
| E     | 任务号是字符串而非实体：没有生命周期、验收态、产物关联                                               | 跨设备/跨重启后，人和 agent 对「这件事做到哪」没有共同事实     | 大   | P2     |
| F     | 清场动作缺失：agent 能分 pane 不能杀 pane/建 session                                                 | 编排尾部（失败重来、批量清理）会退回人类                       | 小   | P1     |

依赖关系：A + B 是 C/D/E 的底座；C/D 有了 A 才有意义。所以本批只做 A、B，不顺手做 F（避免一次改太多面）。

## 4. 本批 P0 的契约（已冻结）

### 4.1 `POST /api/v1/control/fleet/list`

读缓存，不触发扫描（`agentMonitor.getAllStates()`，`agent-monitor.ts:412`）——机队是冷数据，
调用方高频轮询也不会打爆 tmux；monitor 自身的快慢档决定新鲜度（面板/订阅开着即快档，`agent-observability-v2.md §1.2`）。

请求：

```json
{ "hostIds": ["local"], "statuses": ["blocked", "done"], "task": "T-234", "limit": 200 }
```

全部可选。`task` 为精确匹配；`statuses` 为空 = 不过滤。

响应：

```json
{
  "ok": true,
  "capturedAt": "2026-10-30T01:23:45.000Z",
  "summary": { "idle": 1, "working": 3, "blocked": 1, "done": 0, "unknown": 0, "total": 5 },
  "panes": [
    {
      "paneId": "local:%3",
      "hostId": "local",
      "sessionName": "dev",
      "agent": "claude",
      "agentStatus": "blocked",
      "phase": "permission_required",
      "lastEvent": "permission_required",
      "task": "T-234",
      "message": "waiting for approval",
      "confidence": "high",
      "since": "2026-10-30T01:20:00.000Z",
      "updatedAt": "2026-10-30T01:23:40.000Z",
      "needsHuman": true
    }
  ],
  "truncated": false
}
```

排序：`blocked → failed(done 的 lastEvent) → done → working → idle → unknown`，同档按 `since` 升序（卡最久的在前）——
与前端 `fleetRank`（`lib/fleet.ts`）同序，保证 agent 与人在同一屏看到同一个顺序。

安全：只返回 `TMUX_WEB_ALLOWED_SESSIONS` 允许的 session；不含屏幕内容、cwd、env、token。
`limit` 上限 500，超出置 `truncated: true`。

### 4.2 `POST /api/v1/control/panes/task`

```json
{ "paneId": "local:%3", "task": "T-234" }
```

`task` 为空串 = 解绑（走 `set-option -u`，不留空串，理由见 `routes/panes.ts:257-263`）。
与人类入口共用同一条写入语义与审计 action（`pane-task-set` / `pane-task-clear`），只是身份记为 agent token。
错误码沿用 pane 类语义码（`PANE_MISSING` / `INVALID_TARGET` / `PANE_UNKNOWN`）。

### 4.3 附带：self 识别

MCP 侧读 `TMUX_PANE`/`TMUXGO_PANE_ID` 注入 `selfPaneId`，`fleet.list` 结果里对应行 `self: true`。
编排者因此能回答「我在哪、我下面挂了谁」，不必让人类先告诉它 paneId。

## 5. 验收标准

1. `tmuxgo-ctl fleet list` 在真实 pane 内返回单行 JSON，含 `summary` 与至少自身一行（`self: true`）。
2. `tmuxgo-ctl panes task --pane-id <self> --task T-1` 后，`fleet list --task T-1` **立刻**命中该 pane；清空后不再命中。
3. 契约三入口一致：`GET /schema`、`tmuxgo-ctl schema`、`skills/tmuxgo-control/control-protocol.v1.schema.json`。
4. 单测覆盖：状态排序、过滤器（host/status/task/limit）、summary、scope/allowed-session 过滤、空机队。
5. 旧客户端不受影响：不调用新方法时行为零变化（`capabilities` 只增不减）。

## 6. 下一批（P1，不在本批实现）

- **C 集合等待**：`agent.wait` 增加 `targets: [...]` 或 `task: "T-234"`，语义 = 全部达到条件才返回，附每项终态；
  超时返回 partial（哪些到了、哪些没到）。这是 fan-out 收口的唯一正确做法。
- **D 结果信封**：`push` 增加 `result` 类型（`{status, summary, artifacts[], verdict?}`），人侧渲染为可裁决卡片
  （通过/打回/重跑），裁决回写为下一次 `agent.prompt` 的输入。
- **F 清场**：`panes.kill`（需显式 `confirm: true`）+ `sessions.create`（复用模板）。

## 7. 可见性：让 30 秒看懂主攻点

功能的深度不解决问题，**可读性**才解决。当前 README 把 Agent Control 放在功能表倒数第三行（`README.md:134`），
首屏讲的是「终端/文件/编辑器/Git」——这是 ttyd + code-server 的叙事，恰好抹掉了唯一护城河。

建议（按成本从低到高）：

1. README 首屏加一句硬定位：**「一个浏览器标签页，同时看住 5 个 coding agent」**，hero 图换成机队视图而非编辑器。
   （已做第一步：中英 README 功能表下新增「一个人类，多支 agent」小节 + 三条命令；hero 图未动。）
2. 新增 `docs/demo-fleet.md`：三条命令拉起 2 个 worker + 1 个 reviewer，演示「派活 → 卡住 → 人手接管 → 回收」。
   这是本仓库唯一无法被 ttyd/Session Deck 复现的流程。
3. `why-not-ttyd.md`：正面回答「为什么不是 ttyd + tmux」。答案必须落在第 2 节的不对称上（agent 可寻址机队、
   语义状态、恢复），不能落在「我们的终端更好看」。

## 8. 明确不做（红线）

- 不做 IDE（LSP/debug/扩展宿主）、不做 Git GUI（交互式 rebase/stage hunk）、不做通用运维平台（Docker/监控）。
  三条均沿用 `docs/ROADMAP.md` 的既有定界，本批不碰。
- 不为机队引入第二套存储：任务号仍以 tmux user-option 为唯一权威源，gateway 不落盘。
- 不做「机队自动调度」（自动分配任务给空闲 agent）：调度策略属于调用方，工作台只提供可寻址与可观测。

## 9. 实施记录（A + B）

| 层        | 落点                                                                                                                            | 说明                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 纯逻辑    | `apps/gateway/src/lib/fleet.ts`                                                                                                 | `buildFleetList()`：排序（blocked→failed→done→working→idle→unknown，同档 `since` 升序）、过滤（host/status/task/agent/allowSession）、`summary` 按匹配集合在截断前统计、`limit` 收敛到 500 |
| tmux 写入 | `apps/gateway/src/lib/pane-task.ts`                                                                                             | `writePaneTask()`：空串走 `set-option -u` 解绑，不留空值；人类路由与控制面共用                                                                                                             |
| 协议      | `apps/gateway/src/lib/control-protocol.ts`                                                                                      | 新增 `panes.task`、`fleet.list` capability + body schema + `AGENT_CONTROL_TASK_FAILED` / `AGENT_CONTROL_FLEET_FAILED`                                                                      |
| 路由      | `apps/gateway/src/routes/agent-control.ts`                                                                                      | `POST /fleet/list`、`POST /panes/task`；session 双重约束（`isSessionAllowed` + scope）；写操作进审计                                                                                       |
| 一致性    | `apps/gateway/src/lib/agent-monitor.ts`                                                                                         | `notePaneTask()` 就地 patch 缓存 + 广播 `agent_status_changed`；5s `taskOverrides` 挡住「扫描早于写入」把值盖回旧值                                                                        |
| 客户端    | `apps/mcp/index.mjs`、`apps/cli/lib/control.mjs`                                                                                | `tmuxgo_fleet_list` / `tmuxgo_task_set`（self 取 `TMUX_PANE`）；`fleet list` / `panes task`                                                                                                |
| 契约      | `skills/tmuxgo-control/*`                                                                                                       | schema 重新生成；`PROTOCOL.md` / `SKILL.md` 增补方法与错误码                                                                                                                               |
| 测试      | `lib/fleet.test.ts`、`routes/agent-control-fleet.test.ts`、`lib/agent-monitor.test.ts`、`tests/control-schema-contract.test.ts` | 排序/过滤/截断/self、守卫/空机队/校验、任务覆盖窗、MCP 工具与 schema 逐字段比对                                                                                                            |

设计取舍：

- **`fleet.list` 只读 monitor 缓存**，不触发扫描：编排者可能 1s 轮询一次，扫描成本必须由 monitor 的档位控制，而不是由调用方决定。
- **任务号仍以 tmux user-option 为唯一权威源**：gateway 不落盘；`notePaneTask` 只是缓存投影的即时修正，5s 后以 tmux 真值为准。
- **`self` 只是提示**：`selfPaneId` 不参与鉴权，避免把「我在哪个 pane」变成权限面。
- **不新增 `task` 实体**（缺口 E）：字符串任务号足够让工作可寻址；实体化等 C/D 落地后再做，否则先造一张会过期的表。
