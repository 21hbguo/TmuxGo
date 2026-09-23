# 任务包 RB：P1-B attach/redraw/snapshot 重绘请求合并去重（stream 输出）

来源：docs/terminal-rendering-boundary-review-20260923-090529.md。派发自 devin@%655，回执回 %655。

## 开工准备（必须）

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../TmuxGo-wt-redraw-dedup -b fix/attach-redraw-dedup master
cd ../TmuxGo-wt-redraw-dedup && pnpm install --frozen-lockfile  # 如 node_modules 不可用再执行
```

只在 `TmuxGo-wt-redraw-dedup` 内改动。先 todo_write 拆任务。

## 现状（已定位）

`apps/gateway/src/lib/stream/stream-session.ts`：
- attach 同时安排 `scheduleClientRedraw(sessionName, ATTACH_REDRAW_DELAYS≈[48])`（L799、L955/994）与 `scheduleAttachSnapshot(sessionName, attachSeq)`（L782，delays [0,48,120]，无输出时兜底 refresh-client）——两路都汇到 `refreshAttachedClient()`，无共享「本轮 refresh 在途/已完成」状态 → 48ms 附近可能双发。
- 共享 PTY hub 下，单个 client 的 refresh-client 输出进 hub 扇出所有订阅者；普通 output 路径无 `output_resync` 边界 → 新端 attach/重绘会让旧端整屏重绘字节无界到达，若重绘缺清屏/光标复位即重复显示。

## 要求

- 同一 `attachSeq + hostId + sessionName` 内，两条调度共用去重/合并状态；同一时间窗只允许一个 `refresh-client` 在途；收到本轮首个有效重绘输出后取消后续兜底 refresh；失败保留一次有界重试，不得无限刷。
- 共享 hub 区分「仅为新订阅者恢复」与「广播 PTY 重绘」：恢复帧只发新订阅者；确需广播的整屏重绘，接收端必须以 `output_resync` 或等价 reset 语义原子替换，不依赖 tmux 恰好发清屏序列。
- refresh 次数可从指标观察（沿用现有 metrics 通道加计数即可，勿新建平台）。
- 去重/边界协议属非显而易见逻辑，写注释。

## 冲突注意

另一 worker（RA 包）同时改本文件 `demoteFromExclusive`/`reconcileWindowPeers` 区段。你的改动集中在 schedule*/refresh 区段，diff 局部化；合并由派发方串行处理。

## 测试（gateway 单测，P1-C 第 1/2 项并入本包）

- fake tmux refresh executor 统计一次 attach 在 [0,48,120] 窗口内实际 refresh 调用次数：有输出/无输出/refresh 失败三种时序。
- fan-out 测试：A/B 两订阅者，B attach 触发恢复/重绘，断言 A 收到的整屏重绘只一次且带 reset 边界（按你实现的协议断言）。
- `npm test` + `npm run typecheck` + eslint 改动文件。

## 规则

- 真实 tmux 行为只用隔离 server 的 `test` session（scripts/run-e2e.ts 方案），禁碰用户 session。
- commit 到 `fix/attach-redraw-dedup`，不 push。
- **不要** rebuild dist、不要重启实例。
- 回执 `DONE` + 文件清单 + 验证结果 + 遗留风险。
