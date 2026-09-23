# N-B：导航生命周期/历史位置修复（EditorWorkbench.tsx）

- worktree：`/home/guo/project/other/TmuxGo-wt-nav-lifecycle`，分支 `fix/nav-lifecycle`（已建，基于 master 1813fa3）
- 依据：`docs/editor-navigation-boundary-review-20260923-093054.md` §三/§四/§五（先通读全文，重点 §一/§六验收矩阵）
- 目标文件：`apps/frontend/src/components/EditorWorkbench.tsx` 及组件测试；必要时最小改 `editor-open.ts`
- N2/N3 同文件由你一人串行处理

## 已复现 bug

### N2：返回后旧异步跳转抢回焦点（文档 §三）

1. A:22:4 F12→B:60:10；B 再 F12（resolver 挂起）；Alt+Left 回 A:22:4
2. 挂起的 resolver 完成后 → **实际又打开 B 并改写历史；预期停在 A**
- 原因：只在下一次搜索时 abort；Back/Forward 不使旧搜索失效
- 要求：Back/Forward（工具栏+Alt 快捷键同一命令路径）使在途搜索失效——旧结果不得导航、不得改历史；覆盖手动切文件/关源文件/组件卸载；保留「下一次搜索取消前一次」；**不得禁用返回规避**；补延迟 resolver 精确顺序测试（断言最终文件/行列+历史栈未污染）

### N3：旧 pending 覆盖用户新位置（文档 §四）

1. location 事件落 A 到 33:3；用户移到 44:5；1500ms 内切 B 再切回（remount）→ **A 被重放回 33:3**
- 要求：区分「同一次导航的 loading/StrictMode 重挂」与「用户已改位置后的普通切 tab」，不再依赖固定 1500ms 窗口；保留未加载实例的落位能力（不能简单删 pending 致加载竞态回归）；必要时保存/恢复 viewState/选区（当前卸载分支不保存 viewState，只清 pending 不能保证回到 44:5）；只对当前目标实例/模型生效、列号按模型范围校验；补 loading 延迟/旧实例 dispose/快速 remount 测试；「跳定义」可居中，「返回/前进」恢复原视口/选区不强制居中

### §五 顺带核查（已确认才修，勿当根因扩改）

- `getNavigationPosition` 先取 React 缓存再取 Monaco getPosition 的提交边界
- 打开文件失败（读取错误/删除/权限）时历史栈不得丢；不改公共 API 签名
- 快捷键 window capture：验证 Monaco 原生命令/输入框/模态框是否双触发，同一用户动作只产生一次应用导航

## 流程

1. `cd /home/guo/project/other/TmuxGo-wt-nav-lifecycle && pnpm install`
2. 建 todo；先写红测（有状态 Monaco 替身/可控 resolver/opener 派发 location 事件——探针源码参考 `/tmp/navigation-review-probe.test.tsx`，备份可能已失，参照文档描述自建）
3. 验证：`npx vitest run src/components/EditorWorkbench.test.tsx`、`npm run typecheck`、eslint/prettier 改动文件净
4. commit（**不 push**），回执 DONE 到 %0

## 安全红线

- 严禁裸 `tmux`（本包不需要）
- 不碰 `code-navigation.ts`（N-A 地盘）；N-A/N-B 将由我串行合并
