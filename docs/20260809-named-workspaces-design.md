# 命名工作区与会话分组 — 设计文档

日期：2026-08-09
状态：已实施

## 背景与目标

当前会话创建工作区仅为"一个路径"，无名、不可复用、会话列表平铺无分类。目标：

1. 会话根据工作区分类（分组列表展示）
2. 创建工作区时可填写自定义"工作名"
3. 从已有工作名一键快速创建新 session（自动 cwd + 布局模板）

## 现状

| 能力 | 现状 |
|---|---|
| 会话↔工作区 | `CreateSessionDialog` 可选目录作 workspace，写入 `sessionWorkspaces`（`sessionId → workspacePath + rootId/rootPath/rootLabel/relativePath`），文件面板跟随会话工作区 |
| 布局模板 | 内置 4 模板（default/dev/monitor/training）+ 自定义模板（多窗口/多窗格/命令/env），`SessionTemplate` |
| 收藏目录 | `favoriteDirectories`（`{rootId, rootPath, name, path}`），文件面板虚拟根 |
| 会话列表 | 平铺展示，`sessionOrders` 手动排序，无分组 |

## 数据模型

持久化于独立文件 `~/.tmuxgo/workspaces.json`（`TMUXGO_CONFIG_DIR` 可覆盖，格式与 `session-templates.json` 同构：`{ version, updatedAt, workspaces }`）。不塞进 preferences：不污染偏好跨设备同步、无 512KB 大小限制、与模板存储一致。

```ts
interface WorkspaceEntry {
  id: string              // uuid，稳定 id，改名/换路径不失效
  name: string            // 工作名，用户自定义，/^[A-Za-z0-9._-]{1,64}$/
  hostId: string          // local | agent host
  path: string            // 绝对路径，如 /workspace/tmuxgo
  rootId: string          // 文件面板 root 关联（跟随用）
  rootPath: string
  rootLabel: string
  relativePath: string
  templateId: string | null  // 绑定布局模板（内置或自定义）
  createdAt: string
  updatedAt: string
}
```

会话关联升级：`SessionWorkspaceEntry` 增加可选 `workspaceId`；老数据无此字段时降级按 `workspacePath` 匹配；新建会话写入 `workspaceId`。

## 后端 API（routes/workspaces.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces?hostId=` | 列表（按 host 过滤） |
| POST | `/api/workspaces` | 创建：校验 name 合法、path 绝对路径、templateId 存在 |
| PATCH | `/api/workspaces/:id` | 改名 / 换路径 / 换模板 / 换 root 关联 |
| DELETE | `/api/workspaces/:id` | 删除：会话保留，归"未分类" |

校验规则：
- `name`：`/^[A-Za-z0-9._-]{1,64}$/`（与会话名一致，保证可用于会话名前缀）
- `path`：绝对路径
- `templateId`：内置或自定义模板中存在，否则置 null
- 同名工作区（同 host 同 name）：创建时返回冲突，或允许并存（前端展示区分）——实现时定

## 前端改动

### 会话面板分组（SessionPanel）

- 按 `workspaceId` 分组（降级按路径匹配），组头 = 工作名 + 会话数
- 无工作区会话归"未分类"组
- 组头交互：`＋`（从工作区新建）、工作区管理（改名 / 换模板 / 删除）
- 删除工作区确认弹窗提示"会话保留，归未分类"

### 从工作区新建

1. 组头点 `＋` → 打开 `CreateSessionDialog`
2. 预填：`name = <工作名>-<模板默认名>`（可改）、`workspace` 已选中（显示工作名 + 路径）、`layout = 工作区绑定模板`
3. 创建成功 → 自动写入 `sessionWorkspaces`（含 `workspaceId`）

### CreateSessionDialog 升级

目录选择器升级为"命名工作区选择器"：
- 先选已有工作区（显示工作名 + 路径 + 模板），或"新建工作区"（填工作名 + 选目录 + 选模板）
- 选中后回填 cwd

### 其他

- 新增 `useWorkspaces` hook（查询 / 增删改，跟随现有 query 缓存模式）
- `i18n` 补 zh/en 文案
- 组件测试：分组渲染、从工作区新建预填、工作区 CRUD、删除后归未分类

## 边界规则

- 删工作区 → 会话保留、归未分类，`sessionWorkspaces.workspaceId` 清空
- 工作区改名 → 分组即时跟随（按 id 关联，不按名字）
- 跨设备 → `hostId` 隔离，会话面板只显示当前 host 的工作区
- 模板删除 → 工作区 `templateId` 置 null，新建时回退默认模板
- tmux 会话名限制 `[A-Za-z0-9._-]{1,64}`：自动前缀不得引入冒号/斜杠等非法字符

## 实施顺序

1. 后端：preferences schema + CRUD API + 校验 + `routes/workspaces.test.ts`
2. 前端：类型 + `useWorkspaces` + `CreateSessionDialog` 升级
3. 前端：`SessionPanel` 分组 + 工作区管理 UI + i18n + 组件测试
