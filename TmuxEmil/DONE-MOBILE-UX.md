DONE mobile-ux-p1 — feat/mobile-ux-p1（未 push）

## 现状说明（重要）
接手时该 worktree 的 PaneGrid 已含状态条主体（旁观/附着中/只读/接管/待发+清空，U2+U3 提交 f8d2ef6）。本次在上补齐任务剩余增量：

## 本次改动
- `PaneGrid.tsx`
  - `LINK_DOWN_ALERT_MS=1200` 持续中断阈值：短波动完全静默（不弹条、不出重试）；
    `linkDown` 用布尔依赖计时，重连周期内 disconnected↔reconnecting 切换不重置计时。
  - `ownershipStatus` 推导重构：链路中断走防抖升级（attaching+告警文案）；attach 未完成
    （ws 未就绪/attached 未回）立即「正在附着」——区分「网络恢复」与「会话可输入」。
  - 「连接中断 · 正在重连」新文案（reconnecting）；disconnected 沿用「已断开」。
  - 待发输入条显示计数 `grid.input.pending {count}`；重试按钮仅持续中断后出现。
  - 状态条 `pointer-events-none`（不吞终端首行触摸，按钮 auto）+ `env(safe-area-inset-top)`
    避让；顶部锚定天然不挡最后行、不进键盘弹起区；桌面同呈现。
  - 未动：clearPendingInput（=clearInputQueue 语义）/flushInputQueue 时序/输入-attach-核心。
- `i18n zh+en`：`grid.control.reconnecting` 新增；`grid.input.pending` 加 `{count}` 插值。
- `PaneGrid.test.tsx`：i18n mock 支持插值断言；既有 retry 用例适配告警阈值；
  新增 describe「terminal control status bar」5 用例——attaching 呈现（ws open≠ready）、
  短波动静默、持续中断告警+重试、恢复后 attached 前仍附着中、待发计数。

## 验证
- `pnpm --filter frontend test`：86 文件 831 用例全过。
- `tsc -p apps/frontend/tsconfig.json`：0 error。
- eslint 改动文件 0 error（PaneGrid.tsx 存量 exhaustive-deps warning×1，非本次引入，未清理）。
- prettier --write 已应用于改动文件。

## 遗留/边界
- ConsoleLayout.tsx / MobileNav.tsx / MobileDrawer.tsx 未动（按边界约定）。
- split 视图注入 socket 的 isConnected 非响应式（既有问题，不在本任务范围）。
- 未 rebuild dist、未重启 gateway、未 push；pnpm-lock.yaml 为接手前既有脏改，未纳入提交。
