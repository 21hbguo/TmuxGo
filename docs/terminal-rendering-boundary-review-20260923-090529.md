# 终端重复显示与半屏渲染边界复审

- 时间：2026-09-23 09:05:29（Asia/Shanghai）。
- 基线：`2f1f413`，工作树仅新增本报告。
- 用户现象：终端部分内容重复出现；偶发刷新后恢复；部分内容只出现在左侧，右侧为空。
- 本轮未修改业务代码、未重启生产实例；E2E 使用 `scripts/run-e2e.ts` 的临时配置、临时 tmux server 和临时 `test` session，不操作用户现有 session。

## 一、已确认的边界

### 1. “右侧为空/只显示一半”存在可稳定失败的多客户端尺寸回归

执行：

```bash
npx tsx scripts/run-e2e.ts e2e/terminal-rendering.spec.ts e2e/multi-client-arbitration.spec.ts
```

结果：终端渲染相关用例 4 个通过，`multi-client-arbitration.spec.ts` 1 个失败：

```text
Expected: 162
Received: 95
```

失败位置：`e2e/multi-client-arbitration.spec.ts:171`，场景是：

1. A 页面宽视口附着同一 session，tmux window 为约 162 列。
2. B 页面窄视口以独占模式附着，window 被压到约 95 列。
3. A 被降为旁观端。
4. B 关闭，A 回到前台。
5. 期望幸存的 A 把 window 恢复到原宽度，实际仍停留在 95 列。

因此，“窄客户端退出后宽客户端没有恢复尺寸”是已复现 bug，不是单纯 CSS 或截图问题。宽容器与窄 PTY/window 不一致时，xterm 只能渲染左侧列，右侧为空，正好对应用户截图所述边界。

### 2. 尺寸恢复失败的代码原因边界已缩小

`apps/gateway/src/lib/stream/stream-session.ts` 当前逻辑：

- A 初始独占时记录 `desiredCols/desiredRows`。
- B claim 独占后，`demoteFromExclusive()` 会把 A 的 `desiredCols/desiredRows` 和 `assertSeq` 清零。
- B 断开后，`reconcileWindowPeers()` 只从仍满足 `attachedExclusive && isExclusiveOwner() && desiredCols > 0` 的连接选择 champion。
- A 已被降级，B 已断开，因此没有 champion；tmux window 不会回到 A 原来的尺寸。

相关位置：`stream-session.ts:81–88`、`stream-session.ts` 的 `demoteFromExclusive()`、`reconcileWindowPeers()`。

这解释了为什么普通 resize 回归可以通过，但“窄端抢占后退出”的恢复场景仍失败。

### 3. 重复显示存在确定的重复重绘路径，用户界面表现还需补一个专门断言

每次 attach/复用 attach 当前至少会安排两类 tmux 重绘：

- `scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS)`，默认约 48ms。
- `scheduleAttachSnapshot(sessionName, attachSeq)`，默认 `[0, 48, 120]`ms，在没有观察到输出时触发 `refresh-client`。

两条路径都最终调用 `refreshAttachedClient()`，没有共享的“本轮 refresh 已在途/已完成”状态。无输出、慢输出或 refresh 执行时序相同时，48ms 附近可能发起两次刷新。

此外，共享 PTY 模式下，单个 tmux client 的 `refresh-client` 输出会进入共享 hub，再扇出给所有订阅者。一个新端的 attach/redraw 会让旧端也收到整屏重绘字节；当前注释把它视为幂等覆盖，但普通 `output` 路径没有先发送本端 `output_resync` 边界。若重绘字节未包含足够的清屏/光标复位，旧端就可能出现重复内容；多次 attach、切回前台、重连会放大概率。

因此可以确认：**重复重绘的代码路径存在，且共享扇出会把一次重绘扩大到多个客户端**。目前还没有把“屏幕文本重复次数”固化成自动失败的 E2E 断言，不能把每次用户看到的重复都归因于同一条路径；下一步应先补测试再改发送策略。

## 二、优先派活范围

### P1-A：修复窄端退出后的宽端尺寸恢复

建议由 Gateway/终端仲裁方向处理：

- 保留被降级独占端的最后有效尺寸/主张代次，或在 owner 断开后依据当前真实前台/可重新 claim 的端恢复 owner；不要让 `demoteFromExclusive()` 清空所有恢复依据。
- 明确“被抢端已失焦”和“窄端已断开”的区别，不能在后台页自动抢回正在使用的 window。
- 恢复尺寸后，所有 peer 的 PTY、xterm 行列、tmux window 三者必须最终一致。
- 继续覆盖 A 宽 → B 窄 → B 断开 → A 前台，以及 A/B 反复切换、B 在断开前再次 resize 的场景。

验收：原失败用例稳定通过；额外断言 `tmux window cols === pageA xterm.cols === rows DOM 实际宽度对应的列数`，并截图/读取右边界，确认没有空半屏。

### P1-B：合并 attach/redraw/snapshot 的重绘请求

建议由 stream 输出方向处理：

- 同一 `attachSeq + hostId + sessionName` 内，`scheduleClientRedraw` 与 `scheduleAttachSnapshot` 共用去重/合并状态；同一时间窗只允许一个 `refresh-client` 在途。
- 收到本轮首个有效重绘输出后取消后续兜底刷新；refresh 失败仍保留一次有界重试，不能无限刷新。
- 共享 hub 下区分“只为新订阅者恢复”与“广播给所有订阅者的 PTY 重绘”，不要让旧订阅者无边界地重复接收同一整屏重绘。
- 若必须广播，先定义并测试输出边界：整屏重绘必须在接收端以 `output_resync` 或等价 reset 语义原子替换，不能依赖 tmux 恰好发出清屏序列。

验收：

- 同一端 attach、重连、切窗口不会把固定 marker 重复渲染两次。
- 两端同时 attach 时，旧端不会因新端首帧重绘增加重复屏幕。
- 真实输出正在持续时不触发额外的 snapshot refresh。
- 失败重试次数有上限，并能从指标中观察 refresh 次数。

### P1-C：补齐可以阻止回归的自动测试

现有测试能发现尺寸恢复失败，但还缺少重复渲染断言。建议新增：

1. Gateway 单元测试：fake tmux refresh executor 统计一次 attach 在 `[0,48,120]`窗口内实际调用次数，覆盖有输出、无输出、refresh 失败三种时序。
2. Gateway fan-out 测试：A/B 两个订阅者，B attach 触发 refresh，断言 A 收到的整屏重绘具有明确 reset 边界且只出现一次。
3. E2E：向 tmux 输出唯一序列 `TMUXGO_RENDER_MARKER_<id>`，attach/窄端抢占/重连后读取 xterm buffer，断言 marker 不重复；不要只用 `includes`，要统计独立行出现次数。
4. E2E：验证窄端断开后宽端的 `cols/rows`、tmux window 尺寸和终端行区宽度一致。
5. E2E：连续 resize、快速切窗口、后台页恢复与两个客户端同时 attach，分别记录 `window-size`、`attached`、`output_resync`、`refresh` 次数。

## 三、可能相关但暂未定性的边界

### 1. 重复显示可能来自旧输出与新 attach 输出跨代交错

Gateway 有 `attachSeq` 守卫，但浏览器端的 `subscribeOutput` 过滤主要按 `hostId/sessionName`，没有显式 attach epoch。若旧端输出已经进入 WebSocket/前端事件队列，在新一轮 `attach` 后才到达，服务端虽然通常会丢弃旧 PTY 回调，仍应通过测试确认不会在新画面 reset 后再次写入。

建议记录每帧 attach 代次或客户端本地 attach token；先用日志/测试确认，再决定是否扩大协议字段。不要直接新增协议字段作为猜测性修复。

### 2. `output_resync` 与 cell snapshot/diff 的组合要单独测

当前 cell 模式在 resync 时去掉 `ED` 清屏序列，改为 cell reset；普通 ANSI 模式依赖 reset + refresh。两条路径的“重复”和“半屏”表现可能不同，不能只修普通 ANSI 后宣称 cell 已覆盖。需分别验证：

- `TMUXGO_STREAM_CELL=0/1`。
- 压缩开关和 fan-out 开关。
- 桌面独占、桌面旁观、移动端。

### 3. 浏览器截图中的“右侧无内容”不一定全由尺寸造成

本轮 E2E 已确认尺寸失配足以产生该现象，但用户截图的具体浏览器布局、缩放比例、字体加载和 CSS 容器宽度尚未在真实环境复现。修复尺寸仲裁后仍需用截图或 DOM 检查：`.xterm-rows` 宽度、`terminal.cols`、PTY/window cols、横向 scrollWidth 是否一致。

## 四、给 pane3 的执行顺序

1. 先处理 P1-A，修复现有失败的 `a narrower client demotes then restores the wider client view`。
2. 再处理 P1-B，合并两套 attach 重绘调度并补 fake executor 计数测试。
3. 最后处理 P1-C 的 E2E 重复 marker 和尺寸一致性回归。
4. 修复后至少运行：

```bash
npx tsx scripts/run-e2e.ts e2e/terminal-rendering.spec.ts e2e/multi-client-arbitration.spec.ts
npm run typecheck
npm run test:frontend
npm test
```

所有真实 tmux 行为必须继续使用隔离 server 的 `test` session；不要操作用户其它 session。通过后再按项目规则重新 build，并重启生产 `tmuxgo-gateway`。

本报告只提供边界证据和任务拆分，不直接修改业务代码。
