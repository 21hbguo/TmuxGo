# 任务：移动端终端体验优化（PaneGrid 范围，纯 UX 层）

你在 worktree `/home/guo/project/other/TmuxGo-wt-mobile-ux`（分支 feat/mobile-ux-p1）独立开发，完成后我合并。**不要 push；不改 ConsoleLayout.tsx / MobileNav.tsx / MobileDrawer.tsx（另一 worktree 在动，冲突）；不动 PaneGrid 的输入/resize/attach 核心逻辑，只在其上加状态呈现。**

## 背景
`docs/interaction-review-20260923-011624.md` 指出的两个高感知问题至今未实现：
1. 用户分不清「看得到但不能输入」：旁观(ownershipLost/attachPassive/exclusive)、
   附着中、只读分享，在终端区都没有状态解释
2. 重连时输入去向不透明：handleInput 失败入队 flushInputQueue 补发，用户不知道有
   待发队列、不能手动清空

## 要实现（带测试）
1. 终端控制权状态条（PaneGrid 顶部小条，非遮挡）：
   - 正常可输入态弱化不显；ownershipLost/attachPassive →「旁观中·控制权不在本页」+
     「接管」按钮走现有授权/仲裁流程（找现有 takeover/attach 入口复用，不自造）；
   - attach 未完成 →「正在附着终端…」与「连接已就绪」区分；
   - shared/只读 →「只读分享」无接管按钮
2. 重连+待发输入可见性：
   - 断线短暂波动不弹 toast；持续中断 →终端上方非遮挡条「连接中断，正在重连；N 条
     输入待发送」
   - 提供「立即重试」「清空待发」动作（queue 有现有实现，找到清空接口；没有就加
     clearInputQueue 并保持 flushInputQueue 语义不动）
   - 区分「网络恢复」与「会话可输入」（ws open ≠ pane ready）
3. 移动端落地检查：状态条不挡最后行、不进键盘弹起区（沿用现有 safe-area/appHeight
   约定，可加 data-mobile-dock 类避让）；桌面同呈现
4. i18n zh+en
5. 测试：PaneGrid.test.tsx 补用例（旁观/附着中/只读呈现、重连条出现与清空、
   清空后不补发）；仿现有测试结构

## 边界
- 只在 PaneGrid.tsx 及其自有 lib/hook 层新增；i18n 两文件可改
- 不改 tmux 命令、不改 ws 协议、不改输入队列时序语义
- typecheck + 相关 vitest + prettier/eslint 过后 `git commit`（一条），
  TmuxEmil/ 写 DONE-MOBILE-UX 标记；问题写 TmuxEmil/ 回主 pane

## ⚠️ 安全规则（服务曾因 pane 误杀 tmux server 全员下线）
- 禁止 tmux kill-server / pkill tmux / kill-session 除 test 外任何目标
- 测试只跑根目录 `pnpm test`（隔离）或 `pnpm --filter frontend test`
- 重启用 systemctl --user restart tmuxgo-gateway
