# herdr 渲染 / 资源工程细节 → TmuxGo 映射

> 证据来源：本机 `herdr 0.9.5`（`--default-config`、`herdr api schema --json`、`herdr status`、隔离会话 `probe-p3` 实测）。
> TmuxGo 侧行号以本 worktree（`research/herdr-render`）为准。
> 实测脚本口径：`herdr --session probe-p3 server` 起独立会话（不动默认会话），`workspace create` 建 pane，`api snapshot` 读几何；观测完 `herdr session stop probe-p3`。

## 0. 结论摘要

| 维度 | herdr | TmuxGo | 结论 |
| --- | --- | --- | --- |
| 视口尺寸归属 | 每个 client 各自持有视口，服务端只在无 client 时退回 `120x40` | tmux window 尺寸是共享属性，靠独占所有权 + reconcile 仲裁 | 根模型不同，**不迁移**；只抄"空闲虚拟尺寸" |
| scrollback 预算 | 按字节 `10 MB/pane` | 三处行数：tmux 20000 / mirror 1000 / xterm 600 | 数字要合并成一处常量并标注换算 |
| 光标 | `host_cursor=auto/native/drawn` 三态 | 浏览器即外层终端，xterm 画光标 | **不抄**（无宿主/绘制歧义） |
| 标题 | 服务端渲染 `window_title` 模板 + `ClientWindowTitleSet` | 只读 `pane_title` 画 pane 头，浏览器标题固定 | 可做最小版：document.title 同步 |
| pane chrome | 全部客户端开关（边框/间隙/滚动条/tab 栏） | 边框由 tmux 画在 xterm 里，我们在 DOM 只做 pane 头 | 抄 `pane_outer_borders` 与 `mobile_width_threshold` 概念 |
| 渲染协议 | 控制面（公开 schema）与字符流（私有 client 协议）分离 | 自研 cell v2 快照+diff，渲染面就是公开 WS | 抄"控制面不带字符"，不迁移帧格式 |

## 1. headless 尺寸（无 client 时的虚拟终端）

herdr 侧：

- `herdr --default-config` → `[server] headless_cols = 120`、`headless_rows = 40`（注释：无 client 时 pane 用的虚拟终端尺寸）。
- 实测（`probe-p3`，headless server 无任何 client）：`workspace create` 后 root pane 的 rect 正好 `120x40`，`scroll.viewport_rows = 40`。
- 挂一个 100x29 的 client 后 area = `74x28`；128(130 列 -tmux 状态栏) 重测 130x49 → `104x48`。两次差值恒定：**chrome = 侧栏 26 列 + tab 栏 1 行**（`[ui] sidebar_width = 26` 为默认值，与实测列差一致；`tab_bar_position = "top"` 占 1 行）。行数差在两次测量里都是 1，说明除 tab 栏外没有额外常驻行。
- client 全部 detach 后，area 回到 `120x40`——即"没人看 = 退回虚拟尺寸"，pane 内程序会按虚拟尺寸重排。

TmuxGo 现状：

- 没有"虚拟视口"概念。尺寸来自浏览器 fit：`getFitDimensions()` 用渲染器实测的 cell 宽高与容器尺寸算 `cols/rows`（`apps/frontend/src/lib/terminal-layout.ts:197`、`:215`），再经 attach 消息下发给网关（`apps/gateway/src/lib/request-validation.ts:170`，字段 `cols/rows`）。
- 网关侧 hub 缓存 `cols/rows` 并驱动 PTY（`apps/gateway/src/lib/stream/shared-terminal.ts:53-62`），断线后 hub 宽限 30s（`shared-terminal.ts:17`，`TMUXGO_HUB_GRACE_MS`），宽限期内不重置尺寸；宽限期结束销毁 hub，但 tmux window 仍保留最后一次 client 尺寸。

落地建议：

1. 给 hub 加"无订阅者视口"：hub 宽限期开始后把 window 尺寸钉到 `120x40`（env `TMUXGO_HEADLESS_COLS/ROWS`，默认 120/40），避免"最后一个 client 断开 → 全屏程序按旧尺寸重排 → 重连再重排"的抖动。改动面：`shared-terminal.ts` 的 idle 路径 + `StreamSession.reconcile` 的一处分支。
2. 不做：把 `headless_cols/rows` 升格成配置文件项。我们已有 env 通道，配置文件只增加发现成本。

## 2. scrollback 预算

herdr 侧：

- `[advanced] scrollback_limit_bytes = 10000000`（10 MB/pane，注释说明对齐 Ghostty 的 scrollback-limit 行为）——按**字节**限额，而不是行数。
- 滚动状态通过 API 暴露为偏移量而不是行内容：`PaneScrollInfo { offset_from_bottom, max_offset_from_bottom, viewport_rows }`（`herdr api schema --json`，同时出现在 `session_snapshot` 的 `panes[].scroll` 与 `PaneScrollChangedEvent`）。
- `[ui] mouse_scroll_lines = 3`：滚轮 notch 换算成行数，同样由客户端配置。

TmuxGo 现状（三处口径）：

- tmux 侧 `history-limit = 20000` 行：`TMUXGO_HISTORY_LIMIT`（`apps/gateway/src/lib/tmux-policy.ts:24-30`），建 session 前抬**全局**下限、建后钉**session** 值（`:37-49`，注释解释了 pane 创建即固化的事实）。调用点在 `apps/gateway/src/routes/sessions.ts:421-424`、`:624-627`。
- 网关镜像 `SCROLLBACK_LINES = 1000` 行、增量环 `256 KB`（`apps/gateway/src/lib/stream/pane-mirror.ts:26-27`，env 可调）。
- 前端 xterm `scrollback = 600` 行（`apps/frontend/src/lib/terminal-runtime.ts:44`、`:438`）。

落差与建议：

1. 600 < 1000 < 20000：后端能补的比前端能滚的多。建议把三个数字收进一个常量模块并在注释里写换算（20000 行 × 80 列 ≈ 1.6 MB/pane，与 tmux-policy 注释一致；10 MB 参考值对应约 12 万行），前端若要"滚到底还能继续"就把 600 抬到与 mirror 同步。
2. 抄"把滚动状态当偏移量对外"这一点：我们的 pane 归档/capture 端点只回文本，缺 `offset/max/viewport` 三元组；补这三个字段成本低，能给"当前是否在回看"提供判据（herdr 的 `PaneScrollChangedEvent` 就是为此存在）。
3. 不做：按字节限额。xterm 的 scrollback 是行数语义，改成字节要么自己裁剪 buffer、要么换渲染器，收益不足以抵消。

## 3. 光标策略

herdr 侧：

- `[ui] host_cursor = "auto" | "native" | "drawn"`：`auto` 在 Windows/WSL 上自绘光标（规避 ConPTY 光标闪烁），其余平台用外层终端光标；`drawn` 恒自绘（光标作为 cell 内容），`native` 恒用宿主光标。
- 配套：`redraw_on_focus_gained = true`（外层终端重新获焦时强制整屏重绘，代价是可见闪烁，关掉可少闪但可能保留残余脏区）。

TmuxGo 现状：

- 浏览器本身就是外层终端：光标由 xterm 画，`cursorStyle: 'bar'`、`cursorBlink` 取用户偏好（`apps/frontend/src/lib/terminal-core.ts:34`、`:36`；偏好在 `terminal-layout.ts:231` 热更新）。tmux 的光标位置随输出流到达，不存在"宿主光标 vs 自绘光标"的二义性。

建议：

- 不做 `host_cursor`：没有 Windows ConPTY 中介层，加了也没有语义。
- 唯一值得抄的是"焦点回归强制重绘"：我们已有等价物——`redraw` 消息触发 `refresh-client`，并用 `output_resync` 边界帧做原子替换（`apps/gateway/src/lib/stream/stream-session.ts` 的广播重绘边界；前端见 `terminal-runtime.ts:45-49` 的攒流窗口注释）。可以把它做成显式开关（当前是自动触发），让弱网用户能关掉"切回标签页即整屏重放"。

## 4. 标题同步

herdr 侧：

- `[ui] window_title = "{hostname}: {workspace}"`，token 支持 `{hostname} {workspace} {tab} {pane} {terminal_title}`，注释明确"**在 Herdr server 上渲染**，所以远程 attach 时 `{hostname}` 指的是 pane 所在主机"。
- `tab_bar_right` 可放 `zoom/hostname/datetime/text/command`，同样服务端解析（`hostname`/`datetime`/`command` 三项注明 server-side）。
- API 面：`ClientWindowTitleSet { title }` 与 `ClientWindowTitleReason = set | cleared | no_foreground_client`——标题是**推送 + 原因**事件，不是一个可查询状态。
- pane 级：snapshot 里同时给 `terminal_title` 与 `terminal_title_stripped`（去 ANSI/控制序列）。

TmuxGo 现状：

- 只读 tmux 的 `pane_title` 用于 pane 头/列表：`apps/gateway/src/routes/windows.ts:109`、`apps/frontend/.../sessions.ts:203`、`apps/gateway/src/lib/session-snapshot.ts:179`。
- 浏览器文档标题写死：`apps/frontend/index.html:15` `<title>TmuxGo</title>`；全仓没有 `document.title` 写入点（grep 无命中）。
- 没有 `set-titles`/`set-titles-string` 设置（grep 无命中）。

建议（最小可落地）：

1. 在既有 snapshot/会话元数据里补一个 `windowTitle` 字段，由网关按 `{hostname} - {session}: {window}` 渲染（hostname 取 `os.hostname()`/host 记录，会话名来自参数），前端 `useEffect` 写 `document.title`；多标签场景下浏览器标签页立刻能区分。
2. 抄 `terminal_title_stripped`：pane 头现在直接用 `pane_title`，若其中带 OSC 残留会原样上屏；网关侧统一清洗一次再下发。
3. 不做：`window_title` 模板 DSL + token 引擎。收益是"可自定义"，成本是配置解析、迁移与文档，而我们的标题来源单一。

## 5. pane chrome（边框 / 间隙 / 滚动条 / tab 栏）

herdr 侧（全部是**客户端**渲染开关，服务端只维护 rect/splits）：

- `pane_borders = "auto" | "always" | "off"`（auto 只给分屏画边框）、`pane_outer_borders = true`（pane 区外缘再画一圈，关掉即"tmux 式内部分隔"）、`pane_gaps = true`（分屏之间留缝而不是共用分隔线）、`pane_scrollbars = true`（pane 旁独立滚动条列，关掉可把这一列还给终端）。
- `tab_bar_position = "top" | "bottom"`、`hide_tab_bar_when_single_tab`、`mobile_width_threshold = 64`（≤64 列切单列布局）。
- 几何接口：`pane layout` 回 `{area, panes[].rect, splits}`，`pane edges --pane <id>` 回四向邻接布尔——chrome 与布局对 agent 都是可读结构，不是像素。

TmuxGo 现状：

- 不自绘 pane chrome：整个 tmux window（含 tmux 自己画的边框/状态）在一个 xterm 里渲染，`PaneGrid` 每个会话只挂一个 `TerminalPane`（`apps/frontend/src/components/PaneGrid.tsx:1554`）。仓库里没有任何 `pane-border*` / `pane-border-status` 设置（grep 无命中），也没有 `pane_gaps` 等价物。
- 列宽预算由 fit 计算决定（`terminal-layout.ts:197-217`），没有"给滚动条留一列"的建模；xterm 的 viewport 被显式隐藏滚动条（`terminal-core.ts:98-105`：`scrollbarWidth: 'none'`）。

建议：

1. 抄 `pane_outer_borders` 的**语义**而不是实现：单 pane（无分屏）时去掉外缘边框、多 pane 时只画内部分隔。我们现在没有这个概念，视觉上单 pane 也带着一圈框，属于可以立刻收敛的噪音。
2. 抄 `mobile_width_threshold`：我们按 UA/断点切单列，窄桌面窗口（如侧栏拖到 600px）不会退化；加一个"有效列数 < 64 → 单列"的判据成本很低。
3. 不抄 `pane_scrollbars`：xterm 的滚动是 viewport 内部行为，独立滚动条列会永久吃掉 1 列且与触摸滚动冲突；给 "回看中" 状态做 DOM 浮标更合适。

## 6. 多 client 尺寸仲裁对比（核心差异）

herdr 模型（**每客户端独立视口**）：

- 公开 socket API **完全没有** `cols`/`rows` 字段（`herdr api schema --json` 全量 JSON 里 `"cols"` 命中 0 次），视口尺寸只存在于 client↔server 的私有协议（`herdr status` 显示 `private_protocol 22`，`herdr server` 日志里 client socket 与 api socket 分开：`herdr-client.sock` vs `herdr.sock`）。
- 因此不存在"两个 client 抢 window size"：服务端按 client 的视口算各自 rect；没有 client 时退回 `120x40`（§1 实测）。
- 代价：**没有共享视口**。两个 client 看到的 pane 尺寸可以不同，程序（如 vim）只能按某一个尺寸排——herdr 靠"客户端各自渲染 + 服务端只给 rect"回避，这与 tmux 的共享 window 语义是两条路。

TmuxGo 模型（**共享 tmux window**）：

- 尺寸来自 tmux window：`window-size latest / aggressive-resize` 下由"最近主张"的 client 决定（`apps/gateway/src/lib/stream/stream-session.ts:57-66` 注释）。
- 旁观端用 `attach -f ignore-size` 不参与主张（`apps/gateway/src/lib/terminal-attachment.ts:74-90`、`:158-166`，含 `-f` 版本探测与"不要加 `active-pane`"的踩坑注释）。
- 独占所有权：`exclusiveOwners`（`stream-session.ts:71`），易主时 `ownerEpoch` 递增、`windowVersion` 累计每次尺寸决策（`:72-78`），前端据两个单调序号丢弃跨世代/乱序的 `window-size`/`resized`（`:78`、`:659-726`）。
- 仲裁后 reconcile 读真实 window 尺寸回灌所有连接（`:682-730`，含 `WINDOW_SYNC_DELAY_MS = 80`、settle 60ms）。

结论：这不是"实现优劣"，是模型差异——tmux 的窗口尺寸是窗口属性，我们没有 herdr 那种"每客户端视口"的自由度。可抄的只有两点：① 无 client 时退回虚拟尺寸（§1 建议 1）；② "尺寸决策带版本号 + 原因"这种可观测性（我们已有 `windowVersion`/`ownerEpoch`，等价于 herdr 的 `PaneResizeReason`，但 herdr 的 reason 枚举目前只有 `unchanged` 一个值，参考价值有限）。

## 7. cell / snapshot 协议边界

herdr 侧：

- 公开面只有**结构快照与事件**：`session_snapshot`（workspaces/tabs/panes/layouts/scroll/terminal_title）、`pane_layout`、`pane_edges`、`PaneScrollChangedEvent`、`ClientWindowTitleSet/Reason`。字符级帧走私有 client 协议，schema 不公开（`herdr api schema` 只列 `request/success_response/event/error_response/subscription_event` 五类）。
- 换句话说：herdr 把"控制面"（可由 agent/CLI 驱动）与"渲染面"（不可外部复用）切得很干净。

TmuxGo 现状：

- 同一套 WS 上同时跑控制面与渲染面：`attach/detach/resize/input/redraw`（`request-validation.ts:170-200`）与 cell 帧（`apps/gateway/src/lib/stream/stream-cell.ts:4`、`stream-session.ts:452-460`）。
- cell v2 已实现：`cell_snapshot_v2`(9)/`cell_snapshot_v2_gzip`(10)/`cell_diff_v2`(11)/`cell_diff_v2_gzip`(12)，RLE + 显式 `width`（0/1/2）+ `seq/baseSeq` 重同步（`docs/stream-transport-opt/CELL_PROTOCOL_V2.md:9-25`、`:27-45`）。状态源是真终端 `@xterm/headless` 而不是传输层重建 VT。

建议：

- 不做帧格式迁移（herdr 私有协议不可见，抄不到细节）。
- 抄边界划分：REST/CLI/MCP 面继续只回结构（rect / scroll offset / 标题），字符只走 WS。这条我们基本已经做到，唯一缺口是 §2 提到的滚动偏移三元组。

## 8. 明确"不建议抄"清单

| 项 | 为什么不抄 |
| --- | --- |
| 每客户端独立视口（私有 client 协议那套） | tmux window 尺寸是窗口级共享属性，改造要换掉整个 attach/resize 模型，代价与收益不成比例 |
| `host_cursor` 三态 | 浏览器即外层终端，没有宿主光标/自绘光标的分裂 |
| 按字节 scrollback 限额 | xterm 是行语义，要改渲染 buffer 才能按字节裁 |
| `pane_scrollbars` 独立列 | 永久吃 1 列，且与触摸滚动/选择冲突；浮标更合适 |
| `window_title` 模板 DSL + token 引擎 | 标题来源单一，配置解析与迁移成本高于收益 |
| `mouse_scroll_lines` 细粒度配置 | 我们已按行滚 + 触摸惯性，没有 notch 抽象 |

## 9. 落地清单（按性价比排序）

1. 无订阅者视口钉 `120x40`（`shared-terminal.ts` + `stream-session.ts` 各一处分支，env 可调，含单测：hub 空闲 → window 尺寸归位）。
2. `document.title` 同步（网关补 `windowTitle`，前端一个 effect；顺带清洗 `pane_title`）。
3. 三处 scrollback 常量收敛到一处并写换算注释；决定是否把前端 600 抬到 1000。
4. 会话/归档端点补 `scroll: { offset, max, viewport }` 三元组。
5. 单 pane 去外缘边框 + "有效列数 < 64 退单列"。
