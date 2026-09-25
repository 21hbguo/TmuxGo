# 任务：TmuxGo agent 推送收件箱前端（InboxPanel + 移动端入口）

你是前端开发 agent，在 worktree `/home/guo/project/other/TmuxGo-wt-inbox-ui`（分支 feat/agent-inbox-ui）独立开发，完成后我会合并。**不要 push，不要改 gateway/协议，不要动 useConsoleStore。**

## 背景
gateway 已实现 agent→UI 推送收件箱（master 最新提交，本 worktree 已含）：
- `POST /api/v1/control/push`（agent 侧，不用你管）
- 前端 REST：`GET /api/inbox?deviceId=&cursor=&limit=&unread=`、`GET /api/inbox/:id`、
  `POST /api/inbox/:id/read {deviceId}`、`POST /api/inbox/read {ids,deviceId}`、
  `POST /api/inbox/delete {ids}`、`GET /api/inbox/:id/asset`（Range，视频 seek）、
  `GET /api/inbox/unread-count?deviceId=`
- WS 事件（挂在现有 /api/stream 上，metadata-only）：
  `{type:'inbox_message_created', message}`、`{type:'inbox_message_updated', message}`、
  `{type:'inbox_open_target', route:{hostId?,sessionName?,paneId?,tmuxPaneId?}, messageId?}`
- 消息模型见 `docs/agent-inbox/PROTOCOL.md`（type: text|image|video|file|link；
  route 归属 host/session/pane；readBy 按 deviceId）

## 必读文档（先读再写码）
1. `docs/agent-inbox/PROTOCOL.md` — 协议
2. `TmuxEmil/20260926-mobile-p0-r2.md` — **精确改动清单**，移动端部分严格照做
3. `TmuxEmil/20260926-mcp-mobile-p2.md` B 节 — tab 数据模型约束

## 要实现（全部带测试）
1. `stores/useInboxStore.ts`（新 zustand+persist，仿 useConsoleStore 的 persist-storage 用法）：
   messages 元数据镜像、unreadCount、打开的 InboxTab[]（只存 id/title/type/pinned/
   lastOpenedAt/messageId），刷新后按 id 重新 hydrate，过期消息自动过滤
2. `lib/api.ts` 加 inbox 段（getUnreadCount/list/get/markRead/delete/assetUrl 构造）
3. `hooks/useWebSocket.ts` + `lib/stream-events.ts`：三个新事件类型接入 STREAM_EVENT 分发
4. `components/InboxPanel.tsx`：桌面端面板（未读 badge、列表、点击开预览 tab、
   标已读、删除、按 route 跳 pane/session）+ `InboxPreview.tsx`（text markdown 渲染、
   img loading=lazy、video 不 autoplay、file 下载卡片、link 外链卡片）
5. 移动端：`MobileNav` 按 P0-清单 2 节加 Inbox 入口+badge；`ConsoleLayout` 按 1 节接
   overlay 栈（inbox/inbox-preview 两层）、Android back 顺序；`MobileBottomSheet` 复用
6. `inbox_open_target` 事件→导航：先 setActiveSession 再走 MobileDrawer handleSelectPane
   同链路（清单 3 节），目标不存在时 toast 不跳转
7. toast：inbox_message_created 到达时弹轻提示（带"查看"action，复用 pushToast）
8. i18n zh+en 全 key
9. deviceId：复用 agent-notifications 的设备 id 机制（找前端现有实现，没有则生成
   nanoid 存 localStorage `tmuxgo-device-id`）

## 边界（违反=返工）
- 不改 `useConsoleStore`、`PaneGrid` 输入/resize/attach、window API
- WS 不传 blob；预览一律 REST 拉；组件卸载 AbortController+revoke object URL
- 移动端禁用 100vh，用父 shell appHeight；safe-area；键盘打开不抢焦
- 变量命名/风格贴齐现有代码；注释只写非显而易见逻辑
- 提交前过 `npx tsc --noEmit`（apps/frontend 下）、相关 vitest、prettier+eslint
- 先 `pnpm install` 再开工（worktree 无 node_modules）

## 验收
- `components/InboxPanel.test.tsx`、`useInboxStore.test.ts`、`MobileNav.test.tsx`（inbox 项）、
  `ConsoleLayout.test.tsx`（back 顺序）全绿；消息到达→badge→点开预览→标已读→刷新恢复
- 完成后 `git add -A && git commit`（一条 commit），写 DONE-INBOX-UI 标记文件到 TmuxEmil/

## ⚠️ 安全规则（服务曾因 pane 误杀 tmux server 全员下线）
- 禁止 tmux kill-server / pkill tmux / kill-session 除 test 外任何目标
- gateway 测试只跑根目录 `pnpm test`（隔离 harness）；不要在 apps/gateway 里直跑 tsx --test
- 前端测试 `pnpm --filter frontend test` 安全随便跑
- 重启用 systemctl --user restart tmuxgo-gateway

## ⚠️ 续作状态（重要）
上一任 devin 在此 worktree 已写了一半：已有未提交改动
（useWebSocket/agent-push/api/stream-events/types 修改 + 新建 stores/useInboxStore.ts + pnpm-lock）。
先 `git diff` + 读 useInboxStore 摸清已完成的部分，在现有思路上补全剩余 UI
（列表/预览/未读/badge/入口），不要推倒重来。

## 后端新增事件（后端已加，前端请消费）
- `inbox_message_deleted` `{ ids: string[] }` — UI 的 DELETE /api/inbox 或其他客户端删除时广播，收到后从本地列表/镜像里移除对应 id
- `inbox_message_updated` 现在也在 markRead 时逐条广播（readBy 变化）
