# 任务包 B2：U2+U3 终端状态提示收敛 + 历史浏览语义

来源：docs/followup-review-20260923-024431.md（U2、U3）。派发自 devin@%655，回执回 %655。

## 开工准备（必须）

```bash
cd /home/guo/project/other/TmuxGo
git worktree add ../TmuxGo-wt-terminal-hints -b feat/terminal-hints master
cd ../TmuxGo-wt-terminal-hints && pnpm install --frozen-lockfile  # 如 node_modules 不可用再执行
```

注意：master 刚并入 A1/A2，基于最新 master 建分支。只在 `TmuxGo-wt-terminal-hints` 内改动。先 todo_write 拆任务。

## U2 · 终端状态条改为「必要时可行动」

**现状**：`PaneGrid.tsx` 约 L1140 的状态条绝对定位在终端上方，正常 owned 状态也常驻渲染；待发输入/重试/清空同时出现时内容增长、可能遮挡终端。

**要求**：
- 正常就绪态弱化或收起非交互文字；异常（旁观/附着中/断连/待发输入）时才展开成可行动条。
- 窄屏（320px）限制宽度并保证按钮不被裁掉/可换行。
- 「接管」按钮显示请求中态，以实际附着成功为完成条件，点击≠已接管。
- 「清空待发输入」后给轻量反馈；不展示待发内容（可能含密码）；不改现有排队/补发策略。

## U3 · 历史浏览按钮语义与事件隔离

**现状**：`TerminalPane.tsx` 约 L90–113 只跟踪 xterm viewportY/baseY；L544 只做本地 scrollToBottom。

**要求**：
- 按钮语义明确为「返回当前缓冲区底部」，不承诺退出服务端 copy-mode。
- 若想覆盖 tmux copy-mode：读已有真实状态后走现有 `copy_mode_cancel` 路径；旁观/只读端禁止改变他人会话状态（不确定就做第一步收敛+注释）。
- 浮层按钮与终端容器做指针/触摸事件隔离（stopPropagation），参考同文件 GitHub 登录卡片的隔离写法，避免点按钮误触终端点击/唤键盘。
- Vim 等 alternate buffer 不显示历史提示。

## 验证

- 组件测试补：正常态弱化/异常态展开、320px 布局断言（类名层面）、接管 pending、历史按钮事件不冒泡到终端容器。
- `pnpm --filter frontend test` + eslint + typecheck 过。
- 真实 tmux 行为验证只在 `test` session（本包一般用不到）。
- commit 到 `feat/terminal-hints`，不 push。
- **不要** rebuild dist、不要重启 gateway——派发方统一合并部署。
- 回执 `DONE` + 文件清单 + 验证结果 + 遗留风险。
