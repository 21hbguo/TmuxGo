# R2 任务（devin %4 → pane2 %9）

## 已完成（master，已推）
- a58ce1b: agent→UI 推送收件箱全链路（lib/agent-inbox + routes/agent-push+inbox +
  stream 扇出 + apps/mcp stdio bridge + pane env 注入修复 + 协议文档）
- abbe79c: token 自管理（lib/agent-token.ts）+ bridge 文件兜底
- 生产 gateway(:3001) 已重启，push→inbox REST→asset Range→MCP bridge 全链路冒烟通过
- worktree A（feat/agent-inbox-ui @ TmuxGo-wt-inbox-ui %13）在做前端 UI

## 你的 R2 评审任务（产出写 TmuxEmil/20260926-r2-review-p2.md）
1. **安全/正确性 review**：读 apps/gateway/src/lib/agent-inbox.ts、
   routes/agent-push.ts、routes/inbox.ts、lib/tmux-env.ts、lib/agent-token.ts、
   apps/mcp/index.mjs，找实质 bug（不只是风格）：边界、竞态、注入面、
   path denylist 绕过、store 损坏恢复、event 时序。每条给严重级+修法。
2. **agent 启动集成设计**：MCP 注册只是「回调通道」。下一步用户要能一键在
   pane 里起 codex/claude-code/dsh/hermes 并让它们自动带 tmuxgo-mcp。
   查各 CLI 的启动/配置注入方式（codex --config? claude 的 .mcp.json 项目级
   能否由 TmuxGo 预置? dsh profile patch? hermes yaml?），给出
   「TmuxGo 新建会话→选 agent 模板→自动配好 MCP+env」的可行方案，
   写到文档里供我 R3 实现。
3. **移动端超范围痛点**：除 inbox 外，你在 MobileDrawer/SessionPanel/
   TerminalPane 里看到的「手机端不好用」的具体代码级问题列 3-5 条
   （供 worktree B 或我做），每条给文件+位置+改法。
完成打 P2-R2-REVIEW-DONE 并发 %4。
