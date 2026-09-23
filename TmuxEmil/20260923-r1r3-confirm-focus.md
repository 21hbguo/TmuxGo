# 任务包 A1：R1+R3 异步确认防重复提交 + 弹窗焦点闭环

来源：docs/followup-review-20260923-024431.md（R1、R3，均已复现）。派发自 devin@%655，回执回 %655。

## 开工准备（必须）

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../TmuxGo-wt-confirm-focus -b fix/confirm-async-focus master
cd ../TmuxGo-wt-confirm-focus && pnpm install --frozen-lockfile  # 如 node_modules 不可用再执行
```

只在 `TmuxGo-wt-confirm-focus` 内改动，不碰主仓工作区和其他 worktree。先用 todo_write 拆任务。

## R1 · 防重复提交落实到全部异步调用方

**证据**：`ConfirmDialog.tsx:48–55` 只有收到返回的 Promise 才进内部 busy；`CommandPalette.tsx:460` 是 `onConfirm={() => void confirmKillWindow()}`；同类写法还有 `QuickActions.tsx:858/1045`（终止窗格）、`FilePanel.tsx:3270`（文件移除）等。临时测试以 `void request()` 调用弹窗双击，实际请求计数为 2（预期 1）。

**要求**：
- 全仓搜 `onConfirm={() => void` / `void confirm` / `void request` 类写法，逐处让 Promise 真正返回给弹窗（`onConfirm={() => request()}`）或传真实 busy；不要只靠按钮样式。
- 覆盖拒绝路径：`void result.finally(...)` 在 Promise reject 时会产生未处理拒绝链——错误提示由调用方负责（只提示一次），组件负责恢复执行态；失败后允许重试。
- 同步 onConfirm（非 Promise）保持兼容。

## R3 · busy 时保持弹窗焦点边界

**证据**：`ConfirmDialog.tsx:66–72` 无可聚焦元素时直接 return，busy 时两按钮均 disabled → Tab 未被 preventDefault。

**要求**：
- 弹窗容器可程序聚焦（tabIndex={-1} + ref）；busy 时焦点留容器内，正/反向 Tab 均不离开；普通状态继续在有效控件循环。
- 关闭后焦点只恢复到仍存在的触发元素，不能错误送回终端。
- 非显而易见逻辑写注释（focus trap 的 busy 分支为什么单独处理）。

## 测试（复用现有组件测试基建）

- 双击各异步确认只提交一次：命令面板结束窗口、快捷操作结束窗格、文件移除、工作区移除/重启类确认。
- 拒绝后可重试、错误只提示一次；同步确认兼容。
- R3：正常/提交中/失败后三态下 Tab、Shift+Tab、Escape 行为；断言 `document.activeElement` 与 `fireEvent.keyDown` 返回值（默认行为是否被阻止）。

## 规则

- eslint / prettier / typecheck 过（`pnpm --filter frontend test` + `pnpm exec eslint <改动文件>` + `npm run typecheck`）；存量告警不扩大。
- 按 git log 风格 commit 到 `fix/confirm-async-focus`，不 push。
- **不要** rebuild dist、不要重启 tmuxgo-gateway——由派发方统一合并部署。
- 真实 tmux 行为测试只在名为 `test` 的 session 做（本包一般用不到）。
- 完成后回执 `DONE` + 改动文件清单 + 验证结果（lint/typecheck/test）+ 遗留风险。
