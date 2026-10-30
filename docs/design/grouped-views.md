# 多端视角（grouped sessions）设计

> 状态：已实施（2026-10-30）
> 实测环境：tmux 3.4，隔离 socket；设计起点 master `95697a1`
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
- 新建 grouped view 的 current window **不继承** base，总是窗口表第一项；创建后必须显式对齐到 base 当时的 `#{window_index}`，否则第二台设备首次打开会跳窗。
- `<view>:@n` 在 select 目标里不可靠（tmux 会按 index 数字解析）；必须先用 base 查出 `@n` 的真实 index，再切 `<view>:<index>`。

## 2. 模型

- **base session**：用户创建的真实会话，UI 里唯一可见的 session。
- **view session**：`new-session -d -t <base> -s tmuxgo-view-<hash>`，只为某个客户端视角存在。
  - hash = `sha1(hostId + '\0' + base + '\0' + viewId)` 前 16 位，避免非法字符与长度问题。
  - 在 view 上写 session option：`@tmuxgo_view_base=<base>`、`@tmuxgo_view_client=<viewId>`。
  - **过滤依据用 option，不靠名字前缀**：用户完全可以自己建同名前缀 session；option 是权威标记。
- `viewId`：前端 localStorage 生成的稳定随机 id（每设备/浏览器一份，`tmuxgo.viewId.v1`，32 hex），随 attach / 读请求 / select 发送。

## 3. 数据流

```
浏览器 attach {hostId, sessionName, viewId}
  → resolveAttachTarget 得到 base（scope 校验仍按 base）
  → ensureViewSession(host, base, viewId)  // 幂等；同名但 option 不匹配 = collision，绝不 kill
  → StreamSession 记录 attachedSessionName=base（协议/peer/日志）+ attachedViewName=view（PTY/hub/refresh）
  → acquireSharedTerminal(host, view)      // hub key 按 view 隔离
  → mirror / capture / copy-mode 全部打到 view
```

`shared-terminal.ts` 结构未改：把 view 名当 session 名传入即可。所有 tmux 寻址经 `tmuxTargetName()` 替换；对外消息、peer 仲裁、exclusive 所有权、audit target 仍是 base。

## 4. 选择与读路径

| 操作           | 目标                      | 说明                                             |
| -------------- | ------------------------- | ------------------------------------------------ |
| 切窗口         | `<view>:<index>`          | 只改该 view 的 current window                    |
| 切 pane        | `%id`（window 级 active） | 同一 window 内所有 view 共享 active pane，可接受 |
| 新建/关闭窗口  | base                      | 结构变更对所有 view 可见                         |
| 拖 pane 跨窗口 | base 的 window id         | 拓扑共享                                         |

- `GET /windows`、`GET /snapshot`、`GET /panes` 接受 `?viewId=`：tmux 查询用 view，`active/zoomed/activeWindowId` 从 view 算；`sessionId/sessionName` 与 agent 状态查询始终用 base。
- `POST /windows/select` body 扩为 `{windowId, viewId?}`：先用 `list-windows -t base` 精确匹配 `@n` 拿 index，再 `select-window -t <view>:<index>`。
- `viewId` 非法 → 400；读路径 view 尚未创建 → 回退 base（前端 attach 与首屏读并发，不能 404）；**select 不回退 base**——直接 `ensureViewSession` 把 view 建出来再切，否则 attach/首点竞态会把 base 切走而 view 停在旧窗口；同名但 option 为空/不匹配 → 404 `VIEW_CONFLICT`；`TMUXGO_VIEWS=0` → 完全旧路径。

## 5. 枚举过滤

`lib/session-list.ts` 用 tab 分隔的 `list-sessions -F` 统一解析：

- `listUserSessions(hostId)`：丢掉 `@tmuxgo_view_base` 非空的行；替换会话列表、机队/巡检调用方。
- `getViewSessionNames(hostId)` / `parseViewSessionNames`：给 `list-panes -a` 去重（grouped 会让同一 pane 按 session 重复出现）。
- `parseUserSessionNames`：快照恢复判断「已存在」只认用户会话。
- agent 全量扫描（本地/远端/explain）都排除 view 名；per-session 分支查 base 本尊，不需要过滤。

## 6. 生命周期

- **创建**：首次 attach 时 `ensureViewSession`；同进程并发用 in-flight Map 合并，进程外同名冲突重读一次，归属正确则复用。
- **销毁**：**不做 hub destroy 即杀**——destroy 与并发 re-attach 的 ensure 有竞态，ensure 复用旧 view 后 kill 落地会打死新 PTY。
- **清扫**：gateway 启动扫一次 + 每 5 分钟一次，`sweepViewSessions` 只动带 `@tmuxgo_view_base` 的 session：
  1. option 指向的 base 已不存在；
  2. `#{session_attached}=0` 且 `#{session_activity}` 超过 10 分钟（`DEFAULT_VIEW_TTL_MS`）。
- 有附着者的 live view 绝不清；kill 前重新读 option 校验归属；kill 失败/目标消失按幂等处理。
- **禁止** `destroy-unattached`：它会在断线瞬间销毁 view，重连丢当前窗口；清扫必须走自己的 TTL。

这样浏览器 10 分钟内重连仍能保住自己的 current window；孤儿最多滞留一个 TTL。

## 7. 兼容与开关

- 默认开启；`TMUXGO_VIEWS=0` 是一键回退：忽略 `viewId`、不建 view、不查 option，hub key 仍是 base。
- 未带 `viewId`：完全走现有单 hub 路径，零行为变化。
- 控制面/CLI 不暴露 view；view 是 UI 传输层概念，不是用户可操作对象。
- 老前端（不带 `viewId`）与新网关、新前端与老网关（未知字段/查询参数被忽略）均可工作。

## 8. 风险

| 风险                                                    | 处置                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `StreamSession` 里 base/view 混用导致消息里出现 view 名 | 只允许 base 进消息与 UI；`stream-session.view.test.ts` 断言                         |
| 会话枚举漏过滤 → 侧栏/机队出现幽灵 session              | 用 option 过滤的单一 helper；路由测试覆盖同前缀 decoy                               |
| view 泄漏（进程崩溃/网关重启）                          | 启动清扫 + 5 分钟定时清扫；孤儿 kill 幂等                                           |
| view 创建瞬间 option 空窗 → 读请求 404                  | 窗口极窄；读路径对「session 不存在」回退 base；select 走 ensure，只有同名冲突才 404 |
| 每个带 viewId 的读多一次 `list-sessions`                | 本地开销小，远端多一次 SSH；后续可做 host 级短 TTL 缓存                             |
| 尺寸争抢被误认为 bug                                    | UI 文案说明「视角独立，尺寸跟随窗口」；文档写清                                     |
| 24 小时长跑下 view 数量膨胀                             | 单 IP/单 viewId 上限 + 全局 view 数量上限（如 64），超限拒绝并提示（未实施）        |

## 9. 验收

- 单测：`pnpm test view-sessions stream-session.view session-list sessions-view windows agent-state session-snapshot`。
- 真机冒烟：`npx tsx scripts/grouped-view-smoke.ts`（隔离 server + 真 gateway + 两个 WS view；验证独立 current window、base 不变、列表隐藏、snapshot 身份、detach 保留、TTL 清扫）。
- 全量：`pnpm test`、前端 `vitest run`、`pnpm typecheck`、`pnpm build:gateway`、`pnpm build:frontend`。
