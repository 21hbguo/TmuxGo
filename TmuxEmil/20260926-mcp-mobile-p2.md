# TmuxGo MCP + Mobile 总规划（P2 Round 1）

> 目标：在不破坏现有 REST/WS、agent 状态/通知、编辑器和移动端交互的前提下，先用最小闭环让 pane 内 agent 可以把文本/图片/视频/文件推到 TmuxGo，PC/手机都能收件箱式查看；同时把 Tab 数据模型定稳，后续再扩展。

## 现状结论（基于代码）

- gateway 已有 Fastify、`@fastify/multipart`（单文件上限 200 MB、20 个文件）、REST + WebSocket、认证 hook；`/api/agent-events` 是 token 豁免并自行校验 agent event token。
- agent 事件链已经具备：`agent-events` → `agent-monitor` → `stream.ts` 订阅并广播 `agent_status_*` / `agent_notification`；前端 `useWebSocket` 已把事件转成 `STREAM_EVENT`。这条链适合承载“实时到达提示”，不宜直接承载大文件。
- agent 通知已有 `~/.tmuxgo/agent-notifications.json` 的原子持久化、按 deviceId 查询未读/标记已读、Web Push；它的状态枚举是 blocked/done/permission_required 等，不能硬扩成通用媒体存储。
- 前端的长期 UI 状态集中在 Zustand `useConsoleStore`，使用按 device kind 分开的 debounced localStorage；移动端目前只持久化 activeHost/activeSession。`WindowTabs` 的窗口数据来自 API/query state，`EditorWorkbench` 的文件 tab 来自 `openEditors/editorGroups/editorLayout`。
- `ConsoleLayout` 已有移动端 visualViewport/dvh/safe-area/键盘、历史 overlay stack；`MobileNav` 入口较多；`PaneGrid` 已处理 attach、resize、输入队列和移动端 terminal。应在这些既有边界上增量修改，不再造第二套 viewport/WS/状态系统。

## A. MCP server 技术形态与消息路由

### A1. 结论：gateway 内嵌 `/mcp` 为主，另提供薄 stdio bridge

1. **主实现**：Fastify 内注册 MCP Streamable HTTP endpoint（建议 `/mcp`，支持 POST/GET；JSON-RPC 消息和可选 SSE/stream response）。它与现有 gateway 共用端口、auth、host/session/pane 校验和文件落盘，UI 只需接现有 WS/REST。
2. **兼容入口**：新增 `apps/mcp` 或 `apps/cli` 内的薄 stdio bridge，仅负责读取 stdin JSON-RPC、转发到 gateway `/mcp`，不重复实现业务和存储。这样本地 Codex/Claude Code 只需 command 配置，远程/容器环境可直接 URL。
3. 不优先做独立 MCP 进程：独立进程会重复认证、配置、文件生命周期和端口管理，agent 推送与 UI 实时 fanout 还需跨进程总线；只有 gateway 部署隔离或后续多租户需要时再拆。

Codex 当前支持 STDIO 与 Streamable HTTP，HTTP 可用 Bearer/OAuth；MCP 新传输以 Streamable HTTP 取代旧 HTTP+SSE。HTTP 实现必须校验 Origin、正确鉴权，监听本地时只绑定 localhost，避免 DNS rebinding。故本地 CLI 默认 stdio bridge；网络访问默认 `/mcp` + Bearer，禁止匿名。

### A2. MCP 工具最小集合（第一期）

- `tmuxgo_push_text`：文本/markdown；参数 `hostId`, `sessionName?`, `paneId?`, `tmuxPaneId?`, `agentSessionId?`, `title?`, `body`, `dedupeKey?`。
- `tmuxgo_push_media`：小文本 metadata + `content`（base64 仅限小对象）或 `uploadUrl`/已上传 assetId；不把视频 base64 放 JSON。
- `tmuxgo_push_file`：`name`, `mime`, `size`, `sha256`, `content`（小文件）或分片上传后 `assetId`。
- `tmuxgo_list_inbox`：按 `deviceId?`, `hostId?`, `sessionName?`, `paneId?`, `unread`, `cursor`, `limit` 查询。
- `tmuxgo_mark_inbox_read`：按消息 id 批量已读。
- 可选 `tmuxgo_open_target`：请求 UI 聚焦指定 host/session/pane；服务端只发导航事件，不让 MCP 直接操纵浏览器。

工具返回稳定的 `messageId`, `assetId`, `createdAt`, `route`, `status`，并以 `dedupeKey` 做幂等。未知路由不应丢弃消息，进入“未归类/全局 inbox”并提示用户。

### A3. 推送内容与路由模型

统一领域对象（建议 `AgentInboxMessage`）：

```ts
{
  id: string; type: 'text'|'image'|'video'|'file',
  title?: string, text?: string, assetId?: string,
  mime?: string, size?: number, sha256?: string,
  source: { provider?: string; agent?: string; agentSessionId?: string },
  route: { hostId?: string; sessionName?: string; paneId?: string; tmuxPaneId?: string },
  createdAt: string, readBy: string[], expiresAt?: string,
  dedupeKey?: string, metadata?: Record<string, unknown>
}
```

路由匹配优先级：`hostId + paneId` → `hostId + tmuxPaneId` → `hostId + sessionName` → 当前用户全局 inbox。`paneId` 必须验证 host 前缀，`tmuxPaneId` 验证 `%数字`，session 名沿用现有正则。设备是查看者维度，不写入消息路由主体。

### A4. 存储边界

- metadata/text/inbox 索引：独立 `~/.tmuxgo/agent-inbox.json`（或同目录版本化 store），沿用现有原子临时文件 + rename + 0600；不要塞进 `agent-notifications.json`。建议保留最近 1000 条或按 30 天清理，readBy 及 cursor 受上限约束。
- 二进制 asset：`TMUXGO_DATA_DIR`（默认 `~/.tmuxgo/inbox-assets`）按 `sha256` 分层目录，写临时文件后 rename；记录 mime/size/hash，下载接口鉴权并 `Content-Disposition` 白名单文件名。禁止把用户提供路径拼入文件系统路径。
- 生产环境若多实例，JSON 只适合单实例；先明确 gateway 单实例部署约束，未来切换 SQLite/对象存储时保持 repository interface，不在第一轮引数据库。

## B. Tab 数据模型与管理

### B1. 现有边界

- `WindowTabs` 是 tmux window 的服务端真实状态，通过 `useWindows` + `useWindowQueryState`，切换实际调用 `api.windows.select`，不能把 MCP 内容混进 window。
- `EditorWorkbench` 的 tab 是 `FileEditorDocument`，由 `useConsoleStore.openEditors/editorGroups/editorLayout` 管理；文件 tab 有 `kind: file|compare` 和 preview 语义，不能把媒体塞进文件 editor 类型。
- 移动端 `useConsoleStore` 按设计不持久化编辑器/面板细节，只保留 host/session；新增 inbox 应与该策略一致，避免手机 localStorage 存大内容。

### B2. 建议的 Tab 类型

第一期不要改 tmux window API；增加独立 UI workspace tab 类型（可名为 `ContentTab`/`InboxItemView`），仅在 inbox 打开时使用：

```ts
interface InboxTab {
  id: string             // messageId，asset 预览不复制内容
  messageId: string
  hostId?: string
  sessionName?: string
  paneId?: string
  title: string
  type: 'text'|'image'|'video'|'file'
  pinned?: boolean
  lastOpenedAt: string
}
```

建议先放 `useInboxStore`（仍可复用 Zustand persist），不要污染 `useConsoleStore` 的 terminal/editor state。持久化只存 `messageId`、顺序、activeId、pinned，恢复后从 inbox API 重新 hydrate；不存在/过期消息自动过滤。桌面和手机使用同一数据 schema、不同展示布局。

后续若用户要求“浏览器 tab/编辑器 tab/window tab”统一，可以抽象 `WorkspaceTab = TerminalWindowTab | EditorTab | InboxTab`，但本轮不做总重构。当前 window query state、editor layout 和 inbox tabs 保持三种事实源，统一只在导航层聚合。

### B3. Inbox UI 入口

- 桌面：在现有 `DesktopWorkbench`/顶栏加入 Inbox badge + `InboxPanel`；点击消息可展开 text/图片/视频/下载文件，并支持“跳转 pane”。
- 手机：`MobileNav` 的“更多”或新增高优先级收件箱入口（建议主入口保留 5 项、Inbox 置于 sessions 旁，其他入口进 more），使用 `MobileBottomSheet`；不在 `PaneGrid` 内叠加常驻面板。
- 实时事件只刷新列表/query cache 并显示轻量 toast；用户点击后才加载 asset，禁止 WS 中传 blob。

## C. 手机端痛点与优先级

### P0（随 inbox 一起做）

1. **收件箱入口不可见**：现有 `MobileNav` 项目较多且 panes/git/desktop/settings 进 more；新增 Inbox 需 badge、未读数、明确返回路径，不能靠 toast 作为唯一入口。
2. **键盘/viewport 竞态**：`ConsoleLayout` 已经有 visualViewport + rAF + keyboard state，但 overlay、底部 dock 和 terminal fit 仍易出现键盘弹起时跳动/遮挡。Inbox/媒体预览必须复用 `appHeight`/safe-area，不用 `100vh`，并在键盘打开时不抢焦点。
3. **返回键 overlay 栈复杂**：已有 `overlayRef` + `history.pushState`，files/git 还有 nested level。Inbox sheet 必须注册独立 `inbox` / `inbox-preview` 层级，保证 Android back 先关预览再关 sheet，不能直接退出页面。
4. **pane/session 路由操作成本高**：移动端 `PaneGrid` 主视图 + `MobileDrawer` 切 panes/windows；从推送消息跳目标时要先 setActiveSession/setActivePane，再关闭 sheet，避免用户看到“跳了但仍在旧 pane”。
5. **大媒体误触/卡顿**：列表仅缩略图和 metadata；视频默认不 autoplay，图片懒加载；下载和预览显示进度、失败重试，失去网络时保留 message。

### P1

6. **会话切换历史不够直观**：已有 pinned/recent quick session strip，Inbox 路由应按 host/session 显示来源、支持回跳，并避免切换 session 时把旧 inbox 误清空。
7. **底部导航空间与横屏**：已有 compact 选项和 landscape hide class；Inbox badge 在 compact/more 两种布局都要可达，横屏使用桌面/侧栏布局不重复堆 dock。
8. **触摸目标/长按冲突**：沿用现有 pointer/long press 约定；消息卡片点击打开、长按出复制/下载/标记已读菜单，避免和 terminal 手势混用。
9. **离线/弱网反馈**：沿用 connection 状态、toast 和 query retry；inbox 本地只保 metadata，不把上传内容离线缓存到 localStorage。

### P2（可后续）

10. Web Push 点击后深链到 host/session/pane/message；设备订阅已有能力，先复用 agent notification 设置和 deviceId。
11. 媒体全屏预览、横向 swipe、系统 share sheet、断点续传。
12. 手机端 workspace tab 管理、拖拽排序、批量已读/清理。

## D. 任务拆分与并行建议

### 主线（先做，依赖最少）

1. Gateway inbox domain/store：类型、校验、持久化、分页、read/unread、asset lifecycle。
2. MCP `/mcp` + stdio bridge：只调用 domain service；JSON-RPC/MCP transport 适配单元测试；Origin/Bearer/token、目标路由校验。
3. REST：`GET /api/inbox`、`GET /api/inbox/:id`、`POST /api/inbox/:id/read`、`GET /api/inbox/assets/:assetId`、分片/上传 endpoint；复用 auth hook，但 MCP token 不绕过普通 auth。

### 可并行 worktree A（前端 inbox）

- `apps/frontend/src/types/index.ts`
- 新增 `stores/useInboxStore.ts`、`hooks/useInbox.ts`、`components/InboxPanel.tsx`、`InboxPreview.tsx`
- 改 `lib/api.ts`、`hooks/useWebSocket.ts`/`lib/stream-events.ts`（只加 inbox event）
- 改 `ConsoleLayout.tsx`、`MobileNav.tsx`、必要 i18n 和 tests

验收：桌面/手机均能看到未读、打开、标记已读、按 route 跳 pane；刷新后 tabs 只恢复 id。

### 可并行 worktree B（gateway push/asset）

- 新增 `lib/agent-inbox.ts`、`routes/inbox.ts`、`routes/mcp.ts`/MCP adapter、asset 测试
- 接入 `index.ts` 与 `stream/stream-session` fanout
- 不修改已有 agent-notifications store；只在 monitor/stream 增加新事件桥

验收：push text、multipart/file、重复 dedupe、坏 route、超限、鉴权、重启恢复、WS fanout。

### 可并行 worktree C（移动端体验/回归）

- 仅在 A 合并接口后改 `ConsoleLayout` overlay/back/viewport、`MobileDrawer`/`MobileNav`，补 `ConsoleLayout.test.tsx` 和移动键盘/返回回归。
- 不与 C1 同时大改 `PaneGrid` 的 resize/input 逻辑；只接 navigation callback。

### 不建议并行

- 不让多个 worktree 同时修改 `useConsoleStore`、`stream-events.ts`、`api.ts`；这些是冲突中心。先由 gateway 定事件 schema，再由前端接入。
- 不先做通用 tab 重构或独立 DB；会扩大范围并阻塞 MCP 闭环。

## E. 性能、可靠性和安全

### E1. 通道

- MCP 请求/上传走 REST/HTTP；实时通知走现有 WS stream fanout（新增 `inbox_message_created`、`inbox_message_updated`、`inbox_asset_ready`），查询/补偿走 REST cursor。不要轮询作为主通道；WS 断线后用 `createdAt/id` cursor 增量同步。
- WS payload 仅 metadata，单事件设置上限（建议 64 KiB）；断线队列不在内存无限堆积。
- 小文本限制建议 256 KiB；图片/视频/文件统一 multipart 或分片上传。文件推荐 8 MiB 分片、并发 2，服务端按 assetId + partNo 临时目录写入，最终 hash 校验后原子合并；第一期可先单请求 multipart，保留分片接口字段。

### E2. 文件传输

- 上传：MCP 先申请 upload session（目标 route、mime、size、sha256），上传流直接落磁盘，不经 JSON base64；服务端检查大小、mime 白名单/扩展名仅作展示、sha256、总配额。
- 下载/预览：鉴权 GET + Range 支持视频 seek；`Content-Type` 从受控 metadata 取，`X-Content-Type-Options: nosniff`；Content-Disposition 使用安全文件名。
- UI 先请求 metadata/thumbnail，视频按用户点击加载；对象 URL 用完 revoke，组件卸载取消 fetch。

### E3. 安全与幂等

- MCP Bearer/token 与 `/api/agent-events` token 分开；不能因为 agent event 路由豁免就让 `/mcp` 匿名。每次 push 校验 token 对应可访问 host；未指定 route 也只能进入该 token 所属用户的全局 inbox。
- Streamable HTTP 校验 Origin；本地绑定 127.0.0.1；限制 method/header/body，拒绝任意 redirect/SSRF URL。MCP tool 不接受“读取本地路径后由 gateway 自己打开”，只接受上传内容/受控 asset。
- `dedupeKey` 约束长度与 scope（token+route），重复请求返回同一 messageId；时间、size、数量、文件名和 metadata 均设上限。
- 写入采用临时文件 + hash/size 校验 + rename；清理过期 upload session、孤儿 asset 和过期 inbox。所有失败返回稳定 code，日志不得输出 token 或文件正文。

## 推荐实施顺序与验收

1. **Round 1（当前规划）**：冻结上述 schema/route/transport；确认 gateway 单实例及配置目录；实现 domain store + push text REST/MCP + WS metadata。
2. **Round 2（开发中对齐）**：接前端 InboxPanel/移动入口；补图片/文件 multipart，route 跳转和 back stack；跑 gateway/frontend typecheck + focused tests。
3. **Round 3（验收）**：补视频 Range、断线 cursor、清理/配额、stdio bridge 多客户端；真实 test tmux session 验证四类 agent 配置与手机/桌面；再 build 并重启生产 gateway。

最小验收矩阵：

- Codex/Claude Code：stdio bridge 能 `push_text`；Streamable HTTP 能 Bearer 连接。
- dsh/Hermes：同一 HTTP API 能按 host/session/pane 路由。
- UI：PC 与手机收到同一 metadata；未读 badge、预览、下载、已读、刷新恢复均正确。
- 可靠性：WS 断开后 REST cursor 补齐；重复 dedupe；大文件不进入 WS/JSON；错误不影响既有 terminal/agent status 流。
