# TmuxGo MCP/推送通道 设计草案（devin %4 自研，待与 pane2 对齐）

## 1. 形态：控制面扩展 + stdio MCP shim（双入口）

底层永远是 HTTP（沿用现成 agent control plane 的 guard）：
- `POST /api/v1/control/push` —— agent 把内容推给 TmuxGo UI
  - body: `{ kind:'text'|'file'|'image'|'video'|'link', title?, text?, path?|base64?, name?, mime?,
           sessionName?, paneId?, open?:true }`
  - file 大 payload 走 multipart（fastify multipart 已注册），小文件可 base64 JSON
  - `path` 模式：local host 直接读盘零拷贝，最常用（agent 产物本来就在本机）
  - `open:true` = 推送后直接在前端打开预览 tab；否则只进收件箱+toast
- `GET /api/v1/control/push` 列表 / `GET .../push/:id/content` 下载 / `DELETE`（管理）
- 广播：新增 `agent_push` WS 消息类型，挂 stream.ts 里 agentMonitor 同款
  subscribe→session.send 扇出（前端已有 useWebSocket STREAM_EVENT 分发）
- 存储：`$TMUXGO_CONFIG_DIR/agent-pushes/<id>.<ext>` + `index.json`（去抖写盘）
  retention：count≤200 且 size≤512MB 且 ttl≤7d，FIFO 清

stdio MCP shim（`apps/mcp` 或 dist 附带 mjs）：
- 工具: `push_file(path,title?,open?)` `push_text(text,title?)` `push_notify(text)` `list_pushes(limit)`
- shim 从 env 读 `TMUXGO_GATEWAY_URL`(默认 http://127.0.0.1:3001)+`TMUXGO_AGENT_EVENT_TOKEN`，
  自动带 `x-tmuxgo-env:1`；codex/claude/dsh/hermes 都支持 stdio MCP，一行配置接入
- 不支持 MCP 的 agent（裸 shell/hermes 老版）直接 curl —— SKILL.md 里给片段

## 2. 关键修复：pane env 只注入了 TMUXGO_ENV=1
token/url/pane 身份没进 pane 环境 → agent 拿到 SKILL.md 也用不了。
补注入点：sessions.ts:421 new-session `-e`、panes.ts split `-e`、
agent-control.ts:184 split `-e`、gateway 启动 `setenv -g` 三件套
（TOKEN+GATEWAY_URL）；TMUX_PANE tmux 自带。remote host 走 agent executeTmux setenv。

## 3. Tab 数据模型
- FileEditorDocument.kind 扩 `'push'`（或 inbox 集合页内列表项）；
  isPersistableEditorMeta 白名单加 push（持久化存 id+title+kind，内容走 /content 拉取）
- 收件箱本身：store 里加 `agentInbox: PushMeta[]`（轻量元数据镜像）+
  badge/unread 计数；REST 拉历史 + WS 增量
- 移动端：MobileNav 加入口（或 files sheet 顶部 tab 切换"文件/收件箱"），
  推送到达→红点+toast；MobileBottomSheet 复用

## 4. 手机端逻辑优化（等 pane2 痛点清单后定）候选：
- 推送到达时的可直接点开预览（toast 带 action）
- 移动端长按/快捷命令面板入口深度
- 键盘弹起时 bottom sheet 高度（已有 75% 统一）

## 5. 性能
- push 内容不走 ws（二进制大）→ WS 只推元数据事件，内容 lazily REST 拉
- path 模式不落盘拷贝（local 引用原文件？不行，agent 可能删——存硬链/复制进 store，稳妥用复制+quota）
- index.json 防抖写盘；inbox 列表 react-query staleTime

## 6. 并行分工
- 我（master）：gateway 全部 + env 注入 + mcp shim + 测试
- worktree devin pane A：前端收件箱 UI + push tab + toast
- worktree devin pane B：移动端痛点项（等 pane2 清单）
- pane2：规划文档 + review
