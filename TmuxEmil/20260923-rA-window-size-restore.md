# 任务包 RA：P1-A 窄端退出后宽端尺寸恢复（gateway 仲裁）

来源：docs/terminal-rendering-boundary-review-20260923-090529.md（已复现失败：multi-client-arbitration.spec.ts:141 Expected 162 Received 95）。派发自 devin@%655，回执回 %655。

## 开工准备（必须）

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../TmuxGo-wt-size-restore -b fix/window-size-restore master
cd ../TmuxGo-wt-size-restore && pnpm install --frozen-lockfile  # 如 node_modules 不可用再执行
```

只在 `TmuxGo-wt-size-restore` 内改动。先 todo_write 拆任务。

## 根因（已定位）

`apps/gateway/src/lib/stream/stream-session.ts`：
- A 独占时记 `desiredCols/desiredRows`+`assertSeq`；B claim 后 `demoteFromExclusive()` 把 A 的这些字段清零（约 L850）。
- B 断开后 `reconcileWindowPeers()`（L104-125）只从 `attachedExclusive && isExclusiveOwner() && desiredCols>0` 的连接选 champion——A 已降级、B 已断 → 无 champion → window 停在 95 列 → 宽容器右侧空白。

## 要求

- 保留被降级独占端的最后有效尺寸/主张代次（如 demoted 侧存 `lastExclusiveCols/Rows` 或不清空 desired），或在 owner 断开后让当前真实前台/可重新 claim 的端恢复 owner。不能让 `demoteFromExclusive()` 抹掉全部恢复依据。
- 明确区分「被抢端仍存活但被压后台/旁观」与「端已断开」：存活的前台端（或重归前台的端）应可恢复尺寸；**不能**让后台页自动抢回正在使用的 window（multi-client 第 60 行场景必须仍过）。
- 恢复后 peer PTY、xterm cols/rows、tmux window 三者最终一致。
- 覆盖场景：A宽→B窄→B断开→A前台；A/B 反复切换；B 断开前再次 resize。
- 仲裁/恢复逻辑属非显而易见分支，写注释说明取舍。

## 验证（隔离环境，禁碰用户 session）

- `npx tsx scripts/run-e2e.ts e2e/terminal-rendering.spec.ts e2e/multi-client-arbitration.spec.ts` —— 原失败用例必须通过，其余不回归。
- 在 multi-client-arbitration.spec.ts 增补尺寸一致性断言：tmux window cols === A 页 xterm.cols === DOM 行区宽对应列数（P1-C 第 4 项并入本包）。
- `npm test`（gateway 单测）+ `npm run typecheck` + eslint 改动文件。
- commit 到 `fix/window-size-restore`，不 push。
- **不要** rebuild dist、不要重启 prod/dev 实例——派发方统一合并部署。
- 回执 `DONE` + 文件清单 + 验证结果 + 遗留风险。
