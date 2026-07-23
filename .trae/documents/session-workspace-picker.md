# 新建会话时选择工作区

## Context
当前新建会话只命名：`SessionPanel.handleTemplateSelect` 选模板后调 `usePrompt` 取名字，再 `createSession({ hostId, name, layout })`。后端 `tmux new-session -d -s name` 不带 `-c`，首个 pane 落在 tmux 默认目录，后续 split 虽继承 `#{pane_current_path}` 但起点不对。文件标签页（FilePanel）也不跟踪会话工作区，切换会话只重置到默认根。

目标：新建会话时除命名外可选工作区（VSCode 式文件夹选择，复用现有 file tab，兼顾手机/电脑），创建后该会话内 pane 自动 cd 到该工作区，且 file 标签页的工作区固定为该路径。会话工作区映射走 RemotePreferences 多端同步。

用户已确认：① 模板后加工作区步（保留现有模板）② file 固定为创建时选的路径 ③ RemotePreferences 多端同步。

## 复用点
- FilePanel 已有完整树浏览、根切换（workspace/home 根）、收藏目录、`mode='panel'|'mobile'|'explorer'`、`useFileRoots`/`useFileList`。新增 `mode='picker'` + `onPick` 复用全部浏览逻辑。
- 后端 `applyTemplateLayout`（sessions.ts:249）已支持 per-pane `cwd`（`split-window -c` / `new-window -c` / 首 pane `cd` send-keys）。`getPaneStartupCommand`（sessions.ts:216）处理 `pane.cwd`。
- `favoriteDirectories` 在 preferences 的 LWW-by-timestamp 模式（preferences.ts:495）——`sessionWorkspaces` 照搬。
- `PromptDialog` 作为新对话框的模板。`ModalPortal`、`tmuxgo-glass-dialog`、`Button`/`Chip` 复用。
- `getMatchingRootOption`/`mapAbsolutePathToRoot`（FilePanel/files.ts）把绝对工作区路径映射回 rootId+relativePath。

## 改动

### 1. 后端：会话创建支持 cwd
- `apps/gateway/src/lib/request-validation.ts`：`sessionCreateBodySchema` 增 `cwd: z.string().max(4096).optional()`。
- `apps/gateway/src/routes/sessions.ts` POST `/hosts/:hostId/sessions`（L305）：
  - 解构 `cwd`；构造 `new-session` 参数时若 `cwd?.trim()` 追加 `-c <cwd>`。
  - 若有 `layout` 且 `cwd` 存在：克隆 layout，对每个 pane `pane.cwd = pane.cwd || cwd`，再传给 `applyTemplateLayout`（保证新窗口也落到工作区）。
  - 创建返回对象增 `cwd?: string`（仅创建时回传，list 不涉及）。
  - 校验 cwd 为绝对路径（`path.isAbsolute`），否则忽略。

### 2. 后端：preferences 增 sessionWorkspaces 字段
- `apps/gateway/src/routes/preferences.ts`：
  - 新增类型 `SessionWorkspaceEntry = { sessionId, hostId, workspacePath, rootId, rootPath, rootLabel, relativePath, updatedAt }`。
  - `PreferencesStore` 增 `sessionWorkspaces: SessionWorkspaceEntry[]` + `sessionWorkspacesUpdatedAt: string`。
  - `getDefaultStore` / `normalizeStore` / PUT 处理（L481）照搬 `favoriteDirectories` 分支：加 `normalizeSessionWorkspaces`（去重 by sessionId，限流如 200 条），按 `sessionWorkspacesUpdatedAt` 做 LWW。
  - `updatedAt` 汇总（L410、L553）加入新字段时间戳。

### 3. 前端类型与 API
- `apps/frontend/src/types/index.ts`：`RemotePreferences` 增 `sessionWorkspaces: SessionWorkspaceEntry[]` + `sessionWorkspacesUpdatedAt: string`；导出 `SessionWorkspaceEntry` 接口。
- `apps/frontend/src/lib/api.ts`：
  - `sessions.create(hostId, name, layout?, cwd?)` body 带 `cwd`。
  - `preferences.update` payload 类型增 `sessionWorkspaces?` + `sessionWorkspacesUpdatedAt?`。
- `apps/frontend/src/hooks/useApi.ts`：`useCreateSession` 入参增 `cwd?: string` 透传。

### 4. 前端：会话工作区偏好 hook
新增 `apps/frontend/src/hooks/useSessionWorkspaces.ts`：
- `useSessionWorkspaces()`：`useQuery(['preferences','session-workspaces'])` 读 `api.preferences.get('default')` 取 `sessionWorkspaces`。
- `useSetSessionWorkspace()`：mutation，读当前列表 → upsert（按 sessionId）→ `api.preferences.update({ sessionWorkspaces, sessionWorkspacesUpdatedAt: now })` → `setQueryData`。
- `useRemoveSessionWorkspaces(sessionIds[])` / `useMigrateSessionWorkspace(fromId, toId)`：供删除/改名时清理与迁移。

### 5. 前端：FilePanel 增 picker 模式
- `apps/frontend/src/components/FilePanel.tsx`：
  - `mode` 联合类型增 `'picker'`；新增可选 `onPick?: (target: { rootId, rootPath, rootLabel, relativePath, absolutePath }) => void`。
  - picker 模式：复用根选择 + 收藏目录 + 桌面树/移动列表渲染；隐藏 upload/trash/新建文件等动作与文件预览区；header 增“选择此目录”按钮，点击以当前目录（`activeSourceRootPath`+`currentPath`）调 `onPick`。
  - picker 模式下 `isMobile` 用 `isMobileDevice()`（`useMobileKeyboard`）决定走触控列表渲染，避免依赖 ConsoleLayout 的 mobile back 事件栈。
  - 收藏目录在 picker 中作为快捷选择（点选即定位到该目录，不直接 onPick）。

### 6. 前端：CreateSessionDialog 组件
新增 `apps/frontend/src/components/CreateSessionDialog.tsx`：
- props：`open, template: SessionTemplate, defaultName, hostId, onCreate({name, cwd?}), onClose`。
- 桌面：`ModalPortal` + `tmuxgo-glass-dialog`（较宽 max-w-3xl），顶部名字输入（预填 `getTemplateSessionName(template)`），下方内嵌 `<FilePanel mode="picker" onPick={...} />`，底部“创建/取消”。
- 手机：`isMobileDevice()` 为真时整屏容器，FilePanel picker 占主体，名字输入置顶，创建按钮置底（避开键盘）。
- 选中工作区后显示路径摘要，可“更改”重新选；允许“不选工作区”跳过（cwd=undefined，保持原行为）。
- 样式沿用 `--line`、`tmuxgo-control`、`tmuxgo-input` 等既有变量/类（见 project_memory）。

### 7. 前端：两个创建入口接入（SessionPanel + MobileDrawer）
注意：移动端 MobileDrawer 有自己独立的 `handleTemplateSelect`（MobileDrawer.tsx:60），不渲染 SessionPanel。桌面端入口在 SessionPanel.tsx:47。两处都要改。

- `apps/frontend/src/components/SessionPanel.tsx`（桌面）与 `apps/frontend/src/components/MobileDrawer.tsx`（移动）：
  - 各自 `handleTemplateSelect` 不再调 `prompt`；改为打开 `CreateSessionDialog`（本地 state 存 template+defaultName+open）。
  - dialog `onCreate`：`createSession.mutateAsync({ hostId, name, layout: template.layout, cwd })` → 创建成功且 cwd 存在时 `useSetSessionWorkspace` 写入 `{ sessionId: created.id, hostId, workspacePath, rootId, rootPath, rootLabel, relativePath, updatedAt }` → `setActiveSession(created.id)` → toast → MobileDrawer 额外 `onClose()` 关抽屉。
  - 两处各渲染 `<CreateSessionDialog .../>`（与各自 `SessionTemplates` 同级）。
  - 考虑两处逻辑重复，可把「创建+写 workspace」抽成 `useCreateSessionWithWorkspace()` hook 复用。

### 8. 前端：FilePanel 跟随会话工作区
- `apps/frontend/src/components/FilePanel.tsx`：
  - 引入 `useSessionWorkspaces()`。
  - 新增 effect（独立 ref 记录已应用的 sessionId）：当 `activeSessionId` 变化且 workspace 数据与 `rootOptions` 就绪时，查到该会话的 entry → 用 `getMatchingRootOption` 把 `workspacePath` 映射到 root option + relativePath → `setSelectedRootId` + `setCurrentPath`；查不到则保持默认。
  - 与现有 follow-editor effect（L643）共存：工作区定位设定根与初始路径，follow-editor 在此之上精确定位编辑器文件；session 切换时先应用工作区。
  - 仅在非搜索态、`mode!=='explorer'` 时应用，避免干扰嵌入编辑器场景。

### 9. 前端：删除/改名时清理与迁移
- `apps/frontend/src/hooks/useApi.ts`：
  - `useDeleteSession` onSuccess 调 `useRemoveSessionWorkspaces([sessionId])` 清理。
  - `useBatchDeleteSessions` execute 模式 onSuccess 批量清理。
  - `useRenameSession` onSuccess：若 oldId≠newId，调 `useMigrateSessionWorkspace(oldId, newId)`。

### 10. i18n
- 在 i18n 字典增 key：`session.workspace`、`session.selectWorkspace`、`session.selectThisFolder`、`session.noWorkspace`、`session.workspaceHint` 等（zh/en）。

## 验证
1. 桌面：点“新建”→选模板→对话框出现名字+文件树 picker→浏览/收藏选目录→“创建”。确认：会话创建后首 pane `pwd` 为所选目录；split 新 pane 也在该目录；file 标签页根与路径=所选工作区。
2. 手机：MobileDrawer 会话抽屉→“新建”→模板→CreateSessionDialog 整屏 picker，触控浏览可用，键盘不遮挡创建按钮。
3. 不选工作区：行为与现状一致（tmux 默认目录，file 默认根）。
4. 多端同步：A 设备创建带工作区的会话，B 设备 `useSessionWorkspaces` 拉到 entry，切换到该会话 file 自动定位。
5. 改名/删除：workspace 条目随之迁移/清理，不留孤儿。
6. 模板 cwd：选带多窗口模板+工作区，确认每个窗口首 pane 均在工作区。
7. 远程 host：选远程 host 的工作区（远程文件根），`new-session -c` 在远程生效。
