# 后续优化方向
## 范围说明
本文件排除 `FLUENCY_OPTIMIZATION.md` 中已经覆盖或正在实现的流畅性事项，包括终端输出聚合、WebSocket 聚合、移动端 resize 调度、snapshot 查询合并、输入队列批处理、滚动合并、React Query 缓存细化等。这里聚焦功能闭环、操作体验、可靠性、安全边界和产品完成度。
## 高优先级
### 1. 补齐 pane/window 操作闭环
位置：`apps/frontend/src/components/PaneActions.tsx`、`apps/frontend/src/components/WindowTabs.tsx`、`apps/frontend/src/components/WindowList.tsx`、`apps/gateway/src/routes/windows.ts`、`apps/gateway/src/routes/panes.ts`
现状：`PaneActions` 发送 `split`、`close-pane` WebSocket 消息，但 Gateway 的 stream 路由没有处理这些类型；`WindowTabs` 只展示窗口，无法切换；`WindowList` 的拖拽排序只改前端 store，没有同步 tmux。
建议：统一 pane/window 操作为 HTTP API 或统一 WebSocket API，补齐 switch-window、rename-window、kill-window、move-window、select-pane、kill-pane、split-pane 的真实后端实现。前端操作成功后刷新状态或消费 snapshot。
收益：按钮和列表行为从“看起来可用”变成真正可用，减少用户误判。
### 2. 会话模板真实执行 layout
位置：`apps/frontend/src/components/SessionTemplates.tsx`、`apps/frontend/src/components/Sidebar.tsx`、`apps/frontend/src/components/MobileDrawer.tsx`、`apps/gateway/src/routes/sessions.ts`
现状：模板定义了 windows/panes/command，但创建 session 时只传 name，模板中的窗口、分屏和命令没有真正执行。
建议：创建 session API 支持 template layout，后端按模板创建窗口、分屏、发送命令；前端选择模板后传 layout 或 templateId。创建失败时返回具体失败步骤。
收益：README 中的模板能力和实际体验一致，首次使用价值更高。
### 3. 命令面板升级为可键盘操作的动作中心
位置：`apps/frontend/src/components/CommandPalette.tsx`
现状：命令面板只能过滤 hosts/sessions，缺少上下键选择、Enter 执行，也没有操作类命令。
建议：支持 ArrowUp/ArrowDown、Enter、Esc；把 actions 纳入搜索，例如新建 session、切窗口、分屏、zoom pane、打开设置、复制、粘贴、切主题。结果项加入类型和快捷键提示。
收益：桌面端效率明显提升，减少鼠标路径。
### 4. 错误反馈和空状态系统化
位置：`apps/frontend/src/components/QuickActions.tsx`、`apps/frontend/src/components/MobileDrawer.tsx`、`apps/frontend/src/components/Sidebar.tsx`、`apps/frontend/src/lib/api.ts`
现状：部分 `catch {}` 静默吞错，部分操作使用 `alert`/`confirm`，风格不一致。创建、删除、split、kill、paste 失败时用户不知道原因。
建议：新增全局 toast/notification store，统一展示成功、失败、进行中状态。关键 destructive 操作使用一致的确认弹窗。API error 保留 HTTP 状态、错误码和 message。
收益：失败可解释，操作结果更明确。
## 中优先级
### 5. 审计日志从 mock 变成真实数据
位置：`apps/frontend/src/components/AuditLog.tsx`、`apps/gateway/src`
现状：审计日志是静态 mock 数据，与实际 session/pane 操作无关。
建议：Gateway 增加轻量 audit logger，记录 create/delete/split/kill/attach/detach/rename 等操作。前端通过 `/api/audit` 读取，支持筛选 action/result/session。
约束：审计日志必须设置保留策略，默认最多保留最近 1000 条或最近 30 天；前端分页读取，后端自动裁剪旧记录；只记录结构化事件，不记录完整终端输出、敏感输入内容、密码、token 或完整命令历史。
收益：设置里的审计功能变成真实能力，方便排查误操作。
### 6. 终端搜索真正接入 xterm SearchAddon
位置：`apps/frontend/src/components/TerminalSearch.tsx`、`apps/frontend/src/components/TerminalPane.tsx`
现状：`TerminalSearch` 组件存在，但当前终端初始化没有加载 SearchAddon，也没有入口把搜索组件挂到终端上。
建议：TerminalPane 加载 `@xterm/addon-search`，提供 Ctrl+F/Cmd+F 打开搜索；搜索框支持大小写、全词、上一个/下一个。
收益：长日志和历史输出可检索，终端可用性提升。
### 7. 剪贴板和粘贴安全确认
位置：`apps/frontend/src/components/QuickActions.tsx`、`apps/frontend/src/hooks/useClipboard.ts`
现状：粘贴会直接把剪贴板内容发送到终端，包含多行、控制字符或危险命令时没有确认。
建议：多行粘贴、超过阈值长度、包含控制字符时弹出预览确认；允许用户选择直接发送、转义粘贴、取消。
收益：降低误粘贴破坏性命令的风险，尤其是移动端。
### 8. 首次启动和依赖检查页面
位置：`bootstrap.sh`、`start.sh`、`apps/gateway/src/routes/system.ts`、`apps/frontend/src/components`
现状：README 写了依赖要求，但应用内没有显示 tmux/node/nvidia-smi/tailscale 等检查状态。tmux 不可用时多处功能只会失败。
建议：Gateway 提供 health detail，前端无 session 或依赖缺失时显示修复建议和检测结果。包括 tmux 是否安装、tmux server 是否可启动、gateway 端口、Tailscale 状态。
收益：首次使用和环境排障更直接。
### 9. 远程 agent 功能边界明确化
位置：`apps/agent/src`、`apps/gateway/src/agent-manager.ts`、`apps/gateway/src/routes/hosts.ts`
现状：hosts 可以显示 agent，但 session/window/pane 路由主要操作本地 tmux，远程 host 的实际支持边界不清晰。
建议：明确 local-only 与 remote-capable API。若远程 agent 未实现 session 管理，前端禁用对应操作并展示状态；或者把 sessions/windows/panes 命令转发到 agent。
收益：避免用户选择远程 host 后操作落到本机或失败。
## 低优先级
### 10. 用户偏好导入导出
位置：`apps/frontend/src/hooks/usePreferences.ts`、`apps/frontend/src/hooks/useCustomShortcuts.ts`、`apps/frontend/src/components/Settings.tsx`
现状：主题、快捷键、snippets 等存储在 localStorage，换设备或清缓存后不可迁移。
建议：设置页增加导出 JSON、导入 JSON、恢复默认。校验版本号和字段合法性。
收益：多设备使用更方便。
### 11. Snippets 与 QuickActions 整合
位置：`apps/frontend/src/components/CommandSnippets.tsx`、`apps/frontend/src/components/QuickActions.tsx`
现状：CommandSnippets 组件存在，但入口不明显；QuickActions 只支持快捷键和少量操作。
建议：把 snippets 纳入 QuickActions 和 CommandPalette，支持分类、搜索、编辑、发送前确认是否追加 Enter。
收益：常用命令能力更可发现。
### 12. 统一图标、按钮和可访问性
位置：`apps/frontend/src/components`
现状：界面混用字符图标、手写 SVG、按钮 title，部分按钮缺少 aria-label，移动端点击区域不统一。
建议：统一使用图标库或统一 IconButton 组件，补齐 aria-label、disabled 状态、focus ring、tooltip。移动端关键按钮保持最小 44px 点击区域。
收益：界面一致性和可访问性更好。
### 13. 关键操作测试覆盖
位置：`apps/frontend`、`apps/gateway`
现状：未看到针对 session 创建、模板执行、pane split/kill、WebSocket attach/reconnect 的自动化测试。
建议：Gateway 增加 tmux 命令封装层单测；前端增加 store/action 级测试；端到端覆盖创建 session、切换 window、split pane、打开命令面板、移动端抽屉。
收益：后续继续优化时降低回归风险。
## 推荐落地顺序
1. 先补齐 pane/window 操作闭环，修正“按钮存在但后端不响应”的问题。
2. 实现模板 layout 执行，让 README 和真实功能一致。
3. 升级命令面板，提升桌面端高频操作效率。
4. 建全局 toast 和统一错误反馈，减少静默失败。
5. 处理真实审计日志、终端搜索、粘贴安全确认。
6. 最后做首次启动检查、远程 agent 边界、偏好迁移和测试覆盖。
## 可拆任务
1. 为 Gateway 增加 `select-window`、`rename-window`、`kill-window`、`move-window` API。
2. 为 Gateway 增加 `select-pane`、`split-pane`、`kill-pane`、`zoom-pane` API，并统一前端调用。
3. 让 `WindowTabs` 点击后真实切换 tmux window。
4. 让 `WindowList` 拖拽排序调用 tmux `move-window`。
5. 创建 session 时支持 `templateId` 或 `layout`。
6. 新增 toast store 和 ToastViewport，替换静默 catch、alert、confirm。
7. CommandPalette 支持键盘导航和 action registry。
8. AuditLog 接入真实 `/api/audit`。
9. TerminalPane 接入 SearchAddon 和 Ctrl+F。
10. 多行粘贴增加预览确认。
11. system health 增加依赖检查详情。
12. 明确 remote host API 支持状态并在 UI 中禁用不可用操作。
