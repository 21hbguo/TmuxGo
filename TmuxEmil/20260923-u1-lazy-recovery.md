# 任务包 B1：U1 懒加载面板的「加载中、失败、重试」闭环

来源：docs/followup-review-20260923-024431.md（U1）。派发自 devin@%655，回执回 %655。

## 开工准备（必须）

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../TmuxGo-wt-lazy-recovery -b feat/lazy-panel-recovery master
cd ../TmuxGo-wt-lazy-recovery && pnpm install --frozen-lockfile  # 如 node_modules 不可用再执行
```

注意：master 刚并入 A1/A2（确认弹窗防重复、IME 守卫），基于最新 master 建分支。只在 `TmuxGo-wt-lazy-recovery` 内改动。先 todo_write 拆任务。

## 现状依据

- `apps/frontend/src/lib/dynamic.tsx` 统一 `Suspense fallback={null}`；命令面板、设置等已动态加载。
- `App.tsx` 有全局异常边界；`lib/chunk-recovery.ts` 可能整页刷新。
- 面板 chunk 加载失败/慢网络时：点击入口无任何反馈，失败后体验不明。

## 要求

- 面板范围给出简短加载占位（spinner/骨架），**保持终端可见可操作**；首次点击即有反馈，连点不产生多个等待实例。
- 在现有懒加载边界上补局部错误恢复：某面板 chunk 失败 → 该面板内错误提示+重试按钮，不卸载终端、不整页报错；不新增通用框架。
- 重试必须真正重新请求 chunk（lazy 实例失败后需重置重试路径，不能只是重渲染同一个已失败实例）；区分离线与部署后旧 chunk 失效（后者可沿用 chunk-recovery 整页刷新策略，但要有未保存内容保护）。
- 整页自动刷新前必须保留现有未保存编辑保护，不能为恢复面板静默丢编辑状态。
- 非显而易见逻辑写注释（如 lazy 失败态重置为什么要 remount/new import）。

## 验证

- 组件测试：人为延迟/拒绝 chunk 加载（mock dynamic import 或已有基建），断言占位出现、失败提示、重试后恢复；终端区域始终 mounted。
- `pnpm --filter frontend test` + eslint + typecheck 过。
- commit 到 `feat/lazy-panel-recovery`，不 push。
- **不要** rebuild dist、不要重启 gateway——派发方统一合并部署。
- 回执 `DONE` + 文件清单 + 验证结果 + 遗留风险。
