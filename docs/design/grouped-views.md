# 多端视角（grouped sessions）设计

> 状态：设计冻结，待实施
> 实测环境：tmux 3.4，隔离 socket；基线 master `95697a1`
> 目标：同一 workspace 允许多个浏览器各自停在不同的 window，互不抢「当前窗口」。

## 1. 语义与实测

tmux 的 grouped session 共享同一批 window（同一个 `window_id`），但 `current window` 是 session 级属性。

```
$ tmux new-session -d -t test -s viewA
$ tmux new-session -d -t test -s viewB
$ tmux select-window -t viewA:1
$ tmux select-window -t viewB:2
$ tmux list-windows -t viewA -F '#{window_index} #{window_id} active=#{window_active}'
1 @0 active=1
2 @1 active=0
$ tmux list-windows -t viewB -F '#{window_index} #{window_id} active=#{window_active}'
1 @0 active=0
2 @1 active=1
```

`capture-pane -t viewA` 抓到的是 viewA 当前窗口那一屏，`list-panes -t viewA` 也只列该窗口——**镜像与 pane 列表天然按 view 隔离**，前提是 hub 按 view 建。

另两条实测事实：

- `kill-session -t test` 之后 `viewA/viewB` 仍存活（窗口还在），会变孤儿，必须显式清理。
- grouped 只隔离「当前窗口」，**不隔离 window 尺寸**；多端尺寸仍由现有的 ignore-size / 仲裁逻辑处理。

## 2. 模型

- **base session**：用户创建的真实会话，UI 里唯一可见的 session。
- **view session**：`new-session -d -t <base> -s tmuxgo-view-<hash>`，只为某个客户端视角存在。
  - hash = `sha1(hostId + '\0' + base + '\0' + viewId)` 前 12 位，避免非法字符与长度问题。
  - 在 view 上写 session option：`@tmuxgo_view_base=<base>`、`@tmuxgo_view_client=<viewId>`。
  - **过滤依据用 option，不靠名字前缀**：用户完全可以自己建同名 session；option 是权威标记。
- `viewId`：前端 localStorage 生成的稳定随机 id（每设备/浏览器一份），随 attach 消息发送。

## 3. 数据流

```
浏览器 attach {hostId, sessionName, viewId}
  → resolveAttachTarget 得到 base
  → ensureViewSession(host, base, viewId)  // 幂等：已存在则复用
  → StreamSession 记录 baseName（展示）+ attachName=view（真实 PTY 目标）
  → acquireSharedTerminal(host, attachName)  // hub key 自然按 view 隔离
  → mirror 抓取 attachName 当前窗口
```

`shared-terminal.ts` 的 key 不需要改结构：把 view 名当 session 名传进去即可；需要改的是
`StreamSession` 里所有「用 attachedSessionName 做业务判断」的地方，拆成 base 与 attach 两个字段。

## 4. 选择路由

| 操作           | 目标                      | 说明                                             |
| -------------- | ------------------------- | ------------------------------------------------ |
| 切窗口         | `<view>:<index>`          | 只改该 view 的 current window                    |
| 切 pane        | `%id`（window 级 active） | 同一 window 内所有 view 共享 active pane，可接受 |
| 新建/关闭窗口  | base                      | 结构变更对所有 view 可见                         |
| 拖 pane 跨窗口 | base 的 window id         | 拓扑共享                                         |

`routes/windows.ts:375`、`routes/sessions.ts:337` 的 `select-window` 需要接受可选 `viewId`；
缺省（老客户端/CLI/REST）走 base，行为不变。

## 5. 枚举过滤

新增 `listUserSessions(hostId)`：`list-sessions -F '#{session_name}|#{@tmuxgo_view_base}|...'`，
丢掉 `@tmuxgo_view_base` 非空的项。替换：

- `routes/sessions.ts:145` 会话列表
- `lib/agent-state.ts` 的会话扫描（否则同一批 pane 被 base 和 view 各算一次）
- 机队/巡检/快照里所有 `list-sessions` 调用

## 6. 生命周期

- **创建**：首次 attach 时 `ensureViewSession`；并发 attach 用现有 `pendingAcquires` 同款串行化。
- **销毁**：该 view 的 hub 宽限期结束（现有 `DEFAULT_HUB_GRACE_MS`）后 `kill-session -t view`；
  `kill-session` 失败不重试（幂等）。
- **清扫**：gateway 启动后与每 5 分钟一次，杀掉满足任一条件的 view：
  1. `@tmuxgo_view_base` 对应的 base 已不存在；
  2. `#{session_attached}=0` 且 `#{session_activity}` 超过 10 分钟。
- **禁止** `destroy-unattached`：它会在断线瞬间销毁 view，重连丢当前窗口；清扫必须走自己的 TTL。

## 7. 兼容与开关

- 环境变量 `TMUXGO_VIEWS=1` 开启；默认关闭，先灰度。
- 未开启或未带 `viewId`：完全走现有单 hub 路径，零行为变化。
- 控制面/CLI 不暴露 view；view 是 UI 传输层概念，不是用户可操作对象。

## 8. 风险

| 风险                                                      | 处置                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `StreamSession` 里 base/attach 混用导致消息里出现 view 名 | 只允许 `attachedBaseName` 进消息与 UI；加测试断言                            |
| 会话枚举漏过滤 → 侧栏/机队出现幽灵 session                | 用 option 过滤的单一 helper，替换后加一条「session 列表不含 view」的路由测试 |
| view 泄漏（进程崩溃/网关重启）                            | 启动清扫 + 5 分钟定时清扫；孤儿 kill 幂等                                    |
| 尺寸争抢被误认为 bug                                      | UI 文案说明「视角独立，尺寸跟随窗口」；文档写清                              |
| 24 小时长跑下 view 数量膨胀                               | 单 IP/单 viewId 上限 + 全局 view 数量上限（如 64），超限拒绝并提示           |
