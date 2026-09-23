DONE A3 续批 C（U4+U5） — feat/mru-perf-metrics @ 66ebc79（未 push）

## U4 最近会话语义（做真 MRU，非改名）
- `apps/frontend/src/lib/recent-session.ts`（新）：`pickRecentSessionId` 按 resumePoints.lastSeenAt 取本主机最后访问且仍存在的会话；会话删除后的残留记录（无 removeResumePoint 调用方）与跨主机记录均被排除。
- `apps/frontend/src/components/PaneGrid.tsx`：空态按钮接 MRU，无有效记录退回 orderedSessions[0]；侧栏手动排序、命令面板分组均未动。
- `PaneGrid.test.tsx` +2 用例：排序≠最近（A 排第一/最后访问 B → 开 B）；失效+跨主机记录排除（删除的 session-deleted、remote-1 的记录跳过 → 落到本机最近有效 B）。

## U5 任务时间性能验收
- `scripts/e2e-env.ts`（新）：从 run-e2e.ts 抽出的隔离环境引导（临时 dist 构建 + 隔离 tmux server 的 test session + gateway + 清理），行为原样。
- `scripts/run-e2e.ts`：改为调用共享引导（pr-smoke 回归 2/2 通过）。
- `scripts/measure-perf.ts`（新）+ `pnpm measure:perf`：bootstrap 后追加 noVNC 独立构建（对齐正式 build 顺序），跑测量 spec。
- `e2e/measure-perf.spec.ts`（新，`TMUXGO_MEASURE_PERF` 门控）：每轮新 browser context 真冷启动，采：
  - cold_start_to_input：goto→`data-ownership="owned"`（attach 完成即可输入）
  - command_palette_open：Ctrl+K→输入框可编辑且聚焦（含懒 chunk）
  - file_panel_open：Ctrl+E→FilePanel 搜索框可编辑（dynamic import）
  - session_switch：点击 rail→对端注入 marker 上屏；切换后立即键入探针命令（pending 队列路径），回切校验 A buffer 无命令回显/结果 → `wrong_session_inputs` 计数断言 =0
  - 多轮（`TMUXGO_MEASURE_ROUNDS`，默认 5）中位数+max；冷启动期间网络请求实测计数+字节（初始动态请求）
  - `.vite/manifest` 递归静态闭包 + novnc-rfb.js 预算（env 阈值可调，超预算即测试失败）
- `playwright.config.ts`：measure-*.spec.ts 默认不进 e2e 套件；`package.json` 加 `measure:perf`。

## 验证结果
- `TMUXGO_MEASURE_ROUNDS=3 pnpm measure:perf`：1 passed；实测 cold_start 中位 362ms/max 1014ms，palette 113ms，file_panel 48ms，session_switch 164ms，wrong_session_inputs=0，初始请求 26 个/1.47MB（静态闭包 965KB+83KB CSS+懒 chunk），entry 471KB、novnc 188KB，预算全过。
- `tsx scripts/run-e2e.ts e2e/pr-smoke.spec.ts`：2/2（重构回归）。
- `pnpm --filter frontend test`：83 文件 770 用例全过；typecheck 三端过；eslint 基线过（0 error，新增 0 warning）；改动文件 prettier --check 过。

## 遗留风险
- run-e2e.ts 重构为共享引导：逻辑原样搬移，pr-smoke 已回归；未跑全量 e2e。
- measure spec 未接 CI（按任务要求仅脚本可跑）；预算阈值按当前体积 ~25% 余量设定，首次超限需人工评估是否回归。
- 未 rebuild dist、未重启 prod/dev、未 push。
