# TmuxGo 本轮开发简报（devin pane %4 → codex pane %9）

## 用户目标（原文要点）
1. 优化手机端使用逻辑，更好用更方便（但不只手机端）
2. 给 TmuxGo 做一个 MCP server：让 pane 里跑的 agent（codex/claude code/deepseek harness/hermes/devin）
   能直接往 TmuxGo UI 推图片/视频/文件/文本，不再绕道飞书 lark-im
3. Tab（浏览器 tab/编辑器 tab/window tab）需要开发，数据管理要设计
4. 手机端 + PC 端都要有对应页面（MCP 推送内容的收件箱/预览）
5. 效率速度优先；顺手修潜伏 bug

## 仓库现状（我已勘察）
- gateway (fastify)：已有 agent-manager.ts / routes/agent-control|monitor|events|notifications、
  lib/agent-state|signals|terminal-output —— agent 探活/状态/按键注入已存在
- frontend：MobileNav/MobileDrawer/MobileBottomSheet/WindowTabs/EditorWorkbench/FilePanel/
  TaskCenter/PaneNotifications/UploadQueue/ToastViewport —— 组件全，但无「agent 推送收件箱」
- apps/agent：薄 tmux 代理；apps/cli；plugins/vscode-git-graph 插件机制存在
- 协议：ws stream 已二进制化（stream-binary.ts），REST+WS 双通道，auth 已有
- master 已推远端，worktree/分支已清理，无 open PR

## 请 pane2 出总规划（第一轮）
请读仓库后给出：
A. MCP server 技术形态：独立进程 stdio？gateway 内嵌 HTTP MCP endpoint（/mcp）？
   考虑：codex/cc/hermes/dsh 各家 MCP 配置方式（stdio vs streamable-http），
   以及「推送内容存哪、UI 怎么收、怎么按 session/pane 路由消息」
B. Tab 数据模型：现有 WindowTabs/EditorWorkbench tab 状态在哪管（zustand?）、
   MCP 推送该落成什么 tab 类型、本地持久化方案
C. 手机端使用逻辑痛点清单（按优先级），你看 MobileNav/ConsoleLayout/PaneGrid 码后列
D. 任务分工建议：哪些适合并行 worktree 开发（我可以再开 devin pane）
E. 性能注意事项：推送通道走 ws 还是 REST+轮询，大文件图片视频怎么传

## 协作约定
- 我是执行端（devin @ TmuxGo pane %4），你是规划端
- 回复：写文件到 TmuxEmil/ 下（命名 20260926-*-p2.md）然后 `python3 ~/.config/devin/skills/tmux-comm/tmux_comm.py send %4 "p2: 已写 TmuxEmil/xxx.md"`；
  或直接在你屏幕输出也行，我会 read %9 读屏
- 约定回执词：P2-ROUND1-DONE
- 三轮左右：R1 你出规划→我review+开工；R2 中期对齐；R3 验收
