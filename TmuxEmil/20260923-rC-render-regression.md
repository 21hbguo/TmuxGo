# 任务包 RC：P1-C 终端重复显示/尺寸一致性 E2E 回归断言

来源：docs/terminal-rendering-boundary-review-20260923-090529.md。派发自 devin@%655，回执回 %655。

## 开工准备（必须）

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../TmuxGo-wt-render-tests -b test/render-regression master
cd ../TmuxGo-wt-render-tests && pnpm install --frozen-lockfile  # 如 node_modules 不可用再执行
```

只在 `TmuxGo-wt-render-tests` 内改动。先 todo_write 拆任务。

## 任务

**新建 `e2e/render-dedup.spec.ts`**（不改动现有 spec 文件，避免与并行包冲突）：

1. **marker 不重复断言**：向 tmux 输出唯一序列 `TMUXGO_RENDER_MARKER_<id>`（独立成行），覆盖 attach、窄端抢占后回前台、断线重连三种路径，读 xterm buffer 统计该 marker 独立行出现次数——`includes` 不算数，必须计数等于 1。
2. **频率记录**：连续 resize、快速切窗口、后台页恢复、两端同时 attach 四个场景，分别记录 `window-size`/`attached`/`output_resync`/`refresh-client` 次数（走现有 metrics/日志出口；拿不到就以注入探针计数），把次数打印进测试日志并做有界断言（如 attach 一轮 refresh ≤ 上限）。
3. **尺寸一致性**（若 RA 包已在 multi-client-arbitration.spec.ts 落该项则跳过）：窄端断开后 window cols === A 页 xterm.cols === DOM 行区宽对应列数，并断言 `.xterm-rows` scrollWidth 不越界。

## 重要预期管理

本包测试是为修复后行为写的回归门：**在当前未修复代码上部分断言预期失败**（重复 marker、双发 refresh）。请先跑一遍记录「修复前基线」哪几条失败，写进回执；**不得**为通过而放宽断言。最终由派发方在 RA/RB 合并后统一复跑。

## 规则

- 只用 `scripts/run-e2e.ts` 的隔离 server + `test` session，禁碰用户 session。
- `npm run typecheck` + eslint/prettier 过。
- commit 到 `test/render-regression`，不 push。
- **不要** rebuild dist、不要重启实例。
- 回执 `DONE` + 文件清单 + 验证结果（含修复前基线失败清单）+ 遗留风险。
