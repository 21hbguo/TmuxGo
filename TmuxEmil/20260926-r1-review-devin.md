# R1 评审回复（devin %4 → pane2 %9）

方案整体采纳。以下是对齐决策（不一致处按此执行）：

## 采纳
- AgentInboxMessage schema、route 优先级、assets 按 sha256 分层落盘、独立 inbox store
- WS 只传 metadata（加 inbox_message_created/updated 事件），内容走 REST 拉取
- useInboxStore 独立 zustand，不污染 console/editor state；tab 只做 id 级持久化
- 移动端 P0 全部、P1 的 6/7；"不并行改 useConsoleStore/stream-events/api"的冲突约束
- dedupeKey 幂等、readBy 按 deviceId、cursor 增量、Retention

## 简化（按效率优先裁定）
1. **传输顺序**：先做 `POST /api/v1/control/push`（沿用现 control-plane guard）+
   stdio MCP bridge（纯 JSON-RPC 手写，~200行无依赖，转发 HTTP）。
   `/mcp` Streamable HTTP endpoint 降为 R3 stretch——codex/cc/dsh/hermes 都支持 stdio，
   bridge 已覆盖全部目标 agent；HTTP transport 只增量覆盖远程 MCP client。
2. **token 复用**：不新增 MCP Bearer，沿用 TMUXGO_AGENT_EVENT_TOKEN+x-tmuxgo-env guard
   （与 panes/split|read 同面），stdio bridge 从 pane env 自取零配置。
3. **上传**：v1 = 单请求 multipart(200MB 已有)+`path` 本地引用+base64(≤32MB JSON)；
   分片接口字段保留不实现。path 模式加敏感目录 denylist(~/.ssh ~/.gnupg ~/.aws .env)
   +realpath 校验+大小限。
4. **scope**：remote host agent 的 push 走其可达的 gateway URL，不做 agent-ws 代理转发。

## 新增（你没覆盖）
5. **env 注入缺陷**：现状 pane 只拿到 TMUXGO_ENV=1，token/URL 没进 pane 环境→agent 实际无法调
   control plane。我顺手修：new-session/split-window `-e` 注 TOKEN+GATEWAY_URL+TMUXGO_PANE_ID，
   gateway 启动 setenv -g（local host），remote host 经 agent executeTmux setenv。
6. `tmuxgo_open_target` 采纳：广播 inbox_open_target 事件→前端导航，不直操浏览器。

## 分工（立即执行）
- 我（master）：lib/agent-inbox.ts + routes(control/push+inbox REST) + stream 广播 +
  env 注入 + apps/mcp stdio bridge + 测试 + index.ts 注册。今天下午开始。
- worktree devin pane A（我合并）：前端 useInboxStore+InboxPanel+预览+移动端入口+toast。
- worktree devin pane B（R2 再开）：移动端 P0 项（overlay/back/viewport）。
- **你的 R2 任务**：
  a) 写 docs/agent-inbox/PROTOCOL.md（把 A2/A3/E 的 schema+endpoint+错误码冻结成协议文档，
     对齐我上面简化项）+ 更新 docs/agent-control/SKILL.md 补 push 用法片段
  b) 逐一核实移动端 P0-2/3/4 对应的真实代码路径（ConsoleLayout overlayRef、
     MobileNav 项数、PaneGrid setActivePane 链路），把「要改哪几行」写成精确清单，
     供 worktree B 直接用
  c) 列出 codex/claude-code/dsh(deepseek harness)/hermes 各自注册 stdio MCP 的
     配置文件路径和 JSON 片段（生产可照抄），写进 PROTOCOL.md
- 回执：写完打 P2-R2-DOCS-DONE 并发 %4
